import { readImageFileAsItem } from '../fileDropReaders';
import { handleAtMenuKeydown, isAtMenuVisible, updateAtMenu } from '../fileMentionMenu';
import { composerTarget } from '../voiceBar';
import { vscode } from '../vscodeApi';
import {
    clearComposerEdit,
    getComposerEdit,
    handleSendButtonClick,
    handleSteerButtonClick,
    hasSendableInput,
    loadLastUserMessageToComposer,
    requestAbort,
    sendComposerToVoice,
    sendMessage,
    submitComposerEdit,
    submitWhileStreaming,
    updateComposerToolbar,
} from './composer';
import { handleSlashMenuKeydown, hideSlashMenu, isSlashMenuVisible, updateSlashMenu } from './slashMenu';
import { state } from './state';

/** Binds the composer textarea (keys, autosize, menus, image paste) and the input-area buttons. */
export function bindComposerInput(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;

    input?.addEventListener('keydown', (e) => {
        // Keys that confirm or cancel an IME composition (Chinese/Japanese input) are the IME's:
        // Enter would send the half-composed text, Esc would stop the run.
        if (e.isComposing || e.keyCode === 229) {
            return;
        }
        if (handleAtMenuKeydown(e)) {
            return;
        }
        if (handleSlashMenuKeydown(e)) {
            return;
        }

        if (
            e.key === 'ArrowUp' &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !isSlashMenuVisible() &&
            !isAtMenuVisible() &&
            input.selectionStart === 0 &&
            input.selectionEnd === 0 &&
            input.value.length === 0
        ) {
            e.preventDefault();
            loadLastUserMessageToComposer();
            return;
        }

        const composerEdit = getComposerEdit();
        if (composerEdit && e.key === 'Escape') {
            e.preventDefault();
            clearComposerEdit();
            return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (composerEdit) {
                if ((e.ctrlKey || e.metaKey) && composerEdit.entryId) {
                    submitComposerEdit('fork');
                } else {
                    submitComposerEdit('new');
                }
                return;
            }
            if (composerTarget() === 'voice') {
                sendComposerToVoice();
                return;
            }
            if (state.isStreaming) {
                const text = input.value.trim();
                if (hasSendableInput(text)) {
                    if (e.ctrlKey || e.metaKey) {
                        vscode.postMessage({ type: 'steer', text });
                        input.value = '';
                        input.style.height = 'auto';
                        updateComposerToolbar();
                    } else {
                        submitWhileStreaming('queue');
                    }
                }
            } else {
                sendMessage();
            }
        }
        if (e.key === 'Escape' && state.isStreaming) {
            e.preventDefault();
            requestAbort();
        }
    });

    input?.addEventListener('input', () => {
        if (!input) return;
        input.style.height = 'auto';
        // border-box: scrollHeight excludes the border, so add it back or the text scrolls by 2px.
        const border = input.offsetHeight - input.clientHeight;
        input.style.height = Math.min(input.scrollHeight + border, 200) + 'px';
        updateComposerToolbar();
        updateAtMenu(input);
        // Slash commands are the worker's; the Bot view's text goes to the voice agent as is.
        if (isAtMenuVisible() || composerTarget() === 'voice') {
            hideSlashMenu();
        } else {
            updateSlashMenu(input);
        }
    });

    document.querySelector('.input-area')?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const attachBtn = target.closest('#btn-attach') as HTMLButtonElement | null;
        if (attachBtn && !attachBtn.disabled) {
            e.preventDefault();
            vscode.postMessage({ type: 'pickAttachments' });
            return;
        }
        const sendBtn = target.closest('#btn-send') as HTMLButtonElement | null;
        if (sendBtn && !sendBtn.disabled) {
            e.preventDefault();
            handleSendButtonClick();
            return;
        }
        if (target.closest('#btn-steer')) {
            e.preventDefault();
            handleSteerButtonClick();
            return;
        }
    });

    input?.addEventListener('paste', (e) => {
        const clip = e.clipboardData;
        // Images are attachments for the worker; the Bot view's text goes to the voice agent alone.
        if (!clip || composerTarget() === 'voice') return;
        const files: File[] = [];
        for (const item of clip.items) {
            if (!item.type.startsWith('image/')) continue;
            const file = item.getAsFile();
            if (file) files.push(file);
        }
        if (files.length === 0) return;
        e.preventDefault();
        void Promise.all(files.map(readImageFileAsItem)).then((items) => {
            const ready = items.filter(
                (x): x is { mimeType: string; dataBase64: string; name?: string } => x !== null,
            );
            if (ready.length > 0) {
                vscode.postMessage({ type: 'addPastedImages', items: ready });
            }
        });
    });
}
