/**
 * Editor context: the file (and selected lines) open in the active VS Code editor,
 * appended to a prompt as an `<editor-context>` block so the user need not name them.
 */

/** Selected text beyond this many characters is cut; the model can read the file itself. */
const MAX_SELECTION_CHARS = 20_000;

const EDITOR_CONTEXT_BLOCK_RE =
    /<editor-context file="([^"]*)"(?: lines="(\d+)-(\d+)")?>[\s\S]*?<\/editor-context>\s*/gi;

/** Snapshot of the active editor shown in the composer (1-based, inclusive lines). */
export interface EditorContextInfo {
    filePath: string;
    /** Workspace-relative path for display; absolute when outside the workspace. */
    displayPath: string;
    startLine?: number;
    endLine?: number;
}

export interface EditorContextBlock {
    filePath: string;
    startLine?: number;
    endLine?: number;
}

export function formatLineRange(startLine: number, endLine: number): string {
    return startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
}

export function buildEditorContextFragment(
    filePath: string,
    selection?: { startLine: number; endLine: number; text: string },
): string {
    if (!selection) {
        return `<editor-context file="${filePath}"></editor-context>\n`;
    }
    const text =
        selection.text.length > MAX_SELECTION_CHARS
            ? `${selection.text.slice(0, MAX_SELECTION_CHARS)}\n[selection truncated]`
            : selection.text;
    return `<editor-context file="${filePath}" lines="${selection.startLine}-${selection.endLine}">\n${text}\n</editor-context>\n`;
}

/** Remove `<editor-context>` blocks from `rawText`, reporting each through `onBlock`. */
export function stripEditorContextBlocks(
    rawText: string,
    onBlock: (block: EditorContextBlock) => void,
): string {
    return rawText.replace(
        EDITOR_CONTEXT_BLOCK_RE,
        (_match, filePath: string, start?: string, end?: string) => {
            onBlock({
                filePath: filePath.trim(),
                startLine: start ? Number(start) : undefined,
                endLine: end ? Number(end) : undefined,
            });
            return '';
        },
    );
}
