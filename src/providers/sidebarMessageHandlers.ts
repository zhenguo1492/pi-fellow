import * as vscode from 'vscode';
import { updatePiDefaults } from '../pi/piAgentConfig';
import { DEFAULT_CONVERSATION_TITLE } from '../shared/conversationTitle';
import type { ClientMessage } from '../shared/protocol';
import type { ExtensionUiAnswerer } from '../shared/extensionUi';
import type { SidebarHost } from './sidebarHost';
import { openPlanDocument, type PlanDocumentProvider } from './plan-document';
import { SettingsPanel } from './settings-panel';
import { idleConnection, resetStreamingMessage, startTurn, tabReady, turnCutoffIndex, type TabState } from './sidebarTabState';
import { applyTabPermission } from './sidebarPermission';

export type ClientMessageOf<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;

/** Handles one webview message for the tab that was active when it arrived; errors post an `error` message. */
export type MessageHandler<T extends ClientMessage['type']> = (msg: ClientMessageOf<T>, tab: TabState) => Promise<void> | void;

/** The sidebar's webview messages by type; a type without a handler is ignored. */
export type MessageHandlers = { [T in ClientMessage['type']]?: MessageHandler<T> };

/** The active tab's model, session, file changes and checkpoints, plan mode, and dialogs. */
export function conversationHandlers(
    host: SidebarHost,
    planDocument: PlanDocumentProvider,
    /** The dialog cards of tabs showing their TUI: their answers are typed into it, not sent over RPC. */
    tuiDialogs: ExtensionUiAnswerer & { owns(id: string): boolean },
): MessageHandlers {
    return {
        selectModel: async () => {
            await vscode.commands.executeCommand('oh-my-pi-chater.selectModel');
        },
        getContextBreakdown: async (_msg, tab) => {
            // Always answered, even after a tab switch: the webview has one request in flight at a time
            // and refetches when the status line's context changes.
            const reply = await tab.session.getContextBreakdown().then(
                (breakdown) => ({ breakdown }),
                (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
            );
            host.post({ type: 'contextBreakdown', ...reply });
        },
        getModels: (_msg, tab) => {
            host.postModelFooter(tab);
        },
        setModel: async (msg, tab) => {
            await tab.session.setModel(msg.provider, msg.modelId);
            // Persist as the pi/omp CLI default so new conversations start on this model.
            const backend = tab.session.backend;
            try {
                await updatePiDefaults({ provider: msg.provider, model: msg.modelId }, undefined, backend);
            } catch (err: unknown) {
                const detail = err instanceof Error ? err.message : String(err);
                host.outputChannel.appendLine(`Failed to save default model: ${detail}`);
            }
            host.sendStateSync();
        },
        setThinkingLevel: (msg, tab) => {
            tab.session.setThinkingLevel(msg.level);
            host.sendStateSync();
        },
        newSession: async (_msg, tab) => {
            await tab.session.newSession();
            tab.diffManager.clearAll();
            tab.checkpointManager.clearAll();
            tab.turnCounter = 0;
            tab.suspendedMessages = [];
            tab.name = DEFAULT_CONVERSATION_TITLE;
            tab.isStreaming = false;
            resetStreamingMessage(tab);
            tab.agentStartTime = 0;
            tab.messageMeta.clear();
            tab.voiceOrigins.resetSession();
            tab.queuedMessages = [];
            tab.pendingAttachments = [];
            tab.lastPlanEditorHash = '';
            tab.connectionStatus = idleConnection();
            await host.pushStateSync();
            host.postModelFooter(tab);
        },
        getState: () => {
            host.sendStateSync();
        },
        getSlashCommands: async (_msg, tab) => {
            // The chat asks as soon as it loads, which can be before the tab's worker is up. A worker that
            // failed to start has none; its tab already shows the failure.
            try {
                await tabReady(tab);
            } catch {
                return;
            }
            const commands = await tab.session.listSlashCommands();
            host.post({ type: 'slashCommands', commands });
        },
        getSkills: (_msg, tab) => {
            const skills = tab.session.getSkills();
            host.post({ type: 'skills', skills });
        },
        openDiff: async (msg, tab) => {
            if (await tab.diffManager.openDiff(msg.filePath, msg.toolCallId)) {
                host.sendStateSync();
            }
        },
        acceptFileChanges: (_msg, tab) => {
            tab.diffManager.acceptAll();
            host.sendStateSync();
        },
        undoFileChange: async (msg, tab) => {
            await tab.diffManager.undoFileChange(msg.filePath, msg.toolCallId);
            host.sendStateSync();
        },
        restoreCheckpoint: async (msg, tab) => {
            const restored = await tab.checkpointManager.restoreCheckpoint(msg.messageIndex);
            tab.diffManager.suspendChangesAfter(msg.messageIndex);

            const allMsgs = tab.session.getMessages();
            const cutoff = turnCutoffIndex(allMsgs, msg.messageIndex);
            if (cutoff >= 0 && cutoff < allMsgs.length) {
                tab.suspendedMessages = allMsgs.slice(cutoff);
                tab.session.setMessages(allMsgs.slice(0, cutoff));
            }

            if (restored.length > 0) {
                vscode.window.showInformationMessage(
                    `Restored ${restored.length} file(s) to checkpoint.`
                );
            }
            host.sendStateSync();
        },
        redoCheckpoint: async (_msg, tab) => {
            const redone = await tab.checkpointManager.redoCheckpoint();
            tab.diffManager.redoChanges();

            if (tab.suspendedMessages.length > 0) {
                const current = tab.session.getMessages();
                tab.session.setMessages([...current, ...tab.suspendedMessages]);
                tab.suspendedMessages = [];
            }

            if (redone.length > 0) {
                vscode.window.showInformationMessage(
                    `Re-applied ${redone.length} file(s).`
                );
            }
            host.sendStateSync();
        },
        confirmAction: async (msg) => {
            const answer = await vscode.window.showWarningMessage(
                msg.message,
                { modal: true },
                'Yes',
            );
            host.post({
                type: 'confirmResult',
                action: msg.action,
                confirmed: answer === 'Yes',
                payload: msg.payload,
            });
        },
        openSettings: (msg) => {
            if (msg.section) {
                SettingsPanel.showWithSection(msg.section);
            } else {
                vscode.commands.executeCommand('oh-my-pi-chater.openSettings');
            }
        },
        implementPlan: async (_msg, tab) => {
            // Implementing leaves Plan: the tab's Manual / Edit automatically / Auto mode applies to the implementation.
            if (tab.readOnlyPlan) {
                tab.readOnlyPlan = false;
                applyTabPermission(tab);
            }
            startTurn(tab);
            tab.isStreaming = true;
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.agentStartTime = Date.now();
            if (tab.id === host.activeTabId) {
                host.sendStateSync();
            }
            try {
                await tab.session.implementPlan();
            } catch (err) {
                tab.isStreaming = false;
                if (tab.id === host.activeTabId) {
                    host.sendStateSync();
                }
                throw err;
            }
            host.sendStateSync();
        },
        openPlanDocument: async (_msg, tab) => {
            await openPlanDocument(
                planDocument,
                tab.session.session?.sessionId,
            );
        },
        extensionUiResponse: (msg, tab) => {
            // One card UI, two answer paths: typed into a TUI, or back over the tab's RPC.
            const answerer: ExtensionUiAnswerer = tuiDialogs.owns(msg.id) ? tuiDialogs : tab.session.rpcExtensionUi;
            answerer.respond({ id: msg.id, cancelled: msg.cancelled, value: msg.value, confirmed: msg.confirmed });
        },
    };
}
