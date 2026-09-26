import * as vscode from 'vscode';
import { PiRpcSessionManager } from '../pi/rpcSession';
import type { PiChatSession } from '../pi/slashCommands';
import type {
    AgentBackend,
    ClientMessage,
    ConnectionStatus,
    ServerMessage,
    SessionInfo,
    TabInfo,
    TuiAuthCommand,
    VoiceLevelSource,
} from '../shared/protocol';
import { buildEditorContextFragment, type EditorContextInfo } from '../shared/editorContext';
import { FileEditorTracker, selectedLineRange } from '../utils/fileEditor';
import {
    clearCliTargetCache,
    getAgentLayout,
    getAvailableBackends,
    onDidChangeWindowBackend,
    resolveCliTarget,
    resolvePiWorkspaceCwd,
    setWindowBackend,
} from '../pi/piCliPaths';
import { readFavoriteModels } from '../pi/favoriteModels';
import type { AgentLayout } from '../pi/agentBackend';
import { updatePiDefaults } from '../pi/piAgentConfig';
import { applyPiCliDefaultModel } from '../pi/piCliSync';
import {
    buildSessionInfoFromFile,
    buildSessionListRows,
    canonicalizeSessionPath,
    clearSessionInfoCache,
    getSessionDisplayTitle,
    invalidateSessionInfoPath,
    listPiSessionsForCwdAsync,
} from '../pi/sessionCatalog';
import { appendSessionDisplayName, deleteSessionFile } from '../pi/sessionFileOps';
import { DiffManager } from './diff';
import { CheckpointManager } from './checkpoint';
import type { StatusBarManager } from './status-bar';
import { openPlanDocument, type PlanDocumentProvider } from './plan-document';
import { enrichPlanModeFromExtensionChrome } from '../pi/planModeState';
import { mergePlanWithRpivTodos } from '../pi/planDocumentMerge';
import { extractRpivTodoTasks, rpivTasksToPlanTodos } from '../pi/rpivTodoSync';
import { ExtensionUiBridge } from '../pi/extensionUiBridge';
import {
    composePrompt,
    processFilePaths,
    processPastedImages,
    type PastedImageInput,
} from '../pi/fileAttachments';
import { isSlashOnlyInput, isVscodeOnlySlash, tryHandleSlashCommand } from '../pi/slashCommandRouter';
import {
    DEFAULT_CONVERSATION_TITLE,
    deriveConversationTitle,
    extractConversationMessageText,
} from '../shared/conversationTitle';
import {
    type PendingAttachment,
    type QueuedPrompt,
    toPendingAttachment,
    toPendingTextFileAttachment,
    toPreviewList,
} from '../pi/pendingAttachments';
import { TuiProcess } from '../pi/tuiTerminal';
import { VoiceInput } from '../voice/voiceInput';
import { SettingsPanel } from './settings-panel';
import { onVoiceReadinessChange, voiceReadiness } from '../voice/voiceSettings';
import type {
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
import type { VoiceAgentAction, VoiceStatus } from '../shared/voiceViewProtocol';
import { VoiceOriginTracker } from './voiceOrigin';

interface MessageMeta {
    thinkingDurationSec: number;
    messageEndTime: number;
}

interface PendingApproval {
    resolve: (approved: boolean) => void;
}

interface PersistedOpenTabs {
    version: 1;
    sessionPaths: string[];
    activeSessionPath?: string;
}

const OPEN_TABS_STATE_KEY = 'oh-my-pi-chater.openConversationTabs';
const TUI_MODE_STATE_KEY = 'oh-my-pi-chater.tuiMode';
const EDITOR_CONTEXT_STATE_KEY = 'oh-my-pi-chater.includeEditorContext';

/** Session store + folder the resume panel lists for a tab. */
interface SessionListTarget {
    cwd: string;
    layout: AgentLayout;
    currentSessionPath: string | undefined;
}

interface TabState {
    id: string;
    name: string;
    session: PiChatSession;
    diffManager: DiffManager;
    checkpointManager: CheckpointManager;
    turnCounter: number;
    suspendedMessages: any[];
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    agentStartTime: number;
    messageMeta: Map<number, MessageMeta>;
    voiceOrigins: VoiceOriginTracker;
    hasNotification: boolean;
    pendingApprovals: Map<string, PendingApproval>;
    queuedMessages: QueuedPrompt[];
    steeringMessages: string[];
    followUpMessages: string[];
    pendingAttachments: PendingAttachment[];
    isStreaming: boolean;
    queueDrainInFlight: boolean;
    lastPlanEditorHash: string;
    connectionStatus: ConnectionStatus;
    planModeOverride?: 'agent' | 'plan';
    /** Ignore streaming deltas until Pi confirms agent_end (Stop clicked). */
    abortInFlight: boolean;
    /** Skip auto-draining the queue (e.g. while interrupt-and-send is in flight). */
    suppressQueueDrain: boolean;
}

let tabIdCounter = 0;
function nextTabId(): string {
    return `tab-${++tabIdCounter}`;
}

function hashPlanMarkdown(markdown: string): string {
    let h = 0;
    for (let i = 0; i < markdown.length; i++) {
        h = (h * 31 + markdown.charCodeAt(i)) | 0;
    }
    return `${markdown.length}:${h}`;
}

function makeTabState(
    id: string,
    session: PiChatSession,
    diffManager: DiffManager,
    checkpointManager: CheckpointManager,
): TabState {
    return {
        id,
        name: DEFAULT_CONVERSATION_TITLE,
        session,
        diffManager,
        checkpointManager,
        turnCounter: 0,
        suspendedMessages: [],
        streamingText: '',
        streamingThinking: '',
        isThinking: false,
        thinkingStartTime: 0,
        streamingThinkingDuration: 0,
        agentStartTime: 0,
        messageMeta: new Map(),
        voiceOrigins: new VoiceOriginTracker(),
        hasNotification: false,
        pendingApprovals: new Map(),
        queuedMessages: [],
        steeringMessages: [],
        followUpMessages: [],
        pendingAttachments: [],
        isStreaming: false,
        queueDrainInFlight: false,
        lastPlanEditorHash: '',
        connectionStatus: { phase: 'idle' },
        abortInFlight: false,
        suppressQueueDrain: false,
    };
}

/** Live thinking/text belong to the assistant message being streamed, not the whole run. */
function resetStreamingMessage(tab: TabState): void {
    tab.streamingText = '';
    tab.streamingThinking = '';
    tab.isThinking = false;
    tab.thinkingStartTime = 0;
    tab.streamingThinkingDuration = 0;
}

function idleConnection(): ConnectionStatus {
    return { phase: 'idle' };
}

function lastAssistantFromMessages(messages: any[] | undefined): any | undefined {
    if (!messages?.length) {
        return undefined;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant') {
            return messages[i];
        }
    }
    return undefined;
}

function failedStatusFromAssistant(msg: any | undefined): ConnectionStatus | undefined {
    if (!msg || msg.stopReason !== 'error') {
        return undefined;
    }
    const message =
        typeof msg.errorMessage === 'string' && msg.errorMessage.trim()
            ? msg.errorMessage.trim()
            : 'Request failed';
    return { phase: 'failed', message };
}

interface BackendWorkspace {
    tabs: Map<string, TabState>;
    activeTabId: string;
}

export class SidebarProvider implements vscode.WebviewViewProvider, WorkerController, VoiceChatControls {
    private _view?: vscode.WebviewView;
    private readonly _voiceActions = new vscode.EventEmitter<VoiceAgentAction>();
    /** The robot status line, the composer mic and the composer ask the voice agent for something. */
    readonly onVoiceAction = this._voiceActions.event;
    private _extensionUri: vscode.Uri;
    private _outputChannel: vscode.OutputChannel;

    private readonly _workspaces: Record<AgentBackend, BackendWorkspace> = {
        pi: { tabs: new Map(), activeTabId: '' },
        omp: { tabs: new Map(), activeTabId: '' },
    };

    private get _currentWorkspace(): BackendWorkspace {
        return this._workspaces[this._currentBackend] ?? this._workspaces.pi;
    }

    private get _tabs(): Map<string, TabState> {
        return this._currentWorkspace.tabs;
    }

    private get _activeTabId(): string {
        return this._currentWorkspace.activeTabId;
    }

    private set _activeTabId(id: string) {
        this._currentWorkspace.activeTabId = id;
    }

    private _tabSubscriptions = new Map<string, (() => void)[]>();
    private _planDocument: PlanDocumentProvider;
    private readonly _extensionUi = new ExtensionUiBridge();
    private readonly _workspaceState: vscode.Memento;
    private _persistTabsTimer: ReturnType<typeof setTimeout> | undefined;
    private _restoringTabs = false;
    private _lastPersistedTabs = '';
    private _lastAttachKey = '';
    private _lastAttachMs = 0;
    private readonly _pastedStorageDir: string;
    private _sessionPanelOpen = false;
    private _sessionTreeOpen = false;
    /** Last listing per `sessionListCacheKey`; shown instantly, then revalidated from disk. */
    private _sessionListCache = new Map<string, SessionInfo[]>();
    private readonly _sessionListInFlight = new Map<string, Promise<SessionInfo[]>>();
    /** Bumped on invalidation so in-flight listings started earlier do not repopulate the cache. */
    private _sessionListEpoch = 0;
    private _sessionListGeneration = 0;
    private _sessionPanelQuery = '';
    private _currentBackend: AgentBackend = 'pi';
    private _statusBar?: StatusBarManager;
    /** All tabs show the CLI's TUI (one pseudo-terminal per tab) instead of the chat UI. */
    private _tuiMode = false;
    private readonly _tuiProcesses = new Map<string, TuiProcess>();
    private readonly _tuiStarting = new Set<string>();
    /** PTY output coalesced per tab so streaming does not post one message per tiny chunk. */
    private readonly _tuiOutput = new Map<string, string>();
    private _tuiFlushTimer: NodeJS.Timeout | undefined;
    /** Exit codes of TUIs that ended and were not restarted (re-sent when a hidden view returns). */
    private readonly _tuiExitCodes = new Map<string, number>();
    /** Keys to type into a tab's TUI once it starts (the banner's /login or /logout). */
    private readonly _pendingTuiInput = new Map<string, string>();
    /** omp /login or /logout waiting on the chat banner that switches to the TUI to run it. */
    private _tuiAuthPrompt: TuiAuthCommand | undefined;
    /** Include the active editor's file/selection with each prompt (composer chip toggle). */
    private _editorContextEnabled: boolean;
    /** Last file-backed editor; survives focus moving into the chat view. */
    private readonly _fileEditor = new FileEditorTracker();
    private _editorContextTimer: NodeJS.Timeout | undefined;
    /** Mic dictation into the composer. */
    readonly voiceInput: VoiceInput;
    /** The voice agent's last state; while it is on (or starting) it owns the microphone, so dictation is off. */
    private _voiceStatus: VoiceStatus | undefined;

