import * as vscode from 'vscode';
import type { PiChatSession } from '../pi/slashCommands';
import type {
    AgentBackend,
    ClientMessage,
    PermissionLevel,
    ServerMessage,
    TuiAuthCommand,
    VoiceLevelSource,
} from '../shared/protocol';
import { clearCliTargetCache, onDidChangeWindowBackend, resolveCliTarget } from '../pi/piCliPaths';
import { readFavoriteModels } from '../pi/favoriteModels';
import type { DiffManager } from './diff';
import type { CheckpointManager } from './checkpoint';
import type { ModelStatusTracker } from './model-status';
import { openPlanDocument, type PlanDocumentProvider } from './plan-document';
import { toPreviewList, toVoiceAttachments } from '../pi/pendingAttachments';
import { VoiceInput } from '../voice/voiceInput';
import { onVoiceReadinessChange, voiceReadiness } from '../voice/voiceSettings';
import type {
    VoiceHistory,
    WorkerAnswer,
    WorkerController,
    WorkerEvent,
    WorkerRequest,
    WorkerSendOptions,
    WorkerSendOutcome,
    WorkerStatus,
    WorkerTask,
    WorkerTurn,
} from '../voiceAgent/workerController';
import type { VoiceChatControls } from '../voiceAgent/voiceAgentCommands';
import {
    voiceIsOn,
    type VoiceAgentAction,
    type VoiceStatus,
    type VoiceViewClientMessage,
    type VoiceViewHostMessage,
} from '../shared/voiceViewProtocol';
import { routeComposerSend } from './composerRoute';
import { SidebarAttachments } from './sidebarAttachments';
import { SidebarBackends } from './sidebarBackends';
import { SidebarBotView } from './sidebarBotView';
import { safeSerialize, type SidebarHost } from './sidebarHost';
import { getSidebarHtml } from './sidebarHtml';
import { conversationHandlers, type MessageHandler, type MessageHandlers } from './sidebarMessageHandlers';
import { SidebarPromptQueue } from './sidebarPromptQueue';
import { SidebarSessionPanel } from './sidebarSessionPanel';
import { SidebarTabs, updateTabName } from './sidebarTabs';
import {
    claimPlanEditorOpen,
    makeTabState,
    nextTabId,
    tabConnectionStatus,
    tabPlanMode,
    type TabState,
} from './sidebarTabState';
import { toolApprovalHandlers } from './sidebarToolApproval';
import {
    applyTabPermission,
    forgetPermissionPick,
    newTabPermissionLevel,
    permissionHandlers,
    releasePlanToPi,
    tabPermissionLevel,
} from './sidebarPermission';
import { SidebarTuiMode } from './sidebarTuiMode';
import { SidebarVoiceSessions } from './sidebarVoiceSessions';
import { SidebarWorker } from './sidebarWorker';

export class SidebarProvider implements vscode.WebviewViewProvider, WorkerController, VoiceChatControls {
    private _view?: vscode.WebviewView;
    private readonly _voiceActions = new vscode.EventEmitter<VoiceAgentAction>();
    /** The robot status line, the composer mic and the composer ask the voice agent for something. */
    readonly onVoiceAction = this._voiceActions.event;
    private readonly _voiceViewMessages = new vscode.EventEmitter<VoiceViewClientMessage>();
    /** Card buttons and history in the Bot view a tab shows. */
    readonly onDidReceiveVoiceMessage = this._voiceViewMessages.event;
    private readonly _botViewVisibility = new vscode.EventEmitter<void>();
    readonly onDidChangeBotViewVisibility = this._botViewVisibility.event;
    private _extensionUri: vscode.Uri;
    private _outputChannel: vscode.OutputChannel;
    private _planDocument: PlanDocumentProvider;
    private _modelStatus?: ModelStatusTracker;
    /** Mic dictation into the composer. */
    readonly voiceInput: VoiceInput;

