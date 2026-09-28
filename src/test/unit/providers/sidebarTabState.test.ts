import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiChatSession } from '../../../pi/slashCommands';
import type { CheckpointManager } from '../../../providers/checkpoint';
import type { DiffManager } from '../../../providers/diff';
import {
    applyAgentEvent,
    claimPlanEditorOpen,
    makeTabState,
    tabPlanMode,
    turnCutoffIndex,
    type TabState,
} from '../../../providers/sidebarTabState';
import type { PlanModeInfo } from '../../../shared/protocol';

const noPlan: PlanModeInfo = {
    enabled: false,
    hasPlan: false,
    awaitingAction: false,
    statusLabel: 'off',
    planMarkdown: '',
    todos: [],
};

interface FakeSessionOptions {
    messages?: unknown[];
    backend?: 'pi' | 'omp';
    planMode?: PlanModeInfo;
}

/** A tab over a stand-in RPC session: messages live on the manager, the shim only carries run state. */
function fakeTab(options: FakeSessionOptions = {}): TabState {
    const session = {
        messages: options.messages ?? [],
        getMessages() {
            return this.messages;
        },
        session: { retryAttempt: 2, sessionId: 's1' },
        backend: options.backend ?? 'pi',
        getPlanModeInfo: () => options.planMode ?? noPlan,
        extensionChrome: { getSnapshot: () => ({ statuses: [], widgets: [] }) },
    };
    const diffManager = { pruneSettledChanges: vi.fn() };
    return makeTabState(
        'tab-1',
        session as unknown as PiChatSession,
        diffManager as unknown as DiffManager,
        {} as CheckpointManager,
    );
}

function update(type: string, delta?: string) {
    return { type: 'message_update', assistantMessageEvent: { type, delta } };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('applyAgentEvent', () => {
    it('streams one assistant step and files its thinking time under its ordinal', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const tab = fakeTab({ messages: [{ role: 'user', timestamp: 0 }, { role: 'assistant', timestamp: 1 }] });

        applyAgentEvent(tab, { type: 'agent_start' }, true);
        applyAgentEvent(tab, update('thinking_start'), true);
        applyAgentEvent(tab, update('thinking_delta', 'plan'), true);
        vi.setSystemTime(3000);
        applyAgentEvent(tab, update('thinking_end'), true);
        applyAgentEvent(tab, update('text_delta', 'done'), true);
        expect(tab).toMatchObject({ isStreaming: true, streamingThinking: 'plan', streamingText: 'done', streamingThinkingDuration: 2 });

        // The message list may already hold the ended message: it must not count itself.
        const ended = { role: 'assistant', timestamp: 5 };
        tab.session.getMessages().push(ended);
        applyAgentEvent(tab, { type: 'message_end', message: ended }, true);

        expect([...tab.messageMeta]).toEqual([[1, { thinkingDurationSec: 2, messageEndTime: 3000 }]]);
        expect(tab).toMatchObject({ streamingText: '', streamingThinking: '', isThinking: false });
    });

    it('ignores stream deltas while a Stop is in flight', () => {
        const tab = fakeTab();
        applyAgentEvent(tab, { type: 'agent_start' }, true);
        tab.abortInFlight = true;
        applyAgentEvent(tab, update('text_delta', 'late'), true);
        expect(tab.streamingText).toBe('');
    });

    it('ends a run in a background tab with a notification and the failure the model reported', () => {
        const tab = fakeTab();
        applyAgentEvent(tab, { type: 'agent_start' }, false);

        applyAgentEvent(
            tab,
            { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: ' 529 overloaded ' }, { role: 'toolResult' }] },
            false,
        );

        expect(tab).toMatchObject({ isStreaming: false, hasNotification: true, agentStartTime: 0 });
        expect(tab.connectionStatus).toEqual({ phase: 'failed', message: '529 overloaded' });
        expect(tab.diffManager.pruneSettledChanges).toHaveBeenCalledOnce();
    });

    it('keeps the active tab streaming through an agent_end that will retry, then ends the run without a notification', () => {
        const tab = fakeTab();
        applyAgentEvent(tab, { type: 'agent_start' }, true);

        applyAgentEvent(
            tab,
            { type: 'agent_end', willRetry: true, messages: [{ role: 'assistant', errorMessage: 'socket hang up' }] },
            true,
        );

        expect(tab.isStreaming).toBe(true);
        expect(tab.hasNotification).toBe(false);
        expect(tab.connectionStatus).toEqual({ phase: 'retrying', message: 'socket hang up', attempt: 2, maxAttempts: undefined });

        applyAgentEvent(tab, { type: 'agent_end', messages: [] }, true);
        expect(tab).toMatchObject({ isStreaming: false, hasNotification: false });
        expect(tab.connectionStatus).toEqual({ phase: 'idle' });
    });

    it('drops a delivered omp steer from the queue: the matching text, else the oldest', () => {
        const tab = fakeTab();
        tab.steeringMessages = ['first', 'second', 'third'];

        applyAgentEvent(tab, { type: 'message_start', message: { role: 'user', steering: true, content: [{ type: 'text', text: 'second' }] } }, true);
        expect(tab.steeringMessages).toEqual(['first', 'third']);

        applyAgentEvent(tab, { type: 'message_start', message: { role: 'user', steering: true, content: 'rewritten by the CLI' } }, true);
        expect(tab.steeringMessages).toEqual(['third']);
    });
});

