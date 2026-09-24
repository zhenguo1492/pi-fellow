import { stripEditorContextBlocks } from './editorContext';

/** Strip Pi `<file>` blocks from user messages for chat UI (content still went to the model). */
const FILE_BLOCK_RE = /<file name="([^"]*)">[\s\S]*?<\/file>\s*/gi;

export interface DisplayFileAttachment {
    displayName: string;
    path: string;
    /** Editor-context selection (1-based, inclusive). */
    startLine?: number;
    endLine?: number;
}

const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;

export function isImageFilePath(filePath: string): boolean {
    return IMAGE_PATH_RE.test(filePath.trim());
}

export function parseUserMessageForDisplay(rawText: string): {
    displayText: string;
    fileAttachments: DisplayFileAttachment[];
} {
    const found: Omit<DisplayFileAttachment, 'displayName'>[] = [];
    const withoutFiles = rawText.replace(FILE_BLOCK_RE, (_match, filePath: string) => {
        found.push({ path: filePath.trim() });
        return '';
    });
    const displayText = stripEditorContextBlocks(withoutFiles, ({ filePath, startLine, endLine }) => {
        found.push({ path: filePath, startLine, endLine });
    })
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const fileAttachments: DisplayFileAttachment[] = found.map((f) => ({
        ...f,
        displayName: f.path.split(/[/\\]/).pop() || f.path,
    }));

    const text =
        displayText === 'See attached files.' && fileAttachments.length > 0 ? '' : displayText;

    return { displayText: text, fileAttachments };
}
