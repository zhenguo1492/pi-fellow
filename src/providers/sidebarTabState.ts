import type { PendingAttachment, QueuedPrompt } from '../pi/pendingAttachments';
import { mergePlanWithRpivTodos } from '../pi/planDocumentMerge';
import { enrichPlanModeFromExtensionChrome } from '../pi/planModeState';
import { extractRpivTodoTasks, rpivTasksToPlanTodos } from '../pi/rpivTodoSync';
import type { PiChatSession } from '../pi/slashCommands';
import { DEFAULT_CONVERSATION_TITLE } from '../shared/conversationTitle';
import type { ConnectionStatus, PlanModeInfo } from '../shared/protocol';
import type { CheckpointManager } from './checkpoint';
import type { DiffManager } from './diff';
import { VoiceOriginTracker } from './voiceOrigin';

interface MessageMeta {
    thinkingDurationSec: number;
    messageEndTime: number;
}

interface PendingApproval {
    resolve: (approved: boolean) => void;
}

/** One chat tab: its worker session plus the UI state the webview is synced from. */
export interface TabState {
    id: string;
    name: string;
    session: PiChatSession;
    diffManager: DiffManager;
    checkpointManager: CheckpointManager;
    turnCounter: number;
    suspendedMessages: unknown[];
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    agentStartTime: number;
    messageMeta: Map<number, MessageMeta>;
    voiceOrigins: VoiceOriginTracker;
    hasNotification: boolean;
    /** The tab shows the Bot view (the voice agent's conversation) instead of its chat. */
    botView: boolean;
    pendingApprovals: Map<string, PendingApproval>;
    queuedMessages: QueuedPrompt[];
    steeringMessages: string[];
    followUpMessages: string[];
    pendingAttachments: PendingAttachment[];
    isStreaming: boolean;
    queueDrainInFlight: boolean;
    lastPlanEditorHash: string;
    connectionStatus: ConnectionStatus;
    planModeOverride?: 'agent' | 'plan';
    /** Ignore streaming deltas until Pi confirms agent_end (Stop clicked). */
    abortInFlight: boolean;
    /** Skip auto-draining the queue (e.g. while interrupt-and-send is in flight). */
    suppressQueueDrain: boolean;
}

let tabIdCounter = 0;
export function nextTabId(): string {
    return `tab-${++tabIdCounter}`;
}

export function makeTabState(
    id: string,
    session: PiChatSession,
    diffManager: DiffManager,
    checkpointManager: CheckpointManager,
): TabState {
    return {
        id,
        name: DEFAULT_CONVERSATION_TITLE,
        session,
        diffManager,
        checkpointManager,
        turnCounter: 0,
        suspendedMessages: [],
        streamingText: '',
        streamingThinking: '',
        isThinking: false,
        thinkingStartTime: 0,
        streamingThinkingDuration: 0,
        agentStartTime: 0,
        messageMeta: new Map(),
        voiceOrigins: new VoiceOriginTracker(),
        hasNotification: false,
        botView: false,
        pendingApprovals: new Map(),
        queuedMessages: [],
        steeringMessages: [],
        followUpMessages: [],
        pendingAttachments: [],
        isStreaming: false,
        queueDrainInFlight: false,
        lastPlanEditorHash: '',
        connectionStatus: { phase: 'idle' },
        abortInFlight: false,
        suppressQueueDrain: false,
    };
}

export function idleConnection(): ConnectionStatus {
    return { phase: 'idle' };
}

/** Live thinking/text belong to the assistant message being streamed, not the whole run. */
export function resetStreamingMessage(tab: TabState): void {
    tab.streamingText = '';
    tab.streamingThinking = '';
    tab.isThinking = false;
    tab.thinkingStartTime = 0;
    tab.streamingThinkingDuration = 0;
}

/** The tab's session was replaced from disk: drop every piece of UI state tied to the old conversation. */
export function resetTabUiState(tab: TabState): void {
    tab.diffManager.clearAll();
    tab.checkpointManager.clearAll();
    tab.turnCounter = 0;
    tab.suspendedMessages = [];
    tab.isStreaming = false;
    resetStreamingMessage(tab);
    tab.agentStartTime = 0;
    tab.messageMeta.clear();
    tab.voiceOrigins.resetSession();
    tab.queuedMessages = [];
    tab.steeringMessages = [];
    tab.followUpMessages = [];
    tab.pendingAttachments = [];
    tab.lastPlanEditorHash = '';
    tab.connectionStatus = idleConnection();
}

/** A new user turn: a pending rollback becomes permanent, and file checkpoints/diffs key on the new turn. */
export function startTurn(tab: TabState): void {
    if (tab.checkpointManager.rollbackPoint !== null) {
        tab.checkpointManager.discardSuspended();
        tab.diffManager.discardSuspended();
        tab.suspendedMessages = [];
    }
    tab.turnCounter++;
    const turnIdx = tab.turnCounter;
    tab.checkpointManager.startTurn(turnIdx);
    tab.diffManager.setCurrentTurn(turnIdx);
}

