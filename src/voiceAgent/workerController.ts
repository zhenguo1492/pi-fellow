import type { AgentBackend } from '../pi/agentBackend';
import type { ExtensionUiMethod } from '../shared/extensionUi';

/**
 * Task-level control of the worker session in one sidebar tab: the only way the voice agent
 * touches a worker (docs/voice-agent-design.md §5.11). Implemented by SidebarProvider so voice
 * input shares the composer's send path (turn checkpoints, diff tracking, send queue).
 */
export interface WorkerController {
    /** The tab voice control is bound to; undefined before the first tab exists. */
    activeTask(): WorkerTask | undefined;
    /**
     * Fires with the new active task when the tab changes, the backend workspace changes, or the tab
     * switches worker session (resume, /new). Not fired for a session file appearing on a new tab.
     */
    onActiveTaskChanged(listener: (task: WorkerTask | undefined) => void): { dispose(): void };
    /** Raw agent events of every tab in the current backend workspace, for the activity log (§5.8). */
    onTabEvent(listener: (event: { tabId: string; event: WorkerEvent }) => void): { dispose(): void };
    /** A tab's pending requests changed: one arrived, was answered (here or in the editor), or timed out. */
    onRequestsChanged(listener: (tabId: string) => void): { dispose(): void };
    /**
     * Routed on the worker's state at call time, never on the caller's stale view:
     * idle → new task; busy + `now` → steer the running task; busy + `after` → the tab's send queue.
     * Throws when the tab is gone or the message is a slash command / `!` shell shortcut.
     */
    send(tabId: string, text: string, options: WorkerSendOptions): Promise<WorkerSendOutcome>;
    abort(tabId: string): Promise<void>;
    status(tabId: string): WorkerStatus;
    /** Dialogs waiting on the user, oldest first; omp tool approvals arrive here as `select` Approve/Deny. */
    pendingRequests(tabId: string): WorkerRequest[];
    /**
     * First answer wins (the webview may answer the same request). Returns false when the request
     * was already answered, timed out, or never existed; throws when the answer does not fit it.
     */
    answer(tabId: string, requestId: string, answer: WorkerAnswer): boolean;
    /** Last `count` user instructions with the worker's final reply to each, oldest first. */
    recentTurns(tabId: string, count: number): WorkerTurn[];
}

export interface WorkerTask {
    tabId: string;
    name: string;
    backend: AgentBackend;
    /** Worker session file; keys the voice context once it exists (§5.12 rule 1). */
    sessionFile?: string;
    /** `provider/id` of the worker's current model. */
    model?: string;
}

/** A task's key before its tab has a session file. Tab ids restart with the extension host. */
export function provisionalTaskKey(tabId: string): string {
    return `tab:${tabId}`;
}

/** Voice context and transcript key (§5.12 rule 1): the worker session file, or the tab before it has one. */
export function taskKey(task: Pick<WorkerTask, 'tabId' | 'sessionFile'>): string {
    return task.sessionFile ?? provisionalTaskKey(task.tabId);
}

export interface WorkerSendOptions {
    when: 'now' | 'after';
    /** Append the active editor's file/selection, as the composer does. */
    includeEditorContext?: boolean;
}

export type WorkerSendOutcome = 'started' | 'steered' | 'queued';

export interface WorkerStatus {
    phase: 'idle' | 'working' | 'awaiting' | 'error';
    /** Since the current run started; only while working/awaiting. */
    elapsedMs?: number;
    /** Messages waiting in the tab's send queue. */
    queued: number;
    error?: string;
}

export interface WorkerRequest {
    id: string;
    method: ExtensionUiMethod;
    title?: string;
    message?: string;
    options?: string[];
    /** Epoch ms the request reached the extension; answers must come from a user turn after it. */
    receivedAt: number;
}

export interface WorkerTurn {
    instruction: string;
    /** Worker's last text reply in that turn; empty while it is still working. */
    reply: string;
}

/** A worker agent event as the sidebar receives it (pi/omp RPC session events). */
export interface WorkerEvent {
    type: string;
    [key: string]: unknown;
}

/** select/input/editor take `value`; confirm takes `confirmed`. */
export type WorkerAnswer = { cancelled: true } | { confirmed: boolean } | { value: string };
