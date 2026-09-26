import type { WorkerEvent, WorkerStatus } from './workerController';

/**
 * Decides when the voice agent speaks up without being asked (docs/voice-agent-design.md §5.9):
 * which observation about the current task deserves a proactive turn, and whether now is the time.
 * Pure bookkeeping with injected time; the orchestrator owns turns and knows whether anyone is talking.
 */

/** Highest priority first. */
export type ObservationKind = 'needs_input' | 'error' | 'done' | 'research' | 'progress';

export type Observation =
    | { kind: 'needs_input'; tabId: string; requestIds: string[] }
    | { kind: 'error'; tabId: string; detail: string }
    | { kind: 'done'; tabId: string }
    | { kind: 'research'; tabId: string; jobId: string }
    | { kind: 'progress'; tabId: string };

/** `important`: requests, errors, finished work and research; `all` adds progress; `off` never speaks up. */
export type Narration = 'off' | 'important' | 'all';

export interface ArbiterSettings {
    narration: Narration;
    /** Quiet time after any turn before done, research or progress is announced; requests and errors skip it. */
    minProactiveGapMs: number;
    /** Progress is announced at most this often, and only after this long without a turn. */
    narrationIntervalMs: number;
}

/** The active task as it stands when the arbiter is asked. */
export interface ArbiterView {
    tabId: string;
    phase: WorkerStatus['phase'];
    /** Requests the worker is waiting on, oldest first. */
    requestIds: string[];
    /** Research jobs of the task's voice context that settled and have not been shown. */
    settledResearch: string[];
    /** Activity-log entries the task's voice context has not seen. */
    unseenUpdates: number;
}

/**
 * omp ends a steered run and starts another about 3 s later (design §2.4), and the send queue
 * starts its next message right after agent_end: only a worker still idle after this is done.
 */
export const DONE_SETTLE_MS = 4000;

interface TabWatch {
    /** When a run ended normally; done once the worker has stayed idle for DONE_SETTLE_MS. */
    endedAt?: number;
    /** The run failed and the user has not heard about it. */
    error?: string;
    /** Requests the user has already been told about. */
    told: Set<string>;
}

export class FloorArbiter {
    private readonly _tabs = new Map<string, TabWatch>();
    /** When the last voice turn ended; 0 before any. */
    private _lastTurnEndedAt = 0;
    /** When the current task became the active one. */
    private _taskSince = 0;

    constructor(private readonly _settings: () => ArbiterSettings) {}

    /** Every worker event of every tab: background tabs keep their outcomes for when they are active again (§5.12 rule 5). */
    ingest(tabId: string, event: WorkerEvent, now: number): void {
        const watch = this._watch(tabId);
        switch (event.type) {
            case 'agent_start':
                // A new run makes the previous outcome old news.
                watch.endedAt = undefined;
                watch.error = undefined;
                return;
            case 'agent_end': {
                if (event.isTerminal === false || event.willRetry === true) {
                    return;
                }
                const messages = event.messages as Array<{ stopReason?: string; errorMessage?: string }> | undefined;
                const last = messages?.[messages.length - 1];
                if (last?.stopReason === 'error') {
                    watch.error = last.errorMessage ?? 'unknown error';
                } else if (last?.stopReason !== 'aborted') {
                    // A stop the user asked for needs no announcement.
                    watch.endedAt = now;
                }
                return;
            }
            case 'auto_retry_end':
                if (event.success === false) {
                    watch.error = String(event.finalError ?? 'Could not reach the model after several attempts');
                }
                return;
            case 'compaction_end':
                if (event.errorMessage && event.willRetry !== true) {
                    watch.error = `Compaction failed: ${String(event.errorMessage)}`;
                }
                return;
        }
    }

    /** The most urgent observation worth a proactive turn now, or undefined. Does not consume it. */
    next(view: ArbiterView, now: number): Observation | undefined {
        const settings = this._settings();
        if (settings.narration === 'off') {
            return undefined;
        }
        const { tabId } = view;
        const watch = this._watch(tabId);
        for (const id of watch.told) {
            if (!view.requestIds.includes(id)) {
                watch.told.delete(id);
            }
        }
        // Requests and errors cannot wait for a quiet gap: a request may time out, an error stops the work.
        if (view.requestIds.some((id) => !watch.told.has(id))) {
            return { kind: 'needs_input', tabId, requestIds: view.requestIds };
        }
        if (watch.error !== undefined) {
            return { kind: 'error', tabId, detail: watch.error };
        }
        if (now - this._lastTurnEndedAt < settings.minProactiveGapMs) {
            return undefined;
        }
        if (watch.endedAt !== undefined && view.phase === 'idle' && now - watch.endedAt >= DONE_SETTLE_MS) {
            return { kind: 'done', tabId };
        }
        if (view.settledResearch.length > 0) {
            return { kind: 'research', tabId, jobId: view.settledResearch[0] };
        }
        const quietSince = Math.max(this._lastTurnEndedAt, this._taskSince);
        if (
            settings.narration === 'all' &&
            view.phase === 'working' &&
            view.unseenUpdates > 0 &&
            now - quietSince >= settings.narrationIntervalMs
        ) {
            return { kind: 'progress', tabId };
        }
        return undefined;
    }

    /** A proactive turn took `observation`. Research and progress are consumed by the turn showing them. */
    consume(observation: Observation): void {
        const watch = this._watch(observation.tabId);
        switch (observation.kind) {
            case 'needs_input':
                for (const id of observation.requestIds) {
                    watch.told.add(id);
                }
                return;
            case 'error':
                watch.error = undefined;
                return;
            case 'done':
                watch.endedAt = undefined;
                return;
        }
    }

    /** A user turn showed the task's whole state (§5.9 rule 3): nothing in it is news any more. */
    userTurn(tabId: string, requestIds: string[]): void {
        const watch = this._watch(tabId);
        watch.endedAt = undefined;
        watch.error = undefined;
        watch.told = new Set(requestIds);
    }

    turnEnded(now: number): void {
        this._lastTurnEndedAt = now;
    }

    /**
     * The active task changed. A new session in the same tab is a new task: the tab's outcome
     * belongs to the old one. Progress built up in the background is not narrated (§5.12 rule 5).
     */
    taskChanged(tabId: string | undefined, sameTab: boolean, now: number): void {
        this._taskSince = now;
        if (tabId !== undefined && sameTab) {
            this._tabs.delete(tabId);
        }
    }

    private _watch(tabId: string): TabWatch {
        let watch = this._tabs.get(tabId);
        if (!watch) {
            watch = { told: new Set() };
            this._tabs.set(tabId, watch);
        }
        return watch;
    }
}
