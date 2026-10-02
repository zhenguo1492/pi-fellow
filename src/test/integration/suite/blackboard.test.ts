/**
 * Blackboards end to end (docs/blackboard.md), in a real VS Code: the real VoiceAgent, host tools,
 * turn messages, Blackboards and board webview (out/webview/board.js, so `npm run compile` first).
 * Only the voice model is scripted (../fakes/voiceLlm.ts, swapped in by the integration bundle).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BoardBox, BoardClientMessage, BoardHostMessage, BoardMarkBoxes, BoardShownPoint, BoardTarget, BoardZoom } from '../../../shared/board';
import { Blackboards, boardFolder } from '../../../voiceAgent/blackboard';
import { routeAnchors, withBoards } from '../../../voiceAgent/boardWiring';
import { VoiceTranscriptStore, type TranscriptMemento } from '../../../voiceAgent/transcriptStore';
import { VoiceAgent } from '../../../voiceAgent/voiceAgent';
import { fakeLlm, type ScriptedTurn } from '../fakes/voiceLlm';
import { IdleWorker } from '../fakes/worker';

type Reply = (turn: ScriptedTurn) => Promise<void>;
type ToolReply = { text: string; isError: boolean };

const LOGIN = [
    '# Login flow',
    '',
    'The client sends a token to the server.',
    '',
    '- check the token',
    '- refresh it when old',
    '',
    '| step | who |',
    '| --- | --- |',
    '| 1 | client |',
    '',
    '> Tokens expire after an hour.',
    '',
    '```ts',
    'function login(user: string) {',
    '    const token = issue(user);',
    '    return verify(token);',
    '}',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '    Client --> Server',
    '    Server --> Token',
    '```',
    '',
    '```mermaid',
    'this is not a diagram',
    '```',
].join('\n');

/** A sequence diagram (three messages around a note, one labeled like a participant) and a flowchart with edge labels. */
const FLOW = [
    '```mermaid',
    'sequenceDiagram',
    '    participant U as User',
    '    participant AI',
    '    U->>AI: ask',
    '    Note over U,AI: thinking',
    '    AI-->>U: show_me 写内容',
    '    U->>AI: AI',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '    Client -->|sends token| Server',
    '    Server --> Token',
    '```',
].join('\n');

/** src/app.ts in the workspace runTest.ts opens: `// line 1` … `// line 20`. */
function appFile(): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the tests run in the workspace runTest.ts makes');
    return vscode.Uri.joinPath(folder.uri, 'src', 'app.ts');
}

/**
 * Polls until `probe` gives a value. The workbench (tabs, editors) and the board webview answer from
 * other processes with no event the test could await for each state, so this is a real-clock wait.
 */
async function until<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value !== undefined && value !== false) {
            return value;
        }
        if (Date.now() > end) {
            throw new Error(`Timed out waiting for ${what}`);
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 100);
        await promise;
    }
}

function boardTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.label.startsWith('Board · '));
}

