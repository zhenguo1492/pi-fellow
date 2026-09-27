import { el } from './helpers';
import { jumpMessagesScroll } from './scroll';

export function markLatestUserMessageGroup(): void {
    document.querySelectorAll('.message-group-user--latest').forEach((node) => {
        node.classList.remove('message-group-user--latest');
    });
    const groups = document.querySelectorAll('.message-group-user');
    const last = groups[groups.length - 1];
    last?.classList.add('message-group-user--latest');
}

const USER_PROMPT_LINE_CLAMP = 3;
/** Prompts the user expanded; keyed by rendered text so the state survives transcript rebuilds. */
const expandedUserPrompts = new Set<string>();

/** An expanded prompt stops being sticky: pinned, a prompt taller than the view would hide its rest and the turn below. */
function applyUserPromptCollapse(group: HTMLElement, content: HTMLElement, toggle: HTMLButtonElement, expanded: boolean): void {
    group.classList.toggle('user-prompt-expanded', expanded);
    content.classList.toggle('user-prompt-text--collapsed', !expanded);
    toggle.textContent = expanded ? 'Show less' : 'Show more';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

/**
 * Clamps every prompt longer than three lines, collapsed by default, with Show more at the left of its action bar.
 * Resets all prompts, then measures all, then adds toggles: one layout, not one per prompt.
 */
export function bindUserPromptClamps(): void {
    const prompts: Array<{ group: HTMLElement; bar: HTMLElement; content: HTMLElement }> = [];
    document.querySelectorAll<HTMLElement>('.message-group-user').forEach((group) => {
        const bar = group.querySelector<HTMLElement>('.user-prompt-bar');
        const content = group.querySelector<HTMLElement>('.user-prompt-card .message-content');
        bar?.querySelector('.user-prompt-expand-toggle')?.remove();
        content?.classList.remove('user-prompt-text--collapsed');
        if (bar && content) {
            prompts.push({ group, bar, content });
        }
    });
    if (prompts.length === 0) {
        return;
    }
    const lineHeight = parseFloat(getComputedStyle(prompts[0].content).lineHeight);
    const maxHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight * USER_PROMPT_LINE_CLAMP : 52;
    const long = prompts.map(({ content }) => content.scrollHeight > maxHeight + 4);
    prompts.forEach(({ group, bar, content }, i) => {
        if (!long[i]) {
            return;
        }
        const key = content.textContent ?? '';
        const toggle = el('button', 'user-prompt-expand-toggle');
        toggle.type = 'button';
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            const expanded = !expandedUserPrompts.has(key);
            if (expanded) {
                expandedUserPrompts.add(key);
            } else {
                expandedUserPrompts.delete(key);
            }
            toggleInStickyPrompt(content, expanded, () => applyUserPromptCollapse(group, content, toggle, expanded));
        });
        bar.prepend(toggle);
        applyUserPromptCollapse(group, content, toggle, expandedUserPrompts.has(key));
    });
}

/**
 * Expands or folds text in a prompt's sticky group (the prompt, or a steer under it) keeping the
 * reader's place. Expanded, the group stops pinning and would jump to its place in the transcript,
 * so its first line stays where it was. Folded after reading to the end, the turn below stays where
 * it was instead of the view landing mid-reply.
 */
export function toggleInStickyPrompt(text: HTMLElement, expanding: boolean, apply: () => void): void {
    const container = document.getElementById('messages');
    if (!container) {
        apply();
        return;
    }
    const view = container.getBoundingClientRect();
    const below = text.closest('.message-group-user')?.nextElementSibling;
    const anchor = !expanding && below && below.getBoundingClientRect().top < view.bottom ? below : text;
    const before = Math.max(anchor.getBoundingClientRect().top, view.top);
    apply();
    // Instant: `.messages` scrolls smoothly, which would read as the user scrolling mid-animation.
    jumpMessagesScroll(container, container.scrollTop + anchor.getBoundingClientRect().top - before);
}
