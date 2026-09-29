import type { ExtensionUiCard } from '../shared/extensionUi';
import { escapeHtml } from '../shared/html';
import { vscode } from './vscodeApi';

let activeRequest: ExtensionUiCard | null = null;
const pendingQueue: ExtensionUiCard[] = [];
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

/** Keys typed into a TUI tab's terminal are the TUI's, even while one of its dialogs has a card. */
function inTerminal(element: Element | null): boolean {
    return !!element?.closest('.tui-host');
}

export interface ExtensionUiHostOptions {
    /** Puts keyboard focus in a tab's terminal (tuiView's focusTui). */
    focusTui(tabId: string): void;
}

export function initExtensionUiHost(options: ExtensionUiHostOptions): void {
    const host = document.getElementById('extension-ui-host');
    if (!host) {
        return;
    }
    host.addEventListener('mousedown', (e) => {
        // The button hands focus to the terminal: it must not take it itself.
        if ((e.target as HTMLElement).closest('[data-extension-ui-show-tui]')) e.preventDefault();
    });
    host.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const showTui = target.closest<HTMLElement>('[data-extension-ui-show-tui]');
        if (showTui) {
            const tabId = showTui.dataset.extensionUiShowTui ?? '';
            vscode.postMessage({ type: 'showTui', tabId });
            // Shown already: focus it now; else the sync that shows it focuses it.
            options.focusTui(tabId);
            return;
        }
        const cancelBtn = target.closest('[data-extension-ui-cancel]');
        if (cancelBtn && activeRequest) {
            respond({ id: activeRequest.id, cancelled: true });
            return;
        }
        const optionBtn = target.closest('[data-extension-ui-option]') as HTMLElement | null;
        if (optionBtn && activeRequest) {
            const value = optionBtn.dataset.extensionUiOption ?? '';
            if (activeRequest.method === 'select') {
                respond({ id: activeRequest.id, value });
                return;
            }
        }

        const confirmBtn = target.closest('[data-extension-ui-confirm]') as HTMLElement | null;
        if (confirmBtn && activeRequest?.method === 'confirm') {
            respond({
                id: activeRequest.id,
                confirmed: confirmBtn.dataset.extensionUiConfirm === 'yes',
            });
        }

        const submitBtn = target.closest('[data-extension-ui-submit]');
        if (submitBtn && activeRequest && (activeRequest.method === 'input' || activeRequest.method === 'editor')) {
            const input = document.getElementById('extension-ui-input') as HTMLTextAreaElement | null;
            const value = input?.value.trim();
            if (!value) {
                return;
            }
            respond({ id: activeRequest.id, value });
        }
    });
    // The chat was rebuilt (first render, tab switch) with an empty host. The question still waiting
    // must show again: its keyboard shortcuts stay live, and every later request queues behind it.
    if (activeRequest) {
        host.style.display = 'block';
        host.innerHTML = renderRequest(activeRequest);
    } else {
        drainExtensionUiQueue();
    }
}

export function showExtensionUiRequest(request: ExtensionUiCard): void {
    pendingQueue.push(request);
    drainExtensionUiQueue();
}

export function dismissExtensionUi(id: string): void {
    if (activeRequest?.id === id) {
        finishActiveRequest();
        return;
    }
    const idx = pendingQueue.findIndex((r) => r.id === id);
    if (idx !== -1) {
        pendingQueue.splice(idx, 1);
    }
}

function drainExtensionUiQueue(): void {
    const host = document.getElementById('extension-ui-host');
    // No chat drawn yet: the request waits in the queue for initExtensionUiHost.
    if (activeRequest || pendingQueue.length === 0 || !host) {
        return;
    }
    activeRequest = pendingQueue.shift()!;
    host.style.display = 'block';
    host.innerHTML = renderRequest(activeRequest);
    bindExtensionUiKeyboard(activeRequest);
    // Someone typing in a TUI keeps their focus: the card is clicked, or answered in the TUI.
    if (!inTerminal(document.activeElement)) {
        const firstOption = host.querySelector('.extension-ui-option') as HTMLButtonElement | null;
        firstOption?.focus();
    }
    host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function finishActiveRequest(): void {
    unbindExtensionUiKeyboard();
    activeRequest = null;
    const host = document.getElementById('extension-ui-host');
    if (host) {
        host.style.display = 'none';
        host.innerHTML = '';
    }
    drainExtensionUiQueue();
}

function respond(payload: { id: string; cancelled?: boolean; value?: string; confirmed?: boolean }): void {
    vscode.postMessage({ type: 'extensionUiResponse', ...payload });
    dismissExtensionUi(payload.id);
}

function bindExtensionUiKeyboard(req: ExtensionUiCard): void {
    unbindExtensionUiKeyboard();
    // A screen card has nothing to answer from the keyboard.
    if (req.method === 'screen') {
        return;
    }
    keyHandler = (e: KeyboardEvent) => {
        if (!activeRequest || activeRequest.id !== req.id || inTerminal(e.target instanceof Element ? e.target : null)) {
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            respond({ id: req.id, cancelled: true });
            return;
        }
        if (req.method !== 'select' || !req.options?.length) {
            return;
        }
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 9 && num <= req.options.length) {
            e.preventDefault();
            respond({ id: req.id, value: req.options[num - 1] });
        }
    };
    document.addEventListener('keydown', keyHandler, true);
}

