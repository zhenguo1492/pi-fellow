import type { WorkerController, WorkerStatus, WorkerTask } from '../../../voiceAgent/workerController';

/** A chat tab whose worker sits idle in Auto: the voice agent's own tools run unasked. */
export class IdleWorker implements WorkerController {
    readonly task: WorkerTask = { tabId: 'tab-1', name: 'Explain login', backend: 'omp', sessionFile: '/w/login.jsonl' };

    activeTask() {
        return this.task;
    }
    onActiveTaskChanged() {
        return { dispose() {} };
    }
    onSessionResumed() {
        return { dispose() {} };
    }
    onTabEvent() {
        return { dispose() {} };
    }
    onRequestsChanged() {
        return { dispose() {} };
    }
    async send() {
        return 'started' as const;
    }
    async abort() {}
    status(): WorkerStatus {
        return { phase: 'idle', queued: 0 };
    }
    pendingRequests() {
        return [];
    }
    answer() {
        return false;
    }
    recentTurns() {
        return [];
    }
    async nameTask() {
        return false;
    }
    permissionLevel() {
        return 'auto' as const;
    }
    async requestToolApproval() {
        return true;
    }
    lockedPaths(): string[] {
        return [];
    }
    async readTuiScreen(): Promise<string> {
        throw new Error('Not a TUI tab.');
    }
    async typeIntoTui(): Promise<string> {
        throw new Error('Not a TUI tab.');
    }
}
