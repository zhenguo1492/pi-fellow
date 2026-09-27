import type { ConnectionStatus } from '../../shared/protocol';
import { vscode } from '../vscodeApi';
import { el, truncate } from './helpers';
import { scrollToBottom } from './scroll';
import { state } from './state';

/** Banner heading: startup progress, reconnect progress (with the attempt counter when known), or failure. */
export function connectionBannerTitle(cs: ConnectionStatus): string {
    const attemptLabel =
        cs.phase === 'retrying' && cs.attempt != null && cs.maxAttempts != null
            ? ` (${cs.attempt}/${cs.maxAttempts})`
            : cs.phase === 'retrying' && cs.attempt != null
              ? ` (attempt ${cs.attempt})`
              : '';

    if (cs.phase === 'connecting') {
        return cs.message ?? 'Starting…';
    }
    return cs.phase === 'retrying'
        ? `Reconnecting${attemptLabel}…`
        : 'Connection failed';
}

export function updateConnectionBanner(): void {
    const container = document.querySelector('.input-container');
    if (!container) {
        return;
    }

    const existing = document.getElementById('connection-banner');
    const cs = state.connectionStatus ?? { phase: 'idle' };

    if (cs.phase === 'idle') {
        existing?.remove();
        return;
    }

    const title = connectionBannerTitle(cs);

    const detailText = cs.message ? truncate(cs.message, 200) : '';

    let banner = existing;
    if (!banner) {
        banner = el('div', `connection-banner connection-banner-${cs.phase}`);
        banner.id = 'connection-banner';
        const inputArea = container.querySelector('.input-area');
        if (inputArea) {
            container.insertBefore(banner, inputArea);
        } else {
            container.appendChild(banner);
        }
    } else {
        banner.className = `connection-banner connection-banner-${cs.phase}`;
    }

    banner.replaceChildren();

    if (cs.phase === 'connecting' || cs.phase === 'retrying') {
        banner.append(
            el('span', 'connection-banner-spinner'),
            Object.assign(el('span', 'connection-banner-title'), { textContent: title }),
        );
        // While connecting, the message is the title.
        if (detailText && cs.phase === 'retrying') {
            const detailEl = el('span', 'connection-banner-detail');
            detailEl.textContent = detailText;
            banner.append(detailEl);
        }
        return;
    }

    banner.append(Object.assign(el('span', 'connection-banner-title'), { textContent: title }));
    if (detailText) {
        const detailEl = el('span', 'connection-banner-detail');
        detailEl.textContent = detailText;
        banner.append(detailEl);
    }
    appendDismissButton(banner, 'connection-banner-dismiss', () => {
        state.connectionStatus = { phase: 'idle' };
        updateConnectionBanner();
    });
}

export function appendDismissButton(
    container: HTMLElement,
    className: string,
    onDismiss: () => void,
): HTMLButtonElement {
    const closeBtn = el('button', className);
    closeBtn.type = 'button';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Dismiss';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDismiss();
    });
    container.appendChild(closeBtn);
    return closeBtn;
}

/**
 * omp /login|/logout banner at the transcript end: omp only signs in from its own TUI picker, so
 * the button switches to TUI mode and the extension types the command there.
 */
export function updateTuiAuthBanner(): void {
    const container = document.getElementById('messages');
    const streamingEl = document.getElementById('streaming-message');
    const existing = document.getElementById('tui-auth-banner');
    const command = state.tuiAuthPrompt;
    if (!container || !streamingEl || !command) {
        existing?.remove();
        return;
    }
    // Directly above the pending steering strip, which updateMessages keeps right above streaming.
    const anchor = document.getElementById('pending-messages') ?? streamingEl;
    if (existing?.dataset.command === command) {
        if (existing.nextSibling !== anchor) {
            container.insertBefore(existing, anchor);
        }
        return;
    }
    existing?.remove();

    const banner = el('div', 'tui-auth-banner');
    banner.id = 'tui-auth-banner';
    banner.dataset.command = command;
    const text = el('span', 'tui-auth-banner-text');
    text.textContent =
        command === 'login'
            ? 'omp signs in from its terminal UI: pick a subscription or API-key provider there (logged-in ones are marked).'
            : 'omp removes stored credentials from its terminal UI.';
    const button = el('button', 'tui-auth-banner-btn');
    button.type = 'button';
    button.textContent = command === 'login' ? 'Log in via terminal' : 'Log out via terminal';
    button.addEventListener('click', () => vscode.postMessage({ type: 'runTuiAuth' }));
    banner.append(text, button);
    appendDismissButton(banner, 'error-message-dismiss', () => vscode.postMessage({ type: 'dismissTuiAuth' }));
    container.insertBefore(banner, anchor);
    scrollToBottom(true);
}

export function showError(message: string): void {
    if (!message.trim()) {
        return;
    }
    state.connectionStatus = { phase: 'failed', message: message.trim() };
    updateConnectionBanner();

    const container = document.getElementById('messages');
    if (!container) {
        return;
    }
    const errEl = el('div', 'error-message');
    const textEl = el('span', 'error-message-text');
    textEl.textContent = message;
    errEl.appendChild(textEl);
    appendDismissButton(errEl, 'error-message-dismiss', () => {
        errEl.remove();
    });
    container.appendChild(errEl);
    scrollToBottom();
}