describe('tabPlanMode', () => {
    it("shows the todo tool's latest task list from the conversation", () => {
        const todo = (subject: string, status: string) => ({
            role: 'toolResult',
            toolName: 'todo',
            details: { nextId: 2, tasks: [{ id: 1, subject, status }] },
        });
        const tab = fakeTab({
            messages: [todo('Write tests', 'in_progress'), todo('Write tests', 'completed')],
            planMode: { ...noPlan, hasPlan: true, planMarkdown: '# Plan' },
        });

        const { planMode } = tabPlanMode(tab);

        expect(planMode.todos).toEqual([{ id: 'rpiv-1', text: 'Write tests', done: true }]);
        expect(planMode.planMarkdown).toMatch(/^# Plan\n\n## Progress\n[\s\S]*- \[x\] Write tests$/);
    });

    it("shows the user's mode switch until Pi confirms it", () => {
        const tab = fakeTab();
        tab.planModeOverride = 'plan';
        expect(tabPlanMode(tab).planMode).toMatchObject({ enabled: true, statusLabel: 'planning' });
        tab.planModeOverride = 'agent';
        expect(tabPlanMode(tab).planMode).toMatchObject({ enabled: false, statusLabel: 'off' });
    });
});

describe('claimPlanEditorOpen', () => {
    const drafting: PlanModeInfo = { ...noPlan, enabled: true, hasPlan: true, statusLabel: 'ready', planMarkdown: '# Plan\n' };

    it('pops the editor once per plan body while pi drafts it', () => {
        const tab = fakeTab();
        expect(claimPlanEditorOpen(tab, drafting)).toBe(true);
        expect(claimPlanEditorOpen(tab, { ...drafting, planMarkdown: '# Plan' })).toBe(false);
        expect(claimPlanEditorOpen(tab, { ...drafting, planMarkdown: '# Plan v2' })).toBe(true);
    });

    it('never pops for omp or once plan mode is off, and pops the same plan again after it was cleared', () => {
        expect(claimPlanEditorOpen(fakeTab({ backend: 'omp' }), drafting)).toBe(false);

        const tab = fakeTab();
        expect(claimPlanEditorOpen(tab, drafting)).toBe(true);
        expect(claimPlanEditorOpen(tab, { ...drafting, enabled: false, planMarkdown: '# Plan\n\n## Progress' })).toBe(false);
        expect(claimPlanEditorOpen(tab, noPlan)).toBe(false);
        expect(claimPlanEditorOpen(tab, drafting)).toBe(true);
    });
});

describe('turnCutoffIndex', () => {
    const messages = [
        { role: 'user' },
        { role: 'assistant' },
        { role: 'toolResult' },
        { role: 'user' },
        { role: 'assistant' },
    ];

    it('cuts at the first message of the first undone turn', () => {
        expect(turnCutoffIndex(messages, 0)).toBe(0);
        expect(turnCutoffIndex(messages, 1)).toBe(3);
        expect(turnCutoffIndex(messages, 2)).toBe(-1);
    });

    it('counts turns like the webview: a steer delivered mid-run stays in its turn', () => {
        const steered = [
            { role: 'user' },
            { role: 'assistant' },
            { role: 'user', steering: true },
            { role: 'assistant' },
            { role: 'user' },
            { role: 'assistant' },
        ];
        expect(turnCutoffIndex(steered, 1)).toBe(4);
        expect(turnCutoffIndex(steered, 2)).toBe(-1);
    });
});