function unbindExtensionUiKeyboard(): void {
    if (keyHandler) {
        document.removeEventListener('keydown', keyHandler, true);
        keyHandler = null;
    }
}

function optionLetter(index: number): string {
    if (index < 26) {
        return String.fromCharCode(65 + index);
    }
    return String(index + 1);
}

/** Split "1. Label — description" (plan_mode_question) into title + subtitle. */
function parseOptionDisplay(opt: string): { title: string; description?: string; value: string } {
    const value = opt;
    const numbered = opt.match(/^\s*(\d+)[.)]\s+(.+)$/);
    const body = numbered ? numbered[2].trim() : opt.trim();
    const dash = body.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    if (dash) {
        return { title: dash[1].trim(), description: dash[2].trim(), value };
    }
    return { title: body || opt, value };
}

function renderRequest(req: ExtensionUiCard): string {
    if (req.method === 'screen') {
        return `
            <div class="extension-ui-card" role="dialog" aria-label="${escapeHtml(req.title)}">
                <div class="extension-ui-header">
                    <span class="extension-ui-badge">TUI</span>
                    <div class="extension-ui-title">${escapeHtml(req.title)}</div>
                    <p class="extension-ui-subtitle">Answer it in the terminal, or tell the voice agent.</p>
                </div>
                <pre class="extension-ui-screen">${escapeHtml(req.message)}</pre>
                <div class="extension-ui-actions-row">
                    <button type="button" class="extension-ui-btn primary" data-extension-ui-show-tui="${escapeHtml(req.tabId)}">Show the terminal</button>
                </div>
            </div>`;
    }
    const title = req.title?.trim() || 'Selection required';
    const badge =
        req.method === 'select'
            ? 'Question'
            : req.method === 'confirm'
              ? 'Confirm'
              : req.method === 'editor'
                ? 'Text'
                : 'Input';
    // Detail lines, such as the command a tool approval would run.
    const message = req.method !== 'confirm' && req.message?.trim() ? `<p class="extension-ui-message">${escapeHtml(req.message.trim())}</p>` : '';

    if (req.method === 'confirm') {
        const msg = req.message?.trim() || '';
        return `
            <div class="extension-ui-card" role="dialog" aria-label="${escapeHtml(title)}">
                <div class="extension-ui-header">
                    <span class="extension-ui-badge">${badge}</span>
                    <div class="extension-ui-title">${escapeHtml(title)}</div>
                    ${msg ? `<p class="extension-ui-subtitle">${escapeHtml(msg)}</p>` : ''}
                </div>
                <div class="extension-ui-actions-row">
                    <button type="button" class="extension-ui-btn primary" data-extension-ui-confirm="yes">Yes</button>
                    <button type="button" class="extension-ui-btn" data-extension-ui-confirm="no">No</button>
                    <button type="button" class="extension-ui-btn ghost" data-extension-ui-cancel>Cancel</button>
                </div>
            </div>`;
    }

    if (req.method === 'input' || req.method === 'editor') {
        const placeholder = req.placeholder?.trim() || 'Type your answer…';
        const prefill = req.prefill ?? '';
        const rows = req.method === 'editor' ? 4 : 2;
        return `
            <div class="extension-ui-card" role="dialog" aria-label="${escapeHtml(title)}">
                <div class="extension-ui-header">
                    <span class="extension-ui-badge">${badge}</span>
                    <div class="extension-ui-title">${escapeHtml(title)}</div>
                    ${message}
                    <p class="extension-ui-subtitle">Submit to reply · Esc to cancel</p>
                </div>
                <textarea id="extension-ui-input" class="extension-ui-textarea" rows="${rows}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(prefill)}</textarea>
                <div class="extension-ui-actions-row">
                    <button type="button" class="extension-ui-btn primary" data-extension-ui-submit>Submit</button>
                    <button type="button" class="extension-ui-btn ghost" data-extension-ui-cancel>Cancel</button>
                </div>
            </div>`;
    }

    const options = req.options ?? [];
    const optionButtons = options
        .map((opt, i) => {
            const letter = optionLetter(i);
            const { title: optTitle, description, value } = parseOptionDisplay(opt);
            const descHtml = description
                ? `<span class="extension-ui-option-desc">${escapeHtml(description)}</span>`
                : '';
            return `
                <button type="button" class="extension-ui-option" data-extension-ui-option="${escapeHtml(value)}">
                    <span class="extension-ui-letter">${letter}</span>
                    <span class="extension-ui-option-text">${escapeHtml(optTitle)}${descHtml}</span>
                </button>`;
        })
        .join('');

    const keyHint =
        options.length > 0 && options.length <= 9
            ? `Press 1–${options.length} or click · Esc to cancel`
            : 'Click an option · Esc to cancel';

    return `
        <div class="extension-ui-card" role="dialog" aria-label="${escapeHtml(title)}">
            <div class="extension-ui-header">
                <span class="extension-ui-badge">${badge}</span>
                <div class="extension-ui-title">${escapeHtml(title)}</div>
                ${message}
                <p class="extension-ui-subtitle">${escapeHtml(keyHint)}</p>
            </div>
            <div class="extension-ui-options">${optionButtons}</div>
            <div class="extension-ui-actions-row">
                <button type="button" class="extension-ui-btn ghost" data-extension-ui-cancel>Cancel</button>
            </div>
        </div>`;
}
