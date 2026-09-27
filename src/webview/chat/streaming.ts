import { setModelWorkingStatus } from '../modelStatus';
import { el } from './helpers';
import { state } from './state';
import { extractThinking, messageFingerprint } from './messageContent';
import { bindCopyButtons, renderStreamingMarkdown } from './markdown';
import { scrollIfFollowing } from './scroll';
import { isScrolledToEnd, setThinkingOpen } from './thinking';
import { clearStreamingToolArtifacts } from './tools';
import { updateMessages } from './transcript';

let streamRenderPending = false;
/** User collapsed the live thinking box — kept across delta re-renders and into history. */
let streamingThinkingUserCollapsed = false;

export type StreamPhase = 'idle' | 'thinking' | 'tool' | 'writing' | 'waiting';
let streamPhase: StreamPhase = 'idle';
let streamPhaseDetail = '';

export function handleStreamingDelta(ae: any): void {
    switch (ae.type) {
        case 'thinking_start':
            state.isThinking = true;
            if (state.streamingThinking.trim().length > 0) {
                state.streamingThinking += '\n\n';
            }
            state.thinkingStartTime = Date.now();
            state.streamingThinkingDuration = 0;
            streamingThinkingUserCollapsed = false;
            setStreamPhase('thinking');
            break;
        case 'thinking_delta':
            state.streamingThinking += ae.delta ?? '';
            state.isThinking = true;
            setStreamPhase('thinking');
            break;
        case 'thinking_end':
            state.isThinking = false;
            if (state.thinkingStartTime > 0) {
                state.streamingThinkingDuration = Math.round((Date.now() - state.thinkingStartTime) / 1000);
            }
            setStreamPhase(state.streamingText ? 'writing' : 'waiting');
            break;
        case 'text_start':
            setStreamPhase('writing');
            break;
        case 'text_delta':
            state.streamingText += ae.delta ?? '';
            setStreamPhase('writing');
            break;
        case 'text_end':
            break;
    }
    scheduleStreamingRender();
}

export function setStreamPhase(phase: StreamPhase, detail = ''): void {
    streamPhase = phase;
    streamPhaseDetail = detail;
    updateStreamActivityBar();
}

/** Status-pill text for a stream phase; `detail` is the running tool label or the waiting reason. */
export function streamActivityLabel(phase: StreamPhase, detail: string, isStreaming: boolean): string {
    switch (phase) {
        case 'thinking':
            return 'Thinking…';
        case 'tool':
            return detail ? `Running ${detail}…` : 'Running tool…';
        case 'writing':
            return 'Writing response…';
        case 'waiting':
            return detail || 'Working…';
        default:
            return isStreaming ? 'Pi is working…' : '';
    }
}

/** Drop the in-progress assistant message (live thinking/text); tool cards are untouched. */
export function resetStreamingMessage(): void {
    state.streamingText = '';
    state.streamingThinking = '';
    state.isThinking = false;
    state.thinkingStartTime = 0;
    state.streamingThinkingDuration = 0;
    streamingThinkingUserCollapsed = false;
    document.querySelector('#streaming-message > .message.message-assistant')?.remove();
}

/**
 * A finished assistant message leaves the live area and joins the history at its chronological
 * position, so the next step's tool cards and thinking render below it. The following stateSync
 * replaces it with the authoritative copy.
 */
export function commitStreamedAssistantMessage(msg: Record<string, unknown>): void {
    if (state.thinkingStartTime > 0 && !state.streamingThinkingDuration) {
        state.streamingThinkingDuration = Math.round((Date.now() - state.thinkingStartTime) / 1000);
    }
    const last = state.messages[state.messages.length - 1];
    let index = state.messages.length - 1;
    if (!(last?.role === 'assistant' && messageFingerprint(last) === messageFingerprint(msg))) {
        const committed = { ...msg };
        if (state.streamingThinkingDuration > 0) {
            committed._thinkingDurationSec = state.streamingThinkingDuration;
        }
        state.messages.push(committed);
        index = state.messages.length - 1;
    }
    if (streamingThinkingUserCollapsed) {
        setThinkingOpen(`${index}:0`, false);
    }
    resetStreamingMessage();
    updateMessages();
    setStreamPhase('waiting');
}