    private _prewarmedSession: {
        backend: AgentBackend;
        cwd: string;
        session: PiRpcSessionManager;
        readyPromise: Promise<void>;
    } | null = null;
    private _prewarmingInFlight = false;
    private _prewarmDebounceTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        extensionUri: vscode.Uri,
        initialSession: PiChatSession,
        initialDiffManager: DiffManager,
        initialCheckpointManager: CheckpointManager,
        outputChannel: vscode.OutputChannel,
        planDocument: PlanDocumentProvider,
        pastedStorageDir: string,
        workspaceState: vscode.Memento,
        statusBar?: StatusBarManager,
    ) {
        this._planDocument = planDocument;
        this._extensionUri = extensionUri;
        this._outputChannel = outputChannel;
        this._pastedStorageDir = pastedStorageDir;
        this._workspaceState = workspaceState;
        this._statusBar = statusBar;
        this.voiceInput = new VoiceInput(extensionUri, (message) => this._post(message), outputChannel);
        onVoiceReadinessChange(() => {
            this.sendStateSync();
        });
        this._tuiMode = workspaceState.get<boolean>(TUI_MODE_STATE_KEY, false);
        void vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.tuiMode', this._tuiMode);
        this._editorContextEnabled = workspaceState.get<boolean>(EDITOR_CONTEXT_STATE_KEY, true);
        this._fileEditor.onDidChange(() => this._scheduleEditorContextPost());
        this._scheduleEditorContextPost();

        try {
            this._currentBackend = resolveCliTarget().backend;
        } catch {
            this._currentBackend = 'pi';
        }

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('oh-my-pi-chater.favoriteModels')) {
                this.postModelFooter();
            }
        });
        onDidChangeWindowBackend((backend) => {
            if (this._currentBackend !== backend) {
                this._currentBackend = backend;
                clearCliTargetCache();
                this.invalidateSessionListCache();
                this.sendStateSync();
            }
        });

        const id = nextTabId();
        const tab = makeTabState(id, initialSession, initialDiffManager, initialCheckpointManager);
        this._updateTabName(tab);
        this._tabs.set(id, tab);
        this._activeTabId = id;
        this._subscribeTab(tab);
        tab.session.setExtensionUiBridge(this._extensionUi);
        this._schedulePrewarmSession(1500);
    }

    public get activeSession(): PiChatSession | undefined {
        return this._activeTab?.session;
    }

    private get _activeTab(): TabState {
        return this._tabs.get(this._activeTabId)!;
    }

    private _schedulePrewarmSession(delayMs = 500): void {
        if (this._prewarmDebounceTimer) {
            clearTimeout(this._prewarmDebounceTimer);
        }
        this._prewarmDebounceTimer = setTimeout(() => {
            this._prewarmDebounceTimer = undefined;
            void this._prewarmSession();
        }, delayMs);
    }

    private async _prewarmSession(): Promise<void> {
        if (this._prewarmingInFlight) return;
        const targetBackend = this._currentBackend;
        const targetCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

        if (
            this._prewarmedSession &&
            this._prewarmedSession.backend === targetBackend &&
            this._prewarmedSession.cwd === targetCwd
        ) {
            return;
        }

        if (this._prewarmedSession) {
            const old = this._prewarmedSession;
            this._prewarmedSession = null;
            void old.session.dispose();
        }

        this._prewarmingInFlight = true;
        try {
            const { PiRpcSessionManager } = await import('../pi/rpcSession');
            const session = new PiRpcSessionManager(this._outputChannel);
            const readyPromise = session.initialize(targetBackend, targetCwd);
            const entry = { backend: targetBackend, cwd: targetCwd, session, readyPromise };
            this._prewarmedSession = entry;
            await readyPromise;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`Background session pre-warm failed: ${msg}`);
            if (this._prewarmedSession?.session) {
                void this._prewarmedSession.session.dispose();
            }
            this._prewarmedSession = null;
        } finally {
            this._prewarmingInFlight = false;
        }
    }

    public async disposePrewarmedSession(): Promise<void> {
        if (this._prewarmDebounceTimer) {
            clearTimeout(this._prewarmDebounceTimer);
            this._prewarmDebounceTimer = undefined;
        }
        if (this._prewarmedSession) {
            const entry = this._prewarmedSession;
            this._prewarmedSession = null;
            await entry.session.dispose();
        }
    }

    private async _createEmptyTabState(preferredBackend?: AgentBackend): Promise<TabState> {
        const targetBackend = preferredBackend ?? this._currentBackend;
        const targetCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

        let session: PiRpcSessionManager;
        let readyPromise: Promise<void> | undefined;

        if (
            this._prewarmedSession &&
            this._prewarmedSession.backend === targetBackend &&
            this._prewarmedSession.cwd === targetCwd
        ) {
            const prewarmed = this._prewarmedSession;
            this._prewarmedSession = null;
            session = prewarmed.session;
            // The pre-warmed process applied the CLI default when it started; the default may have
            // changed since (chat model picker, settings panel), so re-apply it on hand-off.
            readyPromise = prewarmed.readyPromise.then(async () => {
                await applyPiCliDefaultModel(session).catch(() => false);
            });
        } else {
            if (this._prewarmedSession) {
                const old = this._prewarmedSession;
                this._prewarmedSession = null;
                void old.session.dispose();
            }
            const { PiRpcSessionManager } = await import('../pi/rpcSession');
            session = new PiRpcSessionManager(this._outputChannel);
            readyPromise = session.initialize(targetBackend, targetCwd);
        }

        const checkpoint = new CheckpointManager();
        const diff = new DiffManager(session, checkpoint);
        const tab = makeTabState(nextTabId(), session, diff, checkpoint);
        session.setExtensionUiBridge(this._extensionUi);
        this._wireRpcSessionUi(session);
        this._tabs.set(tab.id, tab);
        this._subscribeTab(tab);

        this._schedulePrewarmSession(300);

        if (readyPromise) {
            void readyPromise
                .then(() => {
                    if (this._tabs.has(tab.id)) {
                        this._updateTabName(tab);
                        if (this._activeTabId === tab.id) {
                            this.sendStateSync();
                            this.postModelFooter(tab);
                        }
                    }
                })
                .catch((err) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    this._outputChannel.appendLine(`Session initialization failed for tab ${tab.id}: ${msg}`);
                    tab.connectionStatus = { phase: 'failed', message: msg };
                    if (this._activeTabId === tab.id) {
                        this.sendStateSync();
                    }
                });
        }

        return tab;
    }

    private _resetTabUiState(tab: TabState): void {
        tab.diffManager.clearAll();
        tab.checkpointManager.clearAll();
        tab.turnCounter = 0;
        tab.suspendedMessages = [];
        tab.isStreaming = false;
        resetStreamingMessage(tab);
        tab.agentStartTime = 0;
        tab.messageMeta.clear();
        tab.voiceOrigins.resetSession();
        tab.queuedMessages = [];
        tab.steeringMessages = [];
        tab.followUpMessages = [];
        tab.pendingAttachments = [];
        tab.lastPlanEditorHash = '';
        tab.connectionStatus = idleConnection();
    }

    /** Restore the conversations that were open in this workspace when VS Code exited. */
    async restorePersistedTabs(backend?: AgentBackend): Promise<void> {
        const targetBackend = backend ?? this._currentBackend;
        const key = `${OPEN_TABS_STATE_KEY}.${targetBackend}`;
        let saved = this._workspaceState.get<PersistedOpenTabs>(key);
        if (!saved && targetBackend === this._currentBackend) {
            saved = this._workspaceState.get<PersistedOpenTabs>(OPEN_TABS_STATE_KEY);
        }
        if (!saved || saved.version !== 1 || !Array.isArray(saved.sessionPaths)) {
            return;
        }

        const sessionPaths = [...new Set(saved.sessionPaths.filter((value) => typeof value === 'string' && value.trim()))];
        if (sessionPaths.length === 0) {
            return;
        }

        this._restoringTabs = true;
        const initialTab = this._tabs.get(this._activeTabId);
        const restoredTabs: TabState[] = [];
        try {
            for (const sessionPath of sessionPaths) {
                const usesInitialTab = restoredTabs.length === 0 && !!initialTab && initialTab.session.messages.length === 0;
                const tab = usesInitialTab ? initialTab : await this._createEmptyTabState(targetBackend);
                try {
                    const restored = await tab.session.loadSession(sessionPath);
                    if (!restored) {
                        if (!usesInitialTab) await this._discardTab(tab);
                        continue;
                    }
                    this._resetTabUiState(tab);
                    const info = buildSessionInfoFromFile(sessionPath);
                    tab.name = info
                        ? getSessionDisplayTitle(info)
                        : DEFAULT_CONVERSATION_TITLE;
                    this._updateTabName(tab);
                    restoredTabs.push(tab);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    this._outputChannel.appendLine(`Restore open tab failed (${sessionPath}): ${message}`);
                    if (!usesInitialTab) await this._discardTab(tab);
                }
            }

            if (restoredTabs.length > 0) {
                const activePath = saved.activeSessionPath
                    ? canonicalizeSessionPath(saved.activeSessionPath)
                    : '';
                const activeTab = restoredTabs.find(
                    (tab) => canonicalizeSessionPath(tab.session.session?.sessionFile) === activePath,
                );
                this._activeTabId = (activeTab ?? restoredTabs[0]).id;
            }
        } finally {
            this._restoringTabs = false;
            await this._persistOpenTabs();
        }
    }

    private async _discardTab(tab: TabState): Promise<void> {
        await this._stopTui(tab.id);
        this._unsubscribeTab(tab.id);
        tab.diffManager.dispose();
        tab.checkpointManager.dispose();
        await tab.session.dispose();
        this._tabs.delete(tab.id);
    }

    private _schedulePersistOpenTabs(): void {
        if (this._restoringTabs) return;
        if (this._persistTabsTimer) clearTimeout(this._persistTabsTimer);
        this._persistTabsTimer = setTimeout(() => {
            this._persistTabsTimer = undefined;
            void this._persistOpenTabs();
        }, 250);
    }

    async flushPersistedTabs(): Promise<void> {
        if (this._persistTabsTimer) {
            clearTimeout(this._persistTabsTimer);
            this._persistTabsTimer = undefined;
        }
        await this._persistOpenTabs();
    }

    private async _persistOpenTabs(): Promise<void> {
        if (this._restoringTabs) return;
        const key = `${OPEN_TABS_STATE_KEY}.${this._currentBackend}`;
        const sessionPaths = [...this._tabs.values()]
            .map((tab) => tab.session.session?.sessionFile)
            .filter((value): value is string => !!value);
        const activeSessionPath = this._activeTab?.session.session?.sessionFile;
        const snapshot: PersistedOpenTabs = {
            version: 1,
            sessionPaths: [...new Set(sessionPaths)],
            activeSessionPath,
        };
        const serialized = JSON.stringify(snapshot);
        if (serialized === this._lastPersistedTabs) return;
        this._lastPersistedTabs = serialized;
        try {
            await this._workspaceState.update(key, snapshot);
            await this._workspaceState.update(OPEN_TABS_STATE_KEY, snapshot);
        } catch (err: unknown) {
            this._lastPersistedTabs = '';
            const message = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`Persist open tabs failed: ${message}`);
        }
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

        webviewView.webview.html = this._getHtml(webviewView.webview);
        this._extensionUi.setPost((m) => this._post(m));
        this._wireRpcSessionUi(this._activeTab.session);
        for (const tab of this._tabs.values()) {
            if (!this._tabSubscriptions.has(tab.id)) {
                this._subscribeTab(tab);
            }
        }

        webviewView.webview.onDidReceiveMessage((msg: ClientMessage) => {
            if (msg.type === 'voiceAgent') {
                this._voiceActions.fire(msg.action);
                return;
            }
            this._handleMessage(msg);
        });

        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) return;
            this._view = webviewView;
            this._refreshVisibleWebview();
            // Hidden (retained) webviews drop every message: repaint terminals from the mirrors.
            this._resyncTuiViews();
        });

        webviewView.onDidDispose(() => {
            // Tab subscriptions belong to the provider/session lifecycle, not the transient
            // webview lifecycle. Clearing them here makes hidden conversations stop syncing.
            if (this._view === webviewView) {
                this._view = undefined;
            }
        });

        this._refreshVisibleWebview();
        void this.warmSessionListCache();
    }

    private _refreshVisibleWebview(): void {
        this._post({ type: 'ready' });
        if (this._sessionPanelOpen) {
            this._post({ type: 'sessionPanel', open: true });
            void this.loadSessionListForPanel('');
        }
        this._postEditorContext();
        void this.pushStateSync().then(() => this.postModelFooter());
    }

    private _wireRpcSessionUi(session: PiChatSession): void {
        if (!(session instanceof PiRpcSessionManager)) {
            return;
        }
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

    private _subscribeTab(tab: TabState): void {
        const unsubs: (() => void)[] = [];

        unsubs.push(
            tab.session.events.onAll((event) => {
                this._handleTabEvent(tab, event);
                // After the tab's own bookkeeping, so status() is current inside listeners.
                this._tabEvent.fire({ tabId: tab.id, event });
            }),
        );

        const requests = tab.session.rpcExtensionUi.onDidChangePending(() => this._requestsChanged.fire(tab.id));
        unsubs.push(() => requests.dispose());

        unsubs.push(
            tab.diffManager.onFileChange((change) => {
                if (tab.id === this._activeTabId) {
                    this._post({ type: 'fileChange', change });
                }
            }),
        );

        tab.session.setToolApprovalHandler(async (toolCallId, toolName, args) => {
            return this._requestToolApproval(tab, toolCallId, toolName, args);
        });

        this._tabSubscriptions.set(tab.id, unsubs);
    }

    private _unsubscribeTab(tabId: string): void {
        const unsubs = this._tabSubscriptions.get(tabId);
        if (unsubs) {
            for (const unsub of unsubs) unsub();
            this._tabSubscriptions.delete(tabId);
        }
    }

    private _handleTabEvent(tab: TabState, event: any): void {
        const isActive = tab.id === this._activeTabId;

        if (event.type === 'agent_start') {
            tab.abortInFlight = false;
            tab.connectionStatus = idleConnection();
            tab.isStreaming = true;
            resetStreamingMessage(tab);
            tab.agentStartTime = Date.now();
            if (isActive) {
                vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', true);
            }
        }

        if (event.type === 'agent_end') {
            // Before the agent_end stateSync below, so throwaway files the agent deleted never linger in the bar.
            tab.diffManager.pruneSettledChanges();
        }

        if (event.type === 'auto_retry_start') {
            tab.connectionStatus = {
                phase: 'retrying',
                message: event.errorMessage ?? 'Connection error',
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
            };
            tab.isStreaming = true;
            if (isActive) {
                vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', true);
            }
        }

        if (event.type === 'auto_retry_end') {
            if (event.success) {
                tab.connectionStatus = idleConnection();
            } else {
                tab.connectionStatus = {
                    phase: 'failed',
                    message:
                        event.finalError ??
                        'Could not reach the model after multiple attempts.',
                    attempt: event.attempt,
                };
            }
        }

        if (event.type === 'compaction_end' && event.errorMessage && !event.willRetry) {
            tab.connectionStatus = {
                phase: 'failed',
                message: event.errorMessage,
            };
        }

        if (event.type === 'queue_update') {
            tab.steeringMessages = Array.isArray(event.steering)
                ? event.steering.map(String)
                : [];
            tab.followUpMessages = Array.isArray(event.followUp)
                ? event.followUp.map(String)
                : [];
        }

        if (event.type === 'message_start' && event.message?.role === 'user') {
            // The ordinal only keys messages without a timestamp; count like the assistant ordinal below.
            const started = event.message;
            let ordinal = 0;
            for (const m of tab.session.getMessages()) {
                if (m.role === 'user' && (started.timestamp === undefined || m.timestamp !== started.timestamp)) {
                    ordinal++;
                }
            }
            if (tab.voiceOrigins.claim(started, ordinal)) {
                started._fromVoice = true;
            }
        }

        // omp never emits queue_update: a delivered steer arrives as a user message marked
        // `steering`, which is the only signal that it left the queue.
        if (event.type === 'message_start' && event.message?.role === 'user' && event.message.steering === true) {
            const content = event.message.content;
            const text = typeof content === 'string'
                ? content
                : Array.isArray(content)
                  ? content.filter((c: { type?: string }) => c.type === 'text').map((c: { text?: string }) => c.text ?? '').join('')
                  : '';
            const idx = tab.steeringMessages.indexOf(text);
            tab.steeringMessages = tab.steeringMessages.filter((_, i) => i !== (idx >= 0 ? idx : 0));
        }

        if (event.type === 'message_start' && event.message?.role === 'assistant') {
            resetStreamingMessage(tab);
        }

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
            // The message list refreshes asynchronously after message_end, so it may not hold the
            // ended message yet: its ordinal is the count of the other assistant messages.
            const ended = event.message;
            let ordinal = 0;
            for (const m of tab.session.getMessages()) {
                if (m.role === 'assistant' && (ended.timestamp === undefined || m.timestamp !== ended.timestamp)) {
                    ordinal++;
                }
            }
            if (tab.thinkingStartTime > 0 && !tab.streamingThinkingDuration) {
                tab.streamingThinkingDuration = Math.round((Date.now() - tab.thinkingStartTime) / 1000);
            }
            tab.messageMeta.set(ordinal, {
                thinkingDurationSec: tab.streamingThinkingDuration,
                messageEndTime: Date.now(),
            });
            resetStreamingMessage(tab);
        }

        if (event.type === 'agent_end') {
            tab.abortInFlight = false;
            const willRetry = event.willRetry === true;
            if (willRetry) {
                const lastAssistant = lastAssistantFromMessages(event.messages);
                tab.connectionStatus = {
                    phase: 'retrying',
                    message:
                        (typeof lastAssistant?.errorMessage === 'string'
                            ? lastAssistant.errorMessage
                            : undefined) ?? 'Connection lost — retrying…',
                    attempt: tab.session.session?.retryAttempt,
                    maxAttempts: undefined,
                };
                tab.isStreaming = true;
            } else {
                const failed = failedStatusFromAssistant(
                    lastAssistantFromMessages(event.messages),
                );
                tab.connectionStatus = failed ?? idleConnection();
                tab.isStreaming = false;
                resetStreamingMessage(tab);
                tab.agentStartTime = 0;
                if (isActive) {
                    vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', false);
                } else {
                    tab.hasNotification = true;
                }
            }
        }

        if (event.type === 'message_update' && event.assistantMessageEvent && !tab.abortInFlight) {
            const ae = event.assistantMessageEvent;
            switch (ae.type) {
                case 'thinking_start':
                    tab.isThinking = true;
                    if (tab.streamingThinking.trim().length > 0) {
                        tab.streamingThinking += '\n\n';
                    } else {
                        tab.streamingThinking = '';
                    }
                    tab.thinkingStartTime = Date.now();
                    tab.streamingThinkingDuration = 0;
                    break;
                case 'thinking_delta':
                    tab.streamingThinking += ae.delta ?? '';
                    break;
                case 'thinking_end':
                    tab.isThinking = false;
                    if (tab.thinkingStartTime > 0) {
                        tab.streamingThinkingDuration = Math.round(
                            (Date.now() - tab.thinkingStartTime) / 1000
                        );
                    }
                    break;
                case 'text_delta':
                    tab.streamingText += ae.delta ?? '';
                    break;
            }
        }

        this._updateTabName(tab);

        if (isActive) {
            this._post({ type: 'agentEvent', event: safeSerialize(event) });

            if (
                event.type === 'agent_start' ||
                event.type === 'agent_end' ||
                event.type === 'message_end' ||
                event.type === 'turn_end' ||
                event.type === 'tool_execution_end' ||
                event.type === 'auto_retry_start' ||
                event.type === 'auto_retry_end' ||
                event.type === 'compaction_end' ||
                event.type === 'queue_update' ||
                (event.type === 'message_start' && event.message?.steering === true)
            ) {
                void this.pushStateSync();
            } else if (event.type === 'context_usage') {
                void this.pushStateSync();
            }
        } else if (
            event.type === 'agent_start' ||
            event.type === 'agent_end' ||
            event.type === 'turn_end'
        ) {
            void this.pushStateSync();
        }

    }

    private _updateTabName(tab: TabState, pendingPrompt?: string): boolean {
        const messages = tab.session.getMessages();
        const title = deriveConversationTitle(
            tab.session.session?.sessionName,
            messages,
            pendingPrompt,
        );
        if (!title) {
            const isIdle = !tab.isStreaming && !tab.session.session?.isStreaming;
            if (isIdle && messages.length === 0 && tab.name !== DEFAULT_CONVERSATION_TITLE) {
                tab.name = DEFAULT_CONVERSATION_TITLE;
                return true;
            }
            return false;
        }
        if (tab.name === title) {
            return false;
        }
        tab.name = title;
        return true;
    }

    /** Stop generation in the active chat tab (webview Stop / Esc). */
    async abortActiveTab(): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) {
            return;
        }
        await this._abortActiveTab(tab);
    }

    // ---- WorkerController: voice agent task control (docs/voice-agent-design.md §5.11) ----

    private readonly _activeTaskChanged = new vscode.EventEmitter<WorkerTask | undefined>();
    readonly onActiveTaskChanged = this._activeTaskChanged.event;
    private _lastActiveTask: WorkerTask | undefined;
    private readonly _tabEvent = new vscode.EventEmitter<{ tabId: string; event: WorkerEvent }>();
    readonly onTabEvent = this._tabEvent.event;
    private readonly _requestsChanged = new vscode.EventEmitter<string>();
    readonly onRequestsChanged = this._requestsChanged.event;

    activeTask(): WorkerTask | undefined {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) {
            return undefined;
        }
        const model = tab.session.session?.model;
        return {
            tabId: tab.id,
            name: tab.name,
            backend: tab.session.backend,
            sessionFile: tab.session.session?.sessionFile,
            model: model && `${model.provider}/${model.id}`,
        };
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
        await tab.session.waitUntilReady();
        const attachments = options.includeEditorContext ? this._editorContextAttachments(true) : [];

        if (!this._uiIsStreaming(tab)) {
            await this._beginPrompt(tab, trimmed, attachments, true);
            return 'started';
        }
        if (options.when === 'after') {
            tab.queuedMessages.push({ text: trimmed, attachments, fromVoice: true });
            void this.pushStateSync();
            return 'queued';
        }
        const { text: composed, images } = composePrompt(trimmed, attachments);
        tab.steeringMessages = [...tab.steeringMessages, composed];
        tab.voiceOrigins.expect(composed);
        void this.pushStateSync();
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
        await this._abortActiveTab(this._workerTab(tabId));
    }

    status(tabId: string): WorkerStatus {
        const tab = this._workerTab(tabId);
        const queued = tab.queuedMessages.length;
        const busy = this._uiIsStreaming(tab);
        const elapsedMs = busy && tab.agentStartTime ? Date.now() - tab.agentStartTime : undefined;
        if (this.pendingRequests(tabId).length > 0) {
            return { phase: 'awaiting', elapsedMs, queued };
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

    /** Tabs are addressed by id; a closed tab, or one in the other backend's workspace, is gone. */
    private _workerTab(tabId: string): TabState {
        const tab = this._tabs.get(tabId);
        if (!tab) {
            throw new Error(`Worker tab ${tabId} is closed`);
        }
        return tab;
    }

    /** Start a new worker turn: composer send and voice `send` on an idle worker. */
    private async _beginPrompt(
        tab: TabState,
        text: string,
        attachments: PendingAttachment[],
        fromVoice = false,
    ): Promise<void> {
        this._startTurn(tab);
        tab.isStreaming = true;
        if (tab.id === this._activeTabId) {
            vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', true);
            this.sendStateSync();
        }
        try {
            await this._dispatchPrompt(tab, text, attachments, fromVoice);
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            tab.connectionStatus = { phase: 'failed', message: errMsg };
            throw err;
        }
        void this.pushStateSync();
    }

    private _startTurn(tab: TabState): void {
        if (tab.checkpointManager.rollbackPoint !== null) {
            tab.checkpointManager.discardSuspended();
            tab.diffManager.discardSuspended();
            tab.suspendedMessages = [];
        }
        tab.turnCounter++;
        const turnIdx = tab.turnCounter;
        tab.checkpointManager.startTurn(turnIdx);
        tab.diffManager.setCurrentTurn(turnIdx);
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
        if (this._updateTabName(tab, userText || text) && tab.id === this._activeTabId) {
            this.sendStateSync();
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
    private _maybeDrainQueuedMessages(tab: TabState, isActive: boolean): void {
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

    private _uiIsStreaming(tab: TabState): boolean {
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
                this.sendStateSync();
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
                    this.sendStateSync();
                }
                await this._runNextQueuedPrompt(tab, isActive);
                return;
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`Queued slash command failed: ${msg}`);
            if (isActive) {
                this._post({ type: 'error', message: msg });
            }
            await this._runNextQueuedPrompt(tab, isActive);
            return;
        }

        this._updateTabName(tab, item.text || text);
        this._startTurn(tab);
        tab.isStreaming = true;
        if (isActive) {
            vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', true);
            this.sendStateSync();
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
            this._outputChannel.appendLine(`Queued prompt failed: ${msg}`);
            if (isActive) {
                this._post({ type: 'error', message: msg });
                vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', false);
                this.sendStateSync();
            }
        } finally {
            if (!tab.session.session?.isStreaming && !tab.isStreaming) {
                this._maybeDrainQueuedMessages(tab, isActive);
            }
        }
    }

    private async _abortActiveTab(tab: TabState): Promise<void> {
        tab.abortInFlight = true;
        tab.isStreaming = false;
        tab.streamingText = '';
        tab.streamingThinking = '';
        tab.isThinking = false;
        tab.thinkingStartTime = 0;
        tab.streamingThinkingDuration = 0;
        tab.agentStartTime = 0;
        tab.connectionStatus = idleConnection();
        if (tab.session.session) {
            tab.session.session.isStreaming = false;
            tab.session.session.isRetrying = false;
        }
        if (tab.id === this._activeTabId) {
            vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', false);
            this.sendStateSync();
        }

        try {
            await tab.session.abort();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`Abort: ${msg}`);
            if (tab.id === this._activeTabId) {
                this._post({ type: 'error', message: msg });
            }
        } finally {
            tab.abortInFlight = false;
            tab.isStreaming = false;
            if (tab.session.session) {
                tab.session.session.isStreaming = false;
                tab.session.session.isRetrying = false;
            }
            const isActive = tab.id === this._activeTabId;
            if (isActive) {
                vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', false);
                this.sendStateSync();
            }
            if (!tab.suppressQueueDrain) {
                this._maybeDrainQueuedMessages(tab, isActive);
            }
        }
    }

    /** Pull latest messages/model from Pi RPC, then push to webview (avoids stale/laggy chat). */
    async pushStateSync(): Promise<void> {
        const tab = this._activeTab;
        if (!tab) {
            return;
        }
        if (tab.session instanceof PiRpcSessionManager) {
            try {
                await tab.session.syncFromRpc();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this._outputChannel.appendLine(`RPC sync before state push: ${msg}`);
            }
        }
        this._updateTabName(tab);
        this.sendStateSync();
    }

    postModelFooter(tab?: TabState): void {
        const t = tab ?? this._activeTab;
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
    async openSessionPanel(): Promise<void> {
        if (!this._sessionPanelOpen) {
            this._sessionPanelOpen = true;
            this._post({ type: 'sessionPanel', open: true });
        }
        await this.loadSessionListForPanel('');
    }

    toggleSessionPanel(): void {
        if (this._sessionPanelOpen) {
            this.closeSessionPanel();
            return;
        }
        void this.openSessionPanel();
    }

    closeSessionPanel(): void {
        this._sessionPanelOpen = false;
        this._post({ type: 'sessionPanel', open: false });
    }

    async openSessionTree(): Promise<void> {
        this._sessionTreeOpen = true;
        this._post({ type: 'sessionTree', open: true });
        await this.loadSessionTree();
    }

    closeSessionTree(): void {
        this._sessionTreeOpen = false;
        this._post({ type: 'sessionTree', open: false });
    }

    toggleSessionTree(): void {
        if (this._sessionTreeOpen) {
            this.closeSessionTree();
            return;
        }
        void this.openSessionTree();
    }

    async loadSessionTree(): Promise<void> {
        const tab = this._activeTab;
        if (!tab || !(tab.session instanceof PiRpcSessionManager)) {
            return;
        }
        try {
            const { tree, leafId } = await tab.session.getSessionTree();
            const { formatSessionTree } = await import('../pi/sessionTree');
            const nodes = formatSessionTree(tree, leafId);
            this._post({
                type: 'sessionTree',
                open: true,
                data: { nodes, leafId },
            });
        } catch (err: any) {
            this._post({
                type: 'sessionTree',
                open: true,
                data: { nodes: [], leafId: null, error: err?.message || String(err) },
            });
        }
    }

    async forkSessionTree(entryId: string, summarize?: boolean, customInstructions?: string): Promise<void> {
        const tab = this._activeTab;
        if (!tab || !(tab.session instanceof PiRpcSessionManager)) {
            return;
        }
        try {
            if (summarize) {
                vscode.window.setStatusBarMessage('Branching with summarization...', 3000);
            }
            const res = await tab.session.forkFromMessage(entryId);
            if (!res.cancelled) {
                this.closeSessionTree();
                await this.pushStateSync();
                vscode.window.showInformationMessage('Navigated to selected session branch.');
            }
        } catch (err: any) {
            const rawErr = err?.message || String(err);
            if (rawErr.includes('Invalid entry ID for forking')) {
                vscode.window.showWarningMessage('Please select a User message node to fork/branch from this point.');
            } else {
                vscode.window.showErrorMessage(`Failed to branch session: ${rawErr}`);
            }
        }
    }

    /**
     * Folder + backend whose sessions the panel lists for `tab`. A TUI owns its tab's folder and
     * backend (resume can move it to another project/CLI without touching the idle RPC session).
     */
    private sessionListTarget(tab: TabState): SessionListTarget {
        const tui = this._tuiMode ? this._tuiProcesses.get(tab.id) : undefined;
        if (tui) {
            return {
                cwd: resolvePiWorkspaceCwd(tui.cwd),
                layout: getAgentLayout(tui.backend),
                currentSessionPath: tui.sessionFile,
            };
        }
        const backend = tab.session instanceof PiRpcSessionManager ? tab.session.backend : this._currentBackend;
        return {
            cwd: resolvePiWorkspaceCwd(tab.session.session?.cwd),
            layout: getAgentLayout(backend),
            currentSessionPath: tab.session.session?.sessionFile,
        };
    }

    private sessionListCacheKey(target: SessionListTarget): string {
        return `${target.layout.agentDir}\0${target.cwd}`;
    }

    private invalidateSessionListCache(): void {
        this._sessionListEpoch++;
        this._sessionListCache.clear();
        this._sessionListInFlight.clear();
        clearSessionInfoCache();
    }

    /** List from disk (per-file metadata is mtime-cached, so repeat listings are cheap); dedupes concurrent reads. */
    private fetchSessionList(
        target: SessionListTarget,
        onProgress?: (loaded: number, total: number) => void,
    ): Promise<SessionInfo[]> {
        const key = this.sessionListCacheKey(target);
        const inFlight = this._sessionListInFlight.get(key);
        if (inFlight) {
            return inFlight;
        }
        const epoch = this._sessionListEpoch;
        const pending = listPiSessionsForCwdAsync(target.cwd, target.layout, onProgress)
            .then((sessions) => {
                if (epoch === this._sessionListEpoch) {
                    this._sessionListCache.set(key, sessions);
                }
                return sessions;
            })
            .finally(() => {
                if (this._sessionListInFlight.get(key) === pending) {
                    this._sessionListInFlight.delete(key);
                }
            });
        this._sessionListInFlight.set(key, pending);
        return pending;
    }

    /** Preload current-folder session list so the resume panel opens instantly. */
    warmSessionListCache(): Promise<void> {
        const tab = this._activeTab;
        if (!tab) {
            return Promise.resolve();
        }
        const target = this.sessionListTarget(tab);
        if (this._sessionListCache.has(this.sessionListCacheKey(target))) {
            return Promise.resolve();
        }
        return this.fetchSessionList(target).then(
            () => undefined,
            () => undefined, // warm is best-effort
        );
    }

    private postSessionListPayload(
        target: SessionListTarget,
        sessions: SessionInfo[],
        query: string,
        loading: boolean,
        progress?: { loaded: number; total: number },
        error?: string,
    ): void {
        const items = loading ? [] : buildSessionListRows(sessions, query, target.currentSessionPath);
        this._post({
            type: 'sessionList',
            data: {
                workspaceCwd: target.cwd,
                items,
                backend: target.layout.backend,
                loading,
                progress,
                error,
            },
        });
    }

    /** Lists only the active tab's folder (the CLI's own `/resume` current-folder scope). */
    async loadSessionListForPanel(query: string): Promise<void> {
        const tab = this._activeTab;
        if (!tab || !this._sessionPanelOpen) {
            return;
        }

        this._sessionPanelQuery = query;
        const generation = ++this._sessionListGeneration;
        const isStale = (): boolean => generation !== this._sessionListGeneration || !this._sessionPanelOpen;
        const target = this.sessionListTarget(tab);

        // Stale-while-revalidate: sessions are created/extended outside this panel (TUI, other windows).
        const cached = this._sessionListCache.get(this.sessionListCacheKey(target));
        this.postSessionListPayload(target, cached ?? [], query, !cached);

        try {
            const sessions = await this.fetchSessionList(
                target,
                cached
                    ? undefined
                    : (loaded, total) => {
                          if (!isStale()) {
                              this.postSessionListPayload(target, [], query, true, { loaded, total });
                          }
                      },
            );
            if (!isStale()) {
                this.postSessionListPayload(target, sessions, query, false);
            }
        } catch (err: unknown) {
            if (isStale()) {
                return;
            }
            const message = err instanceof Error ? err.message : String(err);
            this.postSessionListPayload(target, [], query, false, undefined, message);
        }
    }

    private async resumeSessionFromPanel(sessionPath: string): Promise<void> {
        const tab = this._activeTab;
        if (!tab || !sessionPath) {
            return;
        }

        const { canonicalizeSessionPath, buildSessionInfoFromFile, getSessionDisplayTitle } = await import('../pi/sessionCatalog');
        const currentPath = tab.session.session?.sessionFile;
        if (
            currentPath &&
            canonicalizeSessionPath(currentPath) === canonicalizeSessionPath(sessionPath)
        ) {
            this.closeSessionPanel();
            return;
        }

        this.closeSessionPanel();
        this._post({ type: 'toast', message: 'Resuming session…', variant: 'info' });

        const sessionInfo = buildSessionInfoFromFile(sessionPath);
        const targetBackend: AgentBackend =
            sessionPath.includes('/.omp/agent/') || sessionPath.includes('\\.omp\\agent\\')
                ? 'omp'
                : 'pi';
        const targetCwd = sessionInfo?.cwd;
        this._currentBackend = targetBackend;

        if (this._tuiMode) {
            await this._stopTui(tab.id);
            tab.name = sessionInfo ? getSessionDisplayTitle(sessionInfo) : DEFAULT_CONVERSATION_TITLE;
            this._updateTabName(tab);
            await this._startTui(tab.id, 80, 24, sessionPath, targetCwd, targetBackend);
            await this.pushStateSync();
            const label = sessionInfo ? getSessionDisplayTitle(sessionInfo) : 'session';
            vscode.window.showInformationMessage(`Resumed session: ${label}`);
            return;
        }

        const currentCwd = tab.session.session?.cwd;
        const needsRecreate =
            (tab.session instanceof PiRpcSessionManager && tab.session.backend !== targetBackend) ||
            (targetCwd && currentCwd && targetCwd !== currentCwd);

        if (needsRecreate) {
            try {
                const { createPiChatSession } = await import('../pi/rpcSession');
                const newSession = await createPiChatSession(this._outputChannel, targetBackend, targetCwd);
                this._unsubscribeTab(tab.id);
                await tab.session.dispose?.();
                tab.session = newSession;
                tab.session.setExtensionUiBridge(this._extensionUi);
                this._wireRpcSessionUi(newSession);
                this._subscribeTab(tab);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this._outputChannel.appendLine(`Failed to switch backend/cwd to ${targetBackend} (${targetCwd}) for resume: ${msg}`);
            }
        }

        try {
            let resumed = await tab.session.loadSession(sessionPath);
            if (!resumed) {
                if (targetCwd && targetCwd !== tab.session.session?.cwd) {
                    const { createPiChatSession } = await import('../pi/rpcSession');
                    const newSession = await createPiChatSession(this._outputChannel, targetBackend, targetCwd);
                    this._unsubscribeTab(tab.id);
                    await tab.session.dispose?.();
                    tab.session = newSession;
                    tab.session.setExtensionUiBridge(this._extensionUi);
                    this._wireRpcSessionUi(newSession);
                    this._subscribeTab(tab);
                    resumed = await tab.session.loadSession(sessionPath);
                }
            }

            if (!resumed) {
                this._post({
                    type: 'toast',
                    message: 'Resume cancelled.',
                    variant: 'error',
                });
                return;
            }

            this.invalidateSessionListCache();
            void this.warmSessionListCache();
            tab.diffManager.clearAll();
            tab.checkpointManager.clearAll();
            tab.turnCounter = 0;
            tab.name = sessionInfo
                ? getSessionDisplayTitle(sessionInfo)
                : DEFAULT_CONVERSATION_TITLE;
            tab.suspendedMessages = [];
            tab.isStreaming = false;
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.thinkingStartTime = 0;
            tab.streamingThinkingDuration = 0;
            tab.agentStartTime = 0;
            tab.messageMeta.clear();
            tab.voiceOrigins.resetSession();
            tab.queuedMessages = [];
            tab.lastPlanEditorHash = '';
            tab.connectionStatus = idleConnection();
            this._updateTabName(tab);
            await this.pushStateSync();
            this.postModelFooter(tab);

            const label = sessionInfo ? getSessionDisplayTitle(sessionInfo) : 'session';
            vscode.window.showInformationMessage(`Resumed session: ${label}`);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`Resume session failed: ${message}`);
            this._post({ type: 'toast', message: `Failed to resume session: ${message}`, variant: 'error' });
        }
    }

    private removeSessionFromListCache(sessionPath: string): void {
        const canon = canonicalizeSessionPath(sessionPath);
        for (const [key, list] of this._sessionListCache) {
            this._sessionListCache.set(
                key,
                list.filter((s) => canonicalizeSessionPath(s.path) !== canon),
            );
        }
        invalidateSessionInfoPath(sessionPath);
    }

    private async deleteSessionFromPanel(sessionPath: string): Promise<void> {
        const tab = this._activeTab;
        if (!tab || !sessionPath) {
            return;
        }

        const currentPath = tab.session.session?.sessionFile;
        if (
            currentPath &&
            canonicalizeSessionPath(currentPath) === canonicalizeSessionPath(sessionPath)
        ) {
            this._post({
                type: 'toast',
                message: 'Cannot delete the currently active session',
                variant: 'error',
            });
            return;
        }

        const result = await deleteSessionFile(sessionPath);
        if (!result.ok) {
            this._post({
                type: 'toast',
                message: `Failed to delete: ${result.error}`,
                variant: 'error',
            });
            return;
        }

        this.removeSessionFromListCache(sessionPath);
        const msg = result.method === 'trash' ? 'Session moved to trash' : 'Session deleted';
        this._post({ type: 'toast', message: msg, variant: 'info' });
        await this.loadSessionListForPanel(this._sessionPanelQuery);
    }

    private async renameSessionFromPanel(sessionPath: string, name: string): Promise<void> {
        const tab = this._activeTab;
        if (!tab || !sessionPath) {
            return;
        }

        const trimmed = name.trim();
        if (!trimmed) {
            this._post({ type: 'toast', message: 'Session name cannot be empty', variant: 'error' });
            return;
        }

        const currentPath = tab.session.session?.sessionFile;
        const isCurrent =
            !!currentPath &&
            canonicalizeSessionPath(currentPath) === canonicalizeSessionPath(sessionPath);

        try {
            if (isCurrent) {
                await tab.session.setSessionName(trimmed);
                if (tab.session.session) {
                    tab.session.session.sessionName = trimmed;
                }
                this._updateTabName(tab);
                await this.pushStateSync();
            } else {
                appendSessionDisplayName(sessionPath, trimmed);
            }
            invalidateSessionInfoPath(sessionPath);
            this.invalidateSessionListCache();
            void this.warmSessionListCache();
            this._post({ type: 'toast', message: 'Session renamed', variant: 'info' });
            await this.loadSessionListForPanel(this._sessionPanelQuery);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toast', message: `Failed to rename: ${message}`, variant: 'error' });
        }
    }

    sendStateSync(): void {
        this._noteActiveTask();
        const tab = this._activeTab;
        if (!tab) return;

        const state = tab.session.serializeState();
        state.isStreaming = this._uiIsStreaming(tab);
        if (tab.suspendedMessages.length > 0) {
            state.messages = [
                ...state.messages,
                ...tab.suspendedMessages.map((m: any) => safeSerialize(m)),
            ];
        }
        state.fileChanges = tab.diffManager.fileChanges;
        state.rollbackPoint = tab.checkpointManager.rollbackPoint;
        state.tabs = this._getTabInfos();
        state.activeTabId = this._activeTabId;
        state.tuiMode = this._tuiMode;
        state.tuiAuthPrompt = this._tuiAuthPrompt;
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

        const planModeBase = tab.session.getPlanModeInfo();
        const chrome =
            tab.session instanceof PiRpcSessionManager
                ? tab.session.extensionChrome.getSnapshot()
                : undefined;
        let planMode = enrichPlanModeFromExtensionChrome(planModeBase, chrome);
        if (tab.planModeOverride !== undefined) {
            const override = tab.planModeOverride;
            planMode = {
                ...planMode,
                enabled: override === 'plan',
                statusLabel:
                    override === 'plan'
                        ? planMode.hasPlan
                            ? 'ready'
                            : 'planning'
                        : 'off',
            };
        }
        const session = tab.session.session;
        const rpivTasks = extractRpivTodoTasks(session);
        const mergedPlan = mergePlanWithRpivTodos(planMode.planMarkdown, rpivTasks);
        state.planMode = {
            ...planMode,
            planMarkdown: mergedPlan,
            todos: rpivTasks.length > 0 ? rpivTasksToPlanTodos(rpivTasks) : planMode.todos,
        };
        state.piExtensionChrome = chrome;
        state.connectionStatus = tab.connectionStatus;
        const sessionId = session?.sessionId ?? 'default';
        this._planDocument.setPlanContent(sessionId, mergedPlan);
        const planBody = mergedPlan.trim();
        // Pop the editor only while pi-plan-mode is drafting. After the plan is implemented the
        // todo Progress section keeps changing the body and would reopen it on every update.
        const planModeActive =
            tab.session instanceof PiRpcSessionManager && tab.session.backend === 'pi' && planMode.enabled;
        if (planModeActive && planMode.hasPlan && planBody) {
            const hash = hashPlanMarkdown(planBody);
            if (tab.lastPlanEditorHash !== hash) {
                tab.lastPlanEditorHash = hash;
                void openPlanDocument(this._planDocument, sessionId);
            }
        } else if (!planMode.hasPlan) {
            tab.lastPlanEditorHash = '';
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
        state.activeBackend = this._currentBackend;
        state.availableBackends = getAvailableBackends();
        state.voiceReadiness = voiceReadiness();
        state.voice = this._voiceStatus;
        this._post({ type: 'stateSync', state });
        this._statusBar?.setSession(tab.session);
        this._schedulePersistOpenTabs();
        this._maybeDrainQueuedMessages(tab, true);
    }

    /** Voice mode owns the microphone while on or starting: stop dictation; the composer mic shows its level instead. */
    setVoiceStatus(status: VoiceStatus): void {
        const wasOn = this._voiceStatus !== undefined && (this._voiceStatus.phase !== 'off' || this._voiceStatus.starting);
        const on = status.phase !== 'off' || status.starting;
        this._voiceStatus = status;
        if (on !== wasOn) {
            void this.voiceInput.setBlocked(on);
        }
        this._post({ type: 'voiceStatus', status });
    }

    postVoiceLevel(level: number, source: VoiceLevelSource, wave?: number[]): void {
        this._post({ type: 'voiceLevel', level, source, wave });
    }

    /** Attach local paths (Explorer tree drop or legacy webview path). */
    async attachPaths(paths: string[]): Promise<void> {
        const tab = this._activeTab;
        const unique = [...new Set(paths.filter((p) => p.trim().length > 0))];
        if (unique.length === 0) {
            return;
        }

        const key = unique.sort().join('\0');
        const now = Date.now();
        if (key === this._lastAttachKey && now - this._lastAttachMs < 400) {
            return;
        }
        this._lastAttachKey = key;
        this._lastAttachMs = now;

        const cwd =
            tab.session.session?.cwd ??
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
            process.cwd();
        const processed = await processFilePaths(unique, cwd);
        if (processed.length === 0) {
            vscode.window.showWarningMessage(
                'Oh My Pi Chater: dropped files could not be read or are unsupported.',
            );
            return;
        }
        const existing = new Set(tab.pendingAttachments.map((a) => a.displayName));
        for (const item of processed) {
            if (existing.has(item.displayName)) {
                continue;
            }
            existing.add(item.displayName);
            tab.pendingAttachments.push(toPendingAttachment(item));
        }
        this.sendStateSync();
    }

    private _scheduleEditorContextPost(): void {
        clearTimeout(this._editorContextTimer);
        this._editorContextTimer = setTimeout(() => this._postEditorContext(), 100);
    }

    private _postEditorContext(): void {
        const editor = this._fileEditor.editor;
        const context: EditorContextInfo | null = editor
            ? {
                  filePath: editor.document.uri.fsPath,
                  displayPath: vscode.workspace.asRelativePath(editor.document.uri, false),
                  ...selectedLineRange(editor.selection),
              }
            : null;
        this._post({ type: 'editorContext', context, enabled: this._editorContextEnabled });
    }

    /** Editor file/selection captured at send time; empty without a file editor, or when excluded unless `evenIfExcluded`. */
    private _editorContextAttachments(evenIfExcluded = false): PendingAttachment[] {
        const editor = this._fileEditor.editor;
        if (!editor || (!this._editorContextEnabled && !evenIfExcluded)) {
            return [];
        }
        const filePath = editor.document.uri.fsPath;
        const lines = selectedLineRange(editor.selection);
        return [
            {
                id: 'editor-context',
                displayName: vscode.workspace.asRelativePath(editor.document.uri, false),
                isImage: false,
                absolutePath: filePath,
                textFragment: buildEditorContextFragment(
                    filePath,
                    lines && { ...lines, text: editor.document.getText(editor.selection) },
                ),
            },
        ];
    }

    private async pickAttachmentsDialog(): Promise<void> {
        const tab = this._activeTab;
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach',
            title: 'Attach files or images',
        });
        if (!uris?.length) {
            return;
        }
        await this.attachPaths(uris.map((u) => u.fsPath));
    }

    async attachPastedImages(items: PastedImageInput[]): Promise<void> {
        if (!items.length) {
            return;
        }
        const tab = this._activeTab;
        const processed = await processPastedImages(items, this._pastedStorageDir);
        for (const item of processed) {
            tab.pendingAttachments.push(toPendingAttachment(item));
        }
        this.sendStateSync();
    }

    async attachDroppedTextFiles(files: { name: string; text: string }[]): Promise<void> {
        const tab = this._activeTab;
        let added = false;
        for (const file of files) {
            if (!file.text?.trim()) {
                continue;
            }
            tab.pendingAttachments.push(toPendingTextFileAttachment(file.name, file.text));
            added = true;
        }
        if (added) {
            this.sendStateSync();
        }
    }

    private _getTabInfos(): TabInfo[] {
        return [...this._tabs.entries()].map(([id, tab]) => ({
            id,
            name: tab.name,
            isActive: id === this._activeTabId,
            isStreaming: tab.isStreaming,
            hasNotification: tab.hasNotification,
        }));
    }

    private _post(message: ServerMessage): void {
        this._view?.webview.postMessage(message);
    }

    private async _handleMessage(msg: ClientMessage): Promise<void> {
        try {
            const tab = this._activeTab;

            switch (msg.type) {
                case 'slashCommand': {
                    if (!tab.session.isReady) {
                        try {
                            await tab.session.waitUntilReady();
                        } catch {
                            this._post({
                                type: 'error',
                                message:
                                    'Pi agent is not ready yet. Wait for startup to finish or reload the window.',
                            });
                            break;
                        }
                    }
                    try {
                        await tryHandleSlashCommand(tab.session, msg.text.trim());
                        void this.pushStateSync();
                    } catch (err: unknown) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        this._post({ type: 'error', message: errMsg });
                        void this.pushStateSync();
                    }
                    break;
                }
                case 'prompt': {
                    if (!tab.session.isReady) {
                        try {
                            await tab.session.waitUntilReady();
                        } catch {
                            this._post({
                                type: 'error',
                                message:
                                    'Pi agent is not ready yet. Wait for startup to finish or reload the window.',
                            });
                            break;
                        }
                    }
                    const attachments = [...tab.pendingAttachments];
                    tab.pendingAttachments = [];
                    const trimmed = msg.text.trim();
                    // Slash commands: handle locally, do not start a turn or send to the model.
                    try {
                        if (await this._tryHandleSlashOnlyPrompt(tab, trimmed, attachments)) {
                            void this.pushStateSync();
                            break;
                        }
                    } catch (err: unknown) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        this._post({ type: 'error', message: errMsg });
                        void this.pushStateSync();
                        break;
                    }
                    attachments.push(...this._editorContextAttachments());
                    await this._beginPrompt(tab, msg.text, attachments);
                    break;
                }
                case 'steer': {
                    const attachments = [...tab.pendingAttachments, ...this._editorContextAttachments()];
                    tab.pendingAttachments = [];
                    const { text, images } = composePrompt(msg.text, attachments);
                    if (text || images.length > 0) {
                        tab.steeringMessages = [...tab.steeringMessages, text || '(attachments)'];
                        void this.pushStateSync();
                    }
                    await tab.session.steer(text, images.length > 0 ? images : undefined);
                    void this.pushStateSync();
                    break;
                }
                case 'pickAttachments':
                    await this.pickAttachmentsDialog();
                    break;
                case 'addPastedImages':
                    await this.attachPastedImages(msg.items ?? []);
                    break;
                case 'addDroppedTextFiles':
                    await this.attachDroppedTextFiles(msg.files ?? []);
                    break;
                case 'dropFilePaths':
                    await this.attachPaths(msg.paths ?? []);
                    break;
                case 'dropAttachFailed': {
                    const types = msg.mimeTypes ?? [];
                    const fromExplorer =
                        types.includes('text/uri-list') ||
                        types.includes('application/vnd.code.uri-list');
                    if (fromExplorer) {
                        void vscode.window.showInformationMessage(
                            'Oh My Pi Chater: From Explorer, hold Shift while dropping on the message box. Or right-click the file → Add to Chat.',
                        );
                    }
                    break;
                }
                case 'searchWorkspaceFiles': {
                    const { searchWorkspaceFiles } = await import('../pi/workspaceFileSearch');
                    const files = await searchWorkspaceFiles(msg.query ?? '');
                    this._post({
                        type: 'workspaceFiles',
                        requestId: msg.requestId,
                        files,
                    });
                    break;
                }
                case 'removeAttachment':
                    tab.pendingAttachments = tab.pendingAttachments.filter((a) => a.id !== msg.id);
                    this.sendStateSync();
                    break;
                case 'queueMessage': {
                    if (!tab.session.isReady) {
                        try {
                            await tab.session.waitUntilReady();
                        } catch {
                            this._post({
                                type: 'error',
                                message:
                                    'Pi agent is not ready yet. Wait for startup to finish or reload the window.',
                            });
                            break;
                        }
                    }
                    const trimmed = msg.text.trim();
                    const attachments = [...tab.pendingAttachments];
                    tab.pendingAttachments = [];
                    if (!trimmed && attachments.length === 0) {
                        break;
                    }
                    try {
                        if (await this._tryHandleSlashOnlyPrompt(tab, trimmed, attachments)) {
                            void this.pushStateSync();
                            break;
                        }
                    } catch (err: unknown) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        this._post({ type: 'error', message: errMsg });
                        void this.pushStateSync();
                        break;
                    }
                    attachments.push(...this._editorContextAttachments());
                    if (!this._uiIsStreaming(tab)) {
                        this._startTurn(tab);
                        tab.isStreaming = true;
                        if (tab.id === this._activeTabId) {
                            vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', true);
                        }
                        try {
                            await this._dispatchPrompt(tab, trimmed, attachments);
                        } finally {
                            if (!tab.session.session?.isStreaming) {
                                tab.isStreaming = false;
                                if (tab.id === this._activeTabId) {
                                    vscode.commands.executeCommand(
                                        'setContext',
                                        'oh-my-pi-chater.isStreaming',
                                        false,
                                    );
                                }
                            }
                        }
                        void this.pushStateSync();
                        break;
                    }
                    tab.queuedMessages.push({ text: trimmed, attachments });
                    void this.pushStateSync();
                    break;
                }
                case 'interruptAndSend': {
                    if (!tab.session.isReady) {
                        try {
                            await tab.session.waitUntilReady();
                        } catch {
                            this._post({
                                type: 'error',
                                message:
                                    'Pi agent is not ready yet. Wait for startup to finish or reload the window.',
                            });
                            break;
                        }
                    }
                    const trimmed = msg.text.trim();
                    const attachments = [...tab.pendingAttachments];
                    tab.pendingAttachments = [];
                    if (!trimmed && attachments.length === 0) {
                        break;
                    }
                    tab.suppressQueueDrain = true;
                    try {
                        try {
                            if (await this._tryHandleSlashOnlyPrompt(tab, trimmed, attachments)) {
                                void this.pushStateSync();
                                break;
                            }
                        } catch (err: unknown) {
                            const errMsg = err instanceof Error ? err.message : String(err);
                            this._post({ type: 'error', message: errMsg });
                            void this.pushStateSync();
                            break;
                        }
                        attachments.push(...this._editorContextAttachments());
                        if (this._uiIsStreaming(tab)) {
                            await this._abortActiveTab(tab);
                        }
                        this._startTurn(tab);
                        tab.isStreaming = true;
                        if (tab.id === this._activeTabId) {
                            vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', true);
                            this.sendStateSync();
                        }
                        try {
                            await this._dispatchPrompt(tab, trimmed, attachments);
                        } finally {
                            if (!tab.session.session?.isStreaming) {
                                tab.isStreaming = false;
                                if (tab.id === this._activeTabId) {
                                    vscode.commands.executeCommand(
                                        'setContext',
                                        'oh-my-pi-chater.isStreaming',
                                        false,
                                    );
                                }
                            }
                        }
                        void this.pushStateSync();
                    } finally {
                        tab.suppressQueueDrain = false;
                    }
                    break;
                }
                case 'editQueuedMessage':
                    if (msg.index >= 0 && msg.index < tab.queuedMessages.length && msg.text.trim()) {
                        const prev = tab.queuedMessages[msg.index];
                        tab.queuedMessages[msg.index] = { ...prev, text: msg.text.trim() };
                    }
                    this.sendStateSync();
                    break;
                case 'removeQueuedMessage':
                    if (msg.index >= 0 && msg.index < tab.queuedMessages.length) {
                        tab.queuedMessages.splice(msg.index, 1);
                    }
                    this.sendStateSync();
                    break;
                case 'cancelQueue':
                    tab.queuedMessages = [];
                    this.sendStateSync();
                    break;
                case 'followUp':
                    await tab.session.submitInput(msg.text, { mode: 'followUp' });
                    break;
                case 'abort':
                    await this._abortActiveTab(tab);
                    break;
                case 'getModels':
                    this.postModelFooter(tab);
                    break;
                case 'setModel': {
                    await tab.session.setModel(msg.provider, msg.modelId);
                    // Persist as the pi/omp CLI default so new conversations start on this model.
                    const backend =
                        tab.session instanceof PiRpcSessionManager ? tab.session.backend : this._currentBackend;
                    try {
                        await updatePiDefaults({ provider: msg.provider, model: msg.modelId }, undefined, backend);
                    } catch (err: unknown) {
                        const detail = err instanceof Error ? err.message : String(err);
                        this._outputChannel.appendLine(`Failed to save default model: ${detail}`);
                    }
                    this.sendStateSync();
                    break;
                }
                case 'setThinkingLevel':
                    tab.session.setThinkingLevel(msg.level);
                    this.sendStateSync();
                    break;
                case 'newSession':
                    await tab.session.newSession();
                    tab.diffManager.clearAll();
                    tab.checkpointManager.clearAll();
                    tab.turnCounter = 0;
                    tab.suspendedMessages = [];
                    tab.name = DEFAULT_CONVERSATION_TITLE;
                    tab.isStreaming = false;
                    tab.streamingText = '';
                    tab.streamingThinking = '';
                    tab.isThinking = false;
                    tab.thinkingStartTime = 0;
                    tab.streamingThinkingDuration = 0;
                    tab.agentStartTime = 0;
                    tab.messageMeta.clear();
                    tab.voiceOrigins.resetSession();
                    tab.queuedMessages = [];
                    tab.pendingAttachments = [];
                    tab.lastPlanEditorHash = '';
                    tab.connectionStatus = idleConnection();
                    await this.pushStateSync();
                    this.postModelFooter(tab);
                    break;
                case 'openResumePicker':
                    void this.openSessionPanel();
                    break;
                case 'toggleSessionPanel':
                    this.toggleSessionPanel();
                    break;
                case 'closeSessionPanel':
                    this.closeSessionPanel();
                    break;
                case 'toggleTuiMode':
                    await this._toggleTuiMode();
                    break;
                case 'runTuiAuth':
                    await this._runTuiAuth();
                    break;
                case 'dismissTuiAuth':
                    this._tuiAuthPrompt = undefined;
                    this.sendStateSync();
                    break;
                case 'tuiStart':
                    await this._startTui(msg.tabId, msg.cols, msg.rows);
                    break;
                case 'tuiInput':
                    this._tuiProcesses.get(msg.tabId)?.write(msg.data);
                    break;
                case 'tuiResize':
                    this._tuiProcesses.get(msg.tabId)?.resize(msg.cols, msg.rows);
                    break;
                case 'openSessionTree':
                    void this.openSessionTree();
                    break;
                case 'closeSessionTree':
                    this.closeSessionTree();
                    break;
                case 'forkSessionTree':
                    void this.forkSessionTree(msg.entryId, msg.summarize, msg.customInstructions);
                    break;
                case 'loadSessionList':
                    void this.loadSessionListForPanel(msg.query ?? '');
                    break;
                case 'resumeSession':
                    void this.resumeSessionFromPanel(msg.sessionPath);
                    break;
                case 'deleteSession':
                    void this.deleteSessionFromPanel(msg.sessionPath);
                    break;
                case 'renameSession':
                    void this.renameSessionFromPanel(msg.sessionPath, msg.name);
                    break;
                case 'getState':
                    this.sendStateSync();
                    break;
                case 'getSlashCommands': {
                    let commands;
                    if (tab.session instanceof PiRpcSessionManager) {
                        commands = await tab.session.listSlashCommands();
                    } else {
                        const { listSlashCommandsForUi } = await import('../pi/slashCommands');
                        commands = await listSlashCommandsForUi(tab.session.session);
                    }
                    this._post({ type: 'slashCommands', commands });
                    break;
                }
                case 'getSkills': {
                    const skills = tab.session.getSkills();
                    this._post({ type: 'skills', skills });
                    break;
                }
                case 'approveToolCall':
                    this._resolveToolApproval(tab, msg.toolCallId, true);
                    break;
                case 'rejectToolCall':
                    this._resolveToolApproval(tab, msg.toolCallId, false);
                    break;
                case 'openFile': {
                    const { openAttachmentFile } = await import('../pi/openAttachment');
                    const cwd =
                        tab.session.session?.cwd ??
                        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
                        process.cwd();
                    await openAttachmentFile(
                        msg.filePath,
                        cwd,
                        msg.startLine && msg.endLine
                            ? { startLine: msg.startLine, endLine: msg.endLine }
                            : undefined,
                    );
                    break;
                }
                case 'setEditorContextEnabled': {
                    this._editorContextEnabled = msg.enabled;
                    void this._workspaceState.update(EDITOR_CONTEXT_STATE_KEY, msg.enabled);
                    this._postEditorContext();
                    break;
                }
                case 'toggleDictation':
                    await this.voiceInput.toggle();
                    break;
                case 'readImageFile': {
                    const { readFile } = await import('node:fs/promises');
                    const path = await import('node:path');
                    try {
                        const ext = path.extname(msg.filePath).toLowerCase();
                        const mimeMap: Record<string, string> = {
                            '.png': 'image/png',
                            '.jpg': 'image/jpeg',
                            '.jpeg': 'image/jpeg',
                            '.gif': 'image/gif',
                            '.webp': 'image/webp',
                            '.bmp': 'image/bmp',
                            '.svg': 'image/svg+xml',
                            '.ico': 'image/x-icon',
                        };
                        const mime = mimeMap[ext] || 'image/png';
                        const buffer = await readFile(msg.filePath);
                        const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
                        this._post({
                            type: 'imageFileData',
                            requestId: msg.requestId,
                            filePath: msg.filePath,
                            dataUrl,
                        });
                    } catch (err: any) {
                        this._post({
                            type: 'imageFileData',
                            requestId: msg.requestId,
                            filePath: msg.filePath,
                            error: err?.message || 'Failed to read image',
                        });
                    }
                    break;
                }
                case 'openDiff':
                    if (await tab.diffManager.openDiff(msg.filePath, msg.toolCallId)) {
                        this.sendStateSync();
                    }
                    break;
                case 'acceptFileChanges':
                    tab.diffManager.acceptAll();
                    this.sendStateSync();
                    break;
                case 'undoFileChange':
                    await tab.diffManager.undoFileChange(msg.filePath, msg.toolCallId);
                    this.sendStateSync();
                    break;
                case 'restoreCheckpoint': {
                    const restored = await tab.checkpointManager.restoreCheckpoint(msg.messageIndex);
                    tab.diffManager.suspendChangesAfter(msg.messageIndex);

                    const allMsgs = tab.session.getMessages();
                    const cutoff = this._findCutoffIndex(allMsgs, msg.messageIndex);
                    if (cutoff >= 0 && cutoff < allMsgs.length) {
                        tab.suspendedMessages = allMsgs.slice(cutoff);
                        tab.session.setMessages(allMsgs.slice(0, cutoff));
                    }

                    if (restored.length > 0) {
                        vscode.window.showInformationMessage(
                            `Restored ${restored.length} file(s) to checkpoint.`
                        );
                    }
                    this.sendStateSync();
                    break;
                }
                case 'redoCheckpoint': {
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
                    this.sendStateSync();
                    break;
                }
                case 'resendUserMessage': {
                    if (!(tab.session instanceof PiRpcSessionManager)) {
                        break;
                    }
                    try {
                        await tab.session.resendUserMessage(
                            msg.messageIndex,
                            msg.text,
                            msg.mode,
                            msg.entryId,
                        );
                        if (!this._uiIsStreaming(tab)) {
                            this._startTurn(tab);
                        }
                        tab.isStreaming = true;
                        if (tab.id === this._activeTabId) {
                            vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', true);
                        }
                        await this.pushStateSync();
                    } catch (err: unknown) {
                        const m = err instanceof Error ? err.message : String(err);
                        this._post({ type: 'error', message: m });
                        this._post({ type: 'toast', message: m, variant: 'error' });
                    }
                    break;
                }
                case 'regenerateAssistant': {
                    if (!(tab.session instanceof PiRpcSessionManager)) {
                        break;
                    }
                    try {
                        await tab.session.regenerateAssistant(msg.assistantMessageIndex, msg.mode);
                        if (!this._uiIsStreaming(tab)) {
                            this._startTurn(tab);
                        }
                        tab.isStreaming = true;
                        if (tab.id === this._activeTabId) {
                            vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', true);
                        }
                        await this.pushStateSync();
                    } catch (err: unknown) {
                        const m = err instanceof Error ? err.message : String(err);
                        this._post({ type: 'error', message: m });
                        this._post({ type: 'toast', message: m, variant: 'error' });
                    }
                    break;
                }
                case 'confirmAction': {
                    const answer = await vscode.window.showWarningMessage(
                        msg.message,
                        { modal: true },
                        'Yes',
                    );
                    this._post({
                        type: 'confirmResult',
                        action: msg.action,
                        confirmed: answer === 'Yes',
                        payload: msg.payload,
                    });
                    break;
                }
                case 'createTab':
                    await this._createTab(msg.backend);
                    break;
                case 'setBackend':
                    await this._handleSetBackend(msg.backend);
                    break;
                case 'closeTab':
                    await this._closeTab(msg.tabId);
                    break;
                case 'switchTab':
                    this._switchTab(msg.tabId);
                    break;
                case 'openSettings':
                    if (msg.section) {
                        SettingsPanel.showWithSection(msg.section);
                    } else {
                        vscode.commands.executeCommand('oh-my-pi-chater.openSettings');
                    }
                    break;
                case 'setAgentMode': {
                    const mode = msg.mode;
                    if (mode !== 'agent' && mode !== 'plan') {
                        throw new Error('Invalid agent mode');
                    }
                    tab.planModeOverride = mode;
                    try {
                        await tab.session.setAgentMode(mode);
                    } finally {
                        const confirmed = tab.session.getPlanModeInfo();
                        if (
                            (mode === 'plan' && confirmed.enabled) ||
                            (mode === 'agent' && !confirmed.enabled)
                        ) {
                            tab.planModeOverride = undefined;
                        }
                        await this.pushStateSync();
                    }
                    break;
                }
                case 'implementPlan': {
                    if (tab.checkpointManager.rollbackPoint !== null) {
                        tab.checkpointManager.discardSuspended();
                        tab.diffManager.discardSuspended();
                        tab.suspendedMessages = [];
                    }
                    tab.turnCounter++;
                    const turnIdx = tab.turnCounter;
                    tab.checkpointManager.startTurn(turnIdx);
                    tab.diffManager.setCurrentTurn(turnIdx);
                    tab.isStreaming = true;
                    tab.streamingText = '';
                    tab.streamingThinking = '';
                    tab.isThinking = false;
                    tab.agentStartTime = Date.now();
                    if (tab.id === this._activeTabId) {
                        vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', true);
                        this.sendStateSync();
                    }
                    try {
                        await tab.session.implementPlan();
                    } catch (err) {
                        tab.isStreaming = false;
                        if (tab.id === this._activeTabId) {
                            vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', false);
                            this.sendStateSync();
                        }
                        throw err;
                    }
                    this.sendStateSync();
                    break;
                }
                case 'openPlanDocument':
                    await openPlanDocument(
                        this._planDocument,
                        tab.session.session?.sessionId,
                    );
                    break;
                case 'extensionUiResponse':
                    if (tab.session instanceof PiRpcSessionManager) {
                        tab.session.rpcExtensionUi.respond({
                            id: msg.id,
                            cancelled: msg.cancelled,
                            value: msg.value,
                            confirmed: msg.confirmed,
                        });
                    } else {
                        this._extensionUi.handleResponse({
                            id: msg.id,
                            cancelled: msg.cancelled,
                            value: msg.value,
                            confirmed: msg.confirmed,
                        });
                    }
                    break;
            }
        } catch (err: any) {
            this._post({ type: 'error', message: err.message ?? String(err) });
        }
    }

    private _requestToolApproval(tab: TabState, toolCallId: string, toolName: string, args: any): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            tab.pendingApprovals.set(toolCallId, { resolve });

            if (tab.id === this._activeTabId) {
                this._post({
                    type: 'toolCallPending',
                    pending: { toolCallId, toolName, args: safeSerialize(args) },
                });
            }
        });
    }

    private _resolveToolApproval(tab: TabState, toolCallId: string, approved: boolean): void {
        const pending = tab.pendingApprovals.get(toolCallId);
        if (pending) {
            tab.pendingApprovals.delete(toolCallId);
            pending.resolve(approved);
            if (tab.id === this._activeTabId) {
                this._post({ type: 'toolCallResolved', toolCallId });
            }
        }
    }

    private async _handleSetBackend(backend: AgentBackend): Promise<void> {
        if (this._currentBackend === backend) {
            this.sendStateSync();
            return;
        }

        this._currentBackend = backend;
        clearCliTargetCache();

        if (this._prewarmedSession) {
            const old = this._prewarmedSession;
            this._prewarmedSession = null;
            void old.session.dispose();
        }
        this._schedulePrewarmSession(500);

        setWindowBackend(backend);

        this.invalidateSessionListCache();

        // If target backend has no tabs, restore its persisted tabs or create a fresh one
        if (this._tabs.size === 0) {
            await this.restorePersistedTabs(backend);
            if (this._tabs.size === 0) {
                await this._createTab(backend);
            }
        }

        if (this._sessionPanelOpen) {
            void this.loadSessionListForPanel(this._sessionPanelQuery);
        }

        await this.pushStateSync();
        this.postModelFooter();
        if (this._activeTab) {
            this._statusBar?.setSession(this._activeTab.session);
        }

        if (this._tuiMode) {
            const tab = this._activeTab;
            if (tab) {
                await this._startTui(tab.id, 80, 24);
            }
        }

        this._post({ type: 'toast', message: `Switched to ${backend} workspace`, variant: 'info' });
    }

    private async _createTab(preferredBackend?: AgentBackend): Promise<void> {
        const tab = await this._createEmptyTabState(preferredBackend ?? this._currentBackend);
        this._activeTabId = tab.id;
        this.sendStateSync();
    }

    private async _closeTab(tabId: string): Promise<void> {
        if (this._tabs.size <= 1) return;

        const tab = this._tabs.get(tabId);
        if (!tab) return;

        const wasActive = tabId === this._activeTabId;

        await this._discardTab(tab);

        if (wasActive) {
            this._activeTabId = this._tabs.keys().next().value!;
        }

        this.sendStateSync();
    }

    private _switchTab(tabId: string): void {
        if (!this._tabs.has(tabId) || tabId === this._activeTabId) return;

        this._activeTabId = tabId;

        const tab = this._activeTab;
        tab.hasNotification = false;
        vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', tab.isStreaming);

        this.sendStateSync();
        this.postModelFooter(tab);
        this._statusBar?.setSession(tab.session);
    }

    /** omp only logs in from its TUI: show a chat banner that switches there and runs the command. */
    async promptTuiAuth(command: TuiAuthCommand): Promise<void> {
        await vscode.commands.executeCommand('oh-my-pi-chater.chat.focus');
        if (this._tuiMode) {
            this._post({ type: 'toast', message: `Type /${command} in the terminal.`, variant: 'info' });
            return;
        }
        this._tuiAuthPrompt = command;
        this.sendStateSync();
    }

    private async _runTuiAuth(): Promise<void> {
        const command = this._tuiAuthPrompt;
        const tab = this._activeTab;
        if (!command || !tab || this._tuiMode) {
            return;
        }
        // Chat mode has no TUI processes; the toggle below starts this tab's, which types it.
        this._pendingTuiInput.set(tab.id, `/${command}\r`);
        await this._toggleTuiMode();
        if (!this._tuiMode) {
            this._pendingTuiInput.delete(tab.id); // refused: a response is streaming
        }
    }

    private async _toggleTuiMode(): Promise<void> {
        if (!this._tuiMode && [...this._tabs.values()].some((tab) => tab.isStreaming)) {
            // RPC and TUI must not append to the same session file at once.
            this._post({ type: 'toast', message: 'Stop the running response before switching to TUI.', variant: 'error' });
            return;
        }
        this._tuiMode = !this._tuiMode;
        if (this._tuiMode) {
            this._tuiAuthPrompt = undefined;
        }
        void this._workspaceState.update(TUI_MODE_STATE_KEY, this._tuiMode);
        void vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.tuiMode', this._tuiMode);
        if (!this._tuiMode) {
            const tabIds = [...this._tuiProcesses.keys()];
            await Promise.all(tabIds.map((id) => this._stopTui(id)));
            // The TUIs appended to the tabs' session files; the idle RPC processes hold stale state.
            for (const id of tabIds) {
                const tab = this._tabs.get(id);
                if (!tab) continue;
                try {
                    await tab.session.reloadSessionFromDisk();
                    this._resetTabUiState(tab);
                    this._updateTabName(tab);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    this._outputChannel.appendLine(`Reload after TUI failed (${tab.name}): ${message}`);
                }
            }
        }
        this.sendStateSync();
    }

    /** Start (or re-attach to) the tab's TUI once the webview has a sized terminal for it. */
    private async _startTui(
        tabId: string,
        cols: number,
        rows: number,
        overrideSessionFile?: string,
        overrideCwd?: string,
        overrideBackend?: AgentBackend,
    ): Promise<void> {
        const tab = this._tabs.get(tabId);
        if (!this._tuiMode || !tab || this._tuiStarting.has(tabId)) return;
        const sessionFile = overrideSessionFile ?? tab.session.session?.sessionFile;
        const cwd =
            overrideCwd ??
            tab.session.session?.cwd ??
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
            process.cwd();
        const backend =
            overrideBackend ??
            (tab.session instanceof PiRpcSessionManager ? tab.session.backend : undefined) ??
            this._currentBackend;

        const existing = this._tuiProcesses.get(tabId);
        if (existing && !existing.exited && !overrideSessionFile) {
            // New terminal view (webview re-created): size it and replay the full screen.
            existing.resize(cols, rows);
            await this._sendTuiSnapshot(tabId);
            return;
        }
        if (existing) {
            await this._stopTui(tabId);
        }
        this._tuiExitCodes.delete(tabId);
        this._tuiStarting.add(tabId);
        try {
            const proc = await TuiProcess.start({
                cwd,
                sessionFile,
                backend,
                cols,
                rows,
                onData: (data) => this._queueTuiOutput(tabId, data),
                onExit: (exitCode) => {
                    this._flushTuiOutput();
                    // Stopped on purpose (mode off, tab closed) → already unregistered, nothing to report.
                    if (this._tuiProcesses.get(tabId) !== proc) return;
                    this._tuiProcesses.delete(tabId);
                    this._tuiExitCodes.set(tabId, exitCode);
                    this._post({ type: 'tuiExit', tabId, exitCode });
                },
            });
            if (!this._tuiMode || !this._tabs.has(tabId)) {
                await proc.dispose();
                return;
            }
            this._tuiProcesses.set(tabId, proc);
            const pending = this._pendingTuiInput.get(tabId);
            if (pending) {
                this._pendingTuiInput.delete(tabId);
                void proc.typeWhenReady(pending);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`TUI start failed: ${message}`);
            this._post({ type: 'tuiData', tabId, data: `\r\n\x1b[31mTUI start failed: ${message}\x1b[0m\r\n` });
        } finally {
            this._tuiStarting.delete(tabId);
        }
    }

    private async _stopTui(tabId: string): Promise<void> {
        this._tuiExitCodes.delete(tabId);
        const proc = this._tuiProcesses.get(tabId);
        if (!proc) return;
        this._tuiProcesses.delete(tabId);
        await proc.dispose();
    }

    /** Replace the tab's terminal view with the TUI's full current screen + scrollback. */
    private async _sendTuiSnapshot(tabId: string): Promise<void> {
        const proc = this._tuiProcesses.get(tabId);
        if (!proc || proc.exited) return;
        // Queued live output is already in the mirror, so the snapshot supersedes it.
        this._tuiOutput.delete(tabId);
        const data = await proc.snapshot();
        this._post({ type: 'tuiSnapshot', tabId, data });
    }

    private _resyncTuiViews(): void {
        if (!this._tuiMode) return;
        for (const tabId of this._tuiProcesses.keys()) {
            void this._sendTuiSnapshot(tabId);
        }
        for (const [tabId, exitCode] of this._tuiExitCodes) {
            this._post({ type: 'tuiExit', tabId, exitCode });
        }
    }

    /** Stop every TUI (extension shutdown). */
    async disposeTui(): Promise<void> {
        await Promise.all([...this._tuiProcesses.keys()].map((id) => this._stopTui(id)));
    }

    private _queueTuiOutput(tabId: string, data: string): void {
        this._tuiOutput.set(tabId, (this._tuiOutput.get(tabId) ?? '') + data);
        this._tuiFlushTimer ??= setTimeout(() => this._flushTuiOutput(), 4);
    }

    private _flushTuiOutput(): void {
        if (this._tuiFlushTimer) {
            clearTimeout(this._tuiFlushTimer);
            this._tuiFlushTimer = undefined;
        }
        for (const [tabId, data] of this._tuiOutput) {
            this._post({ type: 'tuiData', tabId, data });
        }
        this._tuiOutput.clear();
    }

    private _findCutoffIndex(messages: any[], rollbackPoint: number): number {
        let userMsgCount = 0;
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === 'user') {
                userMsgCount++;
                if (userMsgCount > rollbackPoint) {
                    return i;
                }
            }
        }
        return -1;
    }

    private _getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'main.js')
        );
        const toolViewsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'omp-tool-views.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'styles', 'main.css')
        );
        const xtermStyleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'styles', 'xterm.css')
        );
        const iconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'icons')
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <link rel="stylesheet" href="${xtermStyleUri}">
    <title>Oh My Pi Chater</title>
</head>
<body>
    <div id="app" data-icons-uri="${iconsUri}"></div>
    <script nonce="${nonce}" src="${toolViewsUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function safeSerialize(obj: any): any {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { type: obj?.type, _serializationFailed: true };
    }
}
