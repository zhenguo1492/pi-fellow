import { composePrompt } from '../pi/fileAttachments';
import type { PendingAttachment } from '../pi/pendingAttachments';
import { isSlashOnlyInput, isVscodeOnlySlash, tryHandleSlashCommand } from '../pi/slashCommandRouter';
import type { SidebarAttachments } from './sidebarAttachments';
import type { SidebarHost } from './sidebarHost';
import type { MessageHandlers } from './sidebarMessageHandlers';
import { updateTabName } from './sidebarTabs';
import { idleConnection, resetStreamingMessage, startTurn, tabReady, type TabState } from './sidebarTabState';

/** What the tabs send their workers: new turns, slash commands, steering, the send queue and its drain, and abort. */
export class SidebarPromptQueue {
    constructor(
        private readonly _host: SidebarHost,
        private readonly _attachments: SidebarAttachments,
    ) {}

    /** Start a new worker turn: composer send and voice `send` on an idle worker. */
    async beginPrompt(
        tab: TabState,
        text: string,
        attachments: PendingAttachment[],
        fromVoice = false,
    ): Promise<void> {
        startTurn(tab);
        tab.isStreaming = true;
        if (tab.id === this._host.activeTabId) {
            this._host.sendStateSync();
        }
        try {
            await this._dispatchPrompt(tab, text, attachments, fromVoice);
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            tab.connectionStatus = { phase: 'failed', message: errMsg };
            throw err;
        }
        void this._host.pushStateSync();
    }

    private async _tryHandleSlashOnlyPrompt(
        tab: TabState,
        text: string,
        attachments: PendingAttachment[],
    ): Promise<boolean> {
        const trimmed = text.trim();
        // /login, /logout, /test-error must never reach Pi RPC or the model, even with attachments.
        if (isVscodeOnlySlash(trimmed)) {
            await tryHandleSlashCommand(tab.session, trimmed);
            return true;
        }
        if (!isSlashOnlyInput(trimmed) || attachments.length > 0) {
            return false;
        }
        await tryHandleSlashCommand(tab.session, trimmed);
        return true;
    }

    private async _dispatchPrompt(
        tab: TabState,
        userText: string,
        attachments: PendingAttachment[],
        fromVoice = false,
    ): Promise<void> {
        const { text, images } = composePrompt(userText, attachments);
        if (!text && images.length === 0) {
            return;
        }
        if (updateTabName(tab, userText || text) && tab.id === this._host.activeTabId) {
            this._host.sendStateSync();
        }
        if (fromVoice) {
            tab.voiceOrigins.expect(text);
        }
        try {
            await tab.session.prompt(text, images.length > 0 ? images : undefined);
        } catch (err: unknown) {
            if (fromVoice) {
                tab.voiceOrigins.cancel(text);
            }
            throw err;
        }
    }

    /** Drain queue when tab and Pi session are both idle (covers missed agent_end / stale UI). */
    maybeDrainQueuedMessages(tab: TabState, isActive: boolean): void {
        if (tab.suppressQueueDrain || tab.queueDrainInFlight || tab.isStreaming) {
            return;
        }
        if (tab.session.session?.isStreaming) {
            return;
        }
        if (tab.queuedMessages.length === 0) {
            return;
        }
        tab.queueDrainInFlight = true;
        void this._runNextQueuedPrompt(tab, isActive).finally(() => {
            tab.queueDrainInFlight = false;
        });
    }

    uiIsStreaming(tab: TabState): boolean {
        if (tab.abortInFlight) {
            return false;
        }
        return (
            tab.isStreaming ||
            (tab.session.session?.isStreaming ?? false) ||
            tab.connectionStatus.phase === 'retrying' ||
            (tab.session.session?.isRetrying ?? false)
        );
    }

