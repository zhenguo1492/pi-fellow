import * as vscode from 'vscode';
import { SessionActivityWatcher } from '../pi/sessionActivity';
import { TuiProcess } from '../pi/tuiTerminal';
import type { AgentBackend, TuiAuthCommand } from '../shared/protocol';
import { TUI_RUN_END, TUI_RUN_START, type WorkerEvent } from '../voiceAgent/workerController';
import type { SidebarHost } from './sidebarHost';
import type { MessageHandlers } from './sidebarMessageHandlers';
import { updateTabName } from './sidebarTabs';
import { resetTabUiState, tabReady, type TabState } from './sidebarTabState';
import { TabTuis } from './sidebarTui';
import { TuiDialogs } from './sidebarTuiDialogs';

/** Lines of the screen a stopped TUI run's notification carries: its last reply or the question it asks. */
const RUN_END_SCREEN_LINES = 15;

/** Per-tab TUI mode (`TabState.tuiMode`): a tab shows its CLI's TUI instead of the chat UI; plus the /login and /logout banner that switches there. */
export class SidebarTuiMode {
    readonly tuis = new TabTuis({
        start: (options) => TuiProcess.start(options),
        post: (message) => this._host.post(message),
        log: (line) => this._host.outputChannel.appendLine(line),
        wanted: (tabId) => !!this._host.tabs.get(tabId)?.tuiMode,
        watchSession: (sessionFile, onBusy) => new SessionActivityWatcher(sessionFile, onBusy),
        busyChanged: (tabId, busy) => {
            const tab = this._host.tabs.get(tabId);
            if (tab) this._setTuiBusy(tab, busy);
            this._reportRun(tabId, busy);
        },
        screenChanged: (tabId) =>
            void this.dialogs.check(tabId).catch((err: unknown) =>
                this._host.outputChannel.appendLine(`Reading the TUI dialog failed: ${err instanceof Error ? err.message : String(err)}`),
            ),
    });
    /** The dialog cards of the TUIs, answered by typing into them. */
    readonly dialogs = new TuiDialogs({
        tui: (tabId) => this.tuis.get(tabId),
        post: (message) => this._host.post(message),
        log: (line) => this._host.outputChannel.appendLine(line),
    });
    /** /login or /logout waiting on the chat banner that switches to the TUI to run it. */
    private _authPrompt: TuiAuthCommand | undefined;
    /** Tabs whose TUI was sent to /login or /logout: the RPC process caches credentials, so it restarts on return. */
    private readonly _authTabs = new Set<string>();

    constructor(
        private readonly _host: SidebarHost,
        /** The provider's worker events (`WorkerController.onTabEvent`), where the voice agent hears of TUI runs. */
        private readonly _onTabEvent: (tabId: string, event: WorkerEvent) => void,
    ) {}

    get authPrompt(): TuiAuthCommand | undefined {
        return this._authPrompt;
    }

    /** The tab's TUI started or ended a run; ending one in a background tab marks it like a finished chat run. */
    private _setTuiBusy(tab: TabState, busy: boolean): void {
        if (tab.tuiBusy === busy) return;
        tab.tuiBusy = busy;
        if (!busy && tab.id !== this._host.activeTabId) {
            tab.hasNotification = true;
        }
        this._host.sendStateSync();
    }

    /**
     * Tells the voice agent a TUI run started or stopped. A stop carries the screen's last lines and, when
     * the TUI waits on a dialog a card can answer, its question: the TUI may be done, or asking something
     * such as a tool approval. A TUI stopped or exited with the run on has nothing to show, and the run
     * did not end on its own: no notice.
     */
    private _reportRun(tabId: string, busy: boolean): void {
        if (busy) {
            this._onTabEvent(tabId, { type: TUI_RUN_START });
            return;
        }
        const tui = this.tuis.get(tabId);
        if (!tui || tui.exited) return;
        void (async () => {
            const screen = await tui.screen().tail(RUN_END_SCREEN_LINES);
            await this.dialogs.check(tabId);
            const question = this.dialogs.question(tabId);
            this._onTabEvent(tabId, { type: TUI_RUN_END, screen, ...(question ? { question } : {}) });
        })().catch((err: unknown) =>
            this._host.outputChannel.appendLine(`Reading the TUI screen failed: ${err instanceof Error ? err.message : String(err)}`),
        );
    }

