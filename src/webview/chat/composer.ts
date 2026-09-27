import { VOICE_OFFLINE_SEND_HINT, VOICE_OFFLINE_SEND_TITLE } from '../../shared/voiceViewProtocol';
import { setMicLocked } from '../dictation';
import { composerLocked, composerTarget, sendToVoice } from '../voiceBar';
import { vscode } from '../vscodeApi';
import { updateConnectionBanner } from './banners';
import { updateAttachmentsStrip } from './composerChips';
import { findLastUserMessageIndex, getUserMessagePlainForCopy } from './messageContent';
import { updateQueuedMessageBanner } from './queuedBanner';
import { resetUserScroll, updateScrollButton } from './scroll';
import { state } from './state';
import { setStreamPhase, updateStreamingUI } from './streaming';
import { showToast } from './toast';
import { appendOptimisticUserMessage } from './transcript';

/** When set, composer is editing a sent user message (resend via banner). */
export interface ComposerEditState {
    messageIndex: number;
    entryId?: string;
    originalText: string;
}
let composerEdit: ComposerEditState | null = null;

/** The sent user message the composer is editing, or null. */
export function getComposerEdit(): Readonly<ComposerEditState> | null {
    return composerEdit;
}

export function hasSendableInput(text: string): boolean {
    return Boolean(text.trim()) || state.pendingAttachments.length > 0;
}

export function updateComposerToolbar(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const text = input?.value.trim() ?? '';
    const locked = composerLocked();
    // The Bot view's text goes to the voice agent: text only, and it neither steers nor interrupts omp.
    const toVoice = composerTarget() === 'voice';
    const canSend = toVoice ? !!text && !locked : hasSendableInput(text);

    const steerBtn = document.getElementById('btn-steer');
    const sendBtn = document.getElementById('btn-send') as HTMLButtonElement | null;

    if (steerBtn) {
        steerBtn.hidden = !state.isStreaming || toVoice;
    }
    const attachBtn = document.getElementById('btn-attach') as HTMLButtonElement | null;
    if (attachBtn) {
        attachBtn.disabled = toVoice;
    }
    if (sendBtn) {
        // Nothing to send (or locked): a running worker can still be stopped.
        const showStop = state.isStreaming && !composerEdit && !canSend;
        const showInterruptSend = state.isStreaming && !composerEdit && canSend && !toVoice;
        sendBtn.classList.toggle('composer-action-btn--as-stop', showStop);
        sendBtn.classList.toggle('composer-action-btn--as-queue', showInterruptSend);
        const sendIcon = sendBtn.querySelector('.composer-btn-icon--send') as HTMLElement | null;
        const stopIcon = sendBtn.querySelector('.composer-btn-icon--stop') as HTMLElement | null;
        if (sendIcon) {
            sendIcon.hidden = showStop;
        }
        if (stopIcon) {
            stopIcon.hidden = !showStop;
        }
        if (composerEdit) {
            sendBtn.title = 'Send as new (⌘↵ fork)';
            sendBtn.setAttribute('aria-label', 'Send as new message');
        } else if (showStop) {
            sendBtn.title = 'Stop (Esc)';
            sendBtn.setAttribute('aria-label', 'Stop generation');
        } else if (locked) {
            sendBtn.title = VOICE_OFFLINE_SEND_TITLE;
            sendBtn.setAttribute('aria-label', VOICE_OFFLINE_SEND_TITLE);
        } else if (showInterruptSend) {
            sendBtn.title = 'Send now (interrupt current work)';
            sendBtn.setAttribute('aria-label', 'Send now and interrupt current work');
        } else if (toVoice) {
            sendBtn.title = 'Send to the voice agent (Enter)';
            sendBtn.setAttribute('aria-label', 'Send to the voice agent');
        } else {
            sendBtn.title = 'Send (Enter)';
            sendBtn.setAttribute('aria-label', 'Send message');
        }
        const disabled = !state.isStreaming && !canSend;
        sendBtn.toggleAttribute('disabled', disabled);
        sendBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }
}

/** The Bot view: sends the composer's text to the voice agent and clears the box. False when there is nothing to send or nobody online. */
export function sendComposerToVoice(): boolean {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const text = input?.value.trim() ?? '';
    if (!input || !text || composerLocked()) {
        return false;
    }
    sendToVoice(text);
    input.value = '';
    input.style.height = 'auto';
    updateComposerToolbar();
    return true;
}

export function submitWhileStreaming(mode: 'queue' | 'interrupt'): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const text = input?.value.trim() ?? '';
    if (!hasSendableInput(text)) {
        return;
    }
    const attachmentCount = state.pendingAttachments.length;
    const slashOnly = attachmentCount === 0 && text.startsWith('/');
    state.pendingAttachments = [];
    updateAttachmentsStrip();
    if (slashOnly) {
        vscode.postMessage({ type: 'slashCommand', text });
    } else {
        if (text || attachmentCount > 0) {
            appendOptimisticUserMessage(text, attachmentCount);
        }
        vscode.postMessage({
            type: mode === 'interrupt' ? 'interruptAndSend' : 'queueMessage',
            text,
        });
    }
    if (input) {
        input.value = '';
        input.style.height = 'auto';
    }
    updateComposerToolbar();
}

export function requestAbort(): void {
    state.isStreaming = false;
    state.streamingText = '';
    state.streamingThinking = '';
    state.isThinking = false;
    state.connectionStatus = { phase: 'idle' };
    setStreamPhase('idle');
    updateStreamingUI();
    updateInputArea();
    updateConnectionBanner();
    vscode.postMessage({ type: 'abort' });
}