/** Fields of the CLI's agent events that the tab's bookkeeping reads (unvalidated RPC JSON). */
interface TabAgentEvent {
    type: string;
    message?: {
        role?: string;
        timestamp?: unknown;
        steering?: boolean;
        content?: unknown;
        _fromVoice?: boolean;
    };
    messages?: unknown;
    success?: boolean;
    willRetry?: boolean;
    errorMessage?: string;
    finalError?: string;
    attempt?: number;
    maxAttempts?: number;
    steering?: unknown;
    followUp?: unknown;
    assistantMessageEvent?: { type: string; delta?: string };
}

interface AssistantOutcome {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
}

function lastAssistantFromMessages(messages: unknown): AssistantOutcome | undefined {
    if (!Array.isArray(messages)) {
        return undefined;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant') {
            return messages[i];
        }
    }
    return undefined;
}

function failedStatusFromAssistant(msg: AssistantOutcome | undefined): ConnectionStatus | undefined {
    if (!msg || msg.stopReason !== 'error') {
        return undefined;
    }
    const message =
        typeof msg.errorMessage === 'string' && msg.errorMessage.trim()
            ? msg.errorMessage.trim()
            : 'Request failed';
    return { phase: 'failed', message };
}

/**
 * The tab's bookkeeping for one agent event (run/stream/retry status, queues, message metadata).
 * Returns the tab's new streaming state when the event started or ended a run, `undefined` otherwise.
 */
export function applyAgentEvent(tab: TabState, event: TabAgentEvent, isActive: boolean): boolean | undefined {
    let streaming: boolean | undefined;

    if (event.type === 'agent_start') {
        tab.abortInFlight = false;
        tab.connectionStatus = idleConnection();
        tab.isStreaming = true;
        resetStreamingMessage(tab);
        tab.agentStartTime = Date.now();
        streaming = true;
    }

    if (event.type === 'agent_end') {
        // Before the agent_end stateSync, so throwaway files the agent deleted never linger in the bar.
        tab.diffManager.pruneSettledChanges();
    }

    if (event.type === 'auto_retry_start') {
        tab.connectionStatus = {
            phase: 'retrying',
            message: event.errorMessage ?? 'Connection error',
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
        };
        tab.isStreaming = true;
        streaming = true;
    }

    if (event.type === 'auto_retry_end') {
        if (event.success) {
            tab.connectionStatus = idleConnection();
        } else {
            tab.connectionStatus = {
                phase: 'failed',
                message:
                    event.finalError ??
                    'Could not reach the model after multiple attempts.',
                attempt: event.attempt,
            };
        }
    }

    if (event.type === 'compaction_end' && event.errorMessage && !event.willRetry) {
        tab.connectionStatus = {
            phase: 'failed',
            message: event.errorMessage,
        };
    }

    if (event.type === 'queue_update') {
        tab.steeringMessages = Array.isArray(event.steering)
            ? event.steering.map(String)
            : [];
        tab.followUpMessages = Array.isArray(event.followUp)
            ? event.followUp.map(String)
            : [];
    }

    if (event.type === 'message_start' && event.message?.role === 'user') {
        // The ordinal only keys messages without a timestamp; count like the assistant ordinal below.
        const started = event.message;
        let ordinal = 0;
        for (const m of tab.session.getMessages()) {
            if (m.role === 'user' && (started.timestamp === undefined || m.timestamp !== started.timestamp)) {
                ordinal++;
            }
        }
        if (tab.voiceOrigins.claim(started, ordinal)) {
            started._fromVoice = true;
        }
    }

    // omp never emits queue_update: a delivered steer arrives as a user message marked
    // `steering`, which is the only signal that it left the queue.
    if (event.type === 'message_start' && event.message?.role === 'user' && event.message.steering === true) {
        const content = event.message.content;
        const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.filter((c: { type?: string }) => c.type === 'text').map((c: { text?: string }) => c.text ?? '').join('')
              : '';
        const idx = tab.steeringMessages.indexOf(text);
        tab.steeringMessages = tab.steeringMessages.filter((_, i) => i !== (idx >= 0 ? idx : 0));
    }

    if (event.type === 'message_start' && event.message?.role === 'assistant') {
        resetStreamingMessage(tab);
    }

    if (event.type === 'message_end' && event.message?.role === 'assistant') {
        // The message list refreshes asynchronously after message_end, so it may not hold the
        // ended message yet: its ordinal is the count of the other assistant messages.
        const ended = event.message;
        let ordinal = 0;
        for (const m of tab.session.getMessages()) {
            if (m.role === 'assistant' && (ended.timestamp === undefined || m.timestamp !== ended.timestamp)) {
                ordinal++;
            }
        }
        if (tab.thinkingStartTime > 0 && !tab.streamingThinkingDuration) {
            tab.streamingThinkingDuration = Math.round((Date.now() - tab.thinkingStartTime) / 1000);
        }
        tab.messageMeta.set(ordinal, {
            thinkingDurationSec: tab.streamingThinkingDuration,
            messageEndTime: Date.now(),
        });
        resetStreamingMessage(tab);
    }

    if (event.type === 'agent_end') {
        tab.abortInFlight = false;
        const willRetry = event.willRetry === true;
        if (willRetry) {
            const lastAssistant = lastAssistantFromMessages(event.messages);
            tab.connectionStatus = {
                phase: 'retrying',
                message:
                    (typeof lastAssistant?.errorMessage === 'string'
                        ? lastAssistant.errorMessage
                        : undefined) ?? 'Connection lost — retrying…',
                attempt: tab.session.session?.retryAttempt,
                maxAttempts: undefined,
            };
            tab.isStreaming = true;
        } else {
            const failed = failedStatusFromAssistant(
                lastAssistantFromMessages(event.messages),
            );
            tab.connectionStatus = failed ?? idleConnection();
            tab.isStreaming = false;
            resetStreamingMessage(tab);
            tab.agentStartTime = 0;
            if (!isActive) {
                tab.hasNotification = true;
            }
            streaming = false;
        }
    }

    if (event.type === 'message_update' && event.assistantMessageEvent && !tab.abortInFlight) {
        const ae = event.assistantMessageEvent;
        switch (ae.type) {
            case 'thinking_start':
                tab.isThinking = true;
                if (tab.streamingThinking.trim().length > 0) {
                    tab.streamingThinking += '\n\n';
                } else {
                    tab.streamingThinking = '';
                }
                tab.thinkingStartTime = Date.now();
                tab.streamingThinkingDuration = 0;
                break;
            case 'thinking_delta':
                tab.streamingThinking += ae.delta ?? '';
                break;
            case 'thinking_end':
                tab.isThinking = false;
                if (tab.thinkingStartTime > 0) {
                    tab.streamingThinkingDuration = Math.round(
                        (Date.now() - tab.thinkingStartTime) / 1000
                    );
                }
                break;
            case 'text_delta':
                tab.streamingText += ae.delta ?? '';
                break;
        }
    }

    return streaming;
}

