import { escapeHtml } from '../../shared/html';
import { shouldHideMessageInChat } from '../../shared/planMessageFilter';
import { bindAttachmentOpenClicks } from './attachments';
import { updateTuiAuthBanner } from './banners';
import { bindDiffButtons } from './diffCard';
import { el } from './helpers';
import { bindCopyButtons, resetCodeBlockIds } from './markdown';
import { bindCheckpointButtons, bindMessageActionButtons, bindRedoButtons } from './messageActions';
import { extractText, isTurnPrompt, messageFingerprint } from './messageContent';
import { renderMessage } from './messageRender';
import { bindPendingMessageClamps, updatePendingMessagesInChat } from './pendingMessages';
import { hasUserScrolled, isNearBottom, jumpMessagesScroll, scrollToBottom, setDetachedHistory } from './scroll';
import { state } from './state';
import { captureThinkingViewState, restoreThinkingScroll } from './thinking';
import {
    buildStepToolsBlock,
    captureToolsOpenState,
    clearStreamingToolArtifacts,
    removeLiveToolArtifacts,
    type ToolStepItem,
} from './tools';
import { bindUserPromptClamps, markLatestUserMessageGroup } from './userPromptSticky';

/** Appends a message the host confirmed (dedupes the repeat, replaces the matching optimistic prompt). */
export function appendUserMessageImmediate(msg: any): void {
    const fp = messageFingerprint(msg);
    const last = state.messages[state.messages.length - 1];
    if (last && messageFingerprint(last) === fp) {
        return;
    }
    if (last?._optimistic && last.role === 'user' && msg?.steering !== true && extractText(last) === extractText(msg)) {
        state.messages[state.messages.length - 1] = msg;
        updateMessages();
        return;
    }
    state.messages.push(msg);
    appendChatMessageDom(msg, state.messages.length - 1);
    scrollToBottom();
}

export function appendOptimisticUserMessage(text: string, attachmentCount: number): void {
    const suffix =
        attachmentCount > 0 ? `\n\n[+${attachmentCount} attachment(s)]` : '';
    const content = text + suffix;
    const msg = { role: 'user', content, _optimistic: true };
    state.messages.push(msg);
    if (turnWindows.get(windowKey())?.last !== undefined) {
        // Sent while paged far up: show the newest turns, where the message goes.
        showLatestTurns();
        scrollToBottom(true);
        return;
    }
    appendChatMessageDom(msg, state.messages.length - 1);
    scrollToBottom();
}

function appendChatMessageDom(msg: any, index: number): void {
    const container = document.getElementById('messages');
    const streamingEl = document.getElementById('streaming-message');
    if (!container || !streamingEl || shouldHideMessageInChat(msg)) {
        return;
    }
    if (turnWindows.get(windowKey())?.last !== undefined) {
        // Its turn is past the rendered window: only the later-turns row changes.
        updateMessages();
        return;
    }
    container.querySelector('.welcome, .history-loading')?.remove();
    let userMsgCount = 0;
    for (let i = 0; i <= index && i < state.messages.length; i++) {
        // As updateMessages numbers turns: hidden prompts (plan implementation) do not count.
        if (isTurnPrompt(state.messages[i]) && !shouldHideMessageInChat(state.messages[i])) {
            userMsgCount++;
        }
    }
    const turnNumber = isTurnPrompt(msg) ? userMsgCount : undefined;
    const msgEl = renderMessage(msg, index, turnNumber);

    if (msg.role === 'user' && msg.steering === true) {
        const turns = container.querySelectorAll('.chat-turn');
        const lastTurn = turns[turns.length - 1] as HTMLElement | undefined;
        const prompt = lastTurn?.querySelector('.message-group-user');
        if (prompt) {
            prompt.appendChild(msgEl);
        } else {
            container.insertBefore(msgEl, streamingEl);
        }
    } else if (msg.role === 'user') {
        const turn = el('div', 'chat-turn');
        const turnBody = el('div', 'chat-turn-body');
        turn.appendChild(msgEl);
        turn.appendChild(turnBody);
        container.insertBefore(turn, streamingEl);
    } else {
        const turns = container.querySelectorAll('.chat-turn');
        const lastTurn = turns[turns.length - 1] as HTMLElement | undefined;
        const turnBody = lastTurn?.querySelector('.chat-turn-body');
        if (turnBody) {
            turnBody.appendChild(msgEl);
        } else {
            container.insertBefore(msgEl, streamingEl);
        }
    }

    markLatestUserMessageGroup();
    if (isTurnPrompt(msg)) {
        updatePendingMessagesInChat();
    }
    bindUserPromptClamps();
    bindPendingMessageClamps();
    bindCopyButtons();
    bindCheckpointButtons();
    bindRedoButtons();
    bindDiffButtons();
    bindAttachmentOpenClicks();
    bindMessageActionButtons();
}