export function handleSendButtonClick(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (composerTarget() === 'voice') {
        // Nothing went to the voice agent: the button was a stop button.
        if (!sendComposerToVoice() && state.isStreaming) {
            requestAbort();
        }
        return;
    }
    if (state.isStreaming) {
        const text = input?.value.trim() ?? '';
        if (hasSendableInput(text)) {
            submitWhileStreaming('interrupt');
        } else {
            requestAbort();
        }
        return;
    }
    sendMessage();
}

export function handleSteerButtonClick(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const text = input?.value.trim() ?? '';
    if (!hasSendableInput(text)) {
        return;
    }
    vscode.postMessage({ type: 'steer', text });
    if (input) {
        input.value = '';
        input.style.height = 'auto';
    }
    updateComposerToolbar();
}

export function updateInputArea(): void {
    updateComposerEditBanner();
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const locked = composerLocked();
    document.querySelector('.input-area')?.classList.toggle('is-locked', locked);
    setMicLocked(locked);
    if (input) {
        input.disabled = locked;
        input.title = locked ? VOICE_OFFLINE_SEND_TITLE : '';
        input.placeholder = locked
            ? VOICE_OFFLINE_SEND_HINT
            : composerEdit
              ? 'Enter = send as new · ⌘↵ = fork & send · Esc = cancel'
              : composerTarget() === 'voice'
                ? 'Talk to the voice agent…'
                : state.isStreaming
                  ? 'Enter to queue · ↑ send now · Ctrl+Enter steer · Esc stop...'
                  : state.planMode.enabled
                    ? 'Plan mode: describe what to build (read-only until you implement)...'
                    : 'Ask Pi anything...';
    }

    updateComposerToolbar();
    updateQueuedMessageBanner();
    updateConnectionBanner();
}

export function sendMessage(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    // The worker's send; the Bot view's text goes to the voice agent instead.
    if (!input || composerTarget() === 'voice') return;
    if (composerEdit) {
        submitComposerEdit('new');
        return;
    }
    const text = input.value.trim();
    if (!hasSendableInput(text)) return;
    const attachments = [...state.pendingAttachments];
    const attachmentCount = attachments.length;
    input.value = '';
    input.style.height = 'auto';
    state.pendingAttachments = [];
    updateAttachmentsStrip();
    resetUserScroll();
    updateScrollButton();
    const slashOnly = attachmentCount === 0 && text.startsWith('/');
    if (slashOnly) {
        vscode.postMessage({ type: 'slashCommand', text });
        updateComposerToolbar();
        return;
    }
    if (text || attachmentCount > 0) {
        appendOptimisticUserMessage(text, attachmentCount);
    }
    vscode.postMessage({ type: 'prompt', text, attachments });
    updateComposerToolbar();
}

export function loadLastUserMessageToComposer(): void {
    const idx = findLastUserMessageIndex(state.messages);
    if (idx < 0) {
        return;
    }
    const msg = state.messages[idx];
    const text = getUserMessagePlainForCopy(msg);
    const entryId = typeof msg._forkEntryId === 'string' ? msg._forkEntryId : undefined;
    startComposerEdit(idx, text, entryId);
}

export function startComposerEdit(messageIndex: number, text: string, entryId?: string): void {
    composerEdit = { messageIndex, entryId, originalText: text };
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (input) {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange(text.length, text.length);
    }
    updateComposerEditBanner();
    updateInputArea();
}

export function clearComposerEdit(): void {
    composerEdit = null;
    updateComposerEditBanner();
    updateInputArea();
}

function updateComposerEditBanner(): void {
    const banner = document.getElementById('composer-edit-banner');
    if (!banner) {
        return;
    }
    if (!composerEdit) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }
    banner.style.display = '';
    const hasFork = !!composerEdit.entryId;
    banner.innerHTML = `
        <span class="composer-edit-label">Editing · Enter = new · ⌘↵ = fork</span>
        <div class="composer-edit-actions">
            <button type="button" class="composer-edit-btn" data-send-mode="new" title="Send as new message (Enter)">Send as new</button>
            <button type="button" class="composer-edit-btn composer-edit-btn--fork" data-send-mode="fork" title="Fork from this point (⌘↵)" ${hasFork ? '' : 'disabled'}>Fork &amp; send</button>
            <button type="button" class="composer-edit-btn composer-edit-btn--ghost" data-cancel-edit>Cancel</button>
        </div>
    `;
    if (!hasFork) {
        banner.querySelector('[data-send-mode="fork"]')?.setAttribute(
            'title',
            'Fork unavailable for this message — use Send as new',
        );
    }
    banner.querySelectorAll('[data-send-mode]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const mode = (btn as HTMLElement).dataset.sendMode as 'new' | 'fork';
            if (mode) {
                submitComposerEdit(mode);
            }
        });
    });
    banner.querySelector('[data-cancel-edit]')?.addEventListener('click', (e) => {
        e.preventDefault();
        clearComposerEdit();
    });
}

export function submitComposerEdit(mode: 'new' | 'fork'): void {
    if (!composerEdit) {
        return;
    }
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const text = input?.value.trim() ?? '';
    if (!text) {
        showToast('Message is empty', 'error');
        return;
    }
    const { messageIndex, entryId } = composerEdit;
    composerEdit = null;
    updateComposerEditBanner();
    if (input) {
        input.value = '';
        input.style.height = 'auto';
    }
    appendOptimisticUserMessage(text, 0);
    vscode.postMessage({
        type: 'resendUserMessage',
        messageIndex,
        text,
        mode,
        entryId,
    });
}

/** Resends a past user message (from its action buttons) as a new message or a fork. */
export function resendUserMessage(messageIndex: number, text: string, mode: 'new' | 'fork', entryId?: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
        return;
    }
    appendOptimisticUserMessage(trimmed, 0);
    vscode.postMessage({ type: 'resendUserMessage', messageIndex, text: trimmed, mode, entryId });
}
