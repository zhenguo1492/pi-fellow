let userHasScrolled = false;
let isProgrammaticScroll = false;
let scrollFollowPending = false;

/** True while the user has scrolled away from the bottom of the transcript. */
export function hasUserScrolled(): boolean {
    return userHasScrolled;
}

/** Resume following the bottom of the transcript. */
export function resetUserScroll(): void {
    userHasScrolled = false;
}

export function scrollToBottom(force = false): void {
    if (userHasScrolled && !force) return;
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
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 50;
}

export function updateScrollButton(): void {
    const btn = document.getElementById('btn-scroll-bottom');
    if (!btn) return;
    if (userHasScrolled) {
        btn.classList.add('visible');
    } else {
        btn.classList.remove('visible');
    }
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