    // ---- WorkerController: voice agent task control (docs/voice-agent-design.md §5.11) ----

    private readonly _activeTaskChanged = new vscode.EventEmitter<WorkerTask | undefined>();
    readonly onActiveTaskChanged = this._activeTaskChanged.event;
    private _lastActiveTask: WorkerTask | undefined;
    private readonly _sessionResumed = new vscode.EventEmitter<string>();
    readonly onSessionResumed = this._sessionResumed.event;
    private readonly _tabEvent = new vscode.EventEmitter<{ tabId: string; event: WorkerEvent }>();
    readonly onTabEvent = this._tabEvent.event;
    private readonly _requestsChanged = new vscode.EventEmitter<string>();
    readonly onRequestsChanged = this._requestsChanged.event;

    private readonly _host: SidebarHost;
    private readonly _backends: SidebarBackends;
    private readonly _voiceSessions: SidebarVoiceSessions;
    private readonly _tui: SidebarTuiMode;
    private readonly _attachments: SidebarAttachments;
    private readonly _queue: SidebarPromptQueue;
    private readonly _worker: SidebarWorker;
    private readonly _tabs: SidebarTabs;
    private readonly _sessionPanel: SidebarSessionPanel;
    private readonly _botView: SidebarBotView;
    /** Every module's webview message handlers, by message type. */
    private readonly _handlers: MessageHandlers;

