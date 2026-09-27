import { el } from './helpers';

export function markLatestUserMessageGroup(): void {
    document.querySelectorAll('.message-group-user--latest').forEach((node) => {
        node.classList.remove('message-group-user--latest');
    });
    const groups = document.querySelectorAll('.message-group-user');
    const last = groups[groups.length - 1];
    last?.classList.add('message-group-user--latest');
}

const USER_PROMPT_STICKY_LINE_CLAMP = 3;

type UserPromptCollapseState = { expanded: boolean; clampable: boolean };

let userPromptStickyObserver: IntersectionObserver | null = null;
const userPromptCollapseByGroup = new WeakMap<HTMLElement, UserPromptCollapseState>();

function teardownUserPromptStickyCollapse(): void {
    userPromptStickyObserver?.disconnect();
    userPromptStickyObserver = null;
}

function userPromptContentNeedsClamp(content: HTMLElement): boolean {
    const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
    const maxHeight =
        Number.isFinite(lineHeight) && lineHeight > 0
            ? lineHeight * USER_PROMPT_STICKY_LINE_CLAMP
            : 52;
    return content.scrollHeight > maxHeight + 4;
}

function applyUserPromptCollapse(group: HTMLElement, collapseState: UserPromptCollapseState): void {
    const stuck = group.classList.contains('user-prompt-stuck');
    const collapsed = stuck && !collapseState.expanded;
    const content = group.querySelector('.message-content') as HTMLElement | null;
    const attachments = group.querySelector('.message-attachments') as HTMLElement | null;
    const toggle = group.querySelector('.user-prompt-expand-toggle') as HTMLButtonElement | null;

    content?.classList.toggle('user-prompt-text--collapsed', collapsed);
    attachments?.classList.toggle('user-prompt-attachments--hidden', collapsed);
    group.classList.toggle('user-prompt-expanded', collapseState.expanded);
    if (toggle) {
        toggle.textContent = collapseState.expanded ? 'Show less' : 'Show more';
        toggle.setAttribute('aria-expanded', collapseState.expanded ? 'true' : 'false');
    }
}

function updateUserPromptStickyState(group: HTMLElement, stuck: boolean): void {
    group.classList.toggle('user-prompt-stuck', stuck);
    const collapseState = userPromptCollapseByGroup.get(group);
    if (!collapseState) {
        return;
    }
    if (!stuck) {
        collapseState.expanded = false;
    }
    applyUserPromptCollapse(group, collapseState);
}

/** Re-attaches the sticky-prompt clamp (sentinel observer + Show more toggle) to every chat turn. */
export function bindUserPromptStickyCollapse(): void {
    const container = document.getElementById('messages');
    if (!container) {
        return;
    }

    teardownUserPromptStickyCollapse();
    userPromptStickyObserver = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const sentinel = entry.target as HTMLElement;
                const group = sentinel.nextElementSibling;
                if (!(group instanceof HTMLElement) || !group.classList.contains('message-group-user')) {
                    continue;
                }
                updateUserPromptStickyState(group, !entry.isIntersecting);
            }
        },
        { root: container, threshold: [0] },
    );

    document.querySelectorAll('.chat-turn').forEach((turnNode) => {
        const turn = turnNode as HTMLElement;
        const group = turn.querySelector('.message-group-user') as HTMLElement | null;
        if (!group) {
            return;
        }

        const content = group.querySelector('.message-content') as HTMLElement | null;
        turn.querySelector('.user-sticky-sentinel')?.remove();
        group.querySelector('.user-prompt-expand-toggle')?.remove();
        group.classList.remove('user-prompt-clampable', 'user-prompt-stuck', 'user-prompt-expanded');
        content?.classList.remove('user-prompt-text--collapsed');
        group.querySelector('.message-attachments')?.classList.remove('user-prompt-attachments--hidden');

        if (!content || !userPromptContentNeedsClamp(content)) {
            userPromptCollapseByGroup.delete(group);
            return;
        }

        const collapseState: UserPromptCollapseState = { expanded: false, clampable: true };
        userPromptCollapseByGroup.set(group, collapseState);
        group.classList.add('user-prompt-clampable');

        const sentinel = el('div', 'user-sticky-sentinel');
        turn.insertBefore(sentinel, group);
        userPromptStickyObserver!.observe(sentinel);

        const toggle = el('button', 'user-prompt-expand-toggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Show more';
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            const state = userPromptCollapseByGroup.get(group);
            if (!state) {
                return;
            }
            state.expanded = !state.expanded;
            applyUserPromptCollapse(group, state);
        });
        group.querySelector('.user-prompt-card')?.appendChild(toggle);

        const containerRect = container.getBoundingClientRect();
        const stuckNow = sentinel.getBoundingClientRect().bottom <= containerRect.top + 1;
        updateUserPromptStickyState(group, stuckNow);
    });
}
