import type { AgentBackend } from '../pi/agentBackend';
import type { TerminalScreen } from '../pi/terminalScreen';
import type { TuiProcessOptions } from '../pi/tuiTerminal';
import type { ServerMessage } from '../shared/protocol';

/** The part of a `TuiProcess` the sidebar drives. */
export interface TabTui {
    /** Folder the TUI runs in; its `/resume` "current folder" scope. */
    readonly cwd: string;
    readonly backend: AgentBackend;
    readonly sessionFile: string | undefined;
    readonly exited: boolean;
    /** The terminal title the TUI last set (omp: `π ! …` while it waits on the user). */
    readonly title: string;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    typeWhenReady(text: string): Promise<void>;
    snapshot(): Promise<string>;
    /** The voice agent's view of the screen; throws once the TUI has exited. */
    screen(): TerminalScreen;
    dispose(): Promise<void>;
}

export type TuiMessage = Extract<ServerMessage, { type: 'tuiData' | 'tuiSnapshot' | 'tuiExit' }>;

export interface TuiLaunch {
    cwd: string;
    sessionFile: string | undefined;
    backend: AgentBackend;
    cols: number;
    rows: number;
    /** Replace a running TUI (resume into another session) instead of re-attaching to it. */
    replace: boolean;
}

export interface TabTuisHost {
    start(options: TuiProcessOptions): Promise<TabTui>;
    post(message: TuiMessage): void;
    log(line: string): void;
    /** Still in TUI mode with the tab open: a TUI that finished starting after either changed is dropped. */
    wanted(tabId: string): boolean;
    /** Follow the session file the TUI appends to; `onBusy` reports whether its agent is working per the file. */
    watchSession(sessionFile: string, onBusy: (busy: boolean) => void): { dispose(): void };
    /** The agent in the tab's TUI started or stopped working. */
    busyChanged(tabId: string, busy: boolean): void;
    /**
     * Look at the tab's screen again for a dialog: at most every DIALOG_CHECK_MS while the TUI draws or
     * sets its title (always after the last change), and at once when it stops or exits.
     */
    screenChanged(tabId: string): void;
}

/** Both CLIs' TUIs interrupt a running turn on Escape (omp's vim mode takes a first Escape to leave insert mode). */
export const TUI_INTERRUPT = '\x1b';

/**
 * What to type into a CLI TUI to send `text` as a prompt: pasted (bracketed, so its newlines stay in the
 * editor instead of each submitting a line), then submitted. Enter starts a turn, or steers the running
 * one; `queue` asks for a follow-up after it instead: Ctrl+Q in omp, Alt+Enter in pi (Ctrl+Q on
 * Windows and WSL, where the terminal takes Alt+Enter).
 */
export function tuiPromptKeys(text: string, backend: AgentBackend, queue: boolean, windows: boolean): string {
    // A paste end marker inside the text would end the paste early and type the rest as keys.
    const paste = `\x1b[200~${text.replace(/\x1b\[20[01]~/g, '')}\x1b[201~`;
    return paste + (!queue ? '\r' : backend === 'omp' || windows ? '\x11' : '\x1b\r');
}

/**
 * A working TUI changes its screen's text many times a second (a spinner, an elapsed timer); an idle
 * one, or one waiting on a dialog, only restyles it at most. This long without new text ends a run the
 * session file still shows as on.
 */
const TUI_QUIET_MS = 3000;

interface TuiActivity {
    watch?: { dispose(): void };
    /** The session file's last word: a run is on. */
    fileBusy: boolean;
    /** Last state reported to the host. */
    busy: boolean;
    /** When the TUI last drew new text (`onScreenChange`), not merely more bytes. */
    lastDrawAt: number;
    quietTimer?: NodeJS.Timeout;
}

/** How often the dialog check runs at most while the screen changes: it runs once after the last change. */
export const DIALOG_CHECK_MS = 500;

