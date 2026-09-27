/**
 * @license MIT
 * Oh My Pi Chater — Copyright (c) 2026 guo.zheng
 *
 * Derived from vscode-pi-agent (https://github.com/FChatin/vs-pi-agent),
 * Copyright (c) 2026 FChatin, released under the MIT License.
 * The original copyright and permission notice are retained in LICENSE.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { PiRpcSessionManager } from './pi/rpcSession';
import type { PiChatSession } from './pi/slashCommands';
import type { TuiAuthCommand } from './shared/protocol';
import { SidebarProvider } from './providers/sidebar';
import { ModelStatusTracker } from './providers/model-status';
import { SettingsPanel } from './providers/settings-panel';
import { clearExtensionApiKeySecrets, getPiAgentDir, isSyncWithPiCli } from './pi/piCliSync';
import { verifyPiCliAvailable, resolvePiCliInvocation, initWindowBackend, getAvailableBackends } from './pi/piCliPaths';
import { canLoadPiNativeModules } from './pi/piExtensionCompat';
import { probeStt, probeTts } from './voice/voiceSettings';
import { maybePromptForRecommendedPackages } from './pi/recommendedPackagesPrompt';
import { setPiExtensionPath } from './pi/extensionPath';

import { DiffManager, DiffContentProvider } from './providers/diff';
import { CheckpointManager } from './providers/checkpoint';
import { PlanDocumentProvider } from './providers/plan-document';
import { createBootErrorWebviewProvider, createCliMissingWebviewProvider } from './providers/boot-error-webview';
import { rebuildAgentNativeModules } from './pi/piExtensionCompat';
import { registerAttachFromExplorer } from './pi/attachFromExplorer';
import { pastedAttachmentsDir } from './pi/pastedAttachmentStore';
import { registerWorkerControlCommands } from './voiceAgent/workerControlCommands';
import { registerVoiceAgentCommands } from './voiceAgent/voiceAgentCommands';

let piSession: PiChatSession | undefined;
let sidebarProviderForShutdown: SidebarProvider | undefined;

function registerBootErrorSidebar(
    context: vscode.ExtensionContext,
    message: string,
): void {
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'oh-my-pi-chater.chat',
            createBootErrorWebviewProvider(message),
        ),
    );
}

/** Neither CLI installed: point the user at an installer, then reload so activation runs again. */
async function promptInstallCli(): Promise<void> {
    const installOmp = 'Install omp';
    const installPi = 'Install pi';
    const reload = 'Reload Window';
    const pick = await vscode.window.showWarningMessage(
        'Oh My Pi Chater needs the omp or pi CLI. Install one, then reload the window.',
        installOmp,
        installPi,
        reload,
    );
    if (pick === installOmp) {
        void vscode.env.openExternal(vscode.Uri.parse('https://omp.sh'));
    } else if (pick === installPi) {
        void vscode.env.openExternal(vscode.Uri.parse('https://www.npmjs.com/package/@earendil-works/pi-coding-agent'));
    } else if (pick === reload) {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

/** pi only: its memory/search tools need better-sqlite3 built for the pi CLI's Node. Reports; never blocks startup. */
async function checkPiNativeModules(outputChannel: vscode.OutputChannel): Promise<void> {
    try {
        const invocation = await resolvePiCliInvocation();
        const npmDir = path.join(getPiAgentDir(), 'npm');
        if (invocation.backend === 'pi' && !(await canLoadPiNativeModules(invocation, npmDir))) {
            outputChannel.appendLine(
                'WARNING: better-sqlite3 failed to load under pi Node. Memory/search tools may fail. Run "Oh My Pi Chater: Rebuild Pi native modules".',
            );
            void vscode.window.showWarningMessage(
                'Pi memory/search native modules are not loading under your global pi Node. Run "Oh My Pi Chater: Rebuild Pi native modules" or reload after fixing pi Node.',
            );
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Pi native module preflight skipped: ${msg}`);
    }
}

/** With CLI sync on, the agent dir's auth file is the only key store: drop the extension's own copies. */
async function clearExtensionOnlyKeys(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): Promise<void> {
    if (!isSyncWithPiCli()) {
        return;
    }
    try {
        const cleared = await clearExtensionApiKeySecrets(context.secrets);
        outputChannel.appendLine(
            `Pi CLI sync enabled. Agent dir: ${getPiAgentDir()}${cleared > 0 ? ` (removed ${cleared} extension-only API key(s))` : ''}`,
        );
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Clearing extension-only API keys failed: ${msg}`);
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel('Oh My Pi Chater');
    outputChannel.appendLine('Oh My Pi Chater extension activating...');
    setPiExtensionPath(context.extensionPath);
    context.subscriptions.push(initWindowBackend(context.workspaceState));

    if (getAvailableBackends().length === 0) {
        outputChannel.appendLine('Agent CLI not found: neither omp nor pi is installed (PATH, common install dirs, oh-my-pi-chater.cliPath).');
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('oh-my-pi-chater.chat', createCliMissingWebviewProvider()),
        );
        void promptInstallCli();
        return;
    }

    // Activation never waits on the agent CLI: the sidebar is registered at once and each tab shows its
    // worker starting (SidebarTabs.watchStartup). These checks run alongside and only report.
    void verifyPiCliAvailable(outputChannel);
    void checkPiNativeModules(outputChannel);
    void clearExtensionOnlyKeys(context, outputChannel);

    try {
        const session = new PiRpcSessionManager(outputChannel);
        piSession = session;
        // A startup failure is reported on the tab that owns the session.
        session.initialize().catch(() => undefined);
        outputChannel.appendLine(
            'Backend: agent CLI RPC only (`--mode rpc`) — same packages/skills/extensions as terminal.',
        );

        void session.waitUntilReady().then(
            () => maybePromptForRecommendedPackages(context, session, outputChannel),
            () => undefined,
        );

        const diffContentProvider = new DiffContentProvider();
        const planDocumentProvider = new PlanDocumentProvider();
        const checkpointManager = new CheckpointManager();
        const modelStatus = new ModelStatusTracker(session);

        const diffManager = new DiffManager(session, checkpointManager);
        const sidebarProvider = new SidebarProvider(
            context.extensionUri,
            session,
            diffManager,
            checkpointManager,
            outputChannel,
            planDocumentProvider,
            // savePastedFile creates it on first paste.
            pastedAttachmentsDir(context.globalStorageUri.fsPath),
            context.workspaceState,
            modelStatus,
        );
        if (sidebarProvider.activeSession) {
            modelStatus.setSession(sidebarProvider.activeSession);
        }
        sidebarProviderForShutdown = sidebarProvider;

        registerAttachFromExplorer(context, () => sidebarProvider);
        context.subscriptions.push(
            ...registerWorkerControlCommands(sidebarProvider, outputChannel),
            ...registerVoiceAgentCommands(context, { worker: sidebarProvider, chat: sidebarProvider, resumeList: sidebarProvider }),
        );
        // After the voice agent's history is in: a tab the user only talked to it about comes back under its voice name.
        // Not awaited: the tabs appear at once and load side by side; prompts wait for their tab (tabReady).
        void sidebarProvider.restorePersistedTabs();

        context.subscriptions.push(
            // Retained so switching to another view container keeps the terminals (TUI mode) and chat DOM.
            vscode.window.registerWebviewViewProvider('oh-my-pi-chater.chat', sidebarProvider, {
                webviewOptions: { retainContextWhenHidden: true },
            }),
            vscode.workspace.registerTextDocumentContentProvider('pi-diff', diffContentProvider),
            vscode.workspace.registerTextDocumentContentProvider('pi-plan', planDocumentProvider),
            modelStatus,

            diffManager,
            checkpointManager,
            outputChannel,

            vscode.commands.registerCommand('oh-my-pi-chater.newChat', async () => {
                const session = sidebarProvider.activeSession ?? piSession;
                await session?.newSession();
                await sidebarProvider.pushStateSync();
                sidebarProvider.postModelFooter();
                modelStatus.refresh();
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.abort', async () => {
                await sidebarProvider.abortActiveTab();
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.selectModel', async () => {
                const session = sidebarProvider.activeSession ?? piSession;
                await session?.showModelPicker();
                sidebarProvider.sendStateSync();
                modelStatus.refresh();
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.toggleThinking', async () => {
                const session = sidebarProvider.activeSession ?? piSession;
                const level = session?.cycleThinkingLevel();
                if (level) {
                    vscode.window.showInformationMessage(`Thinking level: ${level}`);
                }
                sidebarProvider.sendStateSync();
                modelStatus.refresh();
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.focusChat', () => {
                vscode.commands.executeCommand('oh-my-pi-chater.chat.focus');
            }),

            sidebarProvider.voiceInput,
            vscode.commands.registerCommand('oh-my-pi-chater.toggleDictation', async () => {
                if (!sidebarProvider.voiceInput.isRecording) {
                    // Transcripts land in the chat composer, so bring it up first.
                    await vscode.commands.executeCommand('oh-my-pi-chater.chat.focus');
                }
                await sidebarProvider.toggleDictation();
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.openSessionPanel', () => {
                void sidebarProvider.openSessionPanel();
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.openSessionTree', () => {
                void sidebarProvider.openSessionTree();
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.openSettings', () => {
                SettingsPanel.show(
                    context.extensionUri,
                    context.secrets,
                    piSession,
                    context.extension.packageJSON.version,
                    outputChannel,
                );
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.openMcpSettings', () => {
                SettingsPanel.showWithSection('mcp');
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.browsePackages', async () => {
                const { showPiPackageCatalogPicker } = await import('./pi/piPackageCatalogPicker');
                await showPiPackageCatalogPicker(piSession, outputChannel);
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.login', async () => {
                if (!piSession) return;
                const { runPiLoginFlow } = await import('./pi/slashCommands');
                await runPiLoginFlow(piSession);
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.logout', async () => {
                if (!piSession) return;
                const { runPiLogoutFlow } = await import('./pi/slashCommands');
                await runPiLogoutFlow(piSession);
            }),

            // Internal: omp /login and /logout finish in the chat's TUI mode (see piAuthFlow).
            vscode.commands.registerCommand('oh-my-pi-chater.promptTuiAuth', (command: TuiAuthCommand) =>
                sidebarProvider.promptTuiAuth(command),
            ),

            vscode.commands.registerCommand('oh-my-pi-chater.reloadSession', async () => {
                if (!piSession) return;
                await piSession.reloadPiAgentResources();
                sidebarProvider.sendStateSync();
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.installRecommendedPackages', async () => {
                if (!piSession) return;
                const { runRecommendedPackagesSetup } = await import('./pi/recommendedPackagesPrompt');
                await runRecommendedPackagesSetup(piSession, outputChannel);
            }),

            vscode.commands.registerCommand('oh-my-pi-chater.rebuildNativeModules', async () => {
                await rebuildAgentNativeModules(outputChannel);
                if (piSession) {
                    await piSession.reloadPiAgentResources();
                }
                sidebarProvider.sendStateSync();
            }),
        );

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('oh-my-pi-chater.voice.sttUrl')) {
                    // A changed URL invalidates its previous verification; re-check the new one.
                    void probeStt();
                }
                if (e.affectsConfiguration('oh-my-pi-chater.voiceAgent.tts')) {
                    void probeTts();
                }
            }),
        );
        // The mic needs a verified STT server, the voice agent STT and TTS; check the configured ones at startup.
        void probeStt();
        void probeTts();

        outputChannel.appendLine('Oh My Pi Chater extension activated.');
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        outputChannel.appendLine(`Failed to activate: ${msg}`);
        vscode.window.showErrorMessage(`Oh My Pi Chater failed to activate: ${msg}`);
        registerBootErrorSidebar(context, msg);
    }
}

export async function deactivate() {
    await sidebarProviderForShutdown?.flushPersistedTabs();
    await sidebarProviderForShutdown?.disposeTui();
    await sidebarProviderForShutdown?.disposePrewarmedSession();
    await piSession?.dispose();
    await PiRpcSessionManager.disposeGlobal();
}