    /** Neither CLI logs in over RPC: show a chat banner that switches to the TUI and runs the command. */
    async promptAuth(command: TuiAuthCommand): Promise<void> {
        await vscode.commands.executeCommand('oh-my-pi-chater.chat.focus');
        const active = this._host.activeTab;
        if (active?.tuiMode) {
            this._authTabs.add(active.id);
            this._host.post({ type: 'toast', message: `Type /${command} in the terminal.`, variant: 'info' });
            return;
        }
        this._authPrompt = command;
        this._host.sendStateSync();
    }

    private async _runAuth(): Promise<void> {
        const command = this._authPrompt;
        const tab = this._host.activeTab;
        if (!command || !tab || tab.tuiMode) {
            return;
        }
        // A chat tab has no TUI process; the toggle below starts this tab's, which types it.
        this.tuis.typeOnStart(tab.id, `/${command}\r`);
        await this._toggle(tab);
        if (tab.tuiMode) {
            this._authTabs.add(tab.id);
        } else {
            this.tuis.cancelTypeOnStart(tab.id); // refused: a response is streaming
        }
    }

    /** Switch only `tab` between its chat and its TUI; other tabs keep their view. */
    private async _toggle(tab: TabState): Promise<void> {
        if (!tab.tuiMode && tab.isStreaming) {
            // RPC and TUI must not append to the same session file at once.
            this._host.post({ type: 'toast', message: 'Stop the running response before switching to TUI.', variant: 'error' });
            return;
        }
        tab.tuiMode = !tab.tuiMode;
        if (tab.tuiMode) {
            this._authPrompt = undefined;
            tab.botView = false; // entering TUI shows the terminal; the Bot view is a click away
            this._host.sendStateSync();
            return;
        }
        const hadTui = !!this.tuis.get(tab.id);
        const ranAuth = this._authTabs.delete(tab.id);
        await this.tuis.stop(tab.id);
        if (hadTui) {
            // The TUI appended to the tab's session file; the idle RPC process holds stale state.
            // After /login or /logout its model/auth snapshot is stale too: only a restart re-reads it.
            try {
                await (ranAuth ? tab.session.reloadPiAgentResources() : tab.session.reloadSessionFromDisk());
                resetTabUiState(tab);
                updateTabName(tab);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                this._host.outputChannel.appendLine(`Reload after TUI failed (${tab.name}): ${message}`);
            }
        }
        this._host.sendStateSync();
    }

    /** Start (or re-attach to) the tab's TUI; `resume` replaces a running one with that session's. */
    async start(
        tabId: string,
        cols: number,
        rows: number,
        resume?: { sessionFile: string; cwd: string | undefined; backend: AgentBackend },
    ): Promise<void> {
        const tab = this._host.tabs.get(tabId);
        if (!tab?.tuiMode) return;
        if (!resume) {
            // The TUI resumes the tab's session file: a restored conversation must have loaded first.
            // A worker that failed to start leaves no session file; the TUI then starts a new one.
            await tabReady(tab).catch(() => undefined);
            if (!tab.tuiMode || this._host.tabs.get(tabId) !== tab) return;
        }
        await this.tuis.start(tabId, {
            cwd:
                resume?.cwd ??
                tab.session.session?.cwd ??
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
                process.cwd(),
            sessionFile: resume?.sessionFile ?? tab.session.session?.sessionFile,
            backend: resume?.backend ?? tab.session.backend,
            cols,
            rows,
            replace: resume !== undefined,
        });
    }

    handlers(): MessageHandlers {
        return {
            toggleTuiMode: async () => {
                const tab = this._host.activeTab;
                if (tab) await this._toggle(tab);
            },
            runTuiAuth: async () => {
                await this._runAuth();
            },
            dismissTuiAuth: () => {
                this._authPrompt = undefined;
                this._host.sendStateSync();
            },
            tuiStart: async (msg) => {
                await this.start(msg.tabId, msg.cols, msg.rows);
            },
            tuiInput: (msg) => {
                const tab = this._host.tabs.get(msg.tabId);
                // The user submitted something themselves: what the TUI does next is theirs.
                if (tab && msg.data.includes('\r')) tab.tuiPromptFromVoice = false;
                this.tuis.get(msg.tabId)?.write(msg.data);
            },
            tuiResize: (msg) => {
                this.tuis.get(msg.tabId)?.resize(msg.cols, msg.rows);
            },
        };
    }
}
