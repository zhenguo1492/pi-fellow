/** `read`: path + selector summary, file content, image thumbnails. */
import { badge, badges, kvGrid, pathText, resultImages, resultText } from './parts';
import type { ToolRenderer } from './types';
import { detailsRecord, isRecord, languageFromPath, num, plural, shortenPath, splitPathSel, str } from './util';

function readArgs(args: Record<string, unknown>): { path: string; sel: string | null; from: number | null; to: number | null } {
    const rawPath = str(args.path) ?? str(args.file_path) ?? '';
    const split = splitPathSel(rawPath);
    const offset = num(args.offset);
    const limit = num(args.limit);
    const from = offset !== null || limit !== null ? (offset ?? 1) : null;
    const to = from !== null && limit !== null ? from + limit - 1 : null;
    return { path: split.path || rawPath, sel: str(args.sel) ?? split.sel, from, to };
}

export const readRenderer: ToolRenderer = {
    summary({ args }) {
        const { path, sel, from, to } = readArgs(args);
        return [pathText(path || '…', from, to, sel)];
    },

    body({ args, result }) {
        const details = detailsRecord(result);
        const suffix = isRecord(details?.suffixResolution) ? details.suffixResolution : null;
        const summary = isRecord(details?.summary) ? details.summary : null;
        const resolved = str(suffix?.to) ?? str(details?.resolvedPath);
        const correctedFrom = str(suffix?.from);
        const elided = num(summary?.elidedSpans);
        const conflicts = num(details?.conflictCount);
        return [
            kvGrid([
                ['resolved', resolved !== null && pathText(resolved)],
                ['corrected from', correctedFrom !== null && shortenPath(correctedFrom)],
            ]),
            badges([
                conflicts !== null && conflicts > 0 && badge(plural(conflicts, 'conflict'), 'warn'),
                elided !== null && elided > 0 && plural(elided, 'elided span'),
                isRecord(details?.truncation) && badge('truncated', 'warn'),
            ]),
            resultImages(result),
            resultText(result, { maxLines: 12, lang: languageFromPath(readArgs(args).path), variant: 'code' }),
        ];
    },
};