    private async _runNextQueuedPrompt(tab: TabState, isActive: boolean): Promise<void> {
        const item = tab.queuedMessages.shift();
        if (!item) {
            if (isActive) {
                this._host.sendStateSync();
            }
            return;
        }
        const { text, images } = composePrompt(item.text, item.attachments);
        if (!text && images.length === 0) {
            await this._runNextQueuedPrompt(tab, isActive);
            return;
        }
        try {
            if (await this._tryHandleSlashOnlyPrompt(tab, item.text, item.attachments)) {
                if (isActive) {
                    this._host.sendStateSync();
                }
                await this._runNextQueuedPrompt(tab, isActive);
                return;
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._host.outputChannel.appendLine(`Queued slash command failed: ${msg}`);
            if (isActive) {
                this._host.post({ type: 'error', message: msg });
            }
            await this._runNextQueuedPrompt(tab, isActive);
            return;
        }

        updateTabName(tab, item.text || text);
        startTurn(tab);
        tab.isStreaming = true;
        if (isActive) {
            this._host.sendStateSync();
        }
        if (item.fromVoice) {
            tab.voiceOrigins.expect(text);
        }
        try {
            await tab.session.prompt(text, images.length > 0 ? images : undefined);
        } catch (err: unknown) {
            if (item.fromVoice) {
                tab.voiceOrigins.cancel(text);
            }
            tab.isStreaming = false;
            tab.queuedMessages.unshift(item);
            const msg = err instanceof Error ? err.message : String(err);
            this._host.outputChannel.appendLine(`Queued prompt failed: ${msg}`);
            if (isActive) {
                this._host.post({ type: 'error', message: msg });
                this._host.sendStateSync();
            }
        } finally {
            if (!tab.session.session?.isStreaming && !tab.isStreaming) {
                this.maybeDrainQueuedMessages(tab, isActive);
            }
        }
    }

    /** Stop the tab's run (webview Stop / Esc, voice `abort`), then drain its queue unless that is suppressed. */
    async abortTab(tab: TabState): Promise<void> {
        tab.abortInFlight = true;
        tab.isStreaming = false;
        resetStreamingMessage(tab);
        tab.agentStartTime = 0;
        tab.connectionStatus = idleConnection();
        if (tab.session.session) {
            tab.session.session.isStreaming = false;
            tab.session.session.isRetrying = false;
        }
        if (tab.id === this._host.activeTabId) {
            this._host.sendStateSync();
        }

        try {
            await tab.session.abort();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._host.outputChannel.appendLine(`Abort: ${msg}`);
            if (tab.id === this._host.activeTabId) {
                this._host.post({ type: 'error', message: msg });
            }
        } finally {
            tab.abortInFlight = false;
            tab.isStreaming = false;
            if (tab.session.session) {
                tab.session.session.isStreaming = false;
                tab.session.session.isRetrying = false;
            }
            const isActive = tab.id === this._host.activeTabId;
            if (isActive) {
                this._host.sendStateSync();
            }
            if (!tab.suppressQueueDrain) {
                this.maybeDrainQueuedMessages(tab, isActive);
            }
        }
    }

    /** Wait for the tab's worker and restored conversation (`tabReady`); false, after telling the chat, when the worker failed to start. */
    private async _waitForTab(tab: TabState): Promise<boolean> {
        try {
            await tabReady(tab);
            return true;
        } catch {
            this._host.post({
                type: 'error',
                message: 'Pi agent is not ready yet. Wait for startup to finish or reload the window.',
            });
            return false;
        }
    }

    handlers(): MessageHandlers {
        return {
            slashCommand: async (msg, tab) => {
                if (!(await this._waitForTab(tab))) return;
                try {
                    await tryHandleSlashCommand(tab.session, msg.text.trim());
                    void this._host.pushStateSync();
                } catch (err: unknown) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this._host.post({ type: 'error', message: errMsg });
                    void this._host.pushStateSync();
                }
            },
            prompt: async (msg, tab) => {
                if (!(await this._waitForTab(tab))) return;
                const attachments = [...tab.pendingAttachments];
                tab.pendingAttachments = [];
                const trimmed = msg.text.trim();
                // Slash commands: handle locally, do not start a turn or send to the model.
                try {
                    if (await this._tryHandleSlashOnlyPrompt(tab, trimmed, attachments)) {
                        void this._host.pushStateSync();
                        return;
                    }
                } catch (err: unknown) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this._host.post({ type: 'error', message: errMsg });
                    void this._host.pushStateSync();
                    return;
                }
                attachments.push(...this._attachments.editorContextAttachments());
                await this.beginPrompt(tab, msg.text, attachments);
            },
            steer: async (msg, tab) => {
                const attachments = [...tab.pendingAttachments, ...this._attachments.editorContextAttachments()];
                tab.pendingAttachments = [];
                const { text, images } = composePrompt(msg.text, attachments);
                if (text || images.length > 0) {
                    tab.steeringMessages = [...tab.steeringMessages, text || '(attachments)'];
                    void this._host.pushStateSync();
                }
                await tab.session.steer(text, images.length > 0 ? images : undefined);
                void this._host.pushStateSync();
            },
            queueMessage: async (msg, tab) => {
                if (!(await this._waitForTab(tab))) return;
                const trimmed = msg.text.trim();
                const attachments = [...tab.pendingAttachments];
                tab.pendingAttachments = [];
                if (!trimmed && attachments.length === 0) {
                    return;
                }
                try {
                    if (await this._tryHandleSlashOnlyPrompt(tab, trimmed, attachments)) {
                        void this._host.pushStateSync();
                        return;
                    }
                } catch (err: unknown) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this._host.post({ type: 'error', message: errMsg });
                    void this._host.pushStateSync();
                    return;
                }
                attachments.push(...this._attachments.editorContextAttachments());
                if (!this.uiIsStreaming(tab)) {
                    startTurn(tab);
                    tab.isStreaming = true;
                    try {
                        await this._dispatchPrompt(tab, trimmed, attachments);
                    } finally {
                        if (!tab.session.session?.isStreaming) {
                            tab.isStreaming = false;
                        }
                    }
                    void this._host.pushStateSync();
                    return;
                }
                tab.queuedMessages.push({ text: trimmed, attachments });
                void this._host.pushStateSync();
            },
            interruptAndSend: async (msg, tab) => {
                if (!(await this._waitForTab(tab))) return;
                const trimmed = msg.text.trim();
                const attachments = [...tab.pendingAttachments];
                tab.pendingAttachments = [];
                if (!trimmed && attachments.length === 0) {
                    return;
                }
                tab.suppressQueueDrain = true;
                try {
                    try {
                        if (await this._tryHandleSlashOnlyPrompt(tab, trimmed, attachments)) {
                            void this._host.pushStateSync();
                            return;
                        }
                    } catch (err: unknown) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        this._host.post({ type: 'error', message: errMsg });
                        void this._host.pushStateSync();
                        return;
                    }
                    attachments.push(...this._attachments.editorContextAttachments());
                    if (this.uiIsStreaming(tab)) {
                        await this.abortTab(tab);
                    }
                    startTurn(tab);
                    tab.isStreaming = true;
                    if (tab.id === this._host.activeTabId) {
                        this._host.sendStateSync();
                    }
                    try {
                        await this._dispatchPrompt(tab, trimmed, attachments);
                    } finally {
                        if (!tab.session.session?.isStreaming) {
                            tab.isStreaming = false;
                        }
                    }
                    void this._host.pushStateSync();
                } finally {
                    tab.suppressQueueDrain = false;
                }
            },
            editQueuedMessage: (msg, tab) => {
                if (msg.index >= 0 && msg.index < tab.queuedMessages.length && msg.text.trim()) {
                    const prev = tab.queuedMessages[msg.index];
                    tab.queuedMessages[msg.index] = { ...prev, text: msg.text.trim() };
                }
                this._host.sendStateSync();
            },
            removeQueuedMessage: (msg, tab) => {
                if (msg.index >= 0 && msg.index < tab.queuedMessages.length) {
                    tab.queuedMessages.splice(msg.index, 1);
                }
                this._host.sendStateSync();
            },
            steerQueuedMessage: async (msg, tab) => {
                const item = tab.queuedMessages[msg.index];
                // Idle: nothing to steer; the queue drains and runs it as the next prompt anyway.
                if (!item || !this.uiIsStreaming(tab)) {
                    this._host.sendStateSync();
                    return;
                }
                tab.queuedMessages.splice(msg.index, 1);
                const { text, images } = composePrompt(item.text, item.attachments);
                const shown = text || '(attachments)';
                tab.steeringMessages = [...tab.steeringMessages, shown];
                if (item.fromVoice) {
                    tab.voiceOrigins.expect(text);
                }
                void this._host.pushStateSync();
                // prompt + streamingBehavior rather than `steer`: if the run ends before this lands, it
                // starts as a new prompt instead of leaving a stray steer that fires later.
                try {
                    await tab.session.submitInput(
                        text,
                        { mode: 'prompt', streamingBehavior: 'steer' },
                        images.length > 0 ? images : undefined,
                    );
                } catch (err: unknown) {
                    if (item.fromVoice) {
                        tab.voiceOrigins.cancel(text);
                    }
                    const idx = tab.steeringMessages.lastIndexOf(shown);
                    if (idx >= 0) {
                        tab.steeringMessages = tab.steeringMessages.filter((_, i) => i !== idx);
                    }
                    tab.queuedMessages.splice(Math.min(msg.index, tab.queuedMessages.length), 0, item);
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this._host.post({ type: 'error', message: errMsg });
                }
                void this._host.pushStateSync();
            },
            cancelQueue: (_msg, tab) => {
                tab.queuedMessages = [];
                this._host.sendStateSync();
            },
            followUp: async (msg, tab) => {
                await tab.session.submitInput(msg.text, { mode: 'followUp' });
            },
            abort: async (_msg, tab) => {
                await this.abortTab(tab);
            },
            resendUserMessage: async (msg, tab) => {
                try {
                    await tab.session.resendUserMessage(
                        msg.messageIndex,
                        msg.text,
                        msg.mode,
                        msg.entryId,
                    );
                    if (!this.uiIsStreaming(tab)) {
                        startTurn(tab);
                    }
                    tab.isStreaming = true;
                    await this._host.pushStateSync();
                } catch (err: unknown) {
                    const m = err instanceof Error ? err.message : String(err);
                    this._host.post({ type: 'error', message: m });
                    this._host.post({ type: 'toast', message: m, variant: 'error' });
                }
            },
            regenerateAssistant: async (msg, tab) => {
                try {
                    await tab.session.regenerateAssistant(msg.assistantMessageIndex, msg.mode);
                    if (!this.uiIsStreaming(tab)) {
                        startTurn(tab);
                    }
                    tab.isStreaming = true;
                    await this._host.pushStateSync();
                } catch (err: unknown) {
                    const m = err instanceof Error ? err.message : String(err);
                    this._host.post({ type: 'error', message: m });
                    this._host.post({ type: 'toast', message: m, variant: 'error' });
                }
            },
        };
    }
}
