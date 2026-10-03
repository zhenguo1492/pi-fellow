import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardClientMessage, BoardHostMessage } from '../../../shared/board';

interface FakePanel {
    title: string;
    disposed: boolean;
    posted: BoardHostMessage[];
    dispose(): void;
}

const state = vi.hoisted(() => ({
    panels: [] as FakePanel[],
    textDocuments: [] as { isDirty: boolean; uri: { scheme: string; fsPath: string } }[],
    onSave: undefined as ((doc: { uri: { scheme: string; fsPath: string }; getText(): string }) => void) | undefined,
    /** Editor groups, and the column of the active one. */
    groups: 2,
    activeColumn: 2,
    onTabGroups: undefined as (() => void) | undefined,
    commands: [] as string[],
    /** What the fake page's `status` says besides its defaults. */
    status: {} as Record<string, unknown>,
    /** The page is busy drawing: its replies wait in `held`, in order, until the test releases them. */
    holding: false,
    held: [] as (() => void)[],
    /** What a render reports. */
    renderErrors: [] as { block: string; message: string }[],
}));

vi.mock('vscode', () => ({
    ViewColumn: { One: 1, Active: -1, Beside: -2 },
    Uri: {
        joinPath: (...parts: unknown[]) => parts.join('/'),
        file: (fsPath: string) => ({ scheme: 'file', fsPath }),
    },
    workspace: {
        get textDocuments() {
            return state.textDocuments;
        },
        onDidSaveTextDocument: (listener: typeof state.onSave) => {
            state.onSave = listener;
            return { dispose() {} };
        },
    },
    window: {
        onDidChangeTextEditorSelection: () => ({ dispose() {} }),
        showTextDocument: async () => undefined,
        setStatusBarMessage: () => ({ dispose() {} }),
        tabGroups: {
            get all() {
                return Array.from({ length: state.groups }, (_, i) => ({ viewColumn: i + 1 }));
            },
            get activeTabGroup() {
                return { viewColumn: state.activeColumn };
            },
            onDidChangeTabGroups: (listener: () => void) => {
                state.onTabGroups = listener;
                return { dispose() {} };
            },
        },
        createWebviewPanel: (_viewType: string, title: string) => {
            let receive: (message: BoardClientMessage) => void = () => {};
            const disposeListeners: (() => void)[] = [];
            // Answers like the board webview: ready once loaded, then acks every request.
            const reply = (message: BoardHostMessage) => {
                switch (message.type) {
                    case 'render':
                        return receive({ type: 'rendered', version: message.version, errors: state.renderErrors });
                    case 'point':
                        return receive({ type: 'pointed', seq: message.seq });
                    case 'scroll':
                        return receive({ type: 'scrolled', seq: message.seq });
                    case 'status':
                        return receive({
                            type: 'status',
                            seq: message.seq,
                            visible: [],
                            point: null,
                            userMark: null,
                            marks: { pi: null, user: null },
                            width: 800,
                            maximized: false,
                            zoom: { page: 1, blocks: {} },
                            expanded: null,
                            scrollY: 0,
                            diagrams: [],
                            webPages: [],
                            ...state.status,
                        });
                    case 'expand':
                        return receive({ type: 'expanded', seq: message.seq });
                }
            };
            const panel: FakePanel & Record<string, unknown> = {
                title,
                /** What the page posts, as a click in it would. */
                fromPage: (message: BoardClientMessage) => receive(message),
                disposed: false,
                posted: [],
                viewColumn: 2,
                visible: true,
                active: false,
                reveal() {},
                webview: {
                    cspSource: 'test',
                    asWebviewUri: (uri: unknown) => uri,
                    set html(_html: string) {
                        queueMicrotask(() => receive({ type: 'ready' }));
                    },
                    postMessage: async (message: BoardHostMessage) => {
                        panel.posted.push(message);
                        if (state.holding) {
                            state.held.push(() => reply(message));
                        } else {
                            queueMicrotask(() => reply(message));
                        }
                        return true;
                    },
                    onDidReceiveMessage: (listener: typeof receive) => {
                        receive = listener;
                        return { dispose() {} };
                    },
                },
                onDidDispose: (listener: () => void) => {
                    disposeListeners.push(listener);
                    return { dispose() {} };
                },
                dispose() {
                    if (!panel.disposed) {
                        panel.disposed = true;
                        disposeListeners.forEach((l) => l());
                    }
                },
            };
            state.panels.push(panel);
            return panel;
        },
    },
    commands: {
        executeCommand: async (command: string) => {
            state.commands.push(command);
        },
    },
}));

