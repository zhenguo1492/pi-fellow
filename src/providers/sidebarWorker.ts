import { composePrompt } from '../pi/fileAttachments';
import { canonicalizeSessionPath, invalidateSessionInfoPath } from '../pi/sessionCatalog';
import { extractConversationMessageText } from '../shared/conversationTitle';
import type { PermissionLevel } from '../shared/protocol';
import type {
    WorkerAnswer,
    WorkerRequest,
    WorkerSendOptions,
    WorkerSendOutcome,
    WorkerStatus,
    WorkerTask,
    WorkerTurn,
} from '../voiceAgent/workerController';
import type { SidebarAttachments } from './sidebarAttachments';
import type { SidebarHost } from './sidebarHost';
import type { SidebarPromptQueue } from './sidebarPromptQueue';
import { updateTabName } from './sidebarTabs';
import { tabReady, type TabState } from './sidebarTabState';
import { tabPermissionLevel } from './sidebarPermission';
import { requestToolApproval } from './sidebarToolApproval';

/** The TUI owns a tab's session file while it shows: the idle RPC worker must not write to it (design §5.12 rule 7). */
const TUI_TAB_REFUSAL = 'This tab shows the CLI TUI: voice cannot control its worker. Ask the user to switch the tab back to the chat view.';

/** The voice agent's task control of the tabs (docs/voice-agent-design.md §5.11), behind the provider's `WorkerController`. */
export class SidebarWorker {
    private _approvalSeq = 0;

    constructor(
        private readonly _host: SidebarHost,
        private readonly _queue: SidebarPromptQueue,
        private readonly _attachments: SidebarAttachments,
    ) {}

    activeTask(): WorkerTask | undefined {
        const tab = this._host.tabs.get(this._host.activeTabId);
        if (!tab) {
            return undefined;
        }
        const model = tab.session.session?.model;
        return {
            tabId: tab.id,
            name: tab.name,
            backend: tab.session.backend,
            sessionFile: tab.session.session?.sessionFile,
            sessionName: tab.session.session?.sessionName?.trim() || undefined,
            model: model && `${model.provider}/${model.id}`,
        };
    }

    recentTurns(tabId: string, count: number): WorkerTurn[] {
        const turns: WorkerTurn[] = [];
        for (const message of this._workerTab(tabId).session.messages) {
            const text = extractConversationMessageText(message).trim();
            if (message.role === 'user') {
                turns.push({ instruction: text, reply: '' });
            } else if (message.role === 'assistant' && text && turns.length > 0) {
                turns[turns.length - 1].reply = text;
            }
        }
        return turns.slice(-count);
    }

    async nameTask(tabId: string, sessionFile: string, name: string): Promise<boolean> {
        const tab = this._host.tabs.get(tabId);
        const session = tab?.session.session;
        // A TUI owns its tab's session file; the idle RPC session must not write to it.
        if (
            !tab ||
            !session ||
            tab.tuiMode ||
            session.sessionName?.trim() ||
            canonicalizeSessionPath(session.sessionFile) !== canonicalizeSessionPath(sessionFile)
        ) {
            return false;
        }
        await tab.session.setSessionName(name);
        invalidateSessionInfoPath(sessionFile);
        if (updateTabName(tab)) {
            await this._host.pushStateSync();
        }
        return true;
    }

