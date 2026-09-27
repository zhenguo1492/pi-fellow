import * as vscode from 'vscode';
import { applyPiCliDefaultModel } from '../pi/piCliSync';
import type { PiRpcSessionManager } from '../pi/rpcSession';
import type { PiAgentEvent } from '../pi/rpcTypes';
import { canonicalizeSessionPath, getSessionDisplayTitle } from '../pi/sessionCatalog';
import { DEFAULT_CONVERSATION_TITLE, deriveConversationTitle } from '../shared/conversationTitle';
import type { AgentBackend, TabInfo } from '../shared/protocol';
import type { WorkerEvent } from '../voiceAgent/workerController';
import { CheckpointManager } from './checkpoint';
import { DiffManager } from './diff';
import type { ModelStatusTracker } from './model-status';
import type { SidebarBackends } from './sidebarBackends';
import { safeSerialize, type SidebarHost } from './sidebarHost';
import type { MessageHandlers } from './sidebarMessageHandlers';
import {
    applyAgentEvent,
    makeTabState,
    nextTabId,
    resetTabUiState,
    type TabState,
} from './sidebarTabState';
import {
    applySessionPermission,
    applyTabPermission,
    enterPiPlanMode,
    newTabPermissionLevel,
    rememberSessionPermissions,
} from './sidebarPermission';
import { rejectPendingApprovals } from './sidebarToolApproval';
import type { TabTuis } from './sidebarTui';
import type { SidebarVoiceSessions } from './sidebarVoiceSessions';

interface PersistedOpenTabs {
    version: 1;
    sessionPaths: string[];
    activeSessionPath?: string;
    /** Session paths of the tabs showing their TUI. */
    tuiSessionPaths?: string[];
}

const OPEN_TABS_STATE_KEY = 'oh-my-pi-chater.openConversationTabs';

/** Where the tabs' worker events go: the provider's `WorkerController` events. */
export interface TabEventSinks {
    tabEvent: vscode.EventEmitter<{ tabId: string; event: WorkerEvent }>;
    requestsChanged: vscode.EventEmitter<string>;
}

