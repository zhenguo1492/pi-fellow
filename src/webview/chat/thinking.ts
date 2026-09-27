import { renderMarkdown } from './markdown';

// ── Thinking block ──

const thinkingOpenByKey = new Map<string, boolean>();

/** Records the user's open/closed choice for the thinking block identified by `key`. */
export function setThinkingOpen(key: string, open: boolean): void {
    thinkingOpenByKey.set(key, open);
}

/** Within a few px of the end (or not overflowing): new text should keep the box at its tail. */
export function isScrolledToEnd(box: HTMLElement): boolean {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 8;
}

type ThinkingScroll = { top: number; pinned: boolean };

/** Records open state; returns scroll state of open thinking boxes for `restoreThinkingScroll`. */
export function captureThinkingViewState(): Map<string, ThinkingScroll> {
    const scroll = new Map<string, ThinkingScroll>();
    document.querySelectorAll('details.thinking-block[data-think-key]').forEach((node) => {
        const el = node as HTMLDetailsElement;
        const key = el.dataset.thinkKey;
        if (!key) {
            return;
        }
        thinkingOpenByKey.set(key, el.open);
        const box = el.querySelector('.thinking-content') as HTMLElement | null;
        if (el.open && box) {
            scroll.set(key, { top: box.scrollTop, pinned: isScrolledToEnd(box) });
        }
    });
    return scroll;
}

/**
 * Rebuilt thinking boxes start at scrollTop 0. Put each back where it was; a box that was
 * following its tail — or the live turn's box appearing for the first time — shows the newest text.
 */
export function restoreThinkingScroll(saved: Map<string, ThinkingScroll>, liveThinkKey: string | null): void {
    document.querySelectorAll('details.thinking-block[data-think-key][open]').forEach((node) => {
        const el = node as HTMLDetailsElement;
        const key = el.dataset.thinkKey!;
        const box = el.querySelector('.thinking-content') as HTMLElement | null;
        if (!box) {
            return;
        }
        const prev = saved.get(key);
        if (prev ? prev.pinned : key === liveThinkKey) {
            box.scrollTop = box.scrollHeight;
        } else if (prev) {
            box.scrollTop = prev.top;
        }
    });
}

/** Summary label of a thinking block: live, timed, or plain. */
export function thinkingLabel(active: boolean, durationSec?: number): string {
    if (active) {
        return 'Thinking…';
    } else if (durationSec && durationSec > 0) {
        return `Thought for ${durationSec} second${durationSec !== 1 ? 's' : ''}`;
    } else {
        return 'Thought';
    }
}

export function buildThinkingBlock(
    text: string,
    active: boolean,
    durationSec?: number,
    thinkKey?: string,
): HTMLElement {
    const details = document.createElement('details');
    details.className = `thinking-block${active ? ' active' : ''}`;
    if (thinkKey) {
        details.dataset.thinkKey = thinkKey;
        if (thinkingOpenByKey.has(thinkKey)) {
            details.open = thinkingOpenByKey.get(thinkKey)!;
        } else {
            details.open = true;
        }
    }

    const label = thinkingLabel(active, durationSec);

    const summary = document.createElement('summary');
    summary.className = 'thinking-summary';
    summary.innerHTML = `
        <span class="thinking-indicator"></span>
        <span class="thinking-label">${label}</span>
        <span class="thinking-chevron">&#9656;</span>
    `;

    const content = document.createElement('div');
    content.className = 'thinking-content';
    const trimmed = text.trim();
    if (trimmed) {
        content.innerHTML = renderMarkdown(trimmed);
    } else {
        const ph = document.createElement('p');
        ph.className = 'thinking-placeholder';
        ph.textContent = 'No reasoning text was captured for this step.';
        content.appendChild(ph);
    }

    details.appendChild(summary);
    details.appendChild(content);
    details.addEventListener('toggle', () => {
        if (thinkKey) {
            thinkingOpenByKey.set(thinkKey, details.open);
        }
    });
    return details;
}