/** Turns a window step loads; a history rebuild renders the newest this many at first. */
const TURN_WINDOW = 30;
/** Most turns rendered at once: paging past it drops turns at the far end, so the DOM stays bounded. */
const MAX_RENDERED_TURNS = 2 * TURN_WINDOW;
/**
 * Rendered turns (1-based, inclusive) per tab and session. `last` undefined: the window reaches the
 * newest turn and follows it. A number: the user paged up so far that the newest turns were dropped.
 */
const turnWindows = new Map<string, { first: number; last?: number }>();
let windowObserver: IntersectionObserver | null = null;

function windowKey(): string {
    return `${state.activeTabId}\0${state.sessionId ?? ''}`;
}

/** Renders the newest turns again (the scroll-to-bottom button, sending a message). */
function showLatestTurns(): void {
    turnWindows.delete(windowKey());
    updateMessages();
}

/**
 * Moves the window a step towards earlier or later turns, dropping turns at the other end past
 * `MAX_RENDERED_TURNS`, and keeps the turn at the top of the view where it was.
 */
function pageTurns(direction: 'earlier' | 'later'): void {
    const container = document.getElementById('messages');
    const win = turnWindows.get(windowKey());
    if (!container || !win) {
        return;
    }
    if (direction === 'earlier') {
        if (win.first <= 1) {
            return;
        }
        win.first = Math.max(1, win.first - TURN_WINDOW);
        const last = win.last ?? Number.POSITIVE_INFINITY;
        if (last - win.first + 1 > MAX_RENDERED_TURNS) {
            win.last = win.first + MAX_RENDERED_TURNS - 1;
        }
    } else {
        if (win.last === undefined) {
            return;
        }
        win.last += TURN_WINDOW;
        win.first = Math.max(win.first, win.last - MAX_RENDERED_TURNS + 1);
        // updateMessages clears `last` once it reaches the newest turn.
    }

    // The first turn still on screen, and its offset from the view's top.
    const viewTop = container.getBoundingClientRect().top;
    const anchor = [...container.querySelectorAll<HTMLElement>('.chat-turn')].find(
        (turn) => turn.getBoundingClientRect().bottom > viewTop,
    );
    const anchorTurn = anchor?.querySelector<HTMLElement>('.message-group-user')?.dataset.turn;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - viewTop : 0;
    updateMessages();
    const again = container.querySelector(`.message-group-user[data-turn="${anchorTurn}"]`)?.closest('.chat-turn');
    if (again) {
        jumpMessagesScroll(container, container.scrollTop + again.getBoundingClientRect().top - viewTop - anchorOffset);
    }
}

/** The row at an end of the window; scrolling near it (or clicking it) pages that way. */
function buildPageRow(direction: 'earlier' | 'later', count: number, container: HTMLElement): HTMLElement {
    const row = el('button', 'history-page');
    row.type = 'button';
    row.dataset.direction = direction;
    row.textContent = `Show ${count} ${direction} turn${count === 1 ? '' : 's'}`;
    row.addEventListener('click', () => pageTurns(direction));
    windowObserver ??= new IntersectionObserver(
        (entries) => {
            const reached = entries.find((entry) => entry.isIntersecting);
            if (reached) {
                pageTurns((reached.target as HTMLElement).dataset.direction === 'later' ? 'later' : 'earlier');
            }
        },
        { root: container, rootMargin: '300px 0px' },
    );
    windowObserver.observe(row);
    return row;
}

let widthObserver: ResizeObserver | null = null;
let watchedTranscript: Element | null = null;
let transcriptWidth = 0;

/**
 * Clamps are measured from layout, and a hidden transcript (the Bot view, a hidden webview) measures
 * as zero, so prompts rendered there get no Show more. Re-measures when the transcript's width changes:
 * when it is shown again, and when a resize rewraps the text. Height-only changes do not rewrap.
 */
function watchTranscriptWidth(container: HTMLElement): void {
    if (container === watchedTranscript) {
        return;
    }
    widthObserver ??= new ResizeObserver((entries) => {
        const width = entries[entries.length - 1].contentRect.width;
        if (width === transcriptWidth) {
            return;
        }
        transcriptWidth = width;
        if (width > 0) {
            bindUserPromptClamps();
            bindPendingMessageClamps();
        }
    });
    if (watchedTranscript) {
        widthObserver.unobserve(watchedTranscript);
    }
    widthObserver.observe(container);
    watchedTranscript = container;
}

/**
 * Rebuilds the transcript history from `state.messages`, keeping the viewport, folds, and live nodes.
 * Only a window of turns is built (see `turnWindows`): a long history would otherwise rebuild
 * thousands of nodes on every state sync. Other turns load as the user scrolls towards them.
 */
