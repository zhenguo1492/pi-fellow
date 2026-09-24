import * as vscode from 'vscode';
import type { SlashCommandListItem } from '../shared/protocol';
import type { PiRpcSessionManager } from './rpcSession';

export type PiChatSession = PiRpcSessionManager;

/** Built-in Pi slash commands (same set as terminal `pi`). */
export const PI_BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
    { name: 'login', description: 'Configure provider authentication' },
    { name: 'logout', description: 'Remove stored credentials' },
    { name: 'model', description: 'Select model' },
    { name: 'new', description: 'Start a new session' },
    { name: 'reload', description: 'Reload extensions, skills, packages' },
    { name: 'settings', description: 'Open Pi settings' },
    { name: 'compact', description: 'Compact session context' },
    { name: 'resume', description: 'Resume another session' },
    { name: 'session', description: 'Show session info' },
    { name: 'tree', description: 'Explore and navigate session branch tree' },
];

export async function listSlashCommandsForUi(
    sessionManager?: PiRpcSessionManager,
): Promise<SlashCommandListItem[]> {
    if (sessionManager) {
        return sessionManager.listSlashCommands();
    }
    return PI_BUILTIN_SLASH_COMMANDS.map((c) => ({
        invocation: `/${c.name}`,
        name: c.name,
        description: c.description,
        source: 'builtin' as const,
    }));
}

/**
 * Handle Pi built-in slash commands in VS Code (model picker, settings panel, etc.).
 * Extension commands (/mcp, /plan, …) are routed in slashCommandRouter.ts.
 */
export async function tryHandleBuiltinSlashCommand(
    manager: PiChatSession,
    text: string,
): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
        return false;
    }

    const space = trimmed.indexOf(' ');
    const command = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
    const args = space === -1 ? '' : trimmed.slice(space + 1).trim();

    const session = manager.session;
    if (!session) {
        vscode.window.showWarningMessage('Pi session is not ready yet.');
        return true;
    }

    switch (command) {
        case 'model':
            await manager.showModelPicker(args || undefined);
            return true;
        case 'new':
            await manager.newSession();
            vscode.window.showInformationMessage('New Pi session started.');
            return true;
        case 'reload':
            await manager.reloadPiAgentResources();
            vscode.window.showInformationMessage('Pi session reloaded.');
            return true;
        case 'settings':
            await vscode.commands.executeCommand('oh-my-pi-chater.openSettings');
            return true;
        case 'compact':
            await manager.compact(args || undefined);
            vscode.window.showInformationMessage('Session compacted.');
            return true;
        case 'resume':
            await runResumeFlow(manager);
            return true;
        case 'session': {
            const model = session.model;
            const name = session.sessionName ?? session.sessionId ?? 'current';
            const msg = model
                ? `Session: ${name}\nModel: ${model.provider}/${model.id}\nThinking: ${session.thinkingLevel ?? 'off'}`
                : `Session: ${name}`;
            vscode.window.showInformationMessage(msg, { modal: true });
            return true;
        }
        case 'tree':
            await manager.showSessionTree();
            return true;
        default:
            return false;
    }
}

/** Configure provider auth (chat /login and settings button). */
export async function runPiLoginFlow(manager?: PiChatSession): Promise<void> {
    const { runPiAuthLogin } = await import('./piAuthFlow');
    await runPiAuthLogin(manager);
}

export async function runPiLogoutFlow(manager?: PiChatSession): Promise<void> {
    const { runPiAuthLogout } = await import('./piAuthFlow');
    await runPiAuthLogout(manager);
}

async function runResumeFlow(_manager: PiChatSession): Promise<void> {
    await vscode.commands.executeCommand('oh-my-pi-chater.focusChat');
    await vscode.commands.executeCommand('oh-my-pi-chater.openSessionPanel');
}

export async function tryHandleBashPrefix(manager: PiChatSession, text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('!')) {
        return false;
    }
    const session = manager.session;
    if (!session) {
        return false;
    }
    const isExcluded = trimmed.startsWith('!!');
    const command = isExcluded ? trimmed.slice(2).trim() : trimmed.slice(1).trim();
    if (!command) {
        return false;
    }
    if (session.isBashRunning) {
        vscode.window.showWarningMessage('A bash command is already running. Press Escape to stop generation first.');
        return true;
    }
    try {
        await manager.runBash(command, isExcluded);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Bash failed: ${msg}`);
    }
    return true;
}
