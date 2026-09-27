import type { ExtensionUiRequestPayload } from '../shared/extensionUi';
import { vscode } from './vscodeApi';

let activeRequest: ExtensionUiRequestPayload | null = null;
const pendingQueue: ExtensionUiRequestPayload[] = [];
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

export function initExtensionUiHost(): void {
    const host = document.getElementById('extension-ui-host');
    if (!host) {
        return;
    }
    host.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
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

export function showExtensionUiRequest(request: ExtensionUiRequestPayload): void {
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
    const firstOption = host.querySelector('.extension-ui-option') as HTMLButtonElement | null;
    firstOption?.focus();
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

function bindExtensionUiKeyboard(req: ExtensionUiRequestPayload): void {
    unbindExtensionUiKeyboard();
    keyHandler = (e: KeyboardEvent) => {
        if (!activeRequest || activeRequest.id !== req.id) {
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

function escHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escAttr(s: string): string {
    return escHtml(s).replace(/'/g, '&#39;');
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

function renderRequest(req: ExtensionUiRequestPayload): string {
    const title = req.title?.trim() || 'Selection required';
    const badge =
        req.method === 'select'
            ? 'Question'
            : req.method === 'confirm'
              ? 'Confirm'
              : req.method === 'editor'
                ? 'Text'
                : 'Input';

    if (req.method === 'confirm') {
        const msg = req.message?.trim() || '';
        return `
            <div class="extension-ui-card" role="dialog" aria-label="${escHtml(title)}">
                <div class="extension-ui-header">
                    <span class="extension-ui-badge">${badge}</span>
                    <div class="extension-ui-title">${escHtml(title)}</div>
                    ${msg ? `<p class="extension-ui-subtitle">${escHtml(msg)}</p>` : ''}
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
            <div class="extension-ui-card" role="dialog" aria-label="${escHtml(title)}">
                <div class="extension-ui-header">
                    <span class="extension-ui-badge">${badge}</span>
                    <div class="extension-ui-title">${escHtml(title)}</div>
                    <p class="extension-ui-subtitle">Submit to reply · Esc to cancel</p>
                </div>
                <textarea id="extension-ui-input" class="extension-ui-textarea" rows="${rows}" placeholder="${escHtml(placeholder)}">${escHtml(prefill)}</textarea>
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
                ? `<span class="extension-ui-option-desc">${escHtml(description)}</span>`
                : '';
            return `
                <button type="button" class="extension-ui-option" data-extension-ui-option="${escAttr(value)}">
                    <span class="extension-ui-letter">${letter}</span>
                    <span class="extension-ui-option-text">${escHtml(optTitle)}${descHtml}</span>
                </button>`;
        })
        .join('');

    const keyHint =
        options.length > 0 && options.length <= 9
            ? `Press 1–${options.length} or click · Esc to cancel`
            : 'Click an option · Esc to cancel';

    return `
        <div class="extension-ui-card" role="dialog" aria-label="${escHtml(title)}">
            <div class="extension-ui-header">
                <span class="extension-ui-badge">${badge}</span>
                <div class="extension-ui-title">${escHtml(title)}</div>
                <p class="extension-ui-subtitle">${escHtml(keyHint)}</p>
            </div>
            <div class="extension-ui-options">${optionButtons}</div>
            <div class="extension-ui-actions-row">
                <button type="button" class="extension-ui-btn ghost" data-extension-ui-cancel>Cancel</button>
            </div>
        </div>`;
}
