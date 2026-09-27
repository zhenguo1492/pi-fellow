import type { EditorContextInfo } from '../../shared/editorContext';
import { renderComposerAttachmentChip, renderEditorContextChip } from '../attachmentChipHtml';
import { vscode } from '../vscodeApi';
import { requestImagePreview } from './attachments';
import { el, escAttr, escHtml } from './helpers';
import { state } from './state';

/** Active editor file/selection pushed by the extension; shown as a toggle chip in the composer. */
let editorContext: { context: EditorContextInfo | null; enabled: boolean } = {
    context: null,
    enabled: true,
};
/** Pending image attachment whose preview is open above the composer chip row. */
let previewedAttachmentId: string | null = null;

/** Stores the editor context pushed by the extension and re-renders its chip. */
export function setEditorContext(context: EditorContextInfo | null, enabled: boolean): void {
    editorContext = { context, enabled };
    updateEditorContextBar();
}

/** Attaches the composer chip-row listeners to the elements `render()` creates. */
export function bindComposerChips(parts: {
    attachmentPreview: HTMLElement;
    editorContextBar: HTMLElement;
    attachmentsStrip: HTMLElement;
}): void {
    const { attachmentPreview, editorContextBar, attachmentsStrip } = parts;
    attachmentPreview.addEventListener('click', () => {
        previewedAttachmentId = null;
        updateAttachmentPreview();
    });
    editorContextBar.addEventListener('click', (e) => {
        if (!(e.target as HTMLElement).closest('.editor-context-chip')) {
            return;
        }
        editorContext = { ...editorContext, enabled: !editorContext.enabled };
        updateEditorContextBar();
        vscode.postMessage({ type: 'setEditorContextEnabled', enabled: editorContext.enabled });
    });
    attachmentsStrip.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const remove = target.closest<HTMLElement>('.attachment-remove');
        if (remove?.dataset.id) {
            vscode.postMessage({ type: 'removeAttachment', id: remove.dataset.id });
            return;
        }
        const chip = target.closest<HTMLElement>('.attachment-chip');
        if (chip?.dataset.id) {
            activateComposerAttachment(chip.dataset.id);
        }
    });
    attachmentsStrip.addEventListener('keydown', (e) => {
        const chip = e.target as HTMLElement;
        if ((e.key === 'Enter' || e.key === ' ') && chip.classList.contains('attachment-chip') && chip.dataset.id) {
            e.preventDefault();
            activateComposerAttachment(chip.dataset.id);
        }
    });
}

export function updateAttachmentsStrip(): void {
    const strip = document.getElementById('attachments-strip');
    if (!strip) return;

    if (state.pendingAttachments.length === 0) {
        strip.style.display = 'none';
        strip.innerHTML = '';
    } else {
        strip.style.display = '';
        strip.innerHTML = state.pendingAttachments
            .map((a) => renderComposerAttachmentChip(a, a.id === previewedAttachmentId, escHtml, escAttr))
            .join('');
    }
    updateComposerChipRow();
    updateAttachmentPreview();
}

/** Image chips toggle the in-composer preview; other files open in the editor. */
function activateComposerAttachment(id: string): void {
    const a = state.pendingAttachments.find((x) => x.id === id);
    if (!a) return;
    if (!a.isImage) {
        if (a.absolutePath) {
            vscode.postMessage({ type: 'openFile', filePath: a.absolutePath });
        }
        return;
    }
    previewedAttachmentId = previewedAttachmentId === id ? null : id;
    updateAttachmentPreview();
}

export function updateAttachmentPreview(): void {
    const box = document.getElementById('attachment-preview');
    if (!box) return;
    const a = previewedAttachmentId
        ? state.pendingAttachments.find((x) => x.id === previewedAttachmentId)
        : undefined;
    if (!a) {
        previewedAttachmentId = null;
    }
    document.querySelectorAll<HTMLElement>('#attachments-strip .attachment-chip').forEach((chip) => {
        const active = chip.dataset.id === previewedAttachmentId;
        chip.classList.toggle('attachment-chip--active', active);
        if (chip.hasAttribute('aria-pressed')) {
            chip.setAttribute('aria-pressed', String(active));
        }
    });
    if (!a) {
        box.hidden = true;
        box.replaceChildren();
        delete box.dataset.id;
        return;
    }
    if (box.dataset.id === a.id) return;
    box.dataset.id = a.id;
    box.hidden = false;
    const img = document.createElement('img');
    img.className = 'attachment-preview-img';
    img.alt = a.displayName;
    if (a.previewDataUrl) {
        img.src = a.previewDataUrl;
        box.replaceChildren(img);
        return;
    }
    const status = el('div', 'message-image-loading');
    box.replaceChildren(status);
    if (!a.absolutePath) {
        status.textContent = `无法预览: ${a.displayName}`;
        return;
    }
    status.textContent = '正在读取图片…';
    requestImagePreview(a.absolutePath).then(
        (dataUrl) => {
            if (box.dataset.id !== a.id) return;
            img.src = dataUrl;
            box.replaceChildren(img);
        },
        (err: unknown) => {
            if (box.dataset.id !== a.id) return;
            status.textContent = `无法加载图片: ${err instanceof Error ? err.message : '未知错误'}`;
        },
    );
}

export function updateEditorContextBar(): void {
    const bar = document.getElementById('editor-context-bar');
    if (!bar) return;
    const { context, enabled } = editorContext;
    if (!context) {
        bar.style.display = 'none';
        bar.innerHTML = '';
    } else {
        bar.style.display = '';
        bar.innerHTML = renderEditorContextChip(context, enabled, escHtml, escAttr);
    }
    updateComposerChipRow();
}

function updateComposerChipRow(): void {
    const row = document.getElementById('composer-chip-row');
    if (row) {
        row.hidden = !editorContext.context && state.pendingAttachments.length === 0;
    }
}
