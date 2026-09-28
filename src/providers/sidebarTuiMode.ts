import * as vscode from 'vscode';
import { SessionActivityWatcher } from '../pi/sessionActivity';
import { TuiProcess } from '../pi/tuiTerminal';
import type { AgentBackend, TuiAuthCommand } from '../shared/protocol';
import type { SidebarHost } from './sidebarHost';
import type { MessageHandlers } from './sidebarMessageHandlers';
import { updateTabName } from './sidebarTabs';
import { resetTabUiState, tabReady, type TabState } from './sidebarTabState';
import { TabTuis } from './sidebarTui';

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
        },
    });
    /** /login or /logout waiting on the chat banner that switches to the TUI to run it. */
    private _authPrompt: TuiAuthCommand | undefined;
    /** Tabs whose TUI was sent to /login or /logout: the RPC process caches credentials, so it restarts on return. */
    private readonly _authTabs = new Set<string>();

    constructor(private readonly _host: SidebarHost) {}

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
            tab.botView = false; // a TUI tab has no Bot view; switching back shows the conversation
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
                this.tuis.get(msg.tabId)?.write(msg.data);
            },
            tuiResize: (msg) => {
                this.tuis.get(msg.tabId)?.resize(msg.cols, msg.rows);
            },
        };
    }
}