export function updateMessages(): void {
    const container = document.getElementById('messages');
    if (!container) return;
    watchTranscriptWidth(container);

    // The rebuild below tears down and recreates every history node; a layout
    // mid-rebuild clamps scrollTop to the half-built height. Pin the viewport.
    const followBottom = !hasUserScrolled() && isNearBottom();
    const prevScrollTop = container.scrollTop;

    const thinkingScroll = captureThinkingViewState();
    captureToolsOpenState();

    const streamingEl = document.getElementById('streaming-message');
    const spacerEl = container.querySelector('.messages-spacer');

    // Remove history nodes only (keep the follow-up strip at the transcript end).
    for (const child of [...container.childNodes]) {
        if (child === streamingEl || child === spacerEl) {
            break;
        }
        const childId = (child as HTMLElement).id;
        if (childId === 'pending-messages' || childId === 'tui-auth-banner') {
            continue;
        }
        container.removeChild(child);
    }

    windowObserver?.disconnect();
    resetCodeBlockIds();
    let liveThinkKey: string | null = null;
    let detached = false;

    if (state.messages.length === 0 && !state.isStreaming) {
        container.insertBefore(state.restoringHistory ? buildHistoryLoading() : buildWelcome(), streamingEl);
    } else {
        let userMsgCount = 0;
        let totalTurns = 0;
        for (const m of state.messages) {
            if (!shouldHideMessageInChat(m) && isTurnPrompt(m)) {
                totalTurns++;
            }
        }
        const saved = turnWindows.get(windowKey());
        let lastTurn = saved?.last !== undefined && saved.last < totalTurns ? saved.last : totalTurns;
        let firstTurn = Math.max(1, Math.min(saved?.first ?? lastTurn - TURN_WINDOW + 1, lastTurn - TURN_WINDOW + 1));
        // Past the cap only by new turns (paging keeps the window within it): following the bottom,
        // drop the oldest; reading above, drop the newest, so what the user reads stays in place.
        if (lastTurn - firstTurn + 1 > MAX_RENDERED_TURNS) {
            if (followBottom) {
                firstTurn = lastTurn - TURN_WINDOW + 1;
            } else {
                lastTurn = firstTurn + MAX_RENDERED_TURNS - 1;
            }
        }
        detached = lastTurn < totalTurns;
        turnWindows.set(windowKey(), { first: firstTurn, last: detached ? lastTurn : undefined });
        if (firstTurn > 1) {
            container.insertBefore(buildPageRow('earlier', firstTurn - 1, container), streamingEl);
        }
        const rollbackUserIdx = state.rollbackPoint;
        let dimming = false;
        let redoPlaced = false;
        let turnPrompt: HTMLElement | null = null;
        let turnBody: HTMLElement | null = null;
        let lastAssistantIndex = -1;
        // Tool results between two assistant messages: the tools one reasoning step called.
        let stepTools: ToolStepItem[] = [];

        const appendToChat = (node: HTMLElement): void => {
            if (dimming) {
                node.classList.add('dimmed');
            }
            if (turnBody) {
                turnBody.appendChild(node);
            } else {
                container.insertBefore(node, streamingEl);
            }
        };

        const flushStepTools = (live: boolean): void => {
            if (stepTools.length === 0) {
                return;
            }
            appendToChat(buildStepToolsBlock(stepTools, state.messages, live));
            for (const item of stepTools) {
                removeLiveToolArtifacts(item.msg.toolCallId ?? item.msg.tool_call_id ?? '');
            }
            stepTools = [];
        };

        for (let i = 0; i < state.messages.length; i++) {
            const msg = state.messages[i];
            if (shouldHideMessageInChat(msg)) {
                continue;
            }
            const role = msg.role ?? 'unknown';
            const startsTurn = isTurnPrompt(msg);
            if (startsTurn) {
                userMsgCount++;
                if (rollbackUserIdx !== null && userMsgCount > rollbackUserIdx) {
                    dimming = true;
                }
            }
            // Outside the window: counted (turn numbers, rollback dimming), not built.
            if (userMsgCount > lastTurn) {
                break;
            }
            if (firstTurn > 1 && userMsgCount < firstTurn) {
                continue;
            }

            if (role === 'toolResult' || role === 'tool') {
                stepTools.push({ msg, index: i });
                continue;
            }
            if (role === 'user' && msg.steering === true) {
                flushStepTools(false);
                const steeringEl = renderMessage(msg, i);
                if (turnPrompt) {
                    turnPrompt.appendChild(steeringEl);
                } else {
                    appendToChat(steeringEl);
                }
                continue;
            }
            if (startsTurn) {
                flushStepTools(false);

                const currentTurn = el('div', 'chat-turn');
                turnBody = el('div', 'chat-turn-body');

                const msgEl = renderMessage(msg, i, userMsgCount);
                turnPrompt = msgEl;
                if (dimming) {
                    msgEl.classList.add('dimmed');
                }
                currentTurn.appendChild(msgEl);
                currentTurn.appendChild(turnBody);
                container.insertBefore(currentTurn, streamingEl);

                if (dimming && !redoPlaced && rollbackUserIdx !== null) {
                    const redoWrap = el('div', 'redo-anchor');
                    const redoBtn = el('button', 'redo-btn');
                    redoBtn.title = 'Redo changes';
                    redoBtn.textContent = 'Redo';
                    redoWrap.appendChild(redoBtn);
                    turnBody.appendChild(redoWrap);
                    redoPlaced = true;
                }
                continue;
            }

            if (role === 'assistant') {
                lastAssistantIndex = i;
            }
            const msgEl = renderMessage(msg, i);
            // A step with no thinking/text (tool calls only) must not split the tool list.
            if (msgEl.hidden) {
                continue;
            }
            flushStepTools(false);
            appendToChat(msgEl);
        }
        // Detached, the streaming turn is not rendered: nothing here is live.
        flushStepTools(state.isStreaming && !detached);
        if (state.isStreaming && !detached && lastAssistantIndex >= 0) {
            liveThinkKey = `${lastAssistantIndex}:0`;
        }
        if (detached) {
            container.insertBefore(buildPageRow('later', totalTurns - lastTurn, container), streamingEl);
        }
    }

    if (!state.isStreaming) {
        clearStreamingToolArtifacts();
    }

    markLatestUserMessageGroup();
    bindUserPromptClamps();

    bindCopyButtons();
    bindCheckpointButtons();
    bindRedoButtons();
    bindDiffButtons();
    bindAttachmentOpenClicks();
    bindMessageActionButtons();
    const pendingEl = document.getElementById('pending-messages');
    if (pendingEl && streamingEl && pendingEl.nextSibling !== streamingEl) {
        container.insertBefore(pendingEl, streamingEl);
    }
    updatePendingMessagesInChat();
    restoreThinkingScroll(thinkingScroll, liveThinkKey);
    jumpMessagesScroll(container, followBottom ? container.scrollHeight : prevScrollTop);
    // Detached, the live reply and the queued messages belong to turns that are not rendered.
    container.classList.toggle('messages--detached', detached);
    setDetachedHistory(detached ? showLatestTurns : null);
    updateTuiAuthBanner();
}

