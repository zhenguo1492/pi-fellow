import { describe, it, expect } from 'vitest';
import { DONE_SETTLE_MS, FloorArbiter, type ArbiterSettings, type ArbiterView } from '../../../voiceAgent/floorArbiter';

const GAP = 8000;

function setup(overrides: Partial<ArbiterSettings> = {}) {
    const settings: ArbiterSettings = { narration: 'important', minProactiveGapMs: GAP, narrationIntervalMs: 30000, ...overrides };
    const arbiter = new FloorArbiter(() => settings);
    const view = (patch: Partial<ArbiterView> = {}): ArbiterView => ({
        tabId: 'tab-1',
        phase: 'idle',
        requestIds: [],
        fromVoice: false,
        settledApprovals: 0,
        settledResearch: [],
        unseenUpdates: 0,
        ...patch,
    });
    const end = (stopReason = 'stop', extra: Record<string, unknown> = {}) => ({
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason, errorMessage: 'rate limited' }],
        ...extra,
    });
    return { arbiter, settings, view, end };
}

describe('FloorArbiter: done', () => {
    it('waits until the worker has stayed idle, so an omp steer restart is not "done"', () => {
        const { arbiter, view, end } = setup();
        arbiter.ingest('tab-1', end(), 0);
        expect(arbiter.next(view(), DONE_SETTLE_MS - 1)).toBeUndefined();
        // omp starts the steered follow-up run about 3 s later.
        arbiter.ingest('tab-1', { type: 'agent_start' }, 3000);
        expect(arbiter.next(view({ phase: 'working' }), DONE_SETTLE_MS + GAP)).toBeUndefined();
        arbiter.ingest('tab-1', end(), 20000);
        expect(arbiter.next(view(), 20000 + DONE_SETTLE_MS)).toEqual({ kind: 'done', tabId: 'tab-1' });
    });

    it('is not announced for a non-final end, a retry, or a stop the user asked for', () => {
        const { arbiter, view, end } = setup();
        arbiter.ingest('tab-1', end('stop', { isTerminal: false }), 0);
        arbiter.ingest('tab-1', end('error', { willRetry: true }), 0);
        arbiter.ingest('tab-1', end('aborted'), 0);
        expect(arbiter.next(view(), 60000)).toBeUndefined();
    });

    it('is announced once, and not while the worker is busy with the next queued message', () => {
        const { arbiter, view, end } = setup();
        arbiter.ingest('tab-1', end(), 0);
        expect(arbiter.next(view({ phase: 'working' }), 60000)).toBeUndefined();
        const done = arbiter.next(view(), 60000)!;
        arbiter.consume(done);
        expect(arbiter.next(view(), 60000)).toBeUndefined();
    });
});