function memento(): TranscriptMemento {
    const data = new Map<string, unknown>();
    return {
        get: <T>(key: string) => data.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
            data.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
}

/** One VS Code window's voice agent: its transcript store, boards and agent, wired as voiceAgentCommands.ts does. */
class VoiceWindow {
    readonly boards: Blackboards;
    readonly store: VoiceTranscriptStore;
    readonly agent: VoiceAgent;
    readonly log: string[] = [];
    /** Web pages board links sent to the browser, instead of opening one. */
    readonly opened: string[] = [];

    constructor(worker: IdleWorker, state: TranscriptMemento, sessionDir: string, extensionUri: vscode.Uri) {
        const log = (line: string) => this.log.push(line);
        this.boards = new Blackboards({
            extensionUri,
            following: () => true,
            log,
            openExternal: async (uri) => {
                this.opened.push(uri.toString(true));
                return true;
            },
        });
        this.store = new VoiceTranscriptStore(state, { sessions: () => 20, entries: 300 }, () => worker.activeTask());
        this.agent = new VoiceAgent({
            worker,
            cwd: sessionDir,
            sessionDir,
            contexts: withBoards(this.store, this.boards, log),
            boards: this.boards,
            model: '',
            thinking: 'off',
            confirmBeforeDispatch: () => true,
            arbiter: () => ({ narration: 'off', minProactiveGapMs: 60_000, narrationIntervalMs: 60_000 }),
            log,
        });
    }

    /** A typed user turn, answered by `reply`; returns the message the model got. */
    async say(text: string, reply?: Reply): Promise<string> {
        if (reply) {
            fakeLlm.script.push(reply);
        }
        const asked = fakeLlm.prompts.length;
        this.store.addUser(text, 'text');
        const { listener } = this.store.beginReply();
        const cursor = { point: () => {} };
        const result = await this.agent.say(text, 'text', {
            ...listener,
            // Text mode points at once, as anchorLogged does.
            onAnchor: (anchor) => {
                listener.onAnchor?.(anchor);
                routeAnchors([anchor], this.boards, cursor);
            },
        });
        assert.strictEqual(result.error, undefined, result.error);
        return fakeLlm.prompts[asked];
    }

    /** A reply that calls one tool and keeps its result. */
    async call(text: string, toolName: string, args: Record<string, unknown>): Promise<ToolReply> {
        let got: ToolReply | undefined;
        await this.say(text, async (turn) => {
            got = await turn.call(toolName, args);
            turn.say('Done.');
        });
        return got!;
    }

    /** Pi's point on the board as the webview draws it, once it matches `wanted`. */
    async pointOn(board: string, wanted: (point: BoardShownPoint | null) => boolean): Promise<BoardShownPoint | null> {
        let last: BoardShownPoint | null | undefined;
        try {
            await until(`the point on ${board}`, async () => {
                last = (await this.boards.shown(board))?.point;
                return last !== undefined && wanted(last) ? true : undefined;
            });
        } catch (err) {
            throw new Error(`${err instanceof Error ? err.message : String(err)}; last seen ${JSON.stringify(last)}; log: ${this.log.join(' | ')}`);
        }
        return last!;
    }

    /**
     * What the board webview would post: the user's selection and its buttons are DOM events inside
     * the webview, which the extension host cannot script, so their messages go in where it receives them.
     */
    fromWebview(board: string, message: BoardClientMessage): void {
        const internals = this.boards as unknown as { panels: Map<string, { id: string }>; received(panel: unknown, message: BoardClientMessage): void };
        const panel = [...internals.panels.values()].find((p) => p.id === board);
        assert.ok(panel, `board ${board} is open`);
        internals.received(panel, message);
    }

    /** What the host would send the board page (the page's own zoom controls are DOM events the test cannot click). */
    async toWebview(board: string, message: BoardHostMessage): Promise<void> {
        const internals = this.boards as unknown as { panels: Map<string, { id: string; panel: vscode.WebviewPanel }> };
        const panel = [...internals.panels.values()].find((p) => p.id === board);
        assert.ok(panel, `board ${board} is open`);
        assert.ok(await panel.panel.webview.postMessage(message));
    }

    /** The user's click (or pan, with `drag`) at the middle of `target` on the board page, through its `clickAt`. */
    async clickAt(board: string, target: BoardTarget, drag?: { dx: number; dy: number }): Promise<void> {
        type Reply = Extract<BoardClientMessage, { seq: number }> | undefined;
        const internals = this.boards as unknown as { panels: Map<string, { id: string; request(build: (seq: number) => BoardHostMessage): Promise<Reply> }> };
        const panel = [...internals.panels.values()].find((p) => p.id === board);
        assert.ok(panel, `board ${board} is open`);
        const reply = await panel.request((seq) => ({ type: 'clickAt', seq, target, ...(drag ? { drag } : {}) }));
        assert.ok(reply?.type === 'clicked' && !reply.error, `the click on ${JSON.stringify(target)}: ${JSON.stringify(reply)}`);
    }

    /** The board page's status once `wanted` holds; the last seen in the error otherwise. */
    async shownWhen(board: string, what: string, wanted: (status: BoardStatus) => boolean): Promise<BoardStatus> {
        let last: BoardStatus | undefined;
        try {
            return await until(what, async () => {
                last = await this.boards.shown(board);
                return last && wanted(last) ? last : undefined;
            });
        } catch (err) {
            throw new Error(`${err instanceof Error ? err.message : String(err)}; last seen ${JSON.stringify(last)}`);
        }
    }

    async close(): Promise<void> {
        this.store.endRun();
        await this.agent.stop();
        this.boards.dispose();
    }
}

suite('Blackboard', function () {
    this.timeout(120_000);
    const worker = new IdleWorker();
    const state = memento();
    let sessionDir: string;
    let extensionUri: vscode.Uri;
    let win: VoiceWindow;
    let codeFile: vscode.Uri;

    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension('zhenguo.pi-fellow');
        assert.ok(extension, 'the extension is installed');
        extensionUri = extension.extensionUri;
        assert.ok(fs.existsSync(path.join(extensionUri.fsPath, 'out', 'webview', 'board.js')), 'out/webview/board.js is built (npm run compile)');
        sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-board-e2e-'));
        codeFile = vscode.Uri.file(path.join(sessionDir, 'login.ts'));
        fs.writeFileSync(codeFile.fsPath, 'export const login = () => true;\n');
        fakeLlm.reset();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        win = new VoiceWindow(worker, state, sessionDir, extensionUri);
    });

    suiteTeardown(async () => {
        await win?.close();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        fs.rmSync(sessionDir, { recursive: true, force: true });
    });

    test('show_me with short content is only a card in the history: no board', async () => {
        const shown = await win.call('How do I run the tests?', 'show_me', { markdown: '```bash\nnpm test\n```', title: 'Run the tests' });
        assert.strictEqual(shown.isError, false, shown.text);
        assert.match(shown.text, /^Shown as a card under your reply in the chat; it is not read aloud\./);
        assert.deepStrictEqual(boardTabs(), []);
        const session = win.store.current();
        assert.ok(session?.voiceSessionFile);
        assert.strictEqual(fs.existsSync(boardFolder(session.voiceSessionFile)), false);
        const reply = session.entries.at(-1);
        assert.ok(reply?.kind === 'assistant');
        assert.deepStrictEqual(
            reply.tools.map((t) => t.name),
            ['show_me'],
        );
    });

    test('show_me with long or Mermaid content opens "Board · <title>" in the code\'s editor group, and returns the outline and Mermaid errors', async () => {
        await vscode.window.showTextDocument(codeFile, { viewColumn: vscode.ViewColumn.One });
        const written = await win.call('How does login work?', 'show_me', { markdown: LOGIN, title: 'Login flow' });
        assert.strictEqual(written.isError, false, written.text);
        assert.match(written.text, /^Board b1 "Login flow"/);
        for (const line of ['h1 heading "Login flow"', 'p1 paragraph "The client sends a token to the server."', 'l1 list, 2 items', 't1 table, 1 rows', 'q1 quote "Tokens expire after an hour."', 'c1 code ts, 4 lines', 'd1 diagram flowchart, 3 lines', 'd2 diagram this, 1 lines']) {
            assert.ok(written.text.includes(line), `outline has ${line}:\n${written.text}`);
        }
        assert.match(written.text, /d2 did not render: /);
        assert.doesNotMatch(written.text, /d1 did not render/);

        assert.deepStrictEqual(
            boardTabs().map((t) => t.label),
            ['Board · Login flow'],
        );
        const board = boardTabs()[0];
        assert.strictEqual(vscode.window.tabGroups.all.length, 1, 'no new editor group');
        assert.strictEqual(board.group.viewColumn, vscode.ViewColumn.One, 'in the group of the code');
        assert.ok(board.isActive, 'in front of the code');
        assert.ok(board.group.tabs.some((t) => t.label === 'login.ts'), 'the code stays open behind it');
    });

    test('⟦board:…⟧ markers draw a highlight, an underline and a box, each replacing the last point', async () => {
        const marks: [string, (p: BoardShownPoint | null) => boolean][] = [
            ['⟦board:p1⟧ The client starts it.', (p) => p?.target.block === 'p1' && p.target.text === undefined],
            ['⟦board:c1:2-3⟧ These two lines issue and check the token.', (p) => p?.target.block === 'c1'],
            ['⟦board:p1#sends a token⟧ This is the request.', (p) => p?.target.block === 'p1' && p.target.text === 'sends a token'],
            ['⟦board:d1#Server⟧ And here the server answers.', (p) => p?.target.block === 'd1'],
        ];
        const drawn: { block: string; startLine?: number; endLine?: number; text?: string; style: string }[] = [];
        for (const [sentence, matches] of marks) {
            await win.say('Walk me through it.', async (turn) => turn.say(sentence));
            const point = await win.pointOn('b1', matches);
            assert.ok(point && point.rects > 0, `${sentence} is drawn`);
            drawn.push({ ...point.target, style: point.style });
        }
        assert.deepStrictEqual(
            drawn.map(({ block, startLine, endLine, text, style }) => ({ block, startLine, endLine, text, style })),
            [
                { block: 'p1', startLine: undefined, endLine: undefined, text: undefined, style: 'highlight' },
                { block: 'c1', startLine: 2, endLine: 3, text: undefined, style: 'highlight' },
                { block: 'p1', startLine: undefined, endLine: undefined, text: 'sends a token', style: 'underline' },
                { block: 'd1', startLine: undefined, endLine: undefined, text: 'Server', style: 'box' },
            ],
        );
        assert.deepStrictEqual(win.log.filter((line) => line.startsWith('Board point')), []);
    });

    test("the user's mark goes to the next user turn as <board>, and only that one", async () => {
        win.fromWebview('b1', { type: 'userMark', mark: { block: 'd1', kind: 'diagram', node: 'Token' } });
        const marked = await win.say('Why is this here?');
        assert.ok(marked.includes('<board board="b1" title="Login flow" block="d1" kind="diagram" node="Token" latest="true">'), marked);
        const next = await win.say('And then?');
        assert.ok(!next.includes('<board '), next);
    });

    test('a saved source edit redraws the board, clears the point and comes as <board-edited> once; writes wait while it is unsaved', async () => {
        const file = path.join(boardFolder(win.store.current()!.voiceSessionFile!), 'b1.md');
        assert.notStrictEqual(await win.pointOn('b1', (p) => p !== null), null, 'Pi points somewhere before the edit');

        win.fromWebview('b1', { type: 'editSource' });
        const editor = await until('the source editor', () => vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file));
        await editor.edit((edit) => edit.insert(editor.document.lineAt(editor.document.lineCount - 1).range.end, '\n\nAdded by hand.\n'));
        assert.ok(editor.document.isDirty);

        const refused = await win.call('Add a note.', 'show_me', { board: 'b1', mode: 'append', markdown: 'A note.' });
        assert.strictEqual(refused.isError, true);
        assert.match(refused.text, /editing/i);

        assert.ok(await editor.document.save());
        assert.strictEqual(await win.pointOn('b1', (p) => p === null), null);
        const edited = await win.say('I changed it.');
        assert.match(edited, /<board-edited board="b1" title="Login flow" changes="added p2">\n[\s\S]*p2 paragraph "Added by hand\."[\s\S]*\n<\/board-edited>/);
        assert.ok(!(await win.say('Go on.')).includes('<board-edited'));

        const appended = await win.call('Add a note now.', 'show_me', { board: 'b1', mode: 'append', markdown: 'A note.' });
        assert.strictEqual(appended.isError, false, appended.text);
        assert.ok(appended.text.includes('p3 paragraph "A note."'), appended.text);
    });

    test('boards open when the conversation stopped reopen on resume; closed ones stay closed', async () => {
        const scratch = await win.call('Start a new board.', 'show_me', { board: 'new', title: 'Scratch', markdown: Array.from({ length: 8 }, (_, i) => `Line ${i + 1}.`).join('\n\n') });
        assert.match(scratch.text, /^Board b2 "Scratch"/);
        const tab = await until('the Scratch tab', () => boardTabs().find((t) => t.label === 'Board · Scratch'));
        await vscode.window.tabGroups.close(tab);
        await until('Scratch marked closed', () => win.boards.list().find((b) => b.id === 'b2' && !b.open));

        await win.close();
        await until('the board tabs gone with the window', () => boardTabs().length === 0);

        win = new VoiceWindow(worker, state, sessionDir, extensionUri);
        const resumed = await win.say('Where were we?');
        assert.match(resumed, /<boards>\nb1 "Login flow" open\nb2 "Scratch"( current)?\n<\/boards>/);
        await until('Login flow reopened', () => boardTabs().some((t) => t.label === 'Board · Login flow'));
        assert.deepStrictEqual(
            boardTabs().map((t) => t.label),
            ['Board · Login flow'],
        );
    });

    test('sequence messages and flowchart edges: pointed at by label or step, marked by the user', async () => {
        const flow = await win.call('Draw the call.', 'show_me', { board: 'new', title: 'Flow', markdown: FLOW });
        assert.match(flow.text, /^Board b3 "Flow"/);
        assert.ok(flow.text.includes('d1 diagram sequenceDiagram') && flow.text.includes('d2 diagram flowchart'), flow.text);

        const marks: [string, (p: BoardShownPoint | null) => boolean][] = [
            ['⟦board:d1#show_me 写内容⟧ Here I draw it.', (p) => p?.target.text === 'show_me 写内容'],
            ['⟦board:d1:3⟧ Then you ask again.', (p) => p?.target.startLine === 3],
            ['⟦board:d2#sends token⟧ This edge carries it.', (p) => p?.target.text === 'sends token'],
            ['⟦board:d1#AI⟧ The participant, not the message of that name.', (p) => p?.target.text === 'AI'],
        ];
        const drawn: { found: string; style: string }[] = [];
        for (const [sentence, matches] of marks) {
            await win.say('Go on.', async (turn) => turn.say(sentence));
            const point = await win.pointOn('b3', matches);
            assert.ok(point && point.rects > 0, `${sentence} is drawn`);
            drawn.push({ found: point.found, style: point.style });
        }
        assert.deepStrictEqual(drawn, [
            { found: 'message', style: 'box' },
            { found: 'message', style: 'highlight' },
            { found: 'edge', style: 'box' },
            { found: 'node', style: 'box' },
        ]);

        const pointed = await win.call('Show the second message.', 'board_point', { block: 'd1', startLine: 2, style: 'underline' });
        assert.strictEqual(pointed.text, 'Pointed at d1 step 2, a message on board b3 (underline).');
        const beyond = await win.call('And the tenth?', 'board_point', { block: 'd1', startLine: 10 });
        assert.deepStrictEqual(beyond, { text: 'Diagram d1 has messages 1-3; step 10 is not in it.', isError: true });
        const onFlowchart = await win.call('Step one of the flowchart?', 'board_point', { block: 'd2', startLine: 1 });
        assert.strictEqual(onFlowchart.isError, true);
        assert.match(onFlowchart.text, /Steps only point into a sequence diagram/);

        win.fromWebview('b3', { type: 'userMark', mark: { block: 'd1', kind: 'diagram', message: 'show_me 写内容', step: 2 } });
        const marked = await win.say('Why this call?');
        assert.ok(marked.includes('<board board="b3" title="Flow" block="d1" kind="diagram" step="2" message="show_me 写内容" latest="true"></board>'), marked);
        assert.ok(!(await win.say('Hmm.')).includes('<board '));
    });

    test('board_view puts a board in the main editor group and maximizes and restores it', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.window.showTextDocument(appFile(), { viewColumn: vscode.ViewColumn.One });
        assert.match((await win.call('Show the flow.', 'board_view', { action: 'open', board: 'b3' })).text, /is open/);
        const flowTab = () => boardTabs().find((t) => t.label === 'Board · Flow');
        await until('the Flow board in front of the code, in its group', () => flowTab()?.group.viewColumn === vscode.ViewColumn.One && flowTab()?.isActive);
        assert.strictEqual(vscode.window.tabGroups.all.length, 1, 'opening makes no new editor group');
        // The board page's width is what shows whether its group fills the editor area: here it does.
        const width = async () => (await win.boards.shown('b3'))?.width ?? 0;
        const alone = await width();
        assert.ok(alone > 0);

        const beside = await win.call('Put it next to the code.', 'board_view', { action: 'move', to: 'beside' });
        assert.strictEqual(beside.text, 'Board b3 "Flow" moved beside.');
        await until('the Flow board beside the code', () => flowTab()?.group.viewColumn === vscode.ViewColumn.Two);
        await until('the code shown again where the board was', () => vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath === appFile().fsPath && e.viewColumn === vscode.ViewColumn.One));

        const moved = await win.call('Put it in the main area.', 'board_view', { action: 'move', to: 'main' });
        assert.strictEqual(moved.text, 'Board b3 "Flow" moved to the main editor group, in front of the code there.');
        await until('the Flow board in the code group', () => flowTab()?.group.viewColumn === vscode.ViewColumn.One && flowTab()?.isActive);
        const groups = vscode.window.tabGroups.all.map((g) => `${g.viewColumn}: ${g.tabs.map((t) => `${t.label}${t.isPreview ? ' (preview)' : ''}`).join(', ')}`).join(' | ');
        assert.strictEqual(groups, '1: app.ts, Board · Flow', 'the code stays in that group behind the board; both are pinned tabs, and the board group closed');

        await vscode.window.showTextDocument(appFile(), { viewColumn: vscode.ViewColumn.Beside });
        await until('two editor groups', () => vscode.window.tabGroups.all.length === 2);
        // Measured once the page has laid out in its narrower group.
        const sideBySide = await until('the board narrower beside the code', async () => {
            const w = await width();
            return w > 0 && w < alone * 0.75 ? w : undefined;
        });
        const maximized = await win.call('Make the board big.', 'board_view', { action: 'maximize' });
        assert.match(maximized.text, /^Board b3 "Flow" is maximized/);
        await until('the board active', () => flowTab()?.isActive && flowTab()?.group.isActive);
        const big = await until('the board wider', async () => ((await width()) > sideBySide * 1.5 ? width() : undefined));
        assert.match((await win.call('Is it big?', 'board_view', { action: 'looking' })).text, /Board b3 "Flow", the active tab, maximized/);
        assert.match((await win.call('Make it big again.', 'board_view', { action: 'maximize' })).text, /is maximized/);
        assert.strictEqual(await width(), big, 'maximizing again leaves it maximized');
        assert.strictEqual((await win.call('Back to normal.', 'board_view', { action: 'restore' })).text, 'Restored: the editor groups show side by side again.');
        await until('the board side by side again', async () => (await width()) < big * 0.75);
        assert.match((await win.call('Restore again.', 'board_view', { action: 'restore' })).text, /^No board was maximized by you/);
    });

    test("the board's Maximize button maximizes and restores its editor group, and reads what board_view did", async () => {
        await until('two editor groups', () => vscode.window.tabGroups.all.length === 2);
        const shown = async () => {
            const status = await win.boards.shown('b3');
            assert.ok(status, 'the Flow board answers');
            return status;
        };
        const sideBySide = (await shown()).width;
        assert.strictEqual((await shown()).maximized, false, 'the button reads Maximize');

        // Its click, as the page posts it: the extension host cannot click inside a webview.
        win.fromWebview('b3', { type: 'toggleMaximize' });
        const big = await until('the board maximized by its button', async () => {
            const status = await shown();
            return status.maximized && status.width > sideBySide * 1.5 ? status.width : undefined;
        });
        assert.ok(vscode.window.tabGroups.activeTabGroup.tabs.some((t) => t.isActive && t.label === 'Board · Flow'), 'the board has the focus');
        win.fromWebview('b3', { type: 'toggleMaximize' });
        await until('restored by the button, which reads Maximize again', async () => {
            const status = await shown();
            return !status.maximized && status.width < big * 0.75;
        });

        // The voice agent maximizes: the button reads Restore, and pressing it undoes what board_view did.
        assert.match((await win.call('Make it big.', 'board_view', { action: 'maximize', board: 'b3' })).text, /is maximized/);
        await until('Restore on the button', async () => (await shown()).maximized && (await shown()).width > sideBySide * 1.5);
        win.fromWebview('b3', { type: 'toggleMaximize' });
        await until('restored by the button', async () => !(await shown()).maximized && (await shown()).width < big * 0.75);
        assert.match((await win.call('Restore it.', 'board_view', { action: 'restore' })).text, /^No board was maximized/);

        // Maximized by the button, restored by the voice agent: the button reads Maximize again.
        win.fromWebview('b3', { type: 'toggleMaximize' });
        await until('maximized', async () => (await shown()).maximized);
        assert.strictEqual((await win.call('Back to normal.', 'board_view', { action: 'restore' })).text, 'Restored: the editor groups show side by side again.');
        await until('Maximize on the button', async () => !(await shown()).maximized && (await shown()).width < big * 0.75);

        // Activating another group ends a maximized one in VS Code: the button follows.
        win.fromWebview('b3', { type: 'toggleMaximize' });
        await until('maximized', async () => (await shown()).maximized);
        const other = vscode.window.tabGroups.all.find((g) => !g.tabs.some((t) => t.label === 'Board · Flow'));
        assert.ok(other?.viewColumn);
        await vscode.window.showTextDocument(appFile(), { viewColumn: other.viewColumn });
        await until('the button back on Maximize', async () => !(await shown()).maximized && (await shown()).width < big * 0.75);
    });

    test('links on a board open workspace files at their lines and web pages in the browser', async () => {
        const app = appFile();
        const lands = (what: string, line: number, endLine = line) =>
            until(`${what} opens src/app.ts at ${line}-${endLine}`, () =>
                vscode.window.visibleTextEditors.some(
                    (e) => e.document.uri.fsPath === app.fsPath && e.selection.start.line === line - 1 && e.selection.end.line === endLine - 1,
                ),
            );
        win.fromWebview('b3', { type: 'openLink', href: 'src/app.ts#L3' });
        await lands('#L3', 3);
        win.fromWebview('b3', { type: 'openLink', href: 'src/app.ts:5-6' });
        await lands(':5-6', 5, 6);
        win.fromWebview('b3', { type: 'openLink', href: `${app.fsPath}:7` });
        await lands('an absolute path', 7);

        win.fromWebview('b3', { type: 'openLink', href: 'https://example.com/docs?q=1' });
        win.fromWebview('b3', { type: 'openLink', href: 'mailto:someone@example.com' });
        win.fromWebview('b3', { type: 'openLink', href: 'command:workbench.action.quit' });
        await until('the web link sent to the browser', () => win.opened.length > 0);
        await until('the other schemes refused', () => win.log.filter((l) => l.includes('opens nothing')).length === 2);
        assert.deepStrictEqual(win.opened, ['https://example.com/docs?q=1']);

        win.fromWebview('b3', { type: 'openLink', href: 'src/missing.ts' });
        await until('the missing file reported', () => win.log.some((l) => l.includes('src/missing.ts was not found')));
        assert.ok(!vscode.workspace.textDocuments.some((d) => d.uri.fsPath.endsWith('missing.ts')));
    });

    test("a board's new page takes the zoom the user left it at, and Pi pointing into a zoomed diagram brings the node into view", async () => {
        const shownZoom = async () => (await win.boards.shown('b3'))?.zoom;
        const reopen = async () => {
            await win.call('Close the flow board.', 'board_view', { action: 'close', board: 'b3' });
            await until('the Flow tab closed', () => !boardTabs().some((t) => t.label === 'Board · Flow'));
            await win.call('Open it again.', 'board_view', { action: 'open', board: 'b3' });
        };
        // The user zoomed, as the page reports it once zooming pauses: the page to 150%, the flowchart d2 to 400%.
        const zoom = { page: 1.5, blocks: { d2: 4 } };
        win.fromWebview('b3', { type: 'zoomed', zoom });
        await reopen();
        await until('the new page zoomed as the user left it', async () => (JSON.stringify(await shownZoom()) === JSON.stringify(zoom) ? true : undefined));

        // Token, the flowchart's last node, starts outside the zoomed-in view (it shows the first quarter):
        // only a scroll inside the diagram brings it into its clipped view, so rects > 0 proves it.
        await win.say('And the token?', async (turn) => turn.say('⟦board:d2#Token⟧ This is where it ends.'));
        const point = await win.pointOn('b3', (p) => p?.target.block === 'd2' && p.target.text === 'Token' && p.rects > 0);
        assert.deepStrictEqual([point?.found, point?.style], ['node', 'box']);
        assert.deepStrictEqual(win.log.filter((line) => line.startsWith('Board point')), []);
        assert.match((await win.call('What do they see?', 'board_view', { action: 'looking' })).text, /the user zoomed the page to 150%, d2 at 400%/);

        // Back to 100%: nothing is kept, and the next page starts at 100%.
        win.fromWebview('b3', { type: 'zoomed', zoom: { page: 1, blocks: {} } });
        await reopen();
        await until('the new page at 100%', async () => (JSON.stringify(await shownZoom()) === JSON.stringify({ page: 1, blocks: {} }) ? true : undefined));
    });

    test('a ```html block runs as a web page in the real webview: its scripts run, size it and report errors; it is pointed at as a whole', async () => {
        const page = [
            '```html',
            '<title>Stack</title>',
            '<div id="cells"></div>',
            '<button onclick="pop()">Pop</button>',
            '<script>',
            "document.getElementById('cells').style.height = '400px';",
            "throw new Error('stack boom');",
            '</script>',
            '```',
        ].join('\n');
        const written = await win.call('Show me a stack.', 'show_me', { board: 'new', title: 'Stack', markdown: page });
        assert.strictEqual(written.isError, false, written.text);
        assert.ok(written.text.includes('w1 web page "Stack", 7 lines'), written.text);
        // The page's script ran (with the frame nonce, under the inherited CSP) and its error came back through its port.
        assert.match(written.text, /w1 reported: inline event handlers do not run on a board \(onclick on <button>\)[^\n]*; Uncaught Error: stack boom\. Fix the HTML/);

        const pointed = await win.call('Which one?', 'board_point', { block: 'w1', text: 'Pop' });
        assert.strictEqual(pointed.isError, true);
        assert.match(pointed.text, /point at the whole block/);
        await win.say('And this?', async (turn) => turn.say('⟦board:w1⟧ This is the stack.'));
        // Laid out at the column's width, the page is as tall as its content there (400 px of cells and
        // more), not the 16:9 it starts at: in this narrow board taller than wide. Pi's mark covers it.
        const shown = (s: BoardStatus) => s.webPages.find((p) => p.block === 'w1');
        const status = await win.shownWhen('b4', 'w1 marked, at its content height', (s) => {
            const view = shown(s)?.view;
            return s.point?.target.block === 'w1' && !!view && (view.bottom - view.top) / (view.right - view.left) > 1 && !!s.marks.pi?.targetBox && inside(view, s.marks.pi.targetBox);
        });
        assert.strictEqual(status.point?.found, 'block');
    });

    test('a web page designed for 4K shows whole, fitted to its block like a picture, zooms and pans without reflowing, and fills the board when expanded', async () => {
        const wall = ['```html', '<meta name="viewport" content="width=3840, height=2160">', '<title>Wall</title>', '<div style="height:100vh;background:#cde">wall</div>', '```'].join('\n');
        const written = await win.call('Add the wall.', 'show_me', { board: 'b4', markdown: wall });
        assert.ok(written.text.includes('w2 web page "Wall", 3840×2160, 3 lines'), written.text);
        const width = (box: BoardBox) => box.right - box.left;
        const height = (box: BoardBox) => box.bottom - box.top;
        const shownAt = (what: string, wanted: (page: BoardStatus['webPages'][number], s: BoardStatus) => boolean) =>
            win.shownWhen('b4', what, (s) => {
                const page = s.webPages.find((p) => p.block === 'w2');
                return !!page && wanted(page, s);
            });
        const page = (s: BoardStatus) => s.webPages.find((p) => p.block === 'w2')!;

        // At 100% the whole page shows in its block: scaled down to the column, 16:9 as designed.
        const fitted = page(
            await shownAt('w2 fitted', (p) => inside(p.frame, p.view) && inside(p.view, p.frame) && width(p.frame) < 3840 && Math.abs(height(p.frame) / width(p.frame) - 0.5625) < 0.01),
        );
        // 200%: the page is drawn twice as large, its view stays the column's width and pans; nothing reflows (still 16:9).
        await win.toWebview('b4', { type: 'zoom', zoom: { page: 1, blocks: { w2: 2 } } });
        await shownAt(
            'w2 at 200%',
            (p, s) =>
                s.zoom.blocks.w2 === 2 &&
                Math.abs(width(p.frame) - 2 * width(fitted.frame)) < 2 &&
                Math.abs(width(p.view) - width(fitted.view)) < 2 &&
                Math.abs(height(p.frame) / width(p.frame) - 0.5625) < 0.01,
        );

        // Expanded at 200%: it pans in the whole board, Pi's mark on it.
        assert.match((await win.call('Show the wall big.', 'board_view', { action: 'expand', block: 'w2' })).text, /^Web page w2 fills Board b4 "Stack", alone/);
        await win.say('This one.', async (turn) => turn.say('⟦board:w2⟧ The wall.'));
        const big = await shownAt('w2 expanded at 200%', (p, s) => s.expanded === 'w2' && onTarget(s.marks.pi) && width(p.view) > width(fitted.view) && width(p.frame) > width(p.view));
        assert.ok(width(page(big).view) > big.width * 0.8, `its view fills the board: ${JSON.stringify(page(big))} in ${big.width}`);
        assert.match((await win.call('What do they see?', 'board_view', { action: 'looking' })).text, /web page w2 alone, filling the board; [^\n]*the user zoomed w2 at 200%/);
        // Expanded at 100%: the whole page, as large as the board allows.
        await win.toWebview('b4', { type: 'zoom', zoom: { page: 1, blocks: {} } });
        await shownAt('w2 expanded, whole', (p, s) => s.expanded === 'w2' && inside(p.frame, p.view) && inside(p.view, p.frame) && width(p.frame) >= width(fitted.frame) - 1);

        assert.strictEqual((await win.call('Back.', 'board_view', { action: 'collapse' })).text, 'Board b4 "Stack" shows all its blocks again.');
        await shownAt('the whole board again, w2 fitted', (p, s) => s.expanded === null && Math.abs(width(p.frame) - width(fitted.frame)) < 2);
    });
});

