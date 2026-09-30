import type { EditorContextInfo } from '../../shared/editorContext';
import { renderComposerAttachmentChip, renderEditorContextChip } from '../attachmentChipHtml';
import { vscode } from '../vscodeApi';
import { requestImagePreview } from './attachments';
import { el } from './helpers';
import { state } from './state';

/** Active editor file/selection pushed by the extension; shown as a toggle chip in the composer. */
let editorContext: { context: EditorContextInfo | null; enabled: boolean } = {
    context: null,
    enabled: true,
};
/** Pending image attachment whose preview is open above the input row. */
let previewedAttachmentId: string | null = null;
/** Refits the footer chips whenever the space between the model and permission buttons changes. */
let rowObserver: ResizeObserver | undefined;
let dismissBound = false;

const ROW_ID = 'composer-chips';
const MORE_ID = 'btn-chips-more';
const MENU_ID = 'composer-chips-menu';

/**
 * The footer between the model and permission buttons: the editor-context chip, then the pending
 * attachment chips. Chips that do not fit move, in order, into a popup behind a "+N" button.
 */
export const composerChipsHtml = `<div id="${ROW_ID}" class="composer-chips"></div>
            <button id="${MORE_ID}" class="composer-model-btn composer-chips-more" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="${MENU_ID}" hidden>
                <span class="composer-model-label"></span>
                <svg class="dropdown-chevron" width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 10.5l5-5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>`;

/** Popup (above the input box) holding the chips that do not fit in the footer. */
export function createComposerChipsMenu(): HTMLElement {
    const menu = el('div', 'composer-chips-menu');
    menu.id = MENU_ID;
    menu.hidden = true;
    return menu;
}

/** Stores the editor context pushed by the extension and re-renders its chip. */
export function setEditorContext(context: EditorContextInfo | null, enabled: boolean): void {
    editorContext = { context, enabled };
    updateComposerChips();
}

/** Attaches the chip listeners to the elements `render()` creates (footer row, overflow popup, image preview). */
export function bindComposerChips(): void {
    const preview = document.getElementById('attachment-preview');
    const row = document.getElementById(ROW_ID);
    const more = document.getElementById(MORE_ID);
    const menu = document.getElementById(MENU_ID);
    if (!preview || !row || !more || !menu) return;

    preview.addEventListener('click', () => {
        previewedAttachmentId = null;
        updateAttachmentPreview();
    });
    for (const container of [row, menu]) {
        container.addEventListener('click', onChipClick);
        container.addEventListener('keydown', onChipKeydown);
    }
    more.addEventListener('click', () => setMenuOpen(menu.hidden));
    menu.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setMenuOpen(false);
            more.focus();
        }
    });
    if (!dismissBound) {
        dismissBound = true;
        // The path, not `closest`: toggling the editor chip re-renders it, detaching the click target.
        // Closing the image preview leaves the popup as it is, so the next image is one click away.
        const keepOpen: Record<string, true> = { [MENU_ID]: true, [MORE_ID]: true, 'attachment-preview': true };
        document.addEventListener('click', (e) => {
            const inside = e.composedPath().some((n) => n instanceof HTMLElement && keepOpen[n.id] === true);
            if (!inside) {
                setMenuOpen(false);
            }
        });
    }
    rowObserver?.disconnect();
    rowObserver = new ResizeObserver(() => fitComposerChips());
    rowObserver.observe(row);
}

function onChipClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('.editor-context-chip')) {
        editorContext = { ...editorContext, enabled: !editorContext.enabled };
        updateComposerChips();
        vscode.postMessage({ type: 'setEditorContextEnabled', enabled: editorContext.enabled });
        return;
    }
    const remove = target.closest<HTMLElement>('.attachment-remove');
    if (remove?.dataset.id) {
        vscode.postMessage({ type: 'removeAttachment', id: remove.dataset.id });
        return;
    }
    const chip = target.closest<HTMLElement>('.attachment-chip');
    if (chip?.dataset.id) {
        activateComposerAttachment(chip.dataset.id);
    }
}

function onChipKeydown(e: KeyboardEvent): void {
    const chip = e.target as HTMLElement;
    if ((e.key === 'Enter' || e.key === ' ') && chip.classList.contains('attachment-chip') && chip.dataset.id) {
        e.preventDefault();
        activateComposerAttachment(chip.dataset.id);
    }
}

/** Re-renders the editor-context and attachment chips, then fits them into the footer. */
export function updateComposerChips(): void {
    const row = document.getElementById(ROW_ID);
    const menu = document.getElementById(MENU_ID);
    if (!row || !menu) return;
    const { context, enabled } = editorContext;
    row.innerHTML =
        (context ? renderEditorContextChip(context, enabled) : '') +
        state.pendingAttachments
            .map((a) => renderComposerAttachmentChip(a, a.id === previewedAttachmentId))
            .join('');
    menu.replaceChildren();
    fitComposerChips();
    updateAttachmentPreview();
}

/** Keeps the leading chips that fit in the footer row; the rest go, in order, into the popup. */
function fitComposerChips(): void {
    const row = document.getElementById(ROW_ID);
    const more = document.getElementById(MORE_ID);
    const menu = document.getElementById(MENU_ID);
    if (!row || !more || !menu) return;
    row.append(...Array.from(menu.children));
    more.hidden = true;
    if (row.scrollWidth <= row.clientWidth) {
        setMenuOpen(false);
        return;
    }
    // The button takes room from the row, so measure again with it shown.
    more.hidden = false;
    const overflow: Element[] = [];
    while (row.lastElementChild && row.scrollWidth > row.clientWidth) {
        overflow.unshift(row.lastElementChild);
        row.lastElementChild.remove();
    }
    menu.replaceChildren(...overflow);
    const label = more.querySelector('.composer-model-label');
    if (label) {
        label.textContent = `+${overflow.length}`;
    }
    more.title = `${overflow.length} more attachment${overflow.length === 1 ? '' : 's'}`;
}

function setMenuOpen(open: boolean): void {
    const menu = document.getElementById(MENU_ID);
    const more = document.getElementById(MORE_ID);
    if (!menu || !more) return;
    const next = open && !more.hidden;
    menu.hidden = !next;
    more.setAttribute('aria-expanded', String(next));
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

function updateAttachmentPreview(): void {
    const box = document.getElementById('attachment-preview');
    if (!box) return;
    const a = previewedAttachmentId
        ? state.pendingAttachments.find((x) => x.id === previewedAttachmentId)
        : undefined;
    if (!a) {
        previewedAttachmentId = null;
    }
    document
        .querySelectorAll<HTMLElement>(`#${ROW_ID} .attachment-chip, #${MENU_ID} .attachment-chip`)
        .forEach((chip) => {
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
