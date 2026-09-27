import { vscode } from '../vscodeApi';
import { el } from './helpers';
import { getAssistantPlainForCopy, getUserMessagePlainForCopy } from './messageContent';
import { state } from './state';
import { copyPlainText, showToast } from './toast';

/** Composer operations the message action buttons trigger (injected to keep composer above this module). */
export interface MessageActionHandlers {
    editUserMessage(messageIndex: number, text: string, entryId?: string): void;
    resendUserMessage(messageIndex: number, text: string, mode: 'new' | 'fork', entryId?: string): void;
}

let handlers: MessageActionHandlers | null = null;

/** Registers the composer handlers used by the edit / resend / fork buttons. Call once at startup. */
export function installMessageActions(actionHandlers: MessageActionHandlers): void {
    handlers = actionHandlers;
}

function postRegenerateAssistant(assistantMessageIndex: number, mode: 'new' | 'fork'): void {
    vscode.postMessage({ type: 'regenerateAssistant', assistantMessageIndex, mode });
}

/** Inline SVGs drawn in `currentColor`; an `<img>` SVG cannot inherit the text colour and renders black. */
const COPY_ICON =
    '<svg class="msg-action-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';
const EDIT_ICON =
    '<svg class="msg-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M13 7l4 4"/></svg>';

export function buildMessageActions(role: 'user' | 'assistant', index: number, msg: any): HTMLElement {
    const bar = el('div', 'message-actions');
    bar.dataset.msgIndex = String(index);
    bar.dataset.role = role;

    const copyBtn = el('button', 'msg-action');
    copyBtn.type = 'button';
    copyBtn.dataset.action = 'copy';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = COPY_ICON;
    copyBtn.classList.add('msg-action--icon');

    bar.appendChild(copyBtn);

    if (role === 'user') {
        const editBtn = el('button', 'msg-action msg-action--icon');
        editBtn.type = 'button';
        editBtn.dataset.action = 'edit';
        editBtn.title = 'Edit in composer';
        editBtn.innerHTML = EDIT_ICON;
        bar.appendChild(editBtn);

        const resendNew = el('button', 'msg-action');
        resendNew.type = 'button';
        resendNew.dataset.action = 'resend-new';
        resendNew.title = 'Send again (new message at end)';
        resendNew.textContent = 'Resend';
        bar.appendChild(resendNew);

        const resendFork = el('button', 'msg-action msg-action--fork');
        resendFork.type = 'button';
        resendFork.dataset.action = 'resend-fork';
        resendFork.title = 'Fork from here and send';
        resendFork.textContent = 'Fork';
        if (!msg._forkEntryId) {
            resendFork.disabled = true;
            resendFork.title = 'Fork unavailable — use Resend';
        }
        bar.appendChild(resendFork);
    } else {
        const regenNew = el('button', 'msg-action msg-action--icon');
        regenNew.type = 'button';
        regenNew.dataset.action = 'regenerate-new';
        regenNew.title = 'Regenerate response';
        regenNew.textContent = '↻';
        bar.appendChild(regenNew);
    }

    return bar;
}

export function bindMessageActionButtons(): void {
    document.querySelectorAll('.message-actions:not([data-actions-bound])').forEach((bar) => {
        bar.setAttribute('data-actions-bound', '1');
        const index = parseInt((bar as HTMLElement).dataset.msgIndex ?? '-1', 10);
        const role = (bar as HTMLElement).dataset.role;
        if (index < 0) {
            return;
        }
        const msg = state.messages[index];
        if (!msg) {
            return;
        }

        bar.querySelectorAll('.msg-action').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const action = (btn as HTMLElement).dataset.action;
                if (action === 'copy') {
                    const text =
                        role === 'user' ? getUserMessagePlainForCopy(msg) : getAssistantPlainForCopy(msg);
                    copyPlainText(text);
                    return;
                }
                if (action === 'edit' && role === 'user') {
                    const text = getUserMessagePlainForCopy(msg);
                    const entryId =
                        typeof msg._forkEntryId === 'string' ? msg._forkEntryId : undefined;
                    handlers?.editUserMessage(index, text, entryId);
                    return;
                }
                if (action === 'resend-new' && role === 'user') {
                    const text = getUserMessagePlainForCopy(msg);
                    handlers?.resendUserMessage(index, text, 'new', msg._forkEntryId);
                    return;
                }
                if (action === 'resend-fork' && role === 'user') {
                    const text = getUserMessagePlainForCopy(msg);
                    const entryId =
                        typeof msg._forkEntryId === 'string' ? msg._forkEntryId : undefined;
                    if (!entryId) {
                        showToast('Fork unavailable for this message', 'error');
                        return;
                    }
                    handlers?.resendUserMessage(index, text, 'fork', entryId);
                    return;
                }
                if (action === 'regenerate-new' && role === 'assistant') {
                    postRegenerateAssistant(index, 'new');
                    return;
                }
            });
        });
    });
}

export function bindCheckpointButtons(): void {
    document.querySelectorAll('.checkpoint-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const turn = parseInt((btn as HTMLElement).dataset.turn ?? '-1', 10);
            if (turn < 1) return;
            vscode.postMessage({
                type: 'confirmAction',
                action: 'restoreCheckpoint',
                message: 'Discard all changes after this checkpoint?',
                payload: { messageIndex: turn - 1 },
            });
        });
    });
}

export function bindRedoButtons(): void {
    document.querySelectorAll('.redo-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({
                type: 'confirmAction',
                action: 'redoCheckpoint',
                message: 'Re-apply the rolled-back changes?',
            });
        });
    });
}
