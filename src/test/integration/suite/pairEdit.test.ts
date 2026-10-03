/**
 * edit_file in a real VS Code (docs/voice-pair-agent-cursor.md §11): PairHands returns once the edit is
 * placed and types it into a real editor in the background, telling its own changes from the user's
 * by the document's change events.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentCursor } from '../../../voiceAgent/agentCursor';
import { PairHands } from '../../../voiceAgent/pairHands';

/** Polls until `probe` holds: the editor applies edits in another process, with no event per state to await. */
async function until(what: string, probe: () => boolean, timeoutMs = 20_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!probe()) {
        if (Date.now() > end) {
            throw new Error(`Timed out waiting for ${what}`);
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 20);
        await promise;
    }
}

suite('Pair editing: edit_file returns before typing', function () {
    this.timeout(60_000);
    let root: string;
    let cursor: AgentCursor;
    let hands: PairHands;

    suiteSetup(() => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'the tests run in the workspace runTest.ts makes');
        root = folder.uri.fsPath;
        cursor = new AgentCursor(root, () => vscode.window.activeTextEditor, () => {}, true);
        hands = new PairHands(root, cursor, {} as never, {} as never);
    });

    suiteTeardown(async () => {
        hands.dispose();
        cursor.dispose();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('types into the editor after returning, saves, and queues a second edit on the file behind the first', async () => {
        const file = path.join(root, 'src', 'typed.ts');
        fs.writeFileSync(file, 'const a = 1;\n');
        const accepted = await hands.editFile({ path: 'src/typed.ts', oldText: '1', newText: '"hello world"' });
        assert.match(accepted, /^Edit of src\/typed\.ts accepted: it becomes lines 1-1 and is being typed into the user's editor now, and saved when done\./);
        assert.notStrictEqual(fs.readFileSync(file, 'utf8'), 'const a = "hello world";\n', 'not typed and saved yet');

        // Placed in the text the first edit leaves, before that is typed.
        await hands.editFile({ path: 'src/typed.ts', oldText: '"hello world";', newText: '"hello world"; // done' });
        // A save waits for both: each saved the file itself.
        assert.strictEqual(await hands.saveFiles('src/typed.ts'), 'src/typed.ts had no unsaved changes.');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'const a = "hello world"; // done\n');
        assert.deepStrictEqual(hands.takeLateResults(), []);
    });

    test('the user changing the file mid-way: the rest goes in at once where it belongs, and the file is left unsaved', async () => {
        const file = path.join(root, 'src', 'interrupted.ts');
        fs.writeFileSync(file, 'start\nend\n');
        await hands.editFile({ path: 'src/interrupted.ts', oldText: 'start', newText: 'abcdefghijklmnopqrstuvwxyz' });
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await until('typing to start', () => doc.getText().startsWith('ab'));
        const userEdit = new vscode.WorkspaceEdit();
        userEdit.insert(doc.uri, new vscode.Position(0, 0), 'U');
        assert.ok(await vscode.workspace.applyEdit(userEdit));

        await until('the rest at once', () => doc.getText() === 'Uabcdefghijklmnopqrstuvwxyz\nend\n');
        let late: string[] = [];
        await until('the late result', () => (late = hands.takeLateResults()).length > 0);
        assert.deepStrictEqual(late, ['edit_file on src/interrupted.ts: Typed in, but not saved: the user changed the file while it was being typed, so saving it is left to them.']);
        assert.ok(doc.isDirty);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'start\nend\n');
    });

    test('a call typed while the model writes it: adopted with its final arguments, or undone and saved back when dropped', async () => {
        // The test before typed over Pi, which stops following a moment later: follow again after that.
        await until('Pi unfollowed after the user typed', () => !cursor.following);
        cursor.setFollowing(true);
        const file = path.join(root, 'src', 'streamed.ts');
        fs.writeFileSync(file, 'const a = 1;\n');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));

        const kept = hands.previewEdit({ path: 'src/streamed.ts', oldText: '1' });
        kept.update('compute(');
        await until('the start typed', () => doc.getText() === 'const a = compute(;\n');
        kept.update('compute(2');
        assert.match((await kept.commit({ path: 'src/streamed.ts', oldText: '1', newText: 'compute(2)' })) ?? '', /^Edit of src\/streamed\.ts accepted/);
        await until('typed and saved', () => fs.readFileSync(file, 'utf8') === 'const a = compute(2);\n');

        const dropped = hands.previewEdit({ path: 'src/streamed.ts', oldText: 'compute(2)' });
        dropped.update('other');
        await until('the other typed', () => doc.getText() === 'const a = other;\n');
        dropped.drop();
        await until('undone and saved back', () => doc.getText() === 'const a = compute(2);\n' && !doc.isDirty);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'const a = compute(2);\n');
        assert.deepStrictEqual(hands.takeLateResults(), []);
    });
});
