import type { AgentBackend } from '../pi/agentBackend';
import type { TuiProcessOptions } from '../pi/tuiTerminal';
import type { ServerMessage } from '../shared/protocol';

/** The part of a `TuiProcess` the sidebar drives. */
export interface TabTui {
    /** Folder the TUI runs in; its `/resume` "current folder" scope. */
    readonly cwd: string;
    readonly backend: AgentBackend;
    readonly sessionFile: string | undefined;
    readonly exited: boolean;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    typeWhenReady(text: string): Promise<void>;
    snapshot(): Promise<string>;
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
}

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
                onExit: (exitCode) => {
                    this._flushOutput();
                    // Stopped on purpose (mode off, tab closed) → already unregistered, nothing to report.
                    if (this._processes.get(tabId) !== proc) return;
                    this._processes.delete(tabId);
                    this._exitCodes.set(tabId, exitCode);
                    this._host.post({ type: 'tuiExit', tabId, exitCode });
                },
            });
            if (!this._host.wanted(tabId)) {
                await proc.dispose();
                return;
            }
            this._processes.set(tabId, proc);
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
