/**
 * Pi's focus: where the voice agent points while it talks, and what it or the worker is reading or
 * writing right now. Shown in the editor by AgentCursor. Pure; no I/O.
 * Design: docs/voice-pair-agent-cursor.md §10.
 */

/** `pointing`: the voice agent talks about this code; `reading` / `writing`: a tool is looking at or changing it. */
export type FocusKind = 'pointing' | 'reading' | 'writing';

/** Lines are 1-based and inclusive; none means the whole file. */
export interface FocusTarget {
    path: string;
    startLine?: number;
    endLine?: number;
}

/** Selectors a read path may carry: `a.ts:50`, `a.ts:50-80`, `a.ts:50+30`; a list keeps its first range. */
const READ_SELECTOR = /^(.+?):(\d+)(?:([-+])(\d+))?(?:,[\d,+-]*)?$/;

/**
 * The file and lines a read tool call looks at, from its arguments: omp's `path` with an optional
 * line selector, or pi's `path` / `file_path` with `offset` and `limit`. Undefined for a call without a file.
 */
export function readTarget(args: unknown): FocusTarget | undefined {
    const a = (args ?? {}) as Record<string, unknown>;
    const raw = typeof a.path === 'string' ? a.path : typeof a.file_path === 'string' ? a.file_path : '';
    if (!raw || raw.includes('://')) {
        return undefined;
    }
    const selector = READ_SELECTOR.exec(raw);
    if (selector) {
        const start = Number(selector[2]);
        const n = selector[4] === undefined ? undefined : Number(selector[4]);
        const end = n === undefined ? start : selector[3] === '+' ? start + Math.max(n, 1) - 1 : n;
        return start >= 1 ? { path: selector[1], startLine: start, endLine: Math.max(start, end) } : { path: selector[1] };
    }
    const path = raw.replace(/:(raw|conflicts)$/, '');
    if (typeof a.offset === 'number' && a.offset >= 1) {
        const limit = typeof a.limit === 'number' && a.limit >= 1 ? a.limit : 1;
        return { path, startLine: a.offset, endLine: a.offset + limit - 1 };
    }
    return { path };
}

/** Files an edit or write tool call changes: `path` / `file_path`, or the `[path#tag]` section headers of an omp patch. */
export function editPaths(args: unknown): string[] {
    const a = (args ?? {}) as Record<string, unknown>;
    for (const key of ['path', 'file_path']) {
        const value = a[key];
        if (typeof value === 'string' && value) {
            return [value];
        }
    }
    if (typeof a.input !== 'string') {
        return [];
    }
    const paths = [...a.input.matchAll(/^\[([^#\]\n]+)#[^\]\n]*\]/gm)].map((m) => m[1].trim());
    return [...new Set(paths)];
}

/**
 * Lines of `after` that differ from `before`, 1-based: from the first changed line to the last.
 * A pure deletion points at the line after the cut; unchanged text gives undefined; a new file is all of it.
 */
export function changedLines(before: string | undefined, after: string): { startLine: number; endLine: number } | undefined {
    const next = after.split('\n');
    if (before === undefined) {
        return { startLine: 1, endLine: Math.max(1, next.length) };
    }
    if (before === after) {
        return undefined;
    }
    const prev = before.split('\n');
    let head = 0;
    while (head < prev.length && head < next.length && prev[head] === next[head]) {
        head++;
    }
    let tail = 0;
    while (tail < prev.length - head && tail < next.length - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) {
        tail++;
    }
    const last = next.length - tail;
    const start = Math.min(head + 1, next.length);
    return { startLine: start, endLine: Math.max(start, last) };
}

/** A name the model points at may sit this many lines off the ones it gave. */
const NAME_SLACK = 3;
const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

/**
 * Where `name` is written as a whole word on lines `startLine`-`endLine` (1-based), or failing that
 * on the nearest line within NAME_SLACK of them; the first occurrence on a line wins. `line` is
 * 1-based, `start` / `end` are character offsets in it. `lineText` is undefined past the file's end.
 */
export function findName(
    lineText: (line: number) => string | undefined,
    name: string,
    startLine: number,
    endLine: number,
): { line: number; start: number; end: number } | undefined {
    const inLine = (line: number) => {
        const text = lineText(line);
        for (let at = text?.indexOf(name) ?? -1; text !== undefined && at >= 0; at = text.indexOf(name, at + 1)) {
            const before = text[at - 1];
            const after = text[at + name.length];
            if (!(before && IDENTIFIER_CHAR.test(before)) && !(after && IDENTIFIER_CHAR.test(after))) {
                return { line, start: at, end: at + name.length };
            }
        }
        return undefined;
    };
    for (let line = startLine; line <= endLine; line++) {
        const found = inLine(line);
        if (found) {
            return found;
        }
    }
    for (let off = 1; off <= NAME_SLACK; off++) {
        const found = (startLine - off >= 1 ? inLine(startLine - off) : undefined) ?? inLine(endLine + off);
        if (found) {
            return found;
        }
    }
    return undefined;
}