/** Retitles the tab from its session name or conversation; true when the name changed. */
export function updateTabName(tab: TabState, pendingPrompt?: string): boolean {
    const messages = tab.session.getMessages();
    const title = deriveConversationTitle(
        tab.session.session?.sessionName,
        messages,
        pendingPrompt,
    );
    if (!title) {
        const isIdle = !tab.isStreaming && !tab.session.session?.isStreaming;
        // A conversation still loading has no messages yet: keep the title it was opened under.
        if (isIdle && !tab.restoring && messages.length === 0 && tab.name !== DEFAULT_CONVERSATION_TITLE) {
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

/** The current backend's tabs: create, close, switch, their session event subscriptions, and the open tabs kept per workspace. */
export class SidebarTabs {
    private _tabSubscriptions = new Map<string, (() => void)[]>();
    private _persistTabsTimer: NodeJS.Timeout | undefined;
    private _restoringTabs = false;
    private _lastPersistedTabs = '';

    constructor(
        private readonly _host: SidebarHost,
        private readonly _backends: SidebarBackends,
        private readonly _tuis: TabTuis,
        private readonly _voiceSessions: SidebarVoiceSessions,
        private readonly _events: TabEventSinks,
        private readonly _modelStatus: ModelStatusTracker | undefined,
    ) {}

    /** A tab with a new conversation in `targetCwd` (default: the workspace folder). */
    async createEmptyTabState(preferredBackend?: AgentBackend, targetCwd?: string): Promise<TabState> {
        const targetBackend = preferredBackend ?? this._host.currentBackend;
        const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const cwd = targetCwd ?? workspaceCwd;

        let session: PiRpcSessionManager;
        let readyPromise: Promise<void>;

        // The pre-warmed worker runs in the workspace folder; one for another folder must not use (or drop) it.
        const prewarmed = cwd === workspaceCwd ? this._backends.takePrewarmedSession(targetBackend, cwd) : null;
        if (prewarmed) {
            session = prewarmed.session;
            // The pre-warmed process applied the CLI default when it started; the default may have
            // changed since (chat model picker, settings panel), so re-apply it on hand-off.
            readyPromise = prewarmed.readyPromise.then(async () => {
                await applyPiCliDefaultModel(session).catch(() => false);
            });
        } else {
            const { PiRpcSessionManager } = await import('../pi/rpcSession');
            session = new PiRpcSessionManager(this._host.outputChannel);
            readyPromise = session.initialize(targetBackend, cwd);
        }

        const checkpoint = new CheckpointManager();
        const diff = new DiffManager(session, checkpoint);
        const tab = makeTabState(nextTabId(), session, diff, checkpoint, newTabPermissionLevel(this._host.workspaceState));
        applyTabPermission(tab);
        this._host.wireRpcSessionUi(session);
        this._host.tabs.set(tab.id, tab);
        this.subscribeTab(tab);

        this._backends.schedulePrewarmSession(300);
        this.watchStartup(tab, readyPromise);

        return tab;
    }

    /** The chat shows the tab starting until `ready`; then it refreshes, or the tab is marked failed. */
    watchStartup(tab: TabState, ready: Promise<void>): void {
        ready.then(
            () => {
                if (!this._host.tabs.has(tab.id)) return;
                updateTabName(tab);
                // A new tab in Plan (the default level) on pi: pi's own plan mode. A restored conversation keeps its own.
                if (tab.readOnlyPlan && tab.session.backend === 'pi' && !tab.restoring) {
                    void enterPiPlanMode(this._host, tab).then(() => {
                        if (this._host.activeTabId === tab.id) this._host.sendStateSync();
                    });
                }
                if (this._host.activeTabId === tab.id) {
                    this._host.sendStateSync();
                    this._host.postModelFooter(tab);
                }
            },
            (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                this._host.outputChannel.appendLine(`Session initialization failed for tab ${tab.id}: ${msg}`);
                tab.connectionStatus = { phase: 'failed', message: msg };
                if (this._host.activeTabId === tab.id) {
                    this._host.sendStateSync();
                }
            },
        );
    }

    /** Restore the conversations that were open in this workspace when VS Code exited. */
    async restorePersistedTabs(backend?: AgentBackend): Promise<void> {
        const targetBackend = backend ?? this._host.currentBackend;
        const key = `${OPEN_TABS_STATE_KEY}.${targetBackend}`;
        let saved = this._host.workspaceState.get<PersistedOpenTabs>(key);
        if (!saved && targetBackend === this._host.currentBackend) {
            saved = this._host.workspaceState.get<PersistedOpenTabs>(OPEN_TABS_STATE_KEY);
        }
        if (!saved || saved.version !== 1 || !Array.isArray(saved.sessionPaths)) {
            return;
        }

        const sessionPaths = [...new Set(saved.sessionPaths.filter((value) => typeof value === 'string' && value.trim()))];
        if (sessionPaths.length === 0) {
            return;
        }

        this._restoringTabs = true;
        // Several workers start at once: a pre-warm now would only slow them down.
        this._backends.holdPrewarm();
        const initialTab = this._host.tabs.get(this._host.activeTabId);
        const activePath = saved.activeSessionPath ? canonicalizeSessionPath(saved.activeSessionPath) : '';
        try {
            // Each tab appears at once and loads its conversation alongside the others; the first reuses the
            // window's fresh tab, gated before this method first yields so no prompt reaches it unrestored.
            const loads: Promise<unknown>[] = [];
            for (const [index, sessionPath] of sessionPaths.entries()) {
                const usesInitialTab = index === 0 && !!initialTab && initialTab.session.messages.length === 0;
                const tab = usesInitialTab ? initialTab : await this.createEmptyTabState(targetBackend);
                tab.tuiMode = Array.isArray(saved.tuiSessionPaths) && saved.tuiSessionPaths.includes(sessionPath);
                loads.push(
                    this.loadSessionIntoTab(tab, sessionPath, !usesInitialTab).catch((err: unknown) => {
                        const message = err instanceof Error ? err.message : String(err);
                        this._host.outputChannel.appendLine(`Restore open tab failed (${sessionPath}): ${message}`);
                    }),
                );
                if (index === 0 || canonicalizeSessionPath(sessionPath) === activePath) {
                    this._host.activeTabId = tab.id;
                }
            }
            this._host.sendStateSync();
            await Promise.all(loads);
        } finally {
            this._restoringTabs = false;
            this._backends.releasePrewarm(1500);
            await this._persistOpenTabs();
        }
    }

    /**
     * Load `sessionPath` into `tab`; meanwhile the tab shows its history loading and prompts wait for it (`tabReady`).
     * A tab created for it (`discardOnFailure`) is closed when the load is cancelled or fails.
     * False when cancelled (e.g. the session's folder is gone); rejects with the load's error.
     */
    loadSessionIntoTab(tab: TabState, sessionPath: string, discardOnFailure: boolean): Promise<boolean> {
        const load = this._loadSessionIntoTab(tab, sessionPath, discardOnFailure);
        tab.restoring = load.then(
            () => undefined,
            () => undefined,
        );
        return load;
    }

    private async _loadSessionIntoTab(tab: TabState, sessionPath: string, discardOnFailure: boolean): Promise<boolean> {
        // Before the tab first shows: it opens under its conversation's title, not the new-chat one.
        const info = this._voiceSessions.sessionInfo(sessionPath);
        const title = info ? getSessionDisplayTitle(info) : DEFAULT_CONVERSATION_TITLE;
        tab.name = title;
        // Before the tab first shows: the level the conversation had when it was last open.
        applySessionPermission(this._host.workspaceState, tab, sessionPath);
        try {
            if (!(await tab.session.loadSession(sessionPath))) {
                if (discardOnFailure) await this._discardTab(tab);
                return false;
            }
            // Attachments dropped into the composer while the conversation loaded stay.
            const { pendingAttachments } = tab;
            resetTabUiState(tab);
            tab.pendingAttachments = pendingAttachments;
            await this._voiceSessions.adoptTitle(tab);
            // Only talked to the voice agent: open on that conversation; any worker message keeps the worker's.
            // A tab showing its TUI has no Bot view.
            tab.botView =
                !tab.tuiMode &&
                tab.session.messages.length === 0 &&
                this._voiceSessions.sessionFor(sessionPath) !== undefined;
            return true;
        } catch (err: unknown) {
            if (discardOnFailure) await this._discardTab(tab);
            throw err;
        } finally {
            tab.restoring = undefined;
            // Loaded: its session name or conversation. Kept after a failed load: back to the new-chat title.
            updateTabName(tab);
            if (!this._host.tabs.has(this._host.activeTabId)) {
                const first = this._host.tabs.values().next().value;
                if (first) this._host.activeTabId = first.id;
            }
            this._host.sendStateSync();
            if (tab.id === this._host.activeTabId) {
                this._host.postModelFooter(tab);
            }
        }
    }

    private async _discardTab(tab: TabState): Promise<void> {
        rejectPendingApprovals(tab);
        await this._tuis.stop(tab.id);
        this.unsubscribeTab(tab.id);
        tab.diffManager.dispose();
        tab.checkpointManager.dispose();
        await tab.session.dispose();
        this._host.tabs.delete(tab.id);
    }

    schedulePersistOpenTabs(): void {
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
        const key = `${OPEN_TABS_STATE_KEY}.${this._host.currentBackend}`;
        const tabs = [...this._host.tabs.values()];
        const sessionPaths = tabs.map((tab) => tab.session.session?.sessionFile).filter((value): value is string => !!value);
        const tuiSessionPaths: string[] = [];
        for (const tab of tabs) {
            const sessionFile = tab.session.session?.sessionFile;
            if (sessionFile && tab.tuiMode) tuiSessionPaths.push(sessionFile);
        }
        const activeSessionPath = this._host.activeTab?.session.session?.sessionFile;
        const snapshot: PersistedOpenTabs = {
            version: 1,
            sessionPaths: [...new Set(sessionPaths)],
            activeSessionPath,
            tuiSessionPaths,
        };
        const serialized = JSON.stringify(snapshot);
        await this._rememberSessionPermissions(tabs);
        if (serialized === this._lastPersistedTabs) return;
        this._lastPersistedTabs = serialized;
        try {
            await this._host.workspaceState.update(key, snapshot);
            await this._host.workspaceState.update(OPEN_TABS_STATE_KEY, snapshot);
        } catch (err: unknown) {
            this._lastPersistedTabs = '';
            const message = err instanceof Error ? err.message : String(err);
            this._host.outputChannel.appendLine(`Persist open tabs failed: ${message}`);
        }
    }

    private async _rememberSessionPermissions(tabs: Iterable<TabState>): Promise<void> {
        try {
            await rememberSessionPermissions(this._host.workspaceState, tabs);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._host.outputChannel.appendLine(`Persist session permissions failed: ${message}`);
        }
    }

    /** Subscribe the current backend's tabs that have no subscriptions yet. */
    subscribeMissing(): void {
        for (const tab of this._host.tabs.values()) {
            if (!this._tabSubscriptions.has(tab.id)) {
                this.subscribeTab(tab);
            }
        }
    }

    subscribeTab(tab: TabState): void {
        const unsubs: (() => void)[] = [];

        unsubs.push(
            tab.session.events.onAll((event) => {
                this._handleTabEvent(tab, event);
                // After the tab's own bookkeeping, so status() is current inside listeners.
                this._events.tabEvent.fire({ tabId: tab.id, event });
            }),
        );

        const requests = tab.session.rpcExtensionUi.onDidChangePending(() => this._events.requestsChanged.fire(tab.id));
        unsubs.push(() => requests.dispose());

        unsubs.push(
            tab.session.onDidChangeCatalog(() => {
                if (tab.id === this._host.activeTabId) {
                    this._host.post({ type: 'skills', skills: tab.session.getSkills() });
                    this._host.postModelFooter(tab);
                }
            }),
        );

        unsubs.push(
            tab.diffManager.onFileChange((change) => {
                if (tab.id === this._host.activeTabId) {
                    this._host.post({ type: 'fileChange', change });
                }
            }),
        );

        this._tabSubscriptions.set(tab.id, unsubs);
    }

    unsubscribeTab(tabId: string): void {
        const unsubs = this._tabSubscriptions.get(tabId);
        if (unsubs) {
            for (const unsub of unsubs) unsub();
            this._tabSubscriptions.delete(tabId);
        }
    }

    private _handleTabEvent(tab: TabState, event: PiAgentEvent): void {
        const isActive = tab.id === this._host.activeTabId;
        const streaming = applyAgentEvent(tab, event, isActive);
        if (streaming !== undefined && isActive) {
            vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', streaming);
        }

        updateTabName(tab);

        if (isActive) {
            this._host.post({ type: 'agentEvent', event: safeSerialize(event) });

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
                (event.type === 'message_start' &&
                    typeof event.message === 'object' &&
                    event.message !== null &&
                    'steering' in event.message &&
                    event.message.steering === true)
            ) {
                void this._host.pushStateSync();
            } else if (event.type === 'context_usage') {
                void this._host.pushStateSync();
            }
        } else if (
            event.type === 'agent_start' ||
            event.type === 'agent_end' ||
            event.type === 'turn_end'
        ) {
            void this._host.pushStateSync();
        }

    }

    getTabInfos(): TabInfo[] {
        return [...this._host.tabs.entries()].map(([id, tab]) => ({
            id,
            name: tab.name,
            isActive: id === this._host.activeTabId,
            // A TUI's run is not the RPC worker's: it comes from the session file the TUI writes.
            isStreaming: tab.isStreaming || tab.tuiBusy,
            hasNotification: tab.hasNotification,
            botView: tab.botView,
            tuiMode: tab.tuiMode,
        }));
    }

    async createTab(preferredBackend?: AgentBackend): Promise<void> {
        const tab = await this.createEmptyTabState(preferredBackend ?? this._host.currentBackend);
        this._host.activeTabId = tab.id;
        this._host.sendStateSync();
    }

    private async _closeTab(tabId: string): Promise<void> {
        if (this._host.tabs.size <= 1) return;

        const tab = this._host.tabs.get(tabId);
        if (!tab) return;

        const wasActive = tabId === this._host.activeTabId;

        // Its level outlives the tab: reopening the conversation restores it.
        await this._rememberSessionPermissions([tab]);
        await this._discardTab(tab);

        if (wasActive) {
            this._host.activeTabId = this._host.tabs.keys().next().value!;
        }

        this._host.sendStateSync();
    }

    switchTab(tabId: string): void {
        if (!this._host.tabs.has(tabId) || tabId === this._host.activeTabId) return;
        this.showTab(tabId);
    }

    /** Make `tabId` (one of the current backend's tabs) the shown tab, even when it already is the active one. */
    showTab(tabId: string): void {
        this._host.activeTabId = tabId;

        const tab = this._host.activeTab;
        tab.hasNotification = false;
        vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.isStreaming', tab.isStreaming);

        this._host.sendStateSync();
        this._host.postModelFooter(tab);
        this._modelStatus?.setSession(tab.session);
    }

    handlers(): MessageHandlers {
        return {
            createTab: async (msg) => {
                await this.createTab(msg.backend);
            },
            closeTab: async (msg) => {
                await this._closeTab(msg.tabId);
            },
            switchTab: (msg) => {
                this.switchTab(msg.tabId);
            },
        };
    }
}
