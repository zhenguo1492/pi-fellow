import { parseUserMessageForDisplay } from '../../shared/attachmentMessageDisplay';
import { escapeHtml } from '../../shared/html';
import { el } from './helpers';
import { hasUserScrolled, scrollToBottom } from './scroll';
import { state } from './state';
import { copyPlainText } from './toast';
import { toggleInStickyPrompt } from './userPromptSticky';

/** A queued steer keeps the prompt it arrived under, even when later turns start. */
const steeringQueuesByTab = new Map<string, Array<{ text: string; turn: number }>>();

const PENDING_MESSAGE_LINE_CLAMP = 3;
/** Texts the user expanded; keyed by text so the state survives the frequent row re-renders. */
const expandedPendingTexts = new Set<string>();

/** One steering / follow-up row; long text is clamped by `bindPendingMessageClamps`. */
export function pendingMessageRowHtml(kind: 'steer' | 'followup', text: string, tagHtml = ''): string {
    const label = kind === 'steer' ? 'Steering' : 'Follow-up';
    return `<div class="pending-message pending-message--${kind}">
            <span class="pending-message-indicator" aria-hidden="true"></span>
            <span class="pending-message-label">${label}</span>
            ${tagHtml}
            <div class="pending-message-body"><span class="pending-message-text">${escapeHtml(text)}</span></div>
        </div>`;
}

function applyPendingClamp(text: HTMLElement, toggle: HTMLButtonElement, expanded: boolean): void {
    text.classList.toggle('pending-message-text--collapsed', !expanded);
    // Unpins the prompt group a steer sits in (see main.css), as an expanded prompt does.
    text.closest('.pending-message')?.classList.toggle('pending-message--expanded', expanded);
    toggle.textContent = expanded ? 'Show less' : 'Show more';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

/** Clamps every laid-out steering / follow-up row longer than three lines behind a Show more / Copy bar. */
export function bindPendingMessageClamps(): void {
    document.querySelectorAll<HTMLElement>('.pending-message-text').forEach((text) => {
        // Unmeasurable (hidden) rows stay unbound so the next render retries them.
        if (text.dataset.clampBound === '1' || text.scrollHeight === 0) {
            return;
        }
        text.dataset.clampBound = '1';
        const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
        const maxHeight = Number.isFinite(lineHeight) && lineHeight > 0
            ? lineHeight * PENDING_MESSAGE_LINE_CLAMP
            : 52;
        if (text.scrollHeight <= maxHeight + 4) {
            return;
        }
        const key = text.textContent ?? '';
        const toggle = el('button', 'pending-message-expand-toggle');
        toggle.type = 'button';
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            const expanded = !expandedPendingTexts.has(key);
            if (expanded) {
                expandedPendingTexts.add(key);
            } else {
                expandedPendingTexts.delete(key);
            }
            toggleInStickyPrompt(text, expanded, () => applyPendingClamp(text, toggle, expanded));
        });
        const copy = el('button', 'clamp-copy-btn');
        copy.type = 'button';
        copy.title = 'Copy message';
        copy.textContent = 'Copy';
        copy.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            copyPlainText(key);
        });
        const bar = el('div', 'pending-message-clamp-bar');
        bar.append(toggle, copy);
        text.after(bar);
        applyPendingClamp(text, toggle, expandedPendingTexts.has(key));
    });
}

/**
 * Next steering queue given the previous one and the RPC's current `steering` texts.
 * The RPC queue consumes from the front and appends at the back: the longest suffix of
 * `previous` that equals a prefix of `steering` keeps its turns; the remaining `steering`
 * entries are new and belong to `currentTurn`. Does not mutate `previous`.
 */
export function reconcileSteeringQueue(
    previous: ReadonlyArray<{ text: string; turn: number }>,
    steering: readonly string[],
    currentTurn: number,
): Array<{ text: string; turn: number }> {
    // Preserve ownership for the overlapping suffix/prefix; only newly appended entries use the current prompt.
    let retained = Math.min(previous.length, steering.length);
    while (retained > 0) {
        let matches = true;
        for (let i = 0; i < retained; i++) {
            if (previous[previous.length - retained + i].text !== steering[i]) {
                matches = false;
                break;
            }
        }
        if (matches) break;
        retained--;
    }
    const next = previous.slice(previous.length - retained);
    for (let i = retained; i < steering.length; i++) {
        next.push({ text: steering[i], turn: currentTurn });
    }
    return next;
}

export function updatePendingMessagesInChat(): void {
    const container = document.getElementById('pending-messages');
    if (!container) {
        return;
    }

    const steering = state.steeringMessages ?? [];
    const followUp = state.followUpMessages ?? [];
    // Turns are absolute (`data-turn`, 1-based): the transcript renders only its newest turns.
    const prompts = document.querySelectorAll<HTMLElement>('.message-group-user[data-turn]');
    const latestTurn = Number(prompts[prompts.length - 1]?.dataset.turn ?? 0);
    const queue = reconcileSteeringQueue(
        steeringQueuesByTab.get(state.activeTabId) ?? [],
        steering,
        latestTurn,
    );
    if (queue.length > 0) {
        steeringQueuesByTab.set(state.activeTabId, queue);
    } else {
        steeringQueuesByTab.delete(state.activeTabId);
    }

    document.querySelectorAll('.pending-messages--queued').forEach((node) => node.remove());
    container.innerHTML = followUp.map((text) =>
        pendingMessageRowHtml('followup', parseUserMessageForDisplay(text).displayText || text),
    ).join('');

    const byTurn = new Map<number, string[]>();
    for (const { text, turn } of queue) {
        const rows = byTurn.get(turn) ?? [];
        rows.push(pendingMessageRowHtml('steer', parseUserMessageForDisplay(text).displayText || text));
        byTurn.set(turn, rows);
    }
    let hasUnanchoredSteering = false;
    for (const [turn, rows] of byTurn) {
        const steeringEl = el('div', 'pending-messages pending-messages--steering pending-messages--queued');
        steeringEl.innerHTML = rows.join('');
        const prompt = document.querySelector(`.message-group-user[data-turn="${turn}"]`);
        if (prompt) {
            prompt.appendChild(steeringEl);
        } else {
            hasUnanchoredSteering = true;
            container.prepend(steeringEl);
        }
    }

    container.style.display = followUp.length > 0 || hasUnanchoredSteering ? '' : 'none';
    bindPendingMessageClamps();
    if (!hasUserScrolled() && (steering.length > 0 || followUp.length > 0)) {
        scrollToBottom();
    }
}
