import type { PendingAttachmentPreview } from '../shared/protocol';
import { formatLineRange, type EditorContextInfo } from '../shared/editorContext';

export const CHIP_FILE_ICON = `<svg class="chip-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z" stroke="currentColor" stroke-width="1.15"/><path d="M9 1.5V5.5H13" stroke="currentColor" stroke-width="1.15"/></svg>`;

export const CHIP_IMAGE_ICON = `<svg class="chip-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.15"/><circle cx="5.5" cy="6.5" r="1.25" fill="currentColor"/><path d="M3 12l3.5-3.5 2 2L11 8l2 2" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const CHIP_CLOSE_ICON = `<svg class="chip-svg chip-svg-close" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>`;

export const CHIP_EXPAND_ICON = `<svg class="chip-svg chip-svg-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const CHIP_EXTERNAL_ICON = `<svg class="chip-svg chip-svg-external" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 2h4v4M14 2L8 8M13 9.5V13a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1h3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const CHIP_EYE_ICON = `<svg class="chip-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2"/></svg>`;

const CHIP_EYE_OFF_ICON = `<svg class="chip-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;

function fileExtension(name: string): string {
    const i = name.lastIndexOf('.');
    if (i <= 0 || i === name.length - 1) {
        return '';
    }
    return name.slice(i + 1).toLowerCase();
}

/**
 * Compact composer chip shown beside the editor-context chip. Images preview on click
 * (see the composer preview panel in chat/composerChips.ts); other files open in the editor.
 */
export function renderComposerAttachmentChip(
    a: PendingAttachmentPreview,
    active: boolean,
    escHtml: (s: string) => string,
    escAttr: (s: string) => string,
): string {
    const kind = a.isImage ? 'image' : 'file';
    const clickable = a.isImage || Boolean(a.absolutePath);
    const title = a.isImage
        ? `Click to preview ${a.displayName}`
        : a.absolutePath
          ? `Open ${a.displayName}`
          : a.displayName;
    return `<div class="attachment-chip${clickable ? ' attachment-chip--openable' : ''}${active ? ' attachment-chip--active' : ''}" data-id="${escAttr(a.id)}" role="${clickable ? 'button' : 'group'}" tabindex="${clickable ? '0' : '-1'}"${a.isImage ? ` aria-pressed="${active}"` : ''} title="${escAttr(title)}">
        <span class="attachment-chip-glyph attachment-chip-glyph--${kind}">${a.isImage ? CHIP_IMAGE_ICON : CHIP_FILE_ICON}</span>
        <span class="attachment-name">${escHtml(a.displayName)}</span>
        <button type="button" class="attachment-remove" data-id="${escAttr(a.id)}" title="Remove" aria-label="Remove ${escAttr(a.displayName)}">${CHIP_CLOSE_ICON}</button>
    </div>`;
}

/** Composer chip for the active editor file/selection; clicking it toggles inclusion. */
export function renderEditorContextChip(
    context: EditorContextInfo,
    enabled: boolean,
    escHtml: (s: string) => string,
    escAttr: (s: string) => string,
): string {
    const name = context.displayPath.split(/[/\\]/).pop() || context.displayPath;
    const lines =
        context.startLine && context.endLine ? formatLineRange(context.startLine, context.endLine) : '';
    const target = lines ? `${context.displayPath} ${lines}` : context.displayPath;
    const title = enabled
        ? `Sent with your message: ${target}. Click to exclude.`
        : `Not sent: ${target}. Click to include.`;
    return `<button type="button" class="editor-context-chip${enabled ? '' : ' editor-context-chip--off'}" aria-pressed="${enabled}" title="${escAttr(title)}">
        <span class="editor-context-icon">${CHIP_FILE_ICON}</span>
        <span class="editor-context-name">${escHtml(name)}</span>
        ${lines ? `<span class="editor-context-lines">${escHtml(lines)}</span>` : ''}
        <span class="editor-context-toggle">${enabled ? CHIP_EYE_ICON : CHIP_EYE_OFF_ICON}</span>
    </button>`;
}

export function renderMessageAttachmentChip(
    displayName: string,
    filePath: string,
    isImage: boolean,
    escHtml: (s: string) => string,
    escAttr: (s: string) => string,
    lines?: { startLine: number; endLine: number },
): string {
    const ext = fileExtension(displayName);
    const extLabel = lines
        ? `<span class="attachment-ext attachment-ext--muted">${escHtml(formatLineRange(lines.startLine, lines.endLine))}</span>`
        : ext
          ? `<span class="attachment-ext">${escHtml(ext)}</span>`
          : `<span class="attachment-ext attachment-ext--muted">${isImage ? 'image' : 'file'}</span>`;
    const iconClass = isImage ? 'attachment-chip-icon--image' : 'attachment-chip-icon--file';
    const icon = isImage ? CHIP_IMAGE_ICON : CHIP_FILE_ICON;
    const chipClass = isImage
        ? 'message-attachment-chip message-attachment-chip--image'
        : 'message-attachment-chip';

    if (isImage) {
        return `<div class="${chipClass} attachment-chip--openable" data-filepath="${escAttr(filePath)}" data-is-image="true" role="button" tabindex="0" title="${escAttr(`点击在对话框展开/折叠图片: ${displayName}`)}">
        <span class="attachment-chip-icon ${iconClass}">${icon}</span>
        <span class="attachment-chip-text">
            <span class="message-attachment-name">${escHtml(displayName)}</span>
            ${extLabel}
        </span>
        <span class="attachment-preview-toggle" title="展开/收起预览">${CHIP_EXPAND_ICON}</span>
        <button type="button" class="attachment-open-external" data-filepath="${escAttr(filePath)}" title="在编辑器中打开原图" aria-label="Open in editor">${CHIP_EXTERNAL_ICON}</button>
    </div>`;
    }

    const lineAttrs = lines
        ? ` data-start-line="${lines.startLine}" data-end-line="${lines.endLine}"`
        : '';
    return `<div class="${chipClass} attachment-chip--openable" data-filepath="${escAttr(filePath)}"${lineAttrs} role="button" tabindex="0" title="${escAttr(`Open ${displayName}`)}">
        <span class="attachment-chip-icon ${iconClass}">${icon}</span>
        <span class="attachment-chip-text">
            <span class="message-attachment-name">${escHtml(displayName)}</span>
            ${extLabel}
        </span>
    </div>`;
}