type BoardStatus = Extract<BoardClientMessage, { type: 'status' }>;

/**
 * A mark sits on its target: its box, as measured on screen, centered on the visible part of the
 * target within 3 px, and as large as it plus the mark's padding (the box style pads 5 px a side).
 */
function onTarget(marks: BoardMarkBoxes | null | undefined): boolean {
    const box = marks?.box;
    const target = marks?.targetBox;
    if (!box || !target) {
        return false;
    }
    const dx = (box.left + box.right - target.left - target.right) / 2;
    const dy = (box.top + box.bottom - target.top - target.bottom) / 2;
    const dw = box.right - box.left - (target.right - target.left);
    const dh = box.bottom - box.top - (target.bottom - target.top);
    return Math.abs(dx) <= 3 && Math.abs(dy) <= 3 && dw >= -1 && dw <= 16 && dh >= -1 && dh <= 16;
}

function overlap(a: BoardBox | null | undefined, b: BoardBox | null | undefined): boolean {
    return !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Within `outer`, give or take a pixel of rounding. */
function inside(inner: BoardBox, outer: BoardBox): boolean {
    return inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
}

/** A flowchart far wider than the text column: Mermaid draws it about 1600 px wide. */
const WIDE = ['```mermaid', 'flowchart LR', '    A[Client application] --> B[API gateway] --> C[Authentication service] --> D[Token store] --> E[Audit trail] --> F[Metrics pipeline] --> G[Done]', '```'].join('\n');

suite('Blackboard: diagram zoom and expand', function () {
    this.timeout(120_000);
    let sessionDir: string;
    let win: VoiceWindow;
    const zoomTo = (zoom: BoardZoom) => win.toWebview('b1', { type: 'zoom', zoom });

    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension('zhenguo.pi-fellow');
        assert.ok(extension);
        sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-board-zoom-e2e-'));
        fakeLlm.reset();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.window.showTextDocument(appFile(), { viewColumn: vscode.ViewColumn.One });
        win = new VoiceWindow(new IdleWorker(), memento(), sessionDir, extension.extensionUri);
        const filler = 'Filler paragraph.\n\n'.repeat(40);
        const written = await win.call('Draw it.', 'show_me', { title: 'Zoom', markdown: `${FLOW}\n\nSome words between.\n\n${WIDE}\n\n${filler}The end.` });
        assert.match(written.text, /^Board b1 "Zoom"/);
        assert.ok(written.text.includes('d3 diagram flowchart'), written.text);
    });

    suiteTeardown(async () => {
        await win?.close();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        fs.rmSync(sessionDir, { recursive: true, force: true });
    });

    test('at 100% a diagram wider than the text column is fitted whole: its drawing is not clipped', async () => {
        const status = await win.shownWhen('b1', 'the diagrams drawn', (s) => s.diagrams.length === 3);
        const wide = status.diagrams.find((d) => d.block === 'd3')!;
        const flow = status.diagrams.find((d) => d.block === 'd2')!;
        for (const { block, view, drawing } of status.diagrams) {
            assert.ok(inside(drawing, view) && inside(view, drawing), `${block}: the view shows its whole drawing: ${JSON.stringify({ view, drawing })}`);
        }
        // Fitted to the column: no wider than the text, which the smaller flowchart does not fill.
        assert.ok(wide.view.right - wide.view.left >= flow.view.right - flow.view.left, JSON.stringify(status.diagrams));
        assert.ok(wide.view.right - wide.view.left < status.width - 64, `the wide diagram is fitted to the text column: ${JSON.stringify(wide)} in ${status.width}`);
    });

    test("Pi's mark stays on its node through the diagram's and the page's zoom, and a zoomed diagram grows past the text column", async () => {
        const before = (await win.shownWhen('b1', 'd3 drawn', (s) => s.diagrams.some((d) => d.block === 'd3'))).diagrams.find((d) => d.block === 'd3')!;
        await win.say('And the gateway?', async (turn) => turn.say('⟦board:d3#API gateway⟧ It routes everything.'));
        const at100 = await win.shownWhen('b1', 'the mark on the gateway', (s) => s.point?.target.text === 'API gateway' && onTarget(s.marks.pi));

        await zoomTo({ page: 1, blocks: { d3: 2.5 } });
        const zoomed = await win.shownWhen(
            'b1',
            'the mark on the gateway, zoomed 250%',
            (s) => s.zoom.blocks.d3 === 2.5 && onTarget(s.marks.pi) && s.marks.pi!.targetBox!.right - s.marks.pi!.targetBox!.left > (at100.marks.pi!.targetBox!.right - at100.marks.pi!.targetBox!.left) * 2,
        );
        const view = zoomed.diagrams.find((d) => d.block === 'd3')!.view;
        // The text column fills the width at 100% (the fitted d3 spans it): zoomed, the view overflows it on both sides.
        assert.ok(view.left < before.view.left && view.right > before.view.right, `the view grew past the text column on both sides: ${JSON.stringify({ before: before.view, view })}`);
        assert.ok(view.left >= 0 && view.right <= zoomed.width, `…and stays within the board: ${JSON.stringify(view)} in ${zoomed.width}`);

        await zoomTo({ page: 1.5, blocks: { d3: 2.5 } });
        await win.shownWhen('b1', 'the mark on the gateway, the page at 150%', (s) => s.zoom.page === 1.5 && onTarget(s.marks.pi));
        await zoomTo({ page: 1, blocks: {} });
        await win.shownWhen('b1', 'back at 100%', (s) => s.zoom.page === 1 && !s.zoom.blocks.d3);
    });

    test('a diagram fills the board and goes back to the same scroll; Pi pans it to a node at its zoom, and pointing elsewhere brings the board back', async () => {
        // Zoomed first: the diagram's growth moves what the window shows (Chrome anchors the scroll).
        await zoomTo({ page: 1, blocks: { d3: 4 } });
        await win.shownWhen('b1', 'd3 at 400%', (s) => s.zoom.blocks.d3 === 4);
        await win.call('Scroll down.', 'board_view', { action: 'scroll', where: 'd3' });
        await win.shownWhen('b1', 'the board scrolled', (s) => s.scrollY > 0);
        // Scrolled smoothly: settled once two readings agree.
        let previous = -1;
        const y = await until('the scroll settled', async () => {
            const now = (await win.boards.shown('b1'))?.scrollY ?? -1;
            const settled = now === previous && now > 0;
            previous = now;
            return settled ? now : undefined;
        });

        assert.match((await win.call('Show the pipeline big.', 'board_view', { action: 'expand', block: 'd3' })).text, /^Diagram d3 fills Board b1 "Zoom", alone/);
        const expanded = await win.shownWhen('b1', 'd3 expanded', (s) => s.expanded === 'd3');
        const view = expanded.diagrams.find((d) => d.block === 'd3')!.view;
        assert.ok(view.right - view.left > expanded.width * 0.8, `it fills the board: ${JSON.stringify(view)} in ${expanded.width}`);
        assert.strictEqual(expanded.scrollY, y);
        assert.match((await win.call('What do they see?', 'board_view', { action: 'looking' })).text, /diagram d3 alone, filling the board/);

        // Done, the last node, lies outside the view at 400%: Pi's point pans the view to it, zoom unchanged.
        await win.say('And the end?', async (turn) => turn.say('⟦board:d3#Done⟧ It ends here.'));
        const inside = await win.shownWhen('b1', 'the mark on Done, inside the expanded diagram', (s) => s.point?.target.text === 'Done' && onTarget(s.marks.pi));
        assert.deepStrictEqual([inside.expanded, inside.zoom.blocks], ['d3', { d3: 4 }]);
        assert.ok(overlap(inside.marks.pi!.box, view), JSON.stringify(inside.marks.pi));

        assert.strictEqual((await win.call('Back to the board.', 'board_view', { action: 'collapse' })).text, 'Board b1 "Zoom" shows all its blocks again.');
        const back = await win.shownWhen('b1', 'the whole board again', (s) => s.expanded === null);
        assert.strictEqual(back.scrollY, y, 'the board is where it was before the diagram filled it');

        // Expanded again, a point at another block brings the whole board back and goes there.
        await win.call('Big again.', 'board_view', { action: 'expand', block: 'd3' });
        await win.shownWhen('b1', 'd3 expanded again', (s) => s.expanded === 'd3');
        await win.say('And the first diagram?', async (turn) => turn.say('⟦board:d1:1⟧ This is where it starts.'));
        await win.shownWhen('b1', 'the board back, the mark on the sequence diagram', (s) => s.expanded === null && s.point?.target.block === 'd1' && onTarget(s.marks.pi));
        await win.shownWhen('b1', 'scrolled to d1', (s) => s.visible.includes('d1'));
        assert.deepStrictEqual(win.log.filter((line) => line.startsWith('Board point')), []);
    });
});