export function updateStreamActivityBar(): void {
    const label = streamActivityLabel(streamPhase, streamPhaseDetail, state.isStreaming);
    const active = state.isStreaming;
    setModelWorkingStatus(active, label);

    const bar = document.getElementById('stream-activity');
    const container = document.getElementById('streaming-message');
    if (!bar || !container) {
        return;
    }
    // Live reasoning uses the expandable thinking block; hide the duplicate status pill.
    const hideForThinkingBlock =
        state.isStreaming &&
        (state.isThinking || Boolean(state.streamingThinking.trim())) &&
        streamPhase === 'thinking';
    container.classList.toggle('streaming-active', active);
    bar.classList.toggle('stream-activity--idle', !active || hideForThinkingBlock);
    bar.classList.toggle('stream-activity--thinking', streamPhase === 'thinking');
    bar.classList.toggle('stream-activity--tool', streamPhase === 'tool');
    bar.classList.toggle('stream-activity--writing', streamPhase === 'writing');
    if (!active) {
        return;
    }
    const labelEl = bar.querySelector('.stream-activity-label');
    if (labelEl && labelEl.textContent !== label) {
        labelEl.textContent = label;
    }
}

export function scheduleStreamingRender(): void {
    if (streamRenderPending) {
        return;
    }
    streamRenderPending = true;
    requestAnimationFrame(() => {
        streamRenderPending = false;
        renderStreamingContent();
        updateStreamActivityBar();
    });
}

function ensureStreamingMessageShell(container: HTMLElement): void {
    if (container.querySelector('.message.message-assistant')) {
        return;
    }
    const msg = el('div', 'message message-assistant');
    msg.innerHTML = `
        <details class="thinking-block" id="streaming-thinking">
            <summary class="thinking-summary">
                <span class="thinking-indicator"></span>
                <span class="thinking-label">Thinking…</span>
                <span class="thinking-chevron">&#9656;</span>
            </summary>
            <div class="thinking-content"></div>
        </details>
        <div class="message-content" id="streaming-text"></div>
    `;
    // Chronological: a new step's reasoning goes below the previous step's still-live tool cards.
    container.appendChild(msg);
    const created = document.getElementById('streaming-thinking') as HTMLDetailsElement | null;
    created?.addEventListener('toggle', () => {
        streamingThinkingUserCollapsed = !created.open;
    });
}

function renderStreamingContent(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    const streamingThinkingText = state.streamingThinking.trim();
    const showThinkingBlock = state.isStreaming && (state.isThinking || Boolean(streamingThinkingText));
    const showText = Boolean(state.streamingText);

    if (!showThinkingBlock && !showText) {
        return;
    }

    ensureStreamingMessageShell(container);

    const thinkingEl = document.getElementById('streaming-thinking') as HTMLDetailsElement | null;
    if (thinkingEl) {
        thinkingEl.style.display = showThinkingBlock ? '' : 'none';
        if (showThinkingBlock) {
            const contentEl = thinkingEl.querySelector('.thinking-content') as HTMLElement | null;
            // Follow the newest reasoning unless the user scrolled up inside the box.
            const followTail = contentEl ? isScrolledToEnd(contentEl) : false;
            if (contentEl) {
                if (streamingThinkingText) {
                    contentEl.innerHTML = renderStreamingMarkdown(streamingThinkingText);
                } else {
                    contentEl.innerHTML =
                        '<p class="thinking-placeholder">Reasoning in progress…</p>';
                }
            }
            const labelEl = thinkingEl.querySelector('.thinking-label');
            if (state.isThinking) {
                thinkingEl.classList.add('active');
                if (labelEl) labelEl.textContent = 'Thinking…';
            } else {
                thinkingEl.classList.remove('active');
                if (labelEl) {
                    const dur = state.streamingThinkingDuration;
                    labelEl.textContent =
                        dur > 0
                            ? `Thought for ${dur} second${dur !== 1 ? 's' : ''}`
                            : 'Thought';
                }
            }
            if (!streamingThinkingUserCollapsed) {
                thinkingEl.open = true;
            }
            if (contentEl && followTail) {
                contentEl.scrollTop = contentEl.scrollHeight;
            }
        }
    }

    const textEl = document.getElementById('streaming-text');
    if (textEl) {
        textEl.style.display = showText ? '' : 'none';
        if (showText) {
            textEl.innerHTML = renderStreamingMarkdown(state.streamingText);
        }
    }

    bindCopyButtons();
    scrollIfFollowing();
}

export function syncThinkingFromAssistantMessage(msg: any): void {
    if (msg?.role !== 'assistant') {
        return;
    }
    const fromMsg = extractThinking(msg);
    if (fromMsg.length > state.streamingThinking.length) {
        state.streamingThinking = fromMsg;
    }
}

export function updateStreamingUI(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    updateStreamActivityBar();

    const hasThinking = state.isThinking || Boolean(state.streamingThinking.trim());
    const hasPayload = Boolean(state.streamingText) || hasThinking;

    if (!state.isStreaming && !hasPayload) {
        container.querySelector('.message.message-assistant')?.remove();
        container.classList.remove('streaming-active');
        clearStreamingToolArtifacts();
        setStreamPhase('idle');
        return;
    }

    if (!state.isStreaming) {
        clearStreamingToolArtifacts();
    }

    if (hasPayload || state.isThinking) {
        renderStreamingContent();
    }
}