/** In place of the welcome while a conversation restored at window startup loads. */
function buildHistoryLoading(): HTMLElement {
    const w = el('div', 'history-loading');
    w.append(
        el('span', 'history-loading-spinner'),
        Object.assign(el('div', 'history-loading-title'), { textContent: 'Loading conversation history…' }),
    );
    return w;
}

function buildWelcome(): HTMLElement {
    const w = el('div', 'welcome');
    const isOmp = state.activeBackend === 'omp';
    const backendLabel = isOmp ? 'OMP' : 'Pi';
    const planHint = isOmp
        ? '<div class="welcome-hint">Plan (read-only) is in the menu next to the model; omp\'s own plan workflow is TUI-only: <kbd>Alt+Shift+P</kbd> in <kbd>omp</kbd></div>'
        : '';
    const model = state.model;
    const modelName = model ? escapeHtml(model.name || model.id) : '<span class="welcome-meta-empty">Not set</span>';
    const modelTitle = model ? ` title="${escapeHtml(model.id)}"` : '';
    const provider = model?.provider ? escapeHtml(model.provider) : '<span class="welcome-meta-empty">—</span>';
    w.innerHTML = `
        <div class="welcome-icon" role="img" aria-label="π"></div>
        <div class="welcome-title">Pi Fellow</div>
        <div class="welcome-subtitle">Ask anything. ${backendLabel} can read, write, and execute code for you.</div>
        <dl class="welcome-meta">
            <dt>Agent</dt><dd><span class="welcome-backend-badge welcome-backend-badge--${state.activeBackend}">${backendLabel}</span></dd>
            <dt>Model</dt><dd${modelTitle}>${modelName}</dd>
            <dt>Provider</dt><dd>${provider}</dd>
        </dl>
        <div class="welcome-hints">
            <div class="welcome-hint">Type a message to start</div>
            <div class="welcome-hint"><kbd>Enter</kbd> Send · while running, <kbd>Enter</kbd> queue · ↑ interrupt</div>
            ${planHint}
        </div>
    `;
    return w;
}

/** Model info arrives outside stateSync; swap the welcome in place so it never shows a stale model. */
export function refreshWelcome(): void {
    const current = document.querySelector('#messages > .welcome');
    current?.replaceWith(buildWelcome());
}
