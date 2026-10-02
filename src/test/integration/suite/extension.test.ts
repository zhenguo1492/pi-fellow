import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension', () => {
    test('extension is present', () => {
        const ext = vscode.extensions.getExtension('zhenguo.pi-fellow');
        assert.ok(ext, 'Extension should be installed');
    });

    test('commands are registered', async () => {
        // Commands are registered by activate(), which nothing has triggered yet in a fresh window.
        await vscode.extensions.getExtension('zhenguo.pi-fellow')!.activate();
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('oh-my-pi-chater.newChat'), 'newChat command should exist');
        assert.ok(commands.includes('oh-my-pi-chater.abort'), 'abort command should exist');
        assert.ok(commands.includes('oh-my-pi-chater.selectModel'), 'selectModel command should exist');
        assert.ok(commands.includes('oh-my-pi-chater.focusChat'), 'focusChat command should exist');
    });
});