    async send(tabId: string, text: string, options: WorkerSendOptions): Promise<WorkerSendOutcome> {
        const tab = this._workerTab(tabId);
        if (tab.tuiMode) {
            throw new Error(TUI_TAB_REFUSAL);
        }
        const trimmed = text.trim();
        if (!trimmed) {
            throw new Error('Empty instruction');
        }
        // Task control only: session management stays in the UI (design §6).
        if (trimmed.startsWith('/') || trimmed.startsWith('!')) {
            throw new Error('Voice control sends task instructions only, not slash commands or ! shell shortcuts');
        }
        await tabReady(tab);
        const attachments = options.includeEditorContext ? this._attachments.editorContextAttachments(true) : [];

        if (!this._queue.uiIsStreaming(tab)) {
            await this._queue.beginPrompt(tab, trimmed, attachments, true);
            return 'started';
        }
        if (options.when === 'after') {
            tab.queuedMessages.push({ text: trimmed, attachments, fromVoice: true });
            void this._host.pushStateSync();
            return 'queued';
        }
        const { text: composed, images } = composePrompt(trimmed, attachments);
        tab.steeringMessages = [...tab.steeringMessages, composed];
        tab.voiceOrigins.expect(composed);
        void this._host.pushStateSync();
        // prompt + streamingBehavior rather than `steer`: if the run ends before this lands, both
        // pi and omp start it as a new prompt instead of leaving a stray steer that fires later.
        try {
            await tab.session.submitInput(
                composed,
                { mode: 'prompt', streamingBehavior: 'steer' },
                images.length > 0 ? images : undefined,
            );
        } catch (err: unknown) {
            tab.voiceOrigins.cancel(composed);
            throw err;
        }
        return 'steered';
    }

    async abort(tabId: string): Promise<void> {
        const tab = this._workerTab(tabId);
        if (tab.tuiMode) {
            throw new Error(TUI_TAB_REFUSAL);
        }
        await this._queue.abortTab(tab);
    }

    status(tabId: string): WorkerStatus {
        const tab = this._workerTab(tabId);
        const queued = tab.queuedMessages.length;
        const busy = this._queue.uiIsStreaming(tab);
        const elapsedMs = busy && tab.agentStartTime ? Date.now() - tab.agentStartTime : undefined;
        if (this.pendingRequests(tabId).length > 0) {
            return { phase: 'awaiting', elapsedMs, queued, fromVoice: this._latestInstructionFromVoice(tab) };
        }
        if (tab.connectionStatus.phase === 'failed') {
            return { phase: 'error', error: tab.connectionStatus.message, queued };
        }
        return { phase: busy ? 'working' : 'idle', elapsedMs, queued };
    }

    pendingRequests(tabId: string): WorkerRequest[] {
        return this._workerTab(tabId).session.rpcExtensionUi.pendingRequests();
    }

    answer(tabId: string, requestId: string, answer: WorkerAnswer): boolean {
        const ui = this._workerTab(tabId).session.rpcExtensionUi;
        const request = ui.pendingRequests().find((r) => r.id === requestId);
        if (!request) {
            return false;
        }
        if (!('cancelled' in answer)) {
            const isConfirm = request.method === 'confirm';
            if (isConfirm !== ('confirmed' in answer)) {
                throw new Error(`A ${request.method} request takes { ${isConfirm ? 'confirmed' : 'value'} }`);
            }
            if (request.method === 'select' && 'value' in answer && !request.options?.includes(answer.value)) {
                throw new Error(`"${answer.value}" is not one of: ${(request.options ?? []).join(', ')}`);
            }
        }
        return ui.respond({ id: requestId, ...answer });
    }

    /** Whether the tab's latest user message (the instruction the worker is on) came from the voice agent. */
    private _latestInstructionFromVoice(tab: TabState): boolean {
        const messages = tab.session.messages;
        let ordinal = -1;
        let latest: unknown;
        for (const message of messages) {
            if (message.role === 'user') {
                ordinal++;
                latest = message;
            }
        }
        return latest !== undefined && tab.voiceOrigins.isFromVoice(latest, ordinal);
    }

    permissionLevel(tabId: string): PermissionLevel {
        return tabPermissionLevel(this._workerTab(tabId));
    }

    /** A voice-agent change that needs approval (Manual, or a command in Edit automatically) waits for the tab's approval card. */
    requestToolApproval(tabId: string, toolName: string, args: Record<string, unknown>): Promise<boolean> {
        return requestToolApproval(this._host, this._workerTab(tabId), `voice-${++this._approvalSeq}`, toolName, args);
    }

    /** Tabs are addressed by id; a closed tab, or one in the other backend's workspace, is gone. */
    private _workerTab(tabId: string): TabState {
        const tab = this._host.tabs.get(tabId);
        if (!tab) {
            throw new Error(`Worker tab ${tabId} is closed`);
        }
        return tab;
    }
}
