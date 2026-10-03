/**
 * Pure helpers for the voice agent's own work (docs/voice-pair-agent-cursor.md §11-§13): where an edit goes in a file,
 * what of a terminal command's raw output the voice agent gets back, which output it asked for, and
 * whether a path stays inside a folder. No I/O.
 */

import * as path from 'node:path';

/** Where `oldText` sits in `text`, as character offsets; an error message when it cannot be placed. */
export function locateEdit(text: string, oldText: string, nearLine?: number): { start: number; end: number } | { error: string } {
    if (oldText === '') {
        return text === '' ? { start: 0, end: 0 } : { error: 'oldText is empty but the file is not: give the exact text to replace, or the line to insert after together with the new lines.' };
    }
    const starts: number[] = [];
    for (let at = text.indexOf(oldText); at >= 0; at = text.indexOf(oldText, at + 1)) {
        starts.push(at);
    }
    if (starts.length === 0) {
        return { error: 'oldText is not in the file (it must match exactly, whitespace included). Read the file again and copy the lines.' };
    }
    const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;
    if (starts.length > 1 && nearLine === undefined) {
        return { error: `oldText appears ${starts.length} times, at lines ${starts.map(lineOf).join(', ')}. Pass nearLine, or include more surrounding lines.` };
    }
    const start = nearLine === undefined ? starts[0] : starts.reduce((best, s) => (Math.abs(lineOf(s) - nearLine) < Math.abs(lineOf(best) - nearLine) ? s : best));
    return { start, end: start + oldText.length };
}

/** CSI / OSC escape sequences and lone ESC-letter pairs. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/**
 * Terminal output as a person reads it: escape sequences gone, a line rewritten with `\r` (a progress
 * bar) kept as its last state, and only the tail when it is long.
 */
export function cleanTerminalOutput(raw: string, maxLines = 60, maxChars = 4000): string {
    const lines = raw
        .replace(ESCAPES, '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.slice(line.lastIndexOf('\r') + 1).trimEnd());
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    let tail = lines.slice(-maxLines).join('\n');
    const omitted = lines.length > maxLines || tail.length > maxChars;
    if (tail.length > maxChars) {
        tail = tail.slice(-maxChars);
    }
    return omitted ? `…(earlier output omitted)\n${tail}` : tail;
}

/**
 * The one of `names` that `query` means: the one with that exact name (case aside), else the only
 * one containing it. An error message for none or several; `what` names the kind of thing in it.
 */
export function pickName(names: readonly string[], query: string, what: string): { name: string } | { error: string } {
    const q = query.trim().toLowerCase();
    const exact = names.find((name) => name.toLowerCase() === q);
    if (exact !== undefined) {
        return { name: exact };
    }
    const partial = names.filter((name) => name.toLowerCase().includes(q));
    if (partial.length === 1) {
        return { name: partial[0] };
    }
    return partial.length === 0
        ? { error: `No ${what} named ${query}. There is: ${names.join(', ') || 'nothing yet'}.` }
        : { error: `${query} could be ${partial.join(', ')}: say which.` };
}

/** Whether absolute `target` is `folder` or inside it; `..cache` is a name, `../cache` is not inside. */
export function insideFolder(folder: string, target: string): boolean {
    const relative = path.relative(folder, target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Where character `offset` of a document is after a change replaced `rangeLength` characters at
 * `rangeOffset` with `text` (a TextDocumentContentChangeEvent): before the change it stays, after it
 * it moves by the change's growth, and inside the replaced text it goes to the end of the new text.
 */
export function shiftOffset(offset: number, change: { rangeOffset: number; rangeLength: number; text: string }): number {
    if (offset <= change.rangeOffset) {
        return offset;
    }
    const end = change.rangeOffset + change.rangeLength;
    return offset >= end ? offset + change.text.length - change.rangeLength : change.rangeOffset + change.text.length;
}