/** A long sequence diagram with the participant and message the user reported: step 4 is "ok (or GatekeeperException)". */
const SEQUENCE = [
    '```mermaid',
    'sequenceDiagram',
    '    participant C as client',
    '    participant G as ton-gatekeeper (HTTP)',
    '    participant S as ton-service',
    '    participant DB as store',
    '    C->>G: POST /check',
    '    G->>S: verify(token)',
    '    S->>DB: lookup(token)',
    '    S-->>G: ok (or GatekeeperException)',
    '    G-->>C: 200 OK',
    '    C->>G: GET /status',
    '    G->>S: status()',
    '    S-->>G: running',
    '    G-->>C: 200 running',
    '    C->>G: POST /logout',
    '    G->>S: revoke(token)',
    '    S->>DB: delete(token)',
    '    S-->>G: revoked',
    '    G-->>C: 204',
    '```',
].join('\n');

/** A class diagram wider than the text column, with the class the user reported. */
const CLASSES = [
    '```mermaid',
    'classDiagram',
    '    class CamaraNotificationProcessor {',
    '        +String topic',
    '        +process(event) void',
    '        +retry(count) bool',
    '    }',
    '    class NotificationSink { +send(msg) void }',
    '    class EventSource { +subscribe() void }',
    '    class RetryPolicy { +int maxAttempts }',
    '    class AuditLogger { +log(entry) void }',
    '    class MetricsExporter { +export() void }',
    '    class DeadLetterQueue { +park(event) void }',
    '    CamaraNotificationProcessor --> NotificationSink : sends',
    '    EventSource --> CamaraNotificationProcessor : feeds',
    '    CamaraNotificationProcessor --> RetryPolicy : uses',
    '    CamaraNotificationProcessor --> AuditLogger : logs',
    '    CamaraNotificationProcessor --> MetricsExporter : counts',
    '    CamaraNotificationProcessor --> DeadLetterQueue : parks',
    '```',
].join('\n');

