import * as path from 'node:path';
import * as vscode from 'vscode';
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
import { TUI_INTERRUPT, tuiPromptKeys, type TabTui, type TabTuis } from './sidebarTui';

/** pi's TUI queues a follow-up with Ctrl+Q instead of Alt+Enter where the terminal takes Alt+Enter. */
const WINDOWS_KEYS = process.platform === 'win32' || !!process.env.WSL_DISTRO_NAME;

/** The voice agent's task control of the tabs (docs/voice-agent-design.md §5.11), behind the provider's `WorkerController`. */
export class SidebarWorker {
    private _approvalSeq = 0;

    constructor(
        private readonly _host: SidebarHost,
        private readonly _queue: SidebarPromptQueue,
        private readonly _attachments: SidebarAttachments,
        /** The TUIs of tabs in TUI mode: the voice agent types into them and reads their screens. */
        private readonly _tuis: TabTuis,
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
        if (tab.tuiMode) {
            return this._sendToTui(tab, composePrompt(trimmed, attachments).text, options);
        }

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

    /**
     * A TUI tab: the prompt is pasted into the TUI's editor and submitted, as the user would. The TUI owns
     * the session file (design §5.12 rule 7), so the idle RPC worker is never used for it.
     */
    private async _sendToTui(tab: TabState, text: string, options: WorkerSendOptions): Promise<WorkerSendOutcome> {
        const tui = this._runningTui(tab);
        const busy = tab.tuiBusy;
        const queue = busy && options.when === 'after';
        await tui.typeWhenReady(tuiPromptKeys(text, tui.backend, queue, WINDOWS_KEYS));
        tab.tuiPromptFromVoice = true;
        return !busy ? 'started' : queue ? 'queued' : 'steered';
    }

    async abort(tabId: string): Promise<void> {
        const tab = this._workerTab(tabId);
        if (tab.tuiMode) {
            this._runningTui(tab).write(TUI_INTERRUPT);
            return;
        }
        await this._queue.abortTab(tab);
    }

    status(tabId: string): WorkerStatus {
        const tab = this._workerTab(tabId);
        if (tab.tuiMode) {
            return { phase: tab.tuiBusy ? 'working' : 'idle', queued: 0, fromVoice: tab.tuiPromptFromVoice, tui: true };
        }
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
        const tab = this._workerTab(tabId);
        // A TUI asks on its screen; the idle RPC worker behind it has nothing to ask.
        return tab.tuiMode ? [] : tab.session.rpcExtensionUi.pendingRequests();
    }

    async readTuiScreen(tabId: string, pagesBack: number): Promise<string> {
        return this._runningTui(this._workerTab(tabId)).screen().read(pagesBack);
    }

    async typeIntoTui(tabId: string, keys: string): Promise<string> {
        return this._runningTui(this._workerTab(tabId)).screen().type(keys);
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

    lockedPaths(tabId: string, paths: string[]): string[] {
        const tab = this._workerTab(tabId);
        // A TUI does not load the permission gate: nothing is reported (HostToolRouter keeps its busy rule there).
        if (tab.tuiMode || !this._queue.uiIsStreaming(tab)) {
            return [];
        }
        const edits = tab.session.workerEdits();
        if (!edits) {
            return [];
        }
        // The voice agent's paths are relative to the first workspace folder, like its file tools'.
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? tab.session.session?.cwd ?? process.cwd();
        return edits
            .overlapping(paths.map((p) => path.resolve(root, p)))
            .map((locked) => vscode.workspace.asRelativePath(locked, (vscode.workspace.workspaceFolders?.length ?? 0) > 1));
    }

    /** Tabs are addressed by id; a closed tab, or one in the other backend's workspace, is gone. */
    private _workerTab(tabId: string): TabState {
        const tab = this._host.tabs.get(tabId);
        if (!tab) {
            throw new Error(`Worker tab ${tabId} is closed`);
        }
        return tab;
    }

    private _runningTui(tab: TabState): TabTui {
        if (!tab.tuiMode) {
            throw new Error('This tab shows the chat, not the CLI TUI.');
        }
        const tui = this._tuis.get(tab.id);
        if (!tui || tui.exited) {
            throw new Error('This tab is in TUI mode, but its TUI is not running: ask the user to show the tab so it starts again.');
        }
        return tui;
    }
}
