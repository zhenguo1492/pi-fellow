import { state } from './state';
import { extractText, failedConnectionFromAssistant, lastAssistantMessage } from './messageContent';
import { resetUserScroll } from './scroll';
import { getToolLabel } from './toolFormat';
import { clearStreamingToolArtifacts, renderToolEnd, renderToolStart, renderToolUpdate } from './tools';
import { showError, updateConnectionBanner } from './banners';
import { updatePendingMessagesInChat } from './pendingMessages';
import { appendUserMessageImmediate } from './transcript';
import {
    commitStreamedAssistantMessage,
    handleStreamingDelta,
    resetStreamingMessage,
    scheduleStreamingRender,
    setStreamPhase,
    syncThinkingFromAssistantMessage,
    updateStreamingUI,
} from './streaming';
import { updateInputArea } from './composer';
import { updateModeSwitch, updatePlanPanel } from './plan';

export function handleAgentEvent(event: any): void {
    switch (event.type) {
        case 'message_start': {
            const msg = event.message;
            if (msg?.role === 'user') {
                if (msg.steering === true) {
                    // omp has no queue_update: the delivered steer is what leaves the queue.
                    const idx = state.steeringMessages.indexOf(extractText(msg));
                    state.steeringMessages = state.steeringMessages.filter((_, i) => i !== (idx >= 0 ? idx : 0));
                }
                appendUserMessageImmediate(msg);
                if (msg.steering === true) {
                    updatePendingMessagesInChat();
                }
            } else if (msg?.role === 'assistant') {
                // Each assistant message is one step: its own thinking/text, placed after the
                // previous step's tool cards.
                resetStreamingMessage();
            }
            break;
        }
        case 'queue_update':
            state.steeringMessages = Array.isArray(event.steering)
                ? event.steering.map(String)
                : [];
            state.followUpMessages = Array.isArray(event.followUp)
                ? event.followUp.map(String)
                : [];
            updatePendingMessagesInChat();
            break;
        case 'message_update':
            if (state.isStreaming && event.assistantMessageEvent) {
                handleStreamingDelta(event.assistantMessageEvent);
            }
            if (event.message?.role === 'assistant') {
                syncThinkingFromAssistantMessage(event.message);
                scheduleStreamingRender();
            }
            break;
        case 'message_end':
            if (event.message?.role === 'assistant') {
                commitStreamedAssistantMessage(event.message);
            }
            break;
        case 'context_usage':
            if (event.usage) {
                state.contextUsage = {
                    tokens: event.usage.tokens ?? null,
                    contextWindow: event.usage.contextWindow ?? 0,
                    percent: event.usage.percent ?? null,
                };
            }
            break;
        case 'agent_start':
            state.connectionStatus = { phase: 'idle' };
            state.isStreaming = true;
            resetStreamingMessage();
            clearStreamingToolArtifacts();
            setStreamPhase('waiting');
            resetUserScroll();
            updateInputArea();
            updateConnectionBanner();
            updateStreamingUI();
            break;
        case 'agent_end': {
            const willRetry = event.willRetry === true;
            if (willRetry) {
                const lastAssistant = lastAssistantMessage(event.messages);
                state.connectionStatus = {
                    phase: 'retrying',
                    message:
                        (typeof lastAssistant?.errorMessage === 'string'
                            ? lastAssistant.errorMessage
                            : undefined) ?? 'Connection lost — retrying…',
                };
                state.isStreaming = true;
            } else {
                const failed = failedConnectionFromAssistant(
                    lastAssistantMessage(event.messages),
                );
                state.connectionStatus = failed ?? { phase: 'idle' };
                state.isStreaming = false;
                resetStreamingMessage();
                setStreamPhase('idle');
                if (failed?.message) {
                    showError(failed.message);
                }
            }
            updateStreamingUI();
            updateInputArea();
            updateConnectionBanner();
            updateModeSwitch();
            updatePlanPanel();
            break;
        }
        case 'auto_retry_start':
            state.connectionStatus = {
                phase: 'retrying',
                message: event.errorMessage ?? 'Connection error',
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
            };
            state.isStreaming = true;
            updateInputArea();
            updateConnectionBanner();
            break;
        case 'auto_retry_end':
            if (event.success) {
                state.connectionStatus = { phase: 'idle' };
            } else {
                state.connectionStatus = {
                    phase: 'failed',
                    message:
                        event.finalError ??
                        'Could not reach the model after multiple attempts.',
                    attempt: event.attempt,
                };
                state.isStreaming = false;
                if (state.connectionStatus.message) {
                    showError(state.connectionStatus.message);
                }
            }
            updateInputArea();
            updateConnectionBanner();
            break;
        case 'compaction_end':
            if (event.errorMessage && !event.willRetry) {
                state.connectionStatus = {
                    phase: 'failed',
                    message: event.errorMessage,
                };
                showError(event.errorMessage);
                updateConnectionBanner();
            }
            break;
        case 'tool_execution_start': {
            const label = getToolLabel(event.toolName ?? 'tool', event.args);
            setStreamPhase('tool', label);
            renderToolStart(event);
            break;
        }
        case 'tool_execution_update':
            renderToolUpdate(event);
            break;
        case 'tool_execution_end':
            renderToolEnd(event);
            if (state.isThinking) {
                setStreamPhase('thinking');
            } else if (state.streamingText) {
                setStreamPhase('writing');
            } else {
                setStreamPhase('waiting');
            }
            break;
    }
}