suite('Blackboard: marks sit on their targets in the real webview', function () {
    this.timeout(300_000);
    let sessionDir: string;
    let win: VoiceWindow;
    /** What the user reported, and one class: each with the marker text and the target the page finds. */
    const targets: { name: string; target: BoardTarget; found: string }[] = [
        { name: 'the participant', target: { block: 'd1', text: 'ton-gatekeeper (HTTP)' }, found: 'node' },
        { name: 'message 4', target: { block: 'd1', text: 'ok (or GatekeeperException)' }, found: 'message' },
        { name: 'the class', target: { block: 'd2', text: 'CamaraNotificationProcessor' }, found: 'node' },
    ];

    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension('zhenguo.pi-fellow');
        assert.ok(extension);
        sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-board-marks-e2e-'));
        fakeLlm.reset();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.window.showTextDocument(appFile(), { viewColumn: vscode.ViewColumn.One });
        win = new VoiceWindow(new IdleWorker(), memento(), sessionDir, extension.extensionUri);
        // Text above, so the page scrolls down to the diagrams, and below, so it can scroll past them.
        const filler = (n: number) => 'A paragraph of text on the board.\n\n'.repeat(n);
        const written = await win.call('Draw it.', 'show_me', { title: 'Marks', markdown: `${filler(15)}${SEQUENCE}\n\n${filler(4)}${CLASSES}\n\n${filler(30)}The end.` });
        assert.ok(written.text.includes('d1 diagram sequenceDiagram') && written.text.includes('d2 diagram classDiagram'), written.text);
        // Room for the diagrams: the board opens in the code's group, the only one, so it fills the editor area.
        assert.match((await win.call('Make it big.', 'board_view', { action: 'maximize' })).text, /already fills the editor area/);
        assert.strictEqual(vscode.window.tabGroups.all.length, 1);
        await win.shownWhen('b1', 'the diagrams drawn', (s) => s.diagrams.length === 2);
    });

    suiteTeardown(async () => {
        await win?.call('Back.', 'board_view', { action: 'restore' });
        await win?.close();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        fs.rmSync(sessionDir, { recursive: true, force: true });
    });

    /**
     * Pi points at `target` (a marker), then the user clicks it: both marks must sit on it, and stay on
     * it after the page scrolls and, when the diagram pans, after the user drags it.
     */
    async function marksOn({ name, target, found }: (typeof targets)[number], where: string, canPan: boolean): Promise<void> {
        const what = `${name} (${where})`;
        await win.say(`Where is ${name}?`, async (turn) => turn.say(`⟦board:${target.block}#${target.text}⟧ Here.`));
        await win.shownWhen('b1', `Pi's mark on ${what}`, (s) => s.point?.target.text === target.text && s.point?.found === found && onTarget(s.marks.pi));
        await win.clickAt('b1', target);
        await win.shownWhen('b1', `the user's mark on ${what}`, (s) => {
            const mark = s.userMark;
            const named = found === 'message' ? mark?.message === target.text && mark?.step === 4 : mark?.node === target.text;
            return named && onTarget(s.marks.user) && onTarget(s.marks.pi);
        });
        if (canPan) {
            // A pan inside the diagram, which is no click: the marks move with the drawing.
            await win.clickAt('b1', target, { dx: -40, dy: -30 });
            await win.shownWhen('b1', `both marks on ${what}, panned`, (s) => onTarget(s.marks.user) && onTarget(s.marks.pi));
        }
    }

    for (const page of [1, 1.5, 0.75]) {
        for (const diagram of [1, 2.5]) {
            test(`normal view, board ${page * 100}%, diagrams ${diagram * 100}%: both marks on the participant, message 4 and the class, the page scrolled`, async () => {
                await win.toWebview('b1', { type: 'zoom', zoom: { page, blocks: diagram === 1 ? {} : { d1: diagram, d2: diagram } } });
                await win.shownWhen('b1', 'the zoom taken', (s) => s.zoom.page === page && (s.zoom.blocks.d1 ?? 1) === diagram);
                for (const target of targets) {
                    await marksOn(target, `board ${page * 100}%, diagram ${diagram * 100}%`, diagram > 1);
                    // The page scrolled: marks are in the document, so they stay on their content.
                    const before = (await win.boards.shown('b1'))!.scrollY;
                    const where = before > 0 ? 'up' : 'down';
                    await win.call('Scroll.', 'board_view', { action: 'scroll', where });
                    await win.shownWhen('b1', `both marks on ${target.name}, the page scrolled ${where}`, (s) => s.scrollY !== before && onTarget(s.marks.user) && onTarget(s.marks.pi));
                }
            });
        }
    }

    for (const page of [1, 1.5, 0.75]) {
        for (const diagram of [1, 2.5]) {
            test(`expanded, board ${page * 100}%, diagram ${diagram * 100}%: both marks on the participant, message 4 and the class`, async () => {
                await win.toWebview('b1', { type: 'zoom', zoom: { page, blocks: diagram === 1 ? {} : { d1: diagram, d2: diagram } } });
                await win.shownWhen('b1', 'the zoom taken', (s) => s.zoom.page === page && (s.zoom.blocks.d1 ?? 1) === diagram);
                for (const target of targets) {
                    await win.call('Big.', 'board_view', { action: 'expand', block: target.target.block });
                    await win.shownWhen('b1', `${target.target.block} expanded`, (s) => s.expanded === target.target.block);
                    await marksOn(target, `expanded, board ${page * 100}%, diagram ${diagram * 100}%`, diagram > 1);
                    await win.call('Back.', 'board_view', { action: 'collapse' });
                    // Back on the whole board, both marks on it there too.
                    await win.shownWhen('b1', `both marks on ${target.name}, collapsed`, (s) => s.expanded === null && onTarget(s.marks.user) && onTarget(s.marks.pi));
                }
            });
        }
    }
});
