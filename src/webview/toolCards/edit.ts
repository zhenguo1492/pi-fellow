/** `edit` / `apply_patch`: patch application rendered as colored diffs. */
import { badge, diffBlock, h, invalidArg, kvGrid, note, output, pathText, resultText } from './parts';
import type { Child, ToolRenderer } from './types';
import { detailsRecord, isRecord, normalizeWs, num, str, strings, truncate } from './util';

/** Path of a hashline `[path#TAG]` / `[path]` header line, or null. */
function headerPath(line: string): string | null {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
    let body = trimmed.slice(1, -1).trim();
    const hash = /#[0-9a-fA-F]{4}$/.exec(body);
    if (hash) body = body.slice(0, hash.index);
    const first = body[0];
    if (body.length >= 2 && (first === '"' || first === "'") && first === body[body.length - 1]) {
        body = body.slice(1, -1);
    }
    return body.length > 0 ? body : null;
}

const APPLY_PATCH_HEADER = /^\*{3} (?:Update|Add|Delete) File:\s*(.+)$/;
const OP_HEADER = /^(?:replace|insert|delete)\b/;

/** File paths named by hashline or apply_patch section headers, in order. */
export function patchInputPaths(input: string): string[] {
    const paths: string[] = [];
    for (const rawLine of input.replace(/^\uFEFF/, '').split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        const fromHashline = headerPath(line);
        const fromApplyPatch = fromHashline ? null : APPLY_PATCH_HEADER.exec(line.trim());
        if (fromHashline) paths.push(fromHashline);
        else if (fromApplyPatch) paths.push(fromApplyPatch[1].trim());
    }
    return paths;
}

/** Added/removed line counts of a unified diff. */
export function diffStats(diff: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
    }
    return { added, removed };
}

/** One file's outcome; top-level `details` and `perFileResults[i]` share this shape. */
interface FileEntry {
    path: string | null;
    diff: string | null;
    firstChangedLine: number | null;
    op: string | null;
    move: string | null;
    isError: boolean;
    errorText: string | null;
    diagnostics: { summary: string | null; messages: string[]; errored: boolean } | null;
}

function fileEntry(d: Record<string, unknown>): FileEntry {
    const diag = isRecord(d.diagnostics) ? d.diagnostics : null;
    return {
        path: str(d.path),
        diff: str(d.diff),
        firstChangedLine: num(d.firstChangedLine),
        op: str(d.op),
        move: str(d.move),
        isError: d.isError === true,
        errorText: str(d.displayErrorText) ?? str(d.errorText),
        diagnostics: diag
            ? { summary: str(diag.summary), messages: strings(diag.messages), errored: diag.errored === true }
            : null,
    };
}

function fileSection(entry: FileEntry, fallbackPath: string | null = null): HTMLElement {
    const path = entry.path ?? fallbackPath;
    const op = entry.op === 'create' || entry.op === 'delete' ? entry.op : null;
    const diag = entry.diagnostics;
    const heading: Child[] = [];
    if (path !== null) heading.push(pathText(path, entry.isError ? null : entry.firstChangedLine));
    if (entry.move !== null) heading.push(' → ', pathText(entry.move));
    if (op !== null) heading.push(' ', badge(op, op === 'delete' ? 'err' : 'ok'));
    if (entry.isError) heading.push(' ', badge('failed', 'err'));

    let outcome: Child = null;
    if (entry.isError) {
        if (entry.errorText !== null) outcome = output(entry.errorText, { error: true, maxLines: 10 });
    } else if (entry.diff) {
        outcome = diffBlock(entry.diff, 40);
    }
    return h(
        'div',
        undefined,
        heading.length > 0 && h('div', 'tv-row', h('span', 'tv-row-val', ...heading)),
        outcome,
        diag?.summary && note(diag.errored ? 'err' : 'warn', diag.summary),
        diag !== null && diag.messages.length > 0 && output(diag.messages.join('\n'), { maxLines: 6 }),
    );
}

export const editRenderer: ToolRenderer = {
    summary({ args, result }) {
        const input = str(args.input) ?? str(args._input);
        const paths = input ? patchInputPaths(input) : [];
        const argPath = str(args.file_path) ?? str(args.path);
        if (paths.length === 0 && argPath) paths.push(argPath);
        if (paths.length === 0 && Array.isArray(args.edits)) {
            for (const e of args.edits) {
                const p = isRecord(e) ? str(e.path) : null;
                if (p && !paths.includes(p)) paths.push(p);
            }
        }
        let opCount = 0;
        for (const line of input?.split('\n') ?? []) if (OP_HEADER.test(line)) opCount++;
        const details = detailsRecord(result);
        const diff = result?.isError !== true ? str(details?.diff) : null;
        const stats = diff ? diffStats(diff) : null;
        return [
            paths.length > 0
                ? pathText(paths[0])
                : h('span', undefined, truncate(normalizeWs(input?.split('\n', 1)[0] ?? ''), 80)),
            paths.length > 1 && badge(`+${paths.length - 1} more`),
            opCount > 0 && badge(`${opCount} op${opCount === 1 ? '' : 's'}`),
            stats !== null && stats.added > 0 && badge(`+${stats.added}`, 'ok'),
            stats !== null && stats.removed > 0 && badge(`−${stats.removed}`, 'err'),
            result?.isError === true && badge('failed', 'err'),
        ];
    },

    body({ args, result }) {
        const input = str(args.input) ?? str(args._input);
        const details = detailsRecord(result);
        const perFile = Array.isArray(details?.perFileResults) ? details.perFileResults.filter(isRecord).map(fileEntry) : [];
        const fallbackPath = str(args.file_path) ?? str(args.path) ?? (input ? (patchInputPaths(input)[0] ?? null) : null);

        const blocks: Child[] = [];
        if (perFile.length > 0) {
            blocks.push(...perFile.map((entry) => fileSection(entry)));
        } else if (result?.isError === true) {
            // Failed matches embed numbered file context; keep a generous window.
            blocks.push(resultText(result, { maxLines: 15 }));
        } else {
            const top = details ? fileEntry(details) : null;
            blocks.push(
                top && (top.diff !== null || top.diagnostics !== null || top.move !== null)
                    ? fileSection(top, fallbackPath)
                    : resultText(result, { maxLines: 8 }),
            );
        }

        // Hashline edit ops; pi's `{oldText, newText}` edits carry no op and are shown by the diff.
        const ops = Array.isArray(args.edits) ? args.edits.filter(isRecord).filter((e) => str(e.op) !== null) : [];
        blocks.push(
            kvGrid(ops.map((e) => [str(e.op) ?? 'edit', str(e.sel) ?? str(e.path) ?? str(e.rename) ?? str(e.move) ?? '?'])),
        );
        if (input) blocks.push(output(input, { variant: 'code', maxLines: 10, title: 'input' }));
        else if (input === null && (args.input !== undefined || args._input !== undefined)) blocks.push(invalidArg('input'));
        return blocks;
    },
};
