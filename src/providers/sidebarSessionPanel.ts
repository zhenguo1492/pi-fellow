import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { getAgentLayout, resolvePiWorkspaceCwd } from '../pi/piCliPaths';
import {
    buildSessionListRows,
    canonicalizeSessionPath,
    getSessionDirForCwd,
    getSessionDisplayTitle,
    invalidateSessionInfoPath,
    withVoiceSessions,
} from '../pi/sessionCatalog';
import { appendSessionDisplayName, deleteSessionFile } from '../pi/sessionFileOps';
import { DEFAULT_CONVERSATION_TITLE } from '../shared/conversationTitle';
import type { AgentBackend, SessionInfo } from '../shared/protocol';
import type { SidebarHost } from './sidebarHost';
import type { MessageHandlers } from './sidebarMessageHandlers';
import { SessionListCache, type SessionListScope } from './sidebarSessionListCache';
import { updateTabName, type SidebarTabs } from './sidebarTabs';
import type { TabState } from './sidebarTabState';
import type { SidebarTuiMode } from './sidebarTuiMode';
import type { SidebarVoiceSessions } from './sidebarVoiceSessions';

/** Session store + folder the resume panel lists for a tab. */
interface SessionListTarget extends SessionListScope {
    currentSessionPath: string | undefined;
}

/** The in-sidebar resume panel (resume, rename, delete sessions) and the session tree panel (branch from a message). */
export class SidebarSessionPanel {
    private _sessionPanelOpen = false;
    private readonly _sessionLists = new SessionListCache();
    private _sessionListGeneration = 0;
    private _sessionPanelQuery = '';

    constructor(
        private readonly _host: SidebarHost,
        private readonly _tabs: SidebarTabs,
        private readonly _tui: SidebarTuiMode,
        private readonly _voiceSessions: SidebarVoiceSessions,
        /** A resumed session is loaded and shown in this tab. */
        private readonly _onResumed: (tabId: string) => void,
    ) {}

    /** Open in-sidebar resume panel (same session list as Pi CLI `/resume`). */
    async openSessionPanel(): Promise<void> {
        if (!this._sessionPanelOpen) {
            this._sessionPanelOpen = true;
            this._host.post({ type: 'sessionPanel', open: true });
        }
        await this.loadSessionListForPanel('');
    }

    private _toggleSessionPanel(): void {
        if (this._sessionPanelOpen) {
            this._closeSessionPanel();
            return;
        }
        void this.openSessionPanel();
    }

    private _closeSessionPanel(): void {
        this._sessionPanelOpen = false;
        this._host.post({ type: 'sessionPanel', open: false });
    }

    /** A webview that was hidden or recreated shows the resume panel again when it is open. */
    repostOpenPanel(): void {
        if (this._sessionPanelOpen) {
            this._host.post({ type: 'sessionPanel', open: true });
            void this.loadSessionListForPanel('');
        }
    }

    /** The backend changed: every cached listing is stale, and an open panel lists the new backend's sessions. */
    invalidateSessionLists(): void {
        this._sessionLists.invalidate();
    }

    reloadOpenPanel(): void {
        if (this._sessionPanelOpen) {
            void this.loadSessionListForPanel(this._sessionPanelQuery);
        }
    }

    async openSessionTree(): Promise<void> {
        this._host.post({ type: 'sessionTree', open: true });
        await this._loadSessionTree();
    }

    private _closeSessionTree(): void {
        this._host.post({ type: 'sessionTree', open: false });
    }

    private async _loadSessionTree(): Promise<void> {
        const tab = this._host.activeTab;
        if (!tab) {
            return;
        }
        try {
            const { tree, leafId } = await tab.session.getSessionTree();
            const { formatSessionTree } = await import('../pi/sessionTree');
            const nodes = formatSessionTree(tree, leafId);
            this._host.post({
                type: 'sessionTree',
                open: true,
                data: { nodes, leafId },
            });
        } catch (err: unknown) {
            // Errors and RPC error objects carry `message`; whatever else was thrown is read the same way.
            const thrown = err as { message?: string } | null | undefined;
            this._host.post({
                type: 'sessionTree',
                open: true,
                data: { nodes: [], leafId: null, error: thrown?.message || String(err) },
            });
        }
    }