import { Blackboards, boardFolder, pruneBoardFolders } from '../../../voiceAgent/blackboard';

let dir: string;
let boards: Blackboards;
let sessionFile: string;

async function readIndex(file = sessionFile): Promise<{ current?: string; boards: { id: string; title: string; open: boolean; zoom?: unknown }[] }> {
    return JSON.parse(await fs.readFile(path.join(boardFolder(file), 'index.json'), 'utf8'));
}

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boards-'));
    sessionFile = path.join(dir, 's1.jsonl');
    state.panels = [];
    state.textDocuments = [];
    state.groups = 2;
    state.activeColumn = 2;
    state.commands = [];
    state.status = {};
    state.holding = false;
    state.held = [];
    state.renderErrors = [];
    boards = new Blackboards({ extensionUri: '/ext' as never, following: () => false, log: () => {} });
    await boards.bindSession(sessionFile, false);
});

afterEach(async () => {
    boards.dispose();
    await fs.rm(dir, { recursive: true, force: true });
});

describe('Blackboards', () => {
    it('creates a board file and index on the first write, and appends on the next', async () => {
        const first = await boards.write({ markdown: '# Login\n\nThe client sends a token.', mode: 'append' });
        expect(first.split('\n')[0]).toBe('Board b1 "Login": written.');
        const file = path.join(boardFolder(sessionFile), 'b1.md');
        expect(await fs.readFile(file, 'utf8')).toBe('# Login\n\nThe client sends a token.\n');
        expect(await readIndex()).toEqual({ current: 'b1', boards: [{ id: 'b1', title: 'Login', open: true }] });
        expect(state.panels).toHaveLength(1);

        const second = await boards.write({ markdown: '```ts\nlogin();\n```', mode: 'append' });
        expect(second).toBe('Board b1 "Login": appended 1 block.\nh1 heading "Login"\np1 paragraph "The client sends a token."\nc1 code ts, 1 lines');
        expect(await fs.readFile(file, 'utf8')).toBe('# Login\n\nThe client sends a token.\n\n```ts\nlogin();\n```\n');
        // Still the same tab, which got the new document.
        expect(state.panels).toHaveLength(1);
        expect(state.panels[0].posted.at(-1)).toMatchObject({ type: 'render', markdown: '# Login\n\nThe client sends a token.\n\n```ts\nlogin();\n```\n' });

        await boards.write({ markdown: 'Other topic.', mode: 'append', board: 'new', title: 'Tokens' });
        expect((await readIndex()).boards.map((b) => [b.id, b.title])).toEqual([['b1', 'Login'], ['b2', 'Tokens']]);
        expect((await readIndex()).current).toBe('b2');
    });

    it('gives a new page of a board the zoom the user left it at, after a window reload too; 100% keeps nothing', async () => {
        await boards.write({ markdown: '# T', mode: 'append' });
        const zoom = { page: 1.5, blocks: { d1: 2, w1: 0.75 } };
        const page = (i: number) => state.panels[i] as FakePanel & { fromPage(message: BoardClientMessage): void };
        const zoomsTo = (i: number) => page(i).posted.filter((m) => m.type === 'zoom');
        expect(zoomsTo(0)).toEqual([]);
        page(0).fromPage({ type: 'zoomed', zoom });
        await vi.waitFor(async () => expect((await readIndex()).boards[0].zoom).toEqual(zoom));

        page(0).dispose();
        await boards.view({ action: 'open' });
        await vi.waitFor(() => expect(zoomsTo(1)).toEqual([{ type: 'zoom', zoom }]));
        // After the render: the page zooms what it has drawn.
        expect(page(1).posted.findIndex((m) => m.type === 'render')).toBeLessThan(page(1).posted.findIndex((m) => m.type === 'zoom'));

        // A window reload: a new Blackboards reads the index and reopens the board.
        boards.dispose();
        boards = new Blackboards({ extensionUri: '/ext' as never, following: () => false, log: () => {} });
        await boards.bindSession(sessionFile, true);
        await vi.waitFor(() => expect(zoomsTo(2)).toEqual([{ type: 'zoom', zoom }]));

        page(2).fromPage({ type: 'zoomed', zoom: { page: 1, blocks: {} } });
        await vi.waitFor(async () => expect((await readIndex()).boards[0]).toEqual({ id: 'b1', title: 'T', open: true }));
    });

    it('rewrites a block and removes a block given empty markdown', async () => {
        await boards.write({ markdown: '# T\n\nfirst\n\nsecond', mode: 'append' });
        const file = path.join(boardFolder(sessionFile), 'b1.md');

        const rewrote = await boards.write({ markdown: 'FIRST', mode: 'block', block: 'p1' });
        expect(rewrote.split('\n')[0]).toBe('Board b1 "T": rewrote block p1.');
        expect(await fs.readFile(file, 'utf8')).toBe('# T\n\nFIRST\n\nsecond\n');

        const removed = await boards.write({ markdown: '', mode: 'block', block: 'p1' });
        expect(removed.split('\n')[0]).toBe('Board b1 "T": removed block p1.');
        expect(await fs.readFile(file, 'utf8')).toBe('# T\n\nsecond\n');

        await expect(boards.write({ markdown: 'x', mode: 'block', block: 'p9' })).rejects.toThrow('No block p9');
    });

    it('refuses to write a board whose source has unsaved changes', async () => {
        await boards.write({ markdown: '# T\n\ntext', mode: 'append' });
        const file = path.join(boardFolder(sessionFile), 'b1.md');
        state.textDocuments = [{ isDirty: true, uri: { scheme: 'file', fsPath: file } }];
        await expect(boards.write({ markdown: 'more', mode: 'append' })).rejects.toThrow(/user is editing/);
        expect(await fs.readFile(file, 'utf8')).toBe('# T\n\ntext\n');
        // Another board is still writable.
        await expect(boards.write({ markdown: 'new', mode: 'append', board: 'new' })).resolves.toMatch(/^Board b2 /);
    });

    it('closing a tab marks its board closed; a context switch and dispose do not, and reopen restores only open boards', async () => {
        await boards.write({ markdown: '# One', mode: 'append' });
        await boards.write({ markdown: '# Two', mode: 'append', board: 'new' });
        await boards.write({ markdown: '# Three', mode: 'append', board: 'new' });
        state.panels[1].dispose();
        await vi.waitFor(async () => expect((await readIndex()).boards.map((b) => b.open)).toEqual([true, false, true]));

        await boards.bindSession(path.join(dir, 's2.jsonl'), true);
        expect(state.panels.every((p) => p.disposed)).toBe(true);
        expect((await readIndex()).boards.map((b) => b.open)).toEqual([true, false, true]);

        await boards.bindSession(sessionFile, true);
        const reopened = state.panels.filter((p) => !p.disposed).map((p) => p.title);
        expect(reopened).toEqual(['Board · One', 'Board · Three']);
        expect(boards.list()).toEqual([
            { id: 'b1', title: 'One', open: true, current: false },
            { id: 'b2', title: 'Two', open: false, current: false },
            { id: 'b3', title: 'Three', open: true, current: true },
        ]);
        // Reopening again opens nothing twice.
        await boards.bindSession(sessionFile, true);
        expect(state.panels.filter((p) => !p.disposed)).toHaveLength(2);

        boards.dispose();
        expect(state.panels.every((p) => p.disposed)).toBe(true);
        expect((await readIndex()).boards.map((b) => b.open)).toEqual([true, false, true]);
    });

    it('turns a saved source edit into one edit notice, and ignores a save of its own text', async () => {
        await boards.write({ markdown: '# T\n\nold text', mode: 'append' });
        const file = path.join(boardFolder(sessionFile), 'b1.md');
        state.onSave!({ uri: { scheme: 'file', fsPath: file }, getText: () => '# T\n\nold text\n' });
        expect(boards.takeEdits()).toEqual([]);

        state.onSave!({ uri: { scheme: 'file', fsPath: file }, getText: () => '# T\n\nnew text\n\nadded\n' });
        expect(boards.takeEdits()).toEqual([
            { board: 'b1', title: 'T', summary: 'changed p1; added p2', outline: 'h1 heading "T"\np1 paragraph "new text"\np2 paragraph "added"' },
        ]);
        expect(boards.takeEdits()).toEqual([]);
        expect(state.panels[0].posted.at(-1)).toMatchObject({ type: 'render', edited: true, markdown: '# T\n\nnew text\n\nadded\n' });
    });

    it('returns the outline before the page draws; a point waits for the drawing, and its errors come once as late results', async () => {
        state.holding = true;
        state.renderErrors = [{ block: 'd1', message: 'Parse error on line 2' }];
        const written = await boards.write({ markdown: '# T\n\n```mermaid\ngraph TD\nA--\n```', mode: 'append' });
        expect(written).toMatch(/^Board b1 "T": written\.\nh1 heading "T"\nd1 diagram /);
        // Sent, not drawn yet.
        expect([state.panels[0].posted.at(-1)?.type, state.held.length > 0]).toEqual(['render', true]);
        expect(boards.takeLateResults()).toEqual([]);

        // A marker right after: the page answers once it has drawn, however long the drawing takes.
        vi.useFakeTimers();
        try {
            let answer: string | undefined;
            const pointed = boards.point({ block: 'd1' }, undefined).then((text) => (answer = text));
            await vi.advanceTimersByTimeAsync(10_000);
            expect([answer, state.panels[0].posted.at(-1)?.type]).toEqual([undefined, 'point']);
            state.held.splice(0).forEach((release) => release());
            await pointed;
            expect(answer).toMatch(/^Pointed at d1 on board b1/);
        } finally {
            vi.useRealTimers();
        }
        expect(boards.takeLateResults()).toEqual([
            'Board b1 "T": d1 did not render: Parse error on line 2. Fix the Mermaid source and rewrite it with show_me board "b1", mode "block", block "d1".',
        ]);
        expect(boards.takeLateResults()).toEqual([]);
    });

    it('reports nothing for a drawing replaced before it was drawn, only for the one that is shown', async () => {
        state.holding = true;
        await boards.write({ markdown: '```mermaid\ngraph TD\nA--\n```', mode: 'append' });
        await boards.write({ markdown: '```mermaid\ngraph TD\nB--\n```', mode: 'block', block: 'd1' });
        state.renderErrors = [{ block: 'd1', message: 'Parse error' }];
        state.held.splice(0).forEach((release) => release());
        await vi.waitFor(() => expect(boards.takeLateResults()).toEqual([expect.stringMatching(/^Board b1 "Board": d1 did not render: Parse error\./)]));
        expect(boards.takeLateResults()).toEqual([]);
    });

    it('draws a show_me call on a tab of its own while it streams, whole blocks only, and the write takes the tab over', async () => {
        const renders = () => state.panels[0].posted.flatMap((m) => (m.type === 'render' ? [m.markdown] : []));
        const preview = boards.preview({ markdown: '# Login\n\nThe cli', mode: 'append', title: 'Login' });
        // The tab opens at once: its page loads while the model is still writing.
        expect(state.panels.map((p) => p.title)).toEqual(['Board · Login']);
        await vi.waitFor(() => expect(renders().at(-1)).toBe('# Login\n'));
        preview.update({ markdown: '# Login\n\nThe client sends a token.\n\n```mermaid\ngraph TD\nA-->', mode: 'append', title: 'Login' });
        // The diagram still being written is not drawn: it would show as an error.
        await vi.waitFor(() => expect(renders().at(-1)).toBe('# Login\n\nThe client sends a token.\n'));
        // Nothing is written until the call runs.
        await expect(readIndex()).rejects.toThrow();

        const final = { markdown: '# Login\n\nThe client sends a token.\n\n```mermaid\ngraph TD\nA-->B\n```', mode: 'append' as const, title: 'Login' };
        preview.end(final);
        expect(await boards.write(final)).toMatch(/^Board b1 "Login": written\./);
        expect([state.panels.length, state.panels[0].disposed]).toEqual([1, false]);
        expect(renders().at(-1)).toBe(final.markdown + '\n');
        expect(await readIndex()).toEqual({ current: 'b1', boards: [{ id: 'b1', title: 'Login', open: true }] });
    });

    it('closes a tab it opened when its call is dropped, and puts a board it drew on back', async () => {
        await boards.write({ markdown: '# T\n\nfirst', mode: 'append' });
        const onNew = boards.preview({ board: 'new', markdown: '# Other\n\nx\n\n', mode: 'append' });
        expect(state.panels).toHaveLength(2);
        onNew.end();
        expect(state.panels[1].disposed).toBe(true);
        await new Promise((resolve) => setImmediate(resolve));
        expect((await readIndex()).boards.map((b) => b.id)).toEqual(['b1']);

        const renders = () => state.panels[0].posted.flatMap((m) => (m.type === 'render' ? [m.markdown] : []));
        const onOld = boards.preview({ markdown: 'second\n\n', mode: 'append' });
        await vi.waitFor(() => expect(renders().at(-1)).toBe('# T\n\nfirst\n\nsecond\n'));
        // The write that follows goes to another board: this one goes back to what it showed.
        onOld.end({ markdown: 'second', mode: 'append', board: 'new' });
        expect(renders().at(-1)).toBe('# T\n\nfirst\n');
        expect(state.panels[0].disposed).toBe(false);
    });

    it('points at existing blocks only, and at lines only in code', async () => {
        await boards.write({ markdown: '# T\n\ntext\n\n```js\na\nb\n```', mode: 'append' });
        await expect(boards.point({ block: 'p7' }, undefined)).rejects.toThrow(/has no block p7/);
        await expect(boards.point({ block: 'p1', startLine: 1 }, undefined)).rejects.toThrow(/only point into code/);
        await expect(boards.point({ block: 'c1', startLine: 2, endLine: 3 }, undefined)).rejects.toThrow(/lines 1-2/);
        await expect(boards.point({ block: 'c1', startLine: 1, endLine: 2 }, undefined)).resolves.toBe('Pointed at c1 lines 1-2 on board b1 (highlight).');
        expect(state.panels[0].posted.at(-1)).toMatchObject({ type: 'point', target: { board: 'b1', block: 'c1' }, style: 'highlight' });
    });

    it('points at a web page only as a whole block', async () => {
        await boards.write({ markdown: '# T\n\n```html\n<button id="push">Push</button>\n```', mode: 'append' });
        await expect(boards.point({ block: 'w1', text: 'Push' }, undefined)).rejects.toThrow('w1 is a web page, which runs in its own frame: point at the whole block');
        await expect(boards.point({ block: 'w1', startLine: 1 }, undefined)).rejects.toThrow(/point at the whole block/);
        await expect(boards.point({ block: 'w1' }, undefined)).resolves.toBe('Pointed at w1 on board b1 (highlight).');
    });

    it('expands only a diagram or a web page of the board, and collapses', async () => {
        await boards.write({ markdown: '# T\n\n```mermaid\ngraph TD\nA\n```\n\n```html\n<p>demo</p>\n```', mode: 'append' });
        await expect(boards.view({ action: 'expand', block: 'h1' })).rejects.toThrow(/Expand needs a diagram or web page block of Board b1 "T"; h1 is a heading/);
        await expect(boards.view({ action: 'expand', block: 'd7' })).rejects.toThrow(/d7 is not on it/);
        expect(await boards.view({ action: 'expand', block: 'd1' })).toMatch(/^Diagram d1 fills Board b1 "T", alone; its zoom is kept\./);
        expect(state.panels[0].posted.at(-1)).toEqual({ type: 'expand', seq: expect.any(Number), block: 'd1' });
        expect(await boards.view({ action: 'expand', block: 'w1' })).toMatch(/^Web page w1 fills Board b1 "T", alone; its zoom is kept\./);
        expect(state.panels[0].posted.at(-1)).toEqual({ type: 'expand', seq: expect.any(Number), block: 'w1' });
        expect(await boards.view({ action: 'collapse' })).toBe('Board b1 "T" shows all its blocks again.');
        expect(state.panels[0].posted.at(-1)).toEqual({ type: 'expand', seq: expect.any(Number), block: null });
    });

    it('tells the agent which web page fills the board and what the user zoomed', async () => {
        await boards.write({ markdown: '# T\n\n```mermaid\ngraph TD\nA\n```\n\n```html\n<p>demo</p>\n```', mode: 'append' });
        state.status = { expanded: 'w1', zoom: { page: 1, blocks: { w1: 1.5, d1: 2 } } };
        expect(await boards.view({ action: 'looking' })).toBe('Board b1 "T", visible: web page w1 alone, filling the board; the user zoomed w1 at 150%, d1 at 200%.');
        state.status = { expanded: 'd1' };
        expect(await boards.view({ action: 'looking' })).toMatch(/: diagram d1 alone, filling the board\.$/);
    });

    it("passes an element the user marked in a web page on to the next turn and tells it in looking", async () => {
        await boards.write({ markdown: '```html\n<button id="go">Go</button>\n```', mode: 'append' });
        const element = { selector: '#go', tag: 'button', id: 'go', text: 'Go', html: '<button id="go">Go</button>' };
        const panel = state.panels[0] as FakePanel & { fromPage(message: BoardClientMessage): void };
        panel.fromPage({ type: 'userMark', mark: { block: 'w1', kind: 'web', element } });
        expect(boards.userMark()).toMatchObject({ board: 'b1', mark: { block: 'w1', kind: 'web', element } });
        state.status = { visible: ['w1'], userMark: { block: 'w1', kind: 'web', element } };
        expect(await boards.view({ action: 'looking' })).toMatch(/: blocks w1 in view; the user marked w1 element #go\.$/);
    });

    it('prunes board folders of sessions not kept', async () => {
        await boards.write({ markdown: '# T', mode: 'append' });
        await fs.mkdir(boardFolder(path.join(dir, 'gone.jsonl')), { recursive: true });
        await pruneBoardFolders(dir, [sessionFile]);
        expect(await fs.readdir(path.join(dir, 'boards'))).toEqual(['s1']);
    });

    it("maximizes and restores from the page's button and board_view alike, keeping the button's label in step", async () => {
        await boards.write({ markdown: '# T', mode: 'append' });
        const panel = state.panels[0] as FakePanel & { fromPage(message: BoardClientMessage): void };
        const toggle = 'workbench.action.toggleMaximizeEditorGroup';
        const labels = () => panel.posted.filter((m) => m.type === 'maximized').map((m) => (m.type === 'maximized' ? m.maximized : undefined));
        /** Lets the button's handler, started without being awaited, run to its end. */
        const settled = () => {
            const { promise, resolve } = Promise.withResolvers<void>();
            setImmediate(resolve);
            return promise;
        };

        panel.fromPage({ type: 'toggleMaximize' });
        await settled();
        expect(state.commands).toEqual([toggle]);
        expect(labels()).toEqual([true]);
        // Pi says it is maximized, so board_view does nothing more; its restore flips the button back.
        expect(await boards.view({ action: 'maximize' })).toMatch(/is maximized/);
        expect(await boards.view({ action: 'restore' })).toBe('Restored: the editor groups show side by side again.');
        expect(state.commands).toEqual([toggle, toggle]);
        expect(labels()).toEqual([true, false]);

        await boards.view({ action: 'maximize' });
        expect(labels()).toEqual([true, false, true]);
        panel.fromPage({ type: 'toggleMaximize' });
        await settled();
        expect(state.commands).toEqual([toggle, toggle, toggle, toggle]);
        expect(labels()).toEqual([true, false, true, false]);

        // Another group activated: VS Code restored it on its own, so the button reads Maximize again, and restore toggles nothing.
        panel.fromPage({ type: 'toggleMaximize' });
        await settled();
        state.activeColumn = 1;
        state.onTabGroups?.();
        expect(labels()).toEqual([true, false, true, false, true, false]);
        expect(await boards.view({ action: 'restore' })).toMatch(/^No board was maximized/);
        expect(state.commands).toHaveLength(5);

        // The only editor group already fills the editor area: nothing to toggle.
        state.groups = 1;
        panel.fromPage({ type: 'toggleMaximize' });
        await settled();
        expect(state.commands).toHaveLength(5);
        expect(labels()).toHaveLength(6);
    });
});
