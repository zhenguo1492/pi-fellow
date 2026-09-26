import * as vscode from 'vscode';
import { runPiAuthLogin, runPiAuthLogout } from './piAuthFlow';
import type { PiChatSession } from './slashCommands';
import { tryHandleBuiltinSlashCommand } from './slashCommands';
import type { PiRpcSessionManager } from './rpcSession';

/** Handled in VS Code only — must never be sent to Pi RPC as a prompt. */
const VSCODE_ONLY_SLASH = new Set(['login', 'logout', 'test-error']);

export function isSlashOnlyInput(text: string): boolean {
    return text.trim().startsWith('/');
}

export function isVscodeOnlySlash(text: string): boolean {
    if (!isSlashOnlyInput(text)) {
        return false;
    }
    return VSCODE_ONLY_SLASH.has(parseSlash(text.trim()).command);
}

export type SettingsFocusSection =
    | 'mcp'
    | 'packages'
    | 'auth'
    | 'defaults'
    | 'skills'
    | 'extensions'
    | 'commands'
    | 'stt'
    | 'tts'
    | 'voice';

/** Slash commands that need a VS Code panel instead of Pi TUI (RPC has no terminal UI). */
const GUI_SLASH: Record<string, SettingsFocusSection | 'settings' | 'sessions' | 'fork'> = {
    mcp: 'mcp',
    config: 'packages',
    packages: 'packages',
    settings: 'settings',
    fork: 'fork',
    'setup-custom-providers': 'defaults',
    profile: 'defaults',
    stt: 'stt',
    tts: 'tts',
    voice: 'voice',
};

function parseSlash(text: string): { command: string; args: string } {
    const trimmed = text.trim();
    const space = trimmed.indexOf(' ');
    const command = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
    const args = space === -1 ? '' : trimmed.slice(space + 1).trim();
    return { command, args };
}

async function openSettingsSection(section: SettingsFocusSection | 'settings'): Promise<void> {
    const { SettingsPanel } = await import('../providers/settings-panel');
    if (section === 'settings') {
        await vscode.commands.executeCommand('oh-my-pi-chater.openSettings');
        return;
    }
    SettingsPanel.showWithSection(section);
}

/**
 * Route slash input: GUI actions, VS Code builtins, then Pi CLI via RPC prompt.
 * Returns true when the line was handled (do not send to the model as plain text).
 */
export async function tryHandleSlashCommand(manager: PiChatSession, text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
        return false;
    }

    const { command, args } = parseSlash(trimmed);

    if (VSCODE_ONLY_SLASH.has(command)) {
        if (command === 'login') {
            await runPiAuthLogin(manager);
        } else if (command === 'logout') {
            await runPiAuthLogout(manager);
        } else if (command === 'test-error') {
            runTestError(manager, args);
        }
        return true;
    }

    const gui = GUI_SLASH[command];
    if (gui) {
        if (gui === 'settings') {
            await vscode.commands.executeCommand('oh-my-pi-chater.openSettings');
            return true;
        }
        if (gui === 'fork') {
            await manager.showForkPicker();
            return true;
        }
        await openSettingsSection(gui);
        vscode.window.setStatusBarMessage(`Oh My Pi Chater: /${command} → settings`, 3000);
        return true;
    }

    if (command === 'tree') {
        await manager.showSessionTree();
        return true;
    }

    if (await tryHandleBuiltinSlashCommand(manager, trimmed)) {
        return true;
    }

    // Extension / skill / prompt-template commands — same as typing in pi terminal
    await runCliSlashCommand(manager, trimmed);
    return true;
}

function runTestError(manager: PiChatSession, args: string): void {
    const rpc = manager as PiRpcSessionManager;
    const msg =
        args.trim() ||
        'WriteIterableClosedError: WritableIterable is closed (test)';
    rpc.postChatError(msg);
    rpc.postChatError(
        'Pi RPC process exited (code=7, signal=null). Stderr: … (test #2)',
    );
}

/** Send slash to Pi RPC and wait for the CLI to finish handling it. */
export async function runCliSlashCommand(manager: PiChatSession, text: string): Promise<void> {
    if (isVscodeOnlySlash(text)) {
        await tryHandleSlashCommand(manager, text);
        return;
    }
    const rpc = manager as PiRpcSessionManager;
    if (typeof rpc.runCliSlashCommand === 'function') {
        await rpc.runCliSlashCommand(text);
        return;
    }
    await manager.submitInput(text, { mode: 'prompt' });
}