/**
 * One CLI TUI per chat tab in TUI mode. Streams their output to the webview, re-attaches new terminal
 * views to running TUIs, and remembers exit codes so a hidden view that returns can be repainted.
 */
export class TabTuis {
    private readonly _processes = new Map<string, TabTui>();
    private readonly _starting = new Set<string>();
    /** PTY output coalesced per tab so streaming does not post one message per tiny chunk. */
    private readonly _output = new Map<string, string>();
    private _flushTimer: NodeJS.Timeout | undefined;
    /** Exit codes of TUIs that ended and were not restarted (re-sent when a hidden view returns). */
    private readonly _exitCodes = new Map<string, number>();
    /** Keys to type into a tab's TUI once it starts (the banner's /login or /logout). */
    private readonly _pendingInput = new Map<string, string>();
    /** Working state of the running TUIs. */
    private readonly _activity = new Map<string, TuiActivity>();
    /** A dialog check due for the tab (see `screenChanged`). */
    private readonly _checks = new Map<string, NodeJS.Timeout>();

    constructor(private readonly _host: TabTuisHost) {}

    get(tabId: string): TabTui | undefined {
        return this._processes.get(tabId);
    }

    /** Start the tab's TUI once the webview has a sized terminal for it, or re-attach that view to the running one. */
    async start(tabId: string, launch: TuiLaunch): Promise<void> {
        if (this._starting.has(tabId)) return;
        const existing = this._processes.get(tabId);
        if (existing && !existing.exited && !launch.replace) {
            // New terminal view (webview re-created): size it and replay the full screen.
            existing.resize(launch.cols, launch.rows);
            await this._sendSnapshot(tabId);
            return;
        }
        if (existing) {
            await this.stop(tabId);
        }
        this._exitCodes.delete(tabId);
        this._starting.add(tabId);
        try {
            const proc = await this._host.start({
                cwd: launch.cwd,
                sessionFile: launch.sessionFile,
                backend: launch.backend,
                cols: launch.cols,
                rows: launch.rows,
                onData: (data) => this._queueOutput(tabId, data),
                onScreenChange: () => this._drew(tabId),
                onTitleChange: () => this._scheduleCheck(tabId),
                onExit: (exitCode) => {
                    this._flushOutput();
                    // Stopped on purpose (mode off, tab closed) → already unregistered, nothing to report.
                    if (this._processes.get(tabId) !== proc) return;
                    this._processes.delete(tabId);
                    this._endActivity(tabId);
                    this._exitCodes.set(tabId, exitCode);
                    this._host.post({ type: 'tuiExit', tabId, exitCode });
                    this._checkNow(tabId);
                },
            });
            if (!this._host.wanted(tabId)) {
                await proc.dispose();
                return;
            }
            this._processes.set(tabId, proc);
            if (proc.sessionFile) {
                const activity: TuiActivity = { fileBusy: false, busy: false, lastDrawAt: 0 };
                activity.watch = this._host.watchSession(proc.sessionFile, (busy) => {
                    activity.fileBusy = busy;
                    this._refreshBusy(tabId);
                });
                this._activity.set(tabId, activity);
            }
            const pending = this._pendingInput.get(tabId);
            if (pending) {
                this._pendingInput.delete(tabId);
                void proc.typeWhenReady(pending);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._host.log(`TUI start failed: ${message}`);
            this._host.post({ type: 'tuiData', tabId, data: `\r\n\x1b[31mTUI start failed: ${message}\x1b[0m\r\n` });
        } finally {
            this._starting.delete(tabId);
        }
    }

    async stop(tabId: string): Promise<void> {
        this._exitCodes.delete(tabId);
        const proc = this._processes.get(tabId);
        if (!proc) return;
        this._processes.delete(tabId);
        this._endActivity(tabId);
        this._checkNow(tabId);
        await proc.dispose();
    }

    /** Stop every TUI; returns the tabs that had one. */
    async stopAll(): Promise<string[]> {
        const tabIds = [...this._processes.keys()];
        await Promise.all(tabIds.map((id) => this.stop(id)));
        return tabIds;
    }

    /** Type `keys` into the tab's TUI as soon as its next start has it reading input. */
    typeOnStart(tabId: string, keys: string): void {
        this._pendingInput.set(tabId, keys);
    }

    cancelTypeOnStart(tabId: string): void {
        this._pendingInput.delete(tabId);
    }

    /** Hidden (retained) webviews drop every message: repaint the terminals from the mirrors. */
    resync(): void {
        for (const tabId of this._processes.keys()) {
            void this._sendSnapshot(tabId);
        }
        for (const [tabId, exitCode] of this._exitCodes) {
            this._host.post({ type: 'tuiExit', tabId, exitCode });
        }
    }

    /** Replace the tab's terminal view with the TUI's full current screen + scrollback. */
    private async _sendSnapshot(tabId: string): Promise<void> {
        const proc = this._processes.get(tabId);
        if (!proc || proc.exited) return;
        // Queued live output is already in the mirror, so the snapshot supersedes it.
        this._output.delete(tabId);
        const data = await proc.snapshot();
        this._host.post({ type: 'tuiSnapshot', tabId, data });
    }

    private _queueOutput(tabId: string, data: string): void {
        this._output.set(tabId, (this._output.get(tabId) ?? '') + data);
        this._flushTimer ??= setTimeout(() => this._flushOutput(), 4);
    }

    private _drew(tabId: string): void {
        this._scheduleCheck(tabId);
        const activity = this._activity.get(tabId);
        if (!activity) return;
        activity.lastDrawAt = Date.now();
        // Drawing again after a quiet spell (an answered prompt): working again if the file still says so.
        if (activity.fileBusy && !activity.busy) this._refreshBusy(tabId);
    }

    /** A check at the end of the window this change opened, or the one already open: never more often, never before the last change. */
    private _scheduleCheck(tabId: string): void {
        if (this._checks.has(tabId)) return;
        this._checks.set(
            tabId,
            setTimeout(() => {
                this._checks.delete(tabId);
                this._host.screenChanged(tabId);
            }, DIALOG_CHECK_MS),
        );
    }

    private _checkNow(tabId: string): void {
        clearTimeout(this._checks.get(tabId));
        this._checks.delete(tabId);
        this._host.screenChanged(tabId);
    }

    /**
     * Working = the session file says a run is on AND the TUI keeps drawing new text (its spinner). An
     * interrupted run does not always end with an entry in the file, and a run waiting on the user (a tool
     * approval dialog) still shows as on there: the TUI going still ends it then.
     */
    private _refreshBusy(tabId: string): void {
        const activity = this._activity.get(tabId);
        if (!activity) return;
        clearTimeout(activity.quietTimer);
        activity.quietTimer = undefined;
        const quietFor = Date.now() - activity.lastDrawAt;
        const busy = activity.fileBusy && quietFor < TUI_QUIET_MS;
        if (busy) {
            activity.quietTimer = setTimeout(() => this._refreshBusy(tabId), TUI_QUIET_MS - quietFor);
        }
        if (busy !== activity.busy) {
            activity.busy = busy;
            this._host.busyChanged(tabId, busy);
        }
    }

    /** The TUI stopped or exited: stop following its session; a run it was on is over. */
    private _endActivity(tabId: string): void {
        const activity = this._activity.get(tabId);
        if (!activity) return;
        this._activity.delete(tabId);
        activity.watch?.dispose();
        clearTimeout(activity.quietTimer);
        if (activity.busy) this._host.busyChanged(tabId, false);
    }

    private _flushOutput(): void {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = undefined;
        }
        for (const [tabId, data] of this._output) {
            this._host.post({ type: 'tuiData', tabId, data });
        }
        this._output.clear();
    }
}