    constructor(
        extensionUri: vscode.Uri,
        initialSession: PiChatSession,
        initialDiffManager: DiffManager,
        initialCheckpointManager: CheckpointManager,
        outputChannel: vscode.OutputChannel,
        planDocument: PlanDocumentProvider,
        pastedStorageDir: string,
        workspaceState: vscode.Memento,
        modelStatus?: ModelStatusTracker,
    ) {
        this._planDocument = planDocument;
        this._extensionUri = extensionUri;
        this._outputChannel = outputChannel;
        this._modelStatus = modelStatus;
        const backends = new SidebarBackends(outputChannel);
        this._backends = backends;
        this._host = {
            outputChannel,
            workspaceState,
            get tabs() {
                return backends.tabs;
            },
            get activeTabId() {
                return backends.activeTabId;
            },
            set activeTabId(id: string) {
                backends.activeTabId = id;
            },
            get activeTab() {
                return backends.activeTab;
            },
            get currentBackend() {
                return backends.current;
            },
            set currentBackend(backend: AgentBackend) {
                backends.current = backend;
            },
            post: (message) => this._post(message),
            sendStateSync: () => this.sendStateSync(),
            pushStateSync: () => this.pushStateSync(),
            postModelFooter: (tab) => this.postModelFooter(tab),
            wireRpcSessionUi: (session) => this._wireRpcSessionUi(session),
        };
        modelStatus?.onDidChange((status) => this._post({ type: 'modelStatus', status }));
        this.voiceInput = new VoiceInput(extensionUri, (message) => this._post(message), outputChannel);
        onVoiceReadinessChange(() => {
            this.sendStateSync();
        });
        this._tui = new SidebarTuiMode(this._host);
        this._attachments = new SidebarAttachments(this._host, pastedStorageDir);
        this._voiceSessions = new SidebarVoiceSessions(outputChannel);
        this._queue = new SidebarPromptQueue(this._host, this._attachments);
        this._worker = new SidebarWorker(this._host, this._queue, this._attachments);
        this._tabs = new SidebarTabs(
            this._host,
            backends,
            this._tui.tuis,
            this._voiceSessions,
            { tabEvent: this._tabEvent, requestsChanged: this._requestsChanged },
            modelStatus,
        );
        this._sessionPanel = new SidebarSessionPanel(this._host, this._tabs, this._tui, this._voiceSessions, (tabId) =>
            this._sessionResumed.fire(tabId),
        );
        this._botView = new SidebarBotView(
            this._host,
            () => this._view,
            this.voiceInput,
            this._tabs,
            this._botViewVisibility,
        );
        this._handlers = {
            ...this._queue.handlers(),
            ...this._attachments.handlers(),
            ...conversationHandlers(this._host, planDocument),
            ...this._sessionPanel.handlers(),
            ...this._tui.handlers(),
            ...toolApprovalHandlers(this._host),
            ...permissionHandlers(this._host, () => this._tabs.schedulePersistOpenTabs()),
            ...this._tabs.handlers(),
            ...this._botView.handlers(),
        };

        try {
            backends.current = resolveCliTarget().backend;
        } catch {
            backends.current = 'pi';
        }

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('oh-my-pi-chater.favoriteModels')) {
                this.postModelFooter();
            }
            if (e.affectsConfiguration('oh-my-pi-chater.allowedTools')) {
                for (const tab of backends.tabs.values()) {
                    applyTabPermission(tab);
                }
            }
            if (e.affectsConfiguration('oh-my-pi-chater.defaultPermissionLevel')) {
                void forgetPermissionPick(workspaceState);
            }
        });
        // The settings panel is the only backend picker; it switches the window backend.
        onDidChangeWindowBackend((backend) => void this._switchBackend(backend));

        const id = nextTabId();
        const tab = makeTabState(id, initialSession, initialDiffManager, initialCheckpointManager, newTabPermissionLevel(workspaceState));
        applyTabPermission(tab);
        updateTabName(tab);
        backends.tabs.set(id, tab);
        backends.activeTabId = id;
        this._tabs.subscribeTab(tab);
        const ready = initialSession.waitUntilReady();
        this._tabs.watchStartup(tab, ready);
        // The window's first worker is starting: pre-warm the next tab's once it is up.
        backends.holdPrewarm();
        const releasePrewarm = () => backends.releasePrewarm(1500);
        void ready.then(releasePrewarm, releasePrewarm);
    }

    public get activeSession(): PiChatSession | undefined {
        return this._backends.activeTab?.session;
    }

    disposePrewarmedSession(): Promise<void> {
        return this._backends.disposePrewarmedSession();
    }

    /** Restore the conversations that were open in this workspace when VS Code exited. */
    restorePersistedTabs(backend?: AgentBackend): Promise<void> {
        return this._tabs.restorePersistedTabs(backend);
    }

    flushPersistedTabs(): Promise<void> {
        return this._tabs.flushPersistedTabs();
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = getSidebarHtml(webviewView.webview, this._extensionUri);
        this._wireRpcSessionUi(this._backends.activeTab.session);
        this._tabs.subscribeMissing();

        webviewView.webview.onDidReceiveMessage((received: ClientMessage) => {
            const route = routeComposerSend(
                received,
                this._botView.showsBotView(),
                voiceIsOn(this._botView.voiceStatus),
            );
            if ('refuse' in route) {
                this._post({ type: 'toast', message: route.refuse, variant: 'error' });
                void this.pushStateSync();
                return;
            }
            const msg = route.deliver;
            if (msg.type === 'voiceAgent') {
                if (msg.action.type !== 'send') {
                    this._voiceActions.fire(msg.action);
                    return;
                }
                // The tab's pending attachments go along, as with a prompt to the worker.
                const tab = this._backends.activeTab;
                const attachments = toVoiceAttachments(tab?.pendingAttachments ?? []);
                if (tab && attachments) {
                    tab.pendingAttachments = [];
                    this.sendStateSync();
                }
                this._voiceActions.fire({ type: 'send', text: msg.action.text, ...(attachments ? { attachments } : {}) });
                return;
            }
            if (msg.type === 'voice') {
                this._voiceViewMessages.fire(msg.message);
                return;
            }
            this._handleMessage(msg);
        });

        webviewView.onDidChangeVisibility(() => {
            this._botView.syncBotViewVisibility();
            if (!webviewView.visible) return;
            this._view = webviewView;
            this._refreshVisibleWebview();
            // Hidden (retained) webviews drop every message: repaint terminals from the mirrors.
            this._tui.tuis.resync();
        });

        webviewView.onDidDispose(() => {
            // Tab subscriptions belong to the provider/session lifecycle, not the transient
            // webview lifecycle. Clearing them here makes hidden conversations stop syncing.
            if (this._view === webviewView) {
                this._view = undefined;
                this._botView.syncBotViewVisibility();
            }
        });

        this._refreshVisibleWebview();
        void this._sessionPanel.warmSessionListCache();
    }

    private _refreshVisibleWebview(): void {
        this._post({ type: 'ready' });
        this._sessionPanel.repostOpenPanel();
        this._attachments.postEditorContext();
        if (this._modelStatus) {
            this._post({ type: 'modelStatus', status: this._modelStatus.status });
        }
        void this.pushStateSync().then(() => this.postModelFooter());
    }

    private _wireRpcSessionUi(session: PiChatSession): void {
        const post = (m: ServerMessage) => this._post(m);
        session.rpcExtensionUi.setPost(post);
        session.setPostChatError((message) => post({ type: 'error', message }));
        session.extensionChrome.setPost((m) => {
            post(m);
            if (m.type === 'piExtensionChrome') {
                this.sendStateSync();
            }
        });
        session.setOnOpenSessionTree(() => void this.openSessionTree());
    }

    /** Stop generation in the active chat tab (webview Stop / Esc). */
    async abortActiveTab(): Promise<void> {
        const tab = this._backends.tabs.get(this._backends.activeTabId);
        if (!tab) {
            return;
        }
        await this._queue.abortTab(tab);
    }

    activeTask(): WorkerTask | undefined {
        return this._worker.activeTask();
    }

    /** Every tab switch, backend switch, resume and /new ends in a state sync, so detect task changes there. */
    private _noteActiveTask(): void {
        const task = this.activeTask();
        const last = this._lastActiveTask;
        this._lastActiveTask = task;
        // A new tab gets its session file after startup: same task, not a switch.
        if (task?.tabId === last?.tabId && (task?.sessionFile === last?.sessionFile || !last?.sessionFile)) {
            return;
        }
        this._activeTaskChanged.fire(task);
    }

    recentTurns(tabId: string, count: number): WorkerTurn[] {
        return this._worker.recentTurns(tabId, count);
    }

    nameTask(tabId: string, sessionFile: string, name: string): Promise<boolean> {
        return this._worker.nameTask(tabId, sessionFile, name);
    }

    /** The voice transcript store: sessions the user only talked to the voice agent about get resumable. */
    setVoiceHistory(history: VoiceHistory): void {
        this._voiceSessions.history = history;
    }

    send(tabId: string, text: string, options: WorkerSendOptions): Promise<WorkerSendOutcome> {
        return this._worker.send(tabId, text, options);
    }

    abort(tabId: string): Promise<void> {
        return this._worker.abort(tabId);
    }

    status(tabId: string): WorkerStatus {
        return this._worker.status(tabId);
    }

    pendingRequests(tabId: string): WorkerRequest[] {
        return this._worker.pendingRequests(tabId);
    }

    answer(tabId: string, requestId: string, answer: WorkerAnswer): boolean {
        return this._worker.answer(tabId, requestId, answer);
    }

    permissionLevel(tabId: string): PermissionLevel {
        return this._worker.permissionLevel(tabId);
    }

    requestToolApproval(tabId: string, toolName: string, args: Record<string, unknown>): Promise<boolean> {
        return this._worker.requestToolApproval(tabId, toolName, args);
    }

    /** Pull latest messages/model from Pi RPC, then push to webview (avoids stale/laggy chat). */
    async pushStateSync(): Promise<void> {
        const tab = this._backends.activeTab;
        if (!tab) {
            return;
        }
        // A tab still starting or restoring has nothing to pull yet; it pushes its state once it is done.
        if (tab.session.isReady && !tab.restoring) {
            try {
                await tab.session.syncFromRpc();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this._outputChannel.appendLine(`RPC sync before state push: ${msg}`);
            }
        }
        updateTabName(tab);
        this.sendStateSync();
    }

    postModelFooter(tab?: TabState): void {
        const t = tab ?? this._backends.activeTab;
        if (!t) {
            return;
        }
        this._post({
            type: 'models',
            models: t.session.getModels(),
            current: t.session.getCurrentModel(),
            thinkingLevel: t.session.getThinkingLevel(),
            favorites: readFavoriteModels(),
        });
    }

    /** Open in-sidebar resume panel (same session list as Pi CLI `/resume`). */
    openSessionPanel(): Promise<void> {
        return this._sessionPanel.openSessionPanel();
    }

    openSessionTree(): Promise<void> {
        return this._sessionPanel.openSessionTree();
    }

    sendStateSync(): void {
        this._noteActiveTask();
        const tab = this._backends.activeTab;
        if (!tab) return;

        const state = tab.session.serializeState();
        state.isStreaming = this._queue.uiIsStreaming(tab);
        if (tab.suspendedMessages.length > 0) {
            state.messages = [
                ...state.messages,
                ...tab.suspendedMessages.map((m) => safeSerialize(m)),
            ];
        }
        state.fileChanges = tab.diffManager.fileChanges;
        state.rollbackPoint = tab.checkpointManager.rollbackPoint;
        state.tabs = this._tabs.getTabInfos();
        state.activeTabId = this._backends.activeTabId;
        state.tuiAuthPrompt = this._tui.authPrompt;
        state.streamingText = tab.streamingText;
        state.streamingThinking = tab.streamingThinking;
        state.isThinking = tab.isThinking;
        state.thinkingStartTime = tab.thinkingStartTime;
        state.streamingThinkingDuration = tab.streamingThinkingDuration;
        state.queuedMessages = tab.queuedMessages.map((q) => {
            const suffix =
                q.attachments.length > 0 ? ` [+${q.attachments.length} attachment(s)]` : '';
            return `${q.text}${suffix}`;
        });
        state.steeringMessages = [...tab.steeringMessages];
        state.followUpMessages = [...tab.followUpMessages];
        state.pendingAttachments = toPreviewList(tab.pendingAttachments);

        const { planMode, chrome } = tabPlanMode(tab);
        if (releasePlanToPi(tab, planMode.enabled)) {
            this._tabs.schedulePersistOpenTabs();
        }
        state.restoringHistory = tab.restoring !== undefined;
        state.planMode = planMode;
        state.permissionLevel = tabPermissionLevel(tab, planMode.enabled);
        state.pendingToolApprovals = [...tab.pendingApprovals.values()].map((pending) => pending.info);
        state.piExtensionChrome = chrome;
        state.connectionStatus = tabConnectionStatus(tab, this._backends.current);
        const sessionId = tab.session.session?.sessionId ?? 'default';
        this._planDocument.setPlanContent(sessionId, planMode.planMarkdown);
        if (claimPlanEditorOpen(tab, planMode)) {
            void openPlanDocument(this._planDocument, sessionId);
        }

        let assistantOrdinal = 0;
        let userOrdinal = 0;
        for (let i = 0; i < state.messages.length; i++) {
            if (state.messages[i].role === 'assistant') {
                const meta = tab.messageMeta.get(assistantOrdinal);
                if (meta) {
                    state.messages[i]._thinkingDurationSec = meta.thinkingDurationSec;
                    state.messages[i]._messageEndTime = meta.messageEndTime;
                }
                assistantOrdinal++;
            } else if (state.messages[i].role === 'user') {
                if (tab.voiceOrigins.isFromVoice(state.messages[i], userOrdinal)) {
                    state.messages[i]._fromVoice = true;
                }
                userOrdinal++;
            }
        }
        state.activeBackend = this._backends.current;
        state.voiceReadiness = voiceReadiness();
        state.voice = this._botView.voiceStatus;
        this._post({ type: 'stateSync', state });
        this._modelStatus?.setSession(tab.session);
        this._tabs.schedulePersistOpenTabs();
        this._queue.maybeDrainQueuedMessages(tab, true);
        this._botView.syncBotViewVisibility();
        // Dictation types into the composer: it ends when the composer locks.
        if (this._botView.composerLocked() && this.voiceInput.isRecording) {
            void this.voiceInput.toggle();
        }
    }

    toggleDictation(): Promise<void> {
        return this._botView.toggleDictation();
    }

    isBotViewVisible(): boolean {
        return this._botView.isBotViewVisible();
    }

    postVoice(message: VoiceViewHostMessage): void {
        this._post({ type: 'voice', message });
    }

    showBotView(preserveFocus: boolean, options?: { onlyIfWorkerUnused?: boolean }): Promise<void> {
        return this._botView.showBotView(preserveFocus, options);
    }

    setVoiceStatus(status: VoiceStatus): void {
        this._botView.setVoiceStatus(status);
    }

    setDictationPaused(paused: boolean): void {
        this.voiceInput.setPaused(paused);
    }

    postVoiceLevel(level: number, source: VoiceLevelSource, wave?: number[]): void {
        this._post({ type: 'voiceLevel', level, source, wave });
    }

    /** Attach local paths (Explorer tree drop or legacy webview path). */
    attachPaths(paths: string[]): Promise<void> {
        return this._attachments.attachPaths(paths);
    }

    private _post(message: ServerMessage): void {
        this._view?.webview.postMessage(message);
    }

    private async _handleMessage(msg: ClientMessage): Promise<void> {
        try {
            const tab = this._backends.activeTab;
            // Own keys only: a type without a handler (even `toString`) is ignored. The table pairs each type
            // with its handler; TypeScript cannot correlate `msg` with the lookup.
            const handler = Object.hasOwn(this._handlers, msg.type)
                ? (this._handlers[msg.type] as MessageHandler<ClientMessage['type']>)
                : undefined;
            await handler?.(msg, tab);
        } catch (err: unknown) {
            // Errors and RPC error objects carry `message`; whatever else was thrown is read the same way.
            const thrown = err as { message?: string };
            this._post({ type: 'error', message: thrown.message ?? String(err) });
        }
    }

    private async _switchBackend(backend: AgentBackend): Promise<void> {
        if (this._backends.current === backend) return;

        this._backends.current = backend;
        clearCliTargetCache();

        this._backends.dropPrewarmedSession();
        this._backends.schedulePrewarmSession(500);

        this._sessionPanel.invalidateSessionLists();

        // If target backend has no tabs, restore its persisted tabs or create a fresh one
        if (this._backends.tabs.size === 0) {
            await this._tabs.restorePersistedTabs(backend);
            if (this._backends.tabs.size === 0) {
                await this._tabs.createTab(backend);
            }
        }

        this._sessionPanel.reloadOpenPanel();

        await this.pushStateSync();
        this.postModelFooter();
        if (this._backends.activeTab) {
            this._modelStatus?.setSession(this._backends.activeTab.session);
        }

        const tab = this._backends.activeTab;
        if (tab?.tuiMode) {
            await this._tui.start(tab.id, 80, 24);
        }
    }

    /** Neither CLI logs in over RPC: show a chat banner that switches to the TUI and runs the command. */
    promptTuiAuth(command: TuiAuthCommand): Promise<void> {
        return this._tui.promptAuth(command);
    }

    /** Stop every TUI (extension shutdown). */
    async disposeTui(): Promise<void> {
        await this._tui.tuis.stopAll();
    }
}
