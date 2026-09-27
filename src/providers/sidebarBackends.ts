import * as vscode from 'vscode';
import type { PiRpcSessionManager } from '../pi/rpcSession';
import type { AgentBackend } from '../shared/protocol';
import type { TabState } from './sidebarTabState';

interface BackendWorkspace {
    tabs: Map<string, TabState>;
    activeTabId: string;
}

/** A worker process started ahead of time so the next new tab does not wait for startup. */
export interface PrewarmedSession {
    backend: AgentBackend;
    cwd: string;
    session: PiRpcSessionManager;
    readyPromise: Promise<void>;
}

/** Each backend's tabs, the backend the sidebar shows, and the pre-warmed session for its next new tab. */
export class SidebarBackends {
    private readonly _workspaces: Record<AgentBackend, BackendWorkspace> = {
        pi: { tabs: new Map(), activeTabId: '' },
        omp: { tabs: new Map(), activeTabId: '' },
    };
    current: AgentBackend = 'pi';

    private _prewarmedSession: PrewarmedSession | null = null;
    private _prewarmingInFlight = false;
    private _prewarmDebounceTimer: NodeJS.Timeout | undefined;
    /** Workers being started together (window startup, restoring tabs): a pre-warm now would compete with them. */
    private _prewarmHolds = 0;

    constructor(private readonly _outputChannel: vscode.OutputChannel) {}

    private get _currentWorkspace(): BackendWorkspace {
        return this._workspaces[this.current] ?? this._workspaces.pi;
    }

    get tabs(): Map<string, TabState> {
        return this._currentWorkspace.tabs;
    }

    get activeTabId(): string {
        return this._currentWorkspace.activeTabId;
    }

    set activeTabId(id: string) {
        this._currentWorkspace.activeTabId = id;
    }

    get activeTab(): TabState {
        return this.tabs.get(this.activeTabId)!;
    }

    schedulePrewarmSession(delayMs = 500): void {
        if (this._prewarmHolds > 0) return;
        clearTimeout(this._prewarmDebounceTimer);
        this._prewarmDebounceTimer = setTimeout(() => {
            this._prewarmDebounceTimer = undefined;
            void this._prewarmSession();
        }, delayMs);
    }

    /** No pre-warm until every hold is released; the last release schedules one after `delayMs`. */
    holdPrewarm(): void {
        this._prewarmHolds++;
        clearTimeout(this._prewarmDebounceTimer);
        this._prewarmDebounceTimer = undefined;
    }

    releasePrewarm(delayMs: number): void {
        this._prewarmHolds--;
        this.schedulePrewarmSession(delayMs);
    }

    private async _prewarmSession(): Promise<void> {
        if (this._prewarmingInFlight) return;
        const targetBackend = this.current;
        const targetCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

        if (
            this._prewarmedSession &&
            this._prewarmedSession.backend === targetBackend &&
            this._prewarmedSession.cwd === targetCwd
        ) {
            return;
        }

        this.dropPrewarmedSession();

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

    async disposePrewarmedSession(): Promise<void> {
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

    /** The pre-warmed session when it was started for `backend` in `cwd`; any other one is disposed. */
    takePrewarmedSession(backend: AgentBackend, cwd: string): PrewarmedSession | null {
        if (
            this._prewarmedSession &&
            this._prewarmedSession.backend === backend &&
            this._prewarmedSession.cwd === cwd
        ) {
            const prewarmed = this._prewarmedSession;
            this._prewarmedSession = null;
            return prewarmed;
        }
        this.dropPrewarmedSession();
        return null;
    }

    /** Dispose the pre-warmed session without waiting (it is for another backend or folder). */
    dropPrewarmedSession(): void {
        if (this._prewarmedSession) {
            const old = this._prewarmedSession;
            this._prewarmedSession = null;
            void old.session.dispose();
        }
    }
}
