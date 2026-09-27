let userHasScrolled = false;
let isProgrammaticScroll = false;
let scrollFollowPending = false;
/**
 * Set by the transcript while its newest turns are not rendered (the user paged far up), else null.
 * The transcript's end is then not the latest message: following the bottom stops, and a forced
 * scroll to the bottom first renders the newest turns through it.
 */
let showLatestTurns: (() => void) | null = null;

export function setDetachedHistory(showLatest: (() => void) | null): void {
    showLatestTurns = showLatest;
    updateScrollButton();
}

/** True while the user has scrolled away from the bottom of the transcript, or paged away from its newest turns. */
export function hasUserScrolled(): boolean {
    return userHasScrolled || showLatestTurns !== null;
}

/** Resume following the bottom of the transcript. */
export function resetUserScroll(): void {
    userHasScrolled = false;
}

export function scrollToBottom(force = false): void {
    if (hasUserScrolled() && !force) return;
    if (showLatestTurns) {
        const showLatest = showLatestTurns;
        showLatestTurns = null;
        showLatest();
    }
    const messages = document.getElementById('messages');
    if (messages) {
        isProgrammaticScroll = true;
        messages.scrollTop = messages.scrollHeight;
    }
}

/** Instant scroll (bypasses `.messages { scroll-behavior: smooth }`) for restoring after DOM rebuilds. */
export function jumpMessagesScroll(messages: HTMLElement, top: number): void {
    const target = Math.max(0, Math.min(top, messages.scrollHeight - messages.clientHeight));
    if (Math.abs(messages.scrollTop - target) < 1) {
        return;
    }
    isProgrammaticScroll = true;
    messages.scrollTo({ top: target, behavior: 'instant' });
}

export function isNearBottom(): boolean {
    const messages = document.getElementById('messages');
    if (!messages) return true;
    // The newest turns are not rendered: the end of what is shown is not the bottom.
    if (showLatestTurns) return false;
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 50;
}

export function updateScrollButton(): void {
    const btn = document.getElementById('btn-scroll-bottom');
    if (!btn) return;
    btn.classList.toggle('visible', hasUserScrolled());
}

export function bindScrollListener(): void {
    const messages = document.getElementById('messages');
    if (!messages) return;

    // Detect user-initiated scroll intent immediately
    messages.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) {
            userHasScrolled = true;
            updateScrollButton();
        }
    }, { passive: true });

    messages.addEventListener('touchstart', () => {
        userHasScrolled = true;
        updateScrollButton();
    }, { passive: true });

    // The scroll event handles resetting when user reaches bottom
    messages.addEventListener('scroll', () => {
        if (isProgrammaticScroll) {
            isProgrammaticScroll = false;
            return;
        }
        if (isNearBottom()) {
            userHasScrolled = false;
        }
        updateScrollButton();
    });
}

/** Scroll only when the user is already following the stream (avoids layout jump spam). */
export function scrollIfFollowing(): void {
    if (userHasScrolled) {
        return;
    }
    if (scrollFollowPending) {
        return;
    }
    scrollFollowPending = true;
    requestAnimationFrame(() => {
        scrollFollowPending = false;
        if (userHasScrolled) {
            return;
        }
        if (isNearBottom()) {
            scrollToBottom();
        }
    });
}
