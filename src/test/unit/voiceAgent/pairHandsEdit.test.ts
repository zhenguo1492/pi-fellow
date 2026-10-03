import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeChange {
    rangeOffset: number;
    rangeLength: number;
    text: string;
}

const vs = vi.hoisted(() => ({
    root: '',
    document: undefined as unknown,
    changeListeners: [] as ((e: { document: unknown; contentChanges: FakeChange[] }) => void)[],
}));

vi.mock('node:timers/promises', () => ({
    // Goes through the global setTimeout, which the fake timers control.
    setTimeout: (ms: number) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
    },
}));

vi.mock('vscode', () => {
    class Position {
        constructor(
            readonly line: number,
            readonly character: number,
        ) {}
    }
    class Range {
        readonly start: Position;
        readonly end: Position;
        constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
            this.start = typeof a === 'number' ? new Position(a, b as number) : a;
            this.end = typeof a === 'number' ? new Position(c!, d!) : (b as Position);
        }
    }
    class WorkspaceEdit {
        readonly replaced: { range: Range; text: string }[] = [];
        replace(_uri: unknown, range: Range, text: string): void {
            this.replaced.push({ range, text });
        }
    }
    return {
        Position,
        Range,
        WorkspaceEdit,
        EndOfLine: { LF: 1, CRLF: 2 },
        Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` }) },
        window: { onDidCloseTerminal: () => ({ dispose() {} }) },
        workspace: {
            get workspaceFolders() {
                return [{ uri: { scheme: 'file', fsPath: vs.root } }];
            },
            get textDocuments() {
                return [vs.document];
            },
            asRelativePath: (p: string) => p.slice(vs.root.length + 1),
            fs: { stat: async () => ({ type: 1 }) },
            openTextDocument: async () => vs.document,
            onDidChangeTextDocument: (listener: (typeof vs.changeListeners)[number]) => {
                vs.changeListeners.push(listener);
                return { dispose: () => vs.changeListeners.splice(vs.changeListeners.indexOf(listener), 1) };
            },
            applyEdit: async (edit: WorkspaceEdit) => {
                const doc = vs.document as FakeDocument;
                for (const { range, text } of edit.replaced) {
                    doc.change(doc.offsetAt(range.start), doc.offsetAt(range.end), text);
                }
                return true;
            },
        },
    };
});

import * as vscode from 'vscode';
import { PairHands } from '../../../voiceAgent/pairHands';

/** An open text document: a change tells the listeners before the edit's promise resolves, as VS Code does. */
class FakeDocument {
    isDirty = false;
    readonly eol = vscode.EndOfLine.LF;
    saves = 0;

    constructor(
        public text: string,
        readonly uri: vscode.Uri,
    ) {}

    getText(): string {
        return this.text;
    }

    positionAt(offset: number): vscode.Position {
        const lines = this.text.slice(0, offset).split('\n');
        return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
    }

    offsetAt(position: { line: number; character: number }): number {
        const lines = this.text.split('\n');
        let offset = 0;
        for (let i = 0; i < position.line; i++) {
            offset += lines[i].length + 1;
        }
        return offset + position.character;
    }

    change(start: number, end: number, text: string): void {
        this.text = this.text.slice(0, start) + text + this.text.slice(end);
        this.isDirty = true;
        for (const listener of [...vs.changeListeners]) {
            listener({ document: this, contentChanges: [{ rangeOffset: start, rangeLength: end - start, text }] });
        }
    }

    async save(): Promise<boolean> {
        this.saves++;
        this.isDirty = false;
        return true;
    }
}

let doc: FakeDocument;
let hands: PairHands;
/** The edits Pi typed with the editor, in order. */
let typed: string[];

function open(text: string): void {
    doc = new FakeDocument(text, vscode.Uri.file(path.join(vs.root, 'a.ts')));
    vs.document = doc;
}

beforeEach(async () => {
    vs.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pair-edit-')));
    await fs.writeFile(path.join(vs.root, 'a.ts'), '');
    vs.changeListeners = [];
    typed = [];
    const editor = {
        edit: async (build: (b: { delete(r: vscode.Range): void; insert(p: vscode.Position, text: string): void; replace(r: vscode.Range, text: string): void }) => void) => {
            build({
                delete: (r) => doc.change(doc.offsetAt(r.start), doc.offsetAt(r.end), ''),
                replace: (r, text) => doc.change(doc.offsetAt(r.start), doc.offsetAt(r.end), text),
                insert: (p, text) => {
                    typed.push(text);
                    doc.change(doc.offsetAt(p), doc.offsetAt(p), text);
                },
            });
            return true;
        },
    };
    const cursor = {
        following: true,
        write: async () => editor,
        writing: () => {},
        selfEdit: <T>(edit: Thenable<T>) => Promise.resolve(edit),
        onDidChangeFollowing: () => ({ dispose() {} }),
    };
    hands = new PairHands(vs.root, cursor as never, {} as never, {} as never);
    vi.useFakeTimers();
});

afterEach(async () => {
    vi.useRealTimers();
    hands.dispose();
    await fs.rm(vs.root, { recursive: true, force: true });
});

describe('PairHands.editFile', () => {
    it('returns before the typing, which goes on and saves the file when done', async () => {
        open('const a = 1;\n');
        const result = await hands.editFile({ path: 'a.ts', oldText: '1', newText: '4200' });
        expect(result).toMatch(/^Edit of a\.ts accepted: it becomes lines 1-1 and is being typed into the user's editor now, and saved when done\./);
        expect([doc.text === 'const a = 4200;\n', doc.saves]).toEqual([false, 0]);

        await vi.advanceTimersByTimeAsync(1000);
        expect([doc.text, doc.saves, typed]).toEqual(['const a = 4200;\n', 1, ['4', '2', '0', '0']]);
        expect(hands.takeLateResults()).toEqual([]);
    });

    it('places a second edit in the text the first leaves, types it after the first, and a save waits for both', async () => {
        open('a\nb\n');
        await hands.editFile({ path: 'a.ts', oldText: 'a', newText: 'alpha' });
        // "alpha" is not in the file yet: only in the text the first edit leaves.
        const second = await hands.editFile({ path: 'a.ts', oldText: 'alpha\nb', newText: 'alpha\nbeta' });
        expect(second).toMatch(/^Edit of a\.ts accepted: it becomes lines 1-2 and is typed into the user's editor after your earlier edits to this file/);

        const saved = hands.saveFiles('a.ts');
        await vi.advanceTimersByTimeAsync(2000);
        // Both saved the file themselves, so the save found nothing left to do.
        expect(await saved).toBe('a.ts had no unsaved changes.');
        expect([doc.text, doc.saves, typed.join('')]).toEqual(['alpha\nbeta\n', 2, 'alphaalpha\nbeta']);
        expect(hands.takeLateResults()).toEqual([]);
    });

    it('puts the rest in at once where it belongs when the user types, leaves the file unsaved, and says so later', async () => {
        open('start\nend\n');
        await hands.editFile({ path: 'a.ts', oldText: 'start', newText: 'abcdef' });
        await vi.advanceTimersByTimeAsync(40);
        // The user types before Pi's text: what Pi still has to type moves along.
        doc.change(0, 0, 'U');
        await vi.advanceTimersByTimeAsync(40);
        expect([doc.text, doc.saves]).toEqual(['Uabcdef\nend\n', 0]);
        expect(typed.length).toBeLessThan(6);
        expect(hands.takeLateResults()).toEqual([
            'edit_file on a.ts: Typed in, but not saved: the user changed the file while it was being typed, so saving it is left to them.',
        ]);
        expect(hands.takeLateResults()).toEqual([]);
    });

    it('reports a queued edit whose text the user changed before its turn, after returning success', async () => {
        open('one\ntwo\n');
        await hands.editFile({ path: 'a.ts', oldText: 'one', newText: 'ONE ONE ONE' });
        expect(await hands.editFile({ path: 'a.ts', oldText: 'two', newText: 'TWO' })).toMatch(/^Edit of a\.ts accepted/);
        const at = doc.text.indexOf('two');
        doc.change(at, at + 3, 'xyz');
        await vi.advanceTimersByTimeAsync(1000);
        expect(doc.text).toBe('ONE ONE ONE\nxyz\n');
        const late = hands.takeLateResults();
        expect(late).toHaveLength(2);
        expect(late[0]).toMatch(/^edit_file on a\.ts: Typed in, but not saved/);
        expect(late[1]).toMatch(/^edit_file on a\.ts: Not applied, because the file changed before it could be typed: .* Read the file again before going on\.$/);
    });

    it('finishTyping puts every accepted edit in at once, queued ones too', async () => {
        open('x\ny\n');
        await hands.editFile({ path: 'a.ts', oldText: 'x', newText: 'xxxxxxxxxx' });
        await hands.editFile({ path: 'a.ts', oldText: 'y', newText: 'yyyyyyyyyy' });
        hands.finishTyping();
        await vi.advanceTimersByTimeAsync(40);
        expect([doc.text, doc.saves]).toEqual(['xxxxxxxxxx\nyyyyyyyyyy\n', 2]);
        expect(typed.length).toBeLessThanOrEqual(3);
    });
});

describe('PairHands.previewEdit: typing while the model writes the call', () => {
    it('types the replacement as it streams, and the call adopts it with its final arguments', async () => {
        open('const a = 1;\n');
        const preview = hands.previewEdit({ path: 'a.ts', oldText: '1' });
        preview.update('42');
        await vi.waitFor(() => expect(doc.text).toBe('const a = 42;\n'));
        preview.update('42 + x');
        await vi.waitFor(() => expect(doc.text).toBe('const a = 42 + x;\n'));
        expect(doc.saves).toBe(0);

        expect(await preview.commit({ path: 'a.ts', oldText: '1', newText: '42 + x + y' })).toMatch(/^Edit of a\.ts accepted: it becomes lines 1-1 and is being typed/);
        await vi.advanceTimersByTimeAsync(1000);
        expect([doc.text, doc.saves, hands.takeLateResults()]).toEqual(['const a = 42 + x + y;\n', 1, []]);
    });

    it('undoes what it typed when the call is dropped, and when the final arguments differ', async () => {
        open('const a = 1;\n');
        const dropped = hands.previewEdit({ path: 'a.ts', oldText: '1' });
        dropped.update('42');
        await vi.waitFor(() => expect(doc.text).toBe('const a = 42;\n'));
        dropped.drop();
        await vi.waitFor(() => expect([doc.text, doc.isDirty]).toEqual(['const a = 1;\n', false]));

        const changed = hands.previewEdit({ path: 'a.ts', oldText: '1' });
        changed.update('42');
        await vi.waitFor(() => expect(doc.text).toBe('const a = 42;\n'));
        expect(await changed.commit({ path: 'a.ts', oldText: '1', newText: '7' })).toBeUndefined();
        await vi.waitFor(() => expect(doc.text).toBe('const a = 1;\n'));
        // The final arguments then run as an edit of their own, after the undo.
        await hands.editFile({ path: 'a.ts', oldText: '1', newText: '7' });
        await vi.advanceTimersByTimeAsync(1000);
        expect([doc.text, hands.takeLateResults()]).toEqual(['const a = 7;\n', []]);
    });

    it('places an edit_file that comes meanwhile in the text the preview leaves', async () => {
        open('one\ntwo\n');
        const preview = hands.previewEdit({ path: 'a.ts', oldText: 'one' });
        preview.update('ONE');
        await vi.waitFor(() => expect(doc.text).toBe('ONE\ntwo\n'));
        // "ONE!" is in neither the file nor the preview yet: the edit waits for the preview's call to say what it leaves.
        let settled = false;
        const next = hands.editFile({ path: 'a.ts', oldText: 'ONE!\ntwo', newText: 'ONE!\nTWO' });
        void next.then(
            () => (settled = true),
            () => (settled = true),
        );
        for (let i = 0; i < 5; i++) {
            await fs.realpath(vs.root);
        }
        expect(settled).toBe(false);
        expect(await preview.commit({ path: 'a.ts', oldText: 'one', newText: 'ONE!' })).toMatch(/^Edit of a\.ts accepted/);
        expect(await next).toMatch(/after your earlier edits to this file/);
        await vi.advanceTimersByTimeAsync(1000);
        expect([doc.text, hands.takeLateResults()]).toEqual(['ONE!\nTWO\n', []]);
    });
});
