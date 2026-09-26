import * as vscode from 'vscode';
import { selectedLineRange } from '../utils/fileEditor';
import type { EditorSnapshot } from './voicePrompt';

/** Selected lines shown to the voice agent; it reads the file for more. */
const MAX_LINES = 80;
/** Longer lines are cut: minified code would otherwise fill the message. */
const MAX_LINE_CHARS = 300;

/** What the voice agent sees of `editor` (design §5.10): place, cursor, visible lines, and the selected code. */
export function editorSnapshot(editor: vscode.TextEditor): EditorSnapshot {
    const { document, selection, visibleRanges } = editor;
    const selected = selectedLineRange(selection);
    const cursorLine = selection.active.line + 1;
    const first = selected?.startLine ?? cursorLine;
    const last = selected ? Math.min(selected.endLine, first + MAX_LINES - 1) : cursorLine;
    const lines: EditorSnapshot['lines'] = [];
    for (let line = first; line <= last; line++) {
        const text = document.lineAt(line - 1).text;
        lines.push({ line, text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text });
    }
    const top = visibleRanges[0];
    const bottom = visibleRanges[visibleRanges.length - 1];
    return {
        path: vscode.workspace.asRelativePath(document.uri, false),
        language: document.languageId,
        cursorLine,
        visible: top && bottom ? { startLine: top.start.line + 1, endLine: bottom.end.line + 1 } : undefined,
        selection: selected,
        lines,
        omittedLines: selected ? selected.endLine - last : 0,
        unsaved: document.isDirty,
    };
}
