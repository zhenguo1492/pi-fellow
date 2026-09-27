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
import { hasUserScrolled, isNearBottom, jumpMessagesScroll, scrollToBottom } from './scroll';
import { state } from './state';
import { captureThinkingViewState, restoreThinkingScroll } from './thinking';
import {
    buildStepToolsBlock,
    captureToolsOpenState,
    clearStreamingToolArtifacts,
    removeLiveToolArtifacts,
    type ToolStepItem,
} from './tools';
import { bindUserPromptStickyCollapse, markLatestUserMessageGroup } from './userPromptSticky';

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
    appendChatMessageDom(msg, state.messages.length - 1);
    scrollToBottom();
}

function appendChatMessageDom(msg: any, index: number): void {
    const container = document.getElementById('messages');
    const streamingEl = document.getElementById('streaming-message');
    if (!container || !streamingEl || shouldHideMessageInChat(msg)) {
        return;
    }
    container.querySelector('.welcome, .history-loading')?.remove();
    let userMsgCount = 0;
    for (let i = 0; i <= index && i < state.messages.length; i++) {
        if (isTurnPrompt(state.messages[i])) {
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
    bindUserPromptStickyCollapse();
    bindPendingMessageClamps();
    bindCopyButtons();
    bindCheckpointButtons();
    bindRedoButtons();
    bindDiffButtons();
    bindAttachmentOpenClicks();
    bindMessageActionButtons();
}

/** Rebuilds the transcript history from `state.messages`, keeping the viewport, folds, and live nodes. */
export function updateMessages(): void {
    const container = document.getElementById('messages');
    if (!container) return;

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

    resetCodeBlockIds();
    let liveThinkKey: string | null = null;

    if (state.messages.length === 0 && !state.isStreaming) {
        container.insertBefore(state.restoringHistory ? buildHistoryLoading() : buildWelcome(), streamingEl);
    } else {
        let userMsgCount = 0;
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
            if (role === 'user') {
                flushStepTools(false);

                userMsgCount++;
                if (rollbackUserIdx !== null && userMsgCount > rollbackUserIdx) {
                    dimming = true;
                }

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
        flushStepTools(state.isStreaming);
        if (state.isStreaming && lastAssistantIndex >= 0) {
            liveThinkKey = `${lastAssistantIndex}:0`;
        }
    }

    if (!state.isStreaming) {
        clearStreamingToolArtifacts();
    }

    markLatestUserMessageGroup();
    bindUserPromptStickyCollapse();

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
        <div class="welcome-icon">&pi;</div>
        <div class="welcome-title">Oh My Pi Chater</div>
        <div class="welcome-subtitle">Ask anything. ${backendLabel} can read, write, and execute code for you.</div>
        <dl class="welcome-meta">
            <dt>Agent</dt><dd><span class="welcome-backend-badge welcome-backend-badge--${state.activeBackend}">${backendLabel}</span></dd>
            <dt>Model</dt><dd${modelTitle}>${modelName}</dd>
            <dt>Provider</dt><dd>${provider}</dd>
        </dl>
        <div class="welcome-hints">
            <div class="welcome-hint">Type a message to start</div>
            <div class="welcome-hint"><kbd>Ctrl+Shift+L</kbd> Focus chat</div>
            <div class="welcome-hint"><kbd>Ctrl+Shift+N</kbd> New session</div>
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