describe('FloorArbiter: priority and pacing', () => {
    it('puts a worker question first, then an error, then finished work, then research', () => {
        const { arbiter, view, end } = setup();
        arbiter.ingest('tab-1', end(), 0);
        arbiter.ingest('tab-2', end('error'), 0);
        const all = view({ requestIds: ['q1'], settledResearch: ['r1'] });
        const first = arbiter.next(all, 60000)!;
        expect(first).toEqual({ kind: 'needs_input', tabId: 'tab-1', requestIds: ['q1'] });
        arbiter.consume(first);
        const second = arbiter.next(all, 60000)!;
        expect(second.kind).toBe('done');
        arbiter.consume(second);
        expect(arbiter.next(all, 60000)).toEqual({ kind: 'research', tabId: 'tab-1', jobId: 'r1' });
        expect(arbiter.next(view({ tabId: 'tab-2' }), 60000)).toEqual({ kind: 'error', tabId: 'tab-2', detail: 'rate limited' });
    });

    it('keeps quiet after a turn, except for questions and errors', () => {
        const { arbiter, view, end } = setup();
        arbiter.ingest('tab-1', end(), 0);
        arbiter.turnEnded(10000);
        expect(arbiter.next(view(), 10000 + GAP - 1)).toBeUndefined();
        expect(arbiter.next(view({ requestIds: ['q1'] }), 10001)?.kind).toBe('needs_input');
        arbiter.ingest('tab-1', { type: 'auto_retry_end', success: false, finalError: 'offline' }, 10001);
        expect(arbiter.next(view(), 10002)).toEqual({ kind: 'error', tabId: 'tab-1', detail: 'offline' });
    });

    it('announces a new request even when an older one was already told', () => {
        const { arbiter, view } = setup();
        const first = arbiter.next(view({ requestIds: ['q1'] }), 0)!;
        arbiter.consume(first);
        expect(arbiter.next(view({ requestIds: ['q1'] }), 1)).toBeUndefined();
        expect(arbiter.next(view({ requestIds: ['q1', 'q2'] }), 2)).toEqual({
            kind: 'needs_input',
            tabId: 'tab-1',
            requestIds: ['q1', 'q2'],
        });
    });

    it('stays silent with narration off, and narrates progress only with "all"', () => {
        const busy = { phase: 'working' as const, unseenUpdates: 3 };
        const off = setup({ narration: 'off' });
        expect(off.arbiter.next(off.view({ ...busy, requestIds: ['q1'] }), 60000)).toBeUndefined();
        const important = setup();
        expect(important.arbiter.next(important.view(busy), 60000)).toBeUndefined();
        const all = setup({ narration: 'all' });
        all.arbiter.turnEnded(40000);
        expect(all.arbiter.next(all.view(busy), 69999)).toBeUndefined();
        expect(all.arbiter.next(all.view({ ...busy, unseenUpdates: 0 }), 70000)).toBeUndefined();
        expect(all.arbiter.next(all.view(busy), 70000)).toEqual({ kind: 'progress', tabId: 'tab-1' });
    });

    it('with narration off, still relays a request from a task the voice agent sent', () => {
        const off = setup({ narration: 'off' });
        const request = { phase: 'awaiting' as const, requestIds: ['q1'] };
        expect(off.arbiter.next(off.view(request), 60000)).toBeUndefined();
        const relayed = off.arbiter.next(off.view({ ...request, fromVoice: true }), 60000);
        expect(relayed).toEqual({ kind: 'needs_input', tabId: 'tab-1', requestIds: ['q1'] });
        off.arbiter.consume(relayed!);
        expect(off.arbiter.next(off.view({ ...request, fromVoice: true }), 60001)).toBeUndefined();
    });

    it("says the outcome of the voice agent's own approval card first, right after a turn and with narration off", () => {
        const off = setup({ narration: 'off' });
        off.arbiter.turnEnded(59000);
        expect(off.arbiter.next(off.view({ settledApprovals: 1, requestIds: ['q1'], fromVoice: true }), 60000)).toEqual({
            kind: 'approval',
            tabId: 'tab-1',
        });
    });
});

describe('FloorArbiter: user turns and task switches', () => {
    it('lets a user turn take everything it showed', () => {
        const { arbiter, view, end } = setup();
        arbiter.ingest('tab-1', end('error'), 0);
        arbiter.userTurn('tab-1', ['q1']);
        expect(arbiter.next(view({ requestIds: ['q1'] }), 60000)).toBeUndefined();
    });

    it("keeps a background tab's outcome for when it is active again, but not across a new session in the tab", () => {
        const { arbiter, view, end } = setup();
        arbiter.ingest('tab-2', end(), 0);
        arbiter.ingest('tab-1', end(), 0);
        arbiter.taskChanged('tab-2', false, 1000);
        expect(arbiter.next(view({ tabId: 'tab-2' }), 60000)?.kind).toBe('done');
        // /new or resume in tab-1: its finished run belongs to the old task.
        arbiter.taskChanged('tab-1', true, 2000);
        expect(arbiter.next(view(), 60000)).toBeUndefined();
    });

    it('does not narrate progress built up while the task was in the background', () => {
        const { arbiter, view } = setup({ narration: 'all' });
        arbiter.taskChanged('tab-1', false, 100000);
        const busy = view({ phase: 'working', unseenUpdates: 5 });
        expect(arbiter.next(busy, 100000 + 29999)).toBeUndefined();
        expect(arbiter.next(busy, 130000)?.kind).toBe('progress');
    });
});
