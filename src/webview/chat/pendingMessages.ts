import { parseUserMessageForDisplay } from '../../shared/attachmentMessageDisplay';
import { el, escHtml } from './helpers';
import { hasUserScrolled, scrollToBottom } from './scroll';
import { state } from './state';

/** A queued steer keeps the prompt it arrived under, even when later turns start. */
const steeringQueuesByTab = new Map<string, Array<{ text: string; turn: number }>>();

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
    const prompts = document.querySelectorAll('.message-group-user');
    const queue = reconcileSteeringQueue(
        steeringQueuesByTab.get(state.activeTabId) ?? [],
        steering,
        prompts.length - 1,
    );
    if (queue.length > 0) {
        steeringQueuesByTab.set(state.activeTabId, queue);
    } else {
        steeringQueuesByTab.delete(state.activeTabId);
    }

    document.querySelectorAll('.pending-messages--queued').forEach((node) => node.remove());
    container.innerHTML = followUp.map((text) =>
        `<div class="pending-message pending-message--followup">
            <span class="pending-message-indicator" aria-hidden="true"></span>
            <span class="pending-message-label">Follow-up</span>
            <span class="pending-message-text">${escHtml(parseUserMessageForDisplay(text).displayText || text)}</span>
        </div>`,
    ).join('');

    const byTurn = new Map<number, string[]>();
    for (const { text, turn } of queue) {
        const rows = byTurn.get(turn) ?? [];
        rows.push(`<div class="pending-message pending-message--steer">
            <span class="pending-message-indicator" aria-hidden="true"></span>
            <span class="pending-message-label">Steering</span>
            <span class="pending-message-text">${escHtml(parseUserMessageForDisplay(text).displayText || text)}</span>
        </div>`);
        byTurn.set(turn, rows);
    }
    let hasUnanchoredSteering = false;
    for (const [turn, rows] of byTurn) {
        const steeringEl = el('div', 'pending-messages pending-messages--steering pending-messages--queued');
        steeringEl.innerHTML = rows.join('');
        if (prompts[turn]) {
            prompts[turn].appendChild(steeringEl);
        } else {
            hasUnanchoredSteering = true;
            container.prepend(steeringEl);
        }
    }

    container.style.display = followUp.length > 0 || hasUnanchoredSteering ? '' : 'none';
    if (!hasUserScrolled() && (steering.length > 0 || followUp.length > 0)) {
        scrollToBottom();
    }
}