    private async _forkSessionTree(entryId: string, summarize?: boolean, customInstructions?: string): Promise<void> {
        const tab = this._host.activeTab;
        if (!tab) {
            return;
        }
        try {
            if (summarize) {
                vscode.window.setStatusBarMessage('Branching with summarization...', 3000);
            }
            const res = await tab.session.forkFromMessage(entryId);
            if (!res.cancelled) {
                this._closeSessionTree();
                await this._host.pushStateSync();
                vscode.window.showInformationMessage('Navigated to selected session branch.');
            }
        } catch (err: unknown) {
            // Errors and RPC error objects carry `message`; whatever else was thrown is read the same way.
            const thrown = err as { message?: string } | null | undefined;
            const rawErr = thrown?.message || String(err);
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
    private _sessionListTarget(tab: TabState): SessionListTarget {
        const tui = this._tui.tuis.get(tab.id);
        if (tui) {
            return {
                cwd: resolvePiWorkspaceCwd(tui.cwd),
                layout: getAgentLayout(tui.backend),
                currentSessionPath: tui.sessionFile,
            };
        }
        return {
            cwd: resolvePiWorkspaceCwd(tab.session.session?.cwd),
            layout: getAgentLayout(tab.session.backend),
            currentSessionPath: tab.session.session?.sessionFile,
        };
    }

    /** Preload current-folder session list so the resume panel opens instantly. */
    warmSessionListCache(): Promise<void> {
        const tab = this._host.activeTab;
        if (!tab) {
            return Promise.resolve();
        }
        const target = this._sessionListTarget(tab);
        if (this._sessionLists.cached(target)) {
            return Promise.resolve();
        }
        return this._sessionLists.fetch(target).then(
            () => undefined,
            () => undefined, // warm is best-effort
        );
    }

    private _postSessionListPayload(
        target: SessionListTarget,
        sessions: SessionInfo[],
        query: string,
        loading: boolean,
        progress?: { loaded: number; total: number },
        error?: string,
    ): void {
        const items = loading
            ? []
            : buildSessionListRows(
                  withVoiceSessions(sessions, this._voiceSessions.history?.voiceSessions() ?? [], getSessionDirForCwd(target.cwd, target.layout)),
                  query,
                  target.currentSessionPath,
              );
        this._host.post({
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
        const tab = this._host.activeTab;
        if (!tab || !this._sessionPanelOpen) {
            return;
        }

        this._sessionPanelQuery = query;
        const generation = ++this._sessionListGeneration;
        const isStale = (): boolean => generation !== this._sessionListGeneration || !this._sessionPanelOpen;
        const target = this._sessionListTarget(tab);

        // Stale-while-revalidate: sessions are created/extended outside this panel (TUI, other windows).
        const cached = this._sessionLists.cached(target);
        this._postSessionListPayload(target, cached ?? [], query, !cached);

        try {
            const sessions = await this._sessionLists.fetch(
                target,
                cached
                    ? undefined
                    : (loaded, total) => {
                          if (!isStale()) {
                              this._postSessionListPayload(target, [], query, true, { loaded, total });
                          }
                      },
            );
            if (!isStale()) {
                this._postSessionListPayload(target, sessions, query, false);
            }
        } catch (err: unknown) {
            if (isStale()) {
                return;
            }
            const message = err instanceof Error ? err.message : String(err);
            this._postSessionListPayload(target, [], query, false, undefined, message);
        }
    }

    /** Open `sessionPath` in its own tab: the tab that has it already, else a new one (a blank active tab is reused). */
    private async _resumeSessionFromPanel(sessionPath: string): Promise<void> {
        const current = this._host.activeTab;
        if (!current || !sessionPath) {
            return;
        }
        this._closeSessionPanel();

        // Two worker processes must not hold one session: pi's first write of a new session file fails when it exists.
        const target = canonicalizeSessionPath(sessionPath);
        const holder = [...this._host.tabs.values()].find(
            (tab) =>
                canonicalizeSessionPath(this._tui.tuis.get(tab.id)?.sessionFile ?? tab.session.session?.sessionFile) ===
                target,
        );
        if (holder) {
            this._tabs.switchTab(holder.id);
            this._onResumed(holder.id);
            return;
        }

        const sessionInfo = this._voiceSessions.sessionInfo(sessionPath);
        const title = sessionInfo ? getSessionDisplayTitle(sessionInfo) : DEFAULT_CONVERSATION_TITLE;
        const targetBackend: AgentBackend =
            sessionPath.includes('/.omp/agent/') || sessionPath.includes('\\.omp\\agent\\')
                ? 'omp'
                : 'pi';
        const targetCwd = sessionInfo?.cwd;
        const previousBackend = this._host.currentBackend;
        const sameBackend = previousBackend === targetBackend;
        this._host.currentBackend = targetBackend;

        // Resumed from a tab showing its TUI: the session opens in a new tab's TUI.
        if (current.tuiMode) {
            const tab = await this._tabs.createEmptyTabState(targetBackend, targetCwd);
            tab.name = title;
            tab.tuiMode = true;
            await this._tui.start(tab.id, 80, 24, { sessionFile: sessionPath, cwd: targetCwd, backend: targetBackend });
            this._tabs.switchTab(tab.id);
            vscode.window.showInformationMessage(`Resumed session: ${title}`);
            this._onResumed(tab.id);
            return;
        }

        // A blank conversation has nothing to keep: it takes the session instead of staying behind as an empty tab.
        const reuseCurrent =
            sameBackend &&
            !current.restoring &&
            current.session.messages.length === 0 &&
            !current.isStreaming &&
            !current.botView &&
            current.queuedMessages.length === 0 &&
            current.connectionStatus.phase !== 'failed' &&
            (!targetCwd || current.session.session?.cwd === targetCwd);
        const tab = reuseCurrent ? current : await this._tabs.createEmptyTabState(targetBackend, targetCwd);
        // Marked as loading before it shows, so it opens on the history loading rather than the welcome.
        const loading = this._tabs.loadSessionIntoTab(tab, sessionPath, !reuseCurrent);
        if (reuseCurrent) {
            this._host.sendStateSync();
        } else {
            this._tabs.switchTab(tab.id);
        }

        try {
            if (!(await loading)) {
                this._backToTab(current, previousBackend);
                this._host.post({ type: 'toast', message: 'Resume cancelled.', variant: 'error' });
                return;
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._host.outputChannel.appendLine(`Resume session failed: ${message}`);
            this._backToTab(current, previousBackend);
            this._host.post({ type: 'toast', message: `Failed to resume session: ${message}`, variant: 'error' });
            return;
        }
        this._sessionLists.invalidate();
        void this.warmSessionListCache();
        vscode.window.showInformationMessage(`Resumed session: ${title}`);
        this._onResumed(tab.id);
    }

    /** After a resume into a new tab failed (and closed it): show the tab, and its backend, the user resumed from. */
    private _backToTab(tab: TabState, backend: AgentBackend): void {
        this._host.currentBackend = backend;
        if (this._host.tabs.has(tab.id)) {
            this._tabs.showTab(tab.id);
        } else {
            this._host.sendStateSync();
        }
    }

    private async _deleteSessionFromPanel(sessionPath: string): Promise<void> {
        const tab = this._host.activeTab;
        if (!tab || !sessionPath) {
            return;
        }

        const currentPath = tab.session.session?.sessionFile;
        if (
            currentPath &&
            canonicalizeSessionPath(currentPath) === canonicalizeSessionPath(sessionPath)
        ) {
            this._host.post({
                type: 'toast',
                message: 'Cannot delete the currently active session',
                variant: 'error',
            });
            return;
        }

        const result = await deleteSessionFile(sessionPath);
        if (!result.ok) {
            this._host.post({
                type: 'toast',
                message: `Failed to delete: ${result.error}`,
                variant: 'error',
            });
            return;
        }

        this._sessionLists.removeSession(sessionPath);
        const voice = this._voiceSessions.sessionFor(sessionPath);
        if (voice) {
            this._voiceSessions.history?.forgetTask(voice.sessionFile);
        }
        const msg = result.method === 'trash' ? 'Session moved to trash' : 'Session deleted';
        this._host.post({ type: 'toast', message: msg, variant: 'info' });
        await this.loadSessionListForPanel(this._sessionPanelQuery);
    }

    private async _renameSessionFromPanel(sessionPath: string, name: string): Promise<void> {
        const tab = this._host.activeTab;
        if (!tab || !sessionPath) {
            return;
        }

        const trimmed = name.trim();
        if (!trimmed) {
            this._host.post({ type: 'toast', message: 'Session name cannot be empty', variant: 'error' });
            return;
        }

        const currentPath = tab.session.session?.sessionFile;
        const isCurrent =
            !!currentPath &&
            canonicalizeSessionPath(currentPath) === canonicalizeSessionPath(sessionPath);

        const voice = this._voiceSessions.sessionFor(sessionPath);
        try {
            if (isCurrent) {
                await tab.session.setSessionName(trimmed);
                if (tab.session.session) {
                    tab.session.session.sessionName = trimmed;
                }
                updateTabName(tab);
                await this._host.pushStateSync();
            } else if (!voice || fs.existsSync(sessionPath)) {
                // A voice-only pi session has no file yet: its name lives with its voice conversation.
                appendSessionDisplayName(sessionPath, trimmed);
            }
            if (voice) {
                this._voiceSessions.history?.nameTask(voice.sessionFile, trimmed, 'user');
            }
            invalidateSessionInfoPath(sessionPath);
            this._sessionLists.invalidate();
            void this.warmSessionListCache();
            this._host.post({ type: 'toast', message: 'Session renamed', variant: 'info' });
            await this.loadSessionListForPanel(this._sessionPanelQuery);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._host.post({ type: 'toast', message: `Failed to rename: ${message}`, variant: 'error' });
        }
    }

    handlers(): MessageHandlers {
        return {
            openResumePicker: () => {
                void this.openSessionPanel();
            },
            toggleSessionPanel: () => {
                this._toggleSessionPanel();
            },
            closeSessionPanel: () => {
                this._closeSessionPanel();
            },
            openSessionTree: () => {
                void this.openSessionTree();
            },
            closeSessionTree: () => {
                this._closeSessionTree();
            },
            forkSessionTree: (msg) => {
                void this._forkSessionTree(msg.entryId, msg.summarize, msg.customInstructions);
            },
            loadSessionList: (msg) => {
                void this.loadSessionListForPanel(msg.query ?? '');
            },
            resumeSession: (msg) => {
                void this._resumeSessionFromPanel(msg.sessionPath);
            },
            deleteSession: (msg) => {
                void this._deleteSessionFromPanel(msg.sessionPath);
            },
            renameSession: (msg) => {
                void this._renameSessionFromPanel(msg.sessionPath, msg.name);
            },
        };
    }
}