/** Plan panel state: Pi's plan mode with the extension chrome, the user's pending mode switch, and todo-tool progress. */
export function tabPlanMode(tab: TabState) {
    const planModeBase = tab.session.getPlanModeInfo();
    const chrome = tab.session.extensionChrome.getSnapshot();
    let planMode = enrichPlanModeFromExtensionChrome(planModeBase, chrome);
    if (tab.planModeOverride !== undefined) {
        const override = tab.planModeOverride;
        planMode = {
            ...planMode,
            enabled: override === 'plan',
            statusLabel:
                override === 'plan'
                    ? planMode.hasPlan
                        ? 'ready'
                        : 'planning'
                    : 'off',
        };
    }
    const rpivTasks = extractRpivTodoTasks(tab.session);
    return {
        planMode: {
            ...planMode,
            planMarkdown: mergePlanWithRpivTodos(planMode.planMarkdown, rpivTasks),
            todos: rpivTasks.length > 0 ? rpivTasksToPlanTodos(rpivTasks) : planMode.todos,
        },
        chrome,
    };
}

function hashPlanMarkdown(markdown: string): string {
    let h = 0;
    for (let i = 0; i < markdown.length; i++) {
        h = (h * 31 + markdown.charCodeAt(i)) | 0;
    }
    return `${markdown.length}:${h}`;
}

/** Whether this state sync should pop the plan editor; records the plan body it pops for. */
export function claimPlanEditorOpen(tab: TabState, planMode: PlanModeInfo): boolean {
    const planBody = planMode.planMarkdown.trim();
    // Pop the editor only while pi-plan-mode is drafting. After the plan is implemented the
    // todo Progress section keeps changing the body and would reopen it on every update.
    const planModeActive = tab.session.backend === 'pi' && planMode.enabled;
    if (planModeActive && planMode.hasPlan && planBody) {
        const hash = hashPlanMarkdown(planBody);
        if (tab.lastPlanEditorHash !== hash) {
            tab.lastPlanEditorHash = hash;
            return true;
        }
    } else if (!planMode.hasPlan) {
        tab.lastPlanEditorHash = '';
    }
    return false;
}

/**
 * Index of the first message after the first `keptTurns` user turns, or -1 when there is none. Turns are
 * numbered like the webview and the checkpoints: a steer delivered mid-run belongs to the turn it steered.
 */
export function turnCutoffIndex(messages: readonly { role?: unknown; steering?: unknown }[], keptTurns: number): number {
    let userMsgCount = 0;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user' && messages[i].steering !== true) {
            userMsgCount++;
            if (userMsgCount > keptTurns) {
                return i;
            }
        }
    }
    return -1;
}
