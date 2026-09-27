/** `ast_grep` (structural search) and `ast_edit` (structural rewrite). */
import { badge, badges, codeBlock, diffBlock, h, invalidArg, kvGrid, note, output, pathText, resultText, row } from './parts';
import type { Child, ToolRenderer } from './types';
import { detailsRecord, isRecord, languageFromPath, normalizeWs, num, plural, scopePaths, shortenPath, str, strings, truncate } from './util';

/** Comma-separated path chips. */
function pathList(paths: string[]): HTMLElement {
    const list = h('span');
    paths.forEach((p, i) => {
        if (i > 0) list.append(', ');
        list.append(pathText(p));
    });
    return list;
}

export const astGrepRenderer: ToolRenderer = {
    summary({ args }) {
        // `pat` is a string in the current schema, an array on the legacy wire.
        const patterns = typeof args.pat === 'string' ? [args.pat] : strings(args.pat);
        const paths = scopePaths(args);
        const lang = str(args.lang);
        return [
            h('span', 'tv-pattern', patterns.length > 0 ? truncate(normalizeWs(patterns[0]), 64) : '?'),
            patterns.length > 1 && h('span', 'tv-faint', `+${patterns.length - 1}`),
            paths.length > 0 && pathText(paths[0]),
            paths.length > 1 && h('span', 'tv-faint', `+${paths.length - 1}`),
            lang && badge(lang, 'accent'),
        ];
    },

    body({ args, result }) {
        const patterns = typeof args.pat === 'string' ? [args.pat] : strings(args.pat);
        const paths = scopePaths(args);
        const lang = str(args.lang);
        const glob = str(args.glob);
        const sel = str(args.sel);
        const skip = num(args.skip);

        const details = detailsRecord(result);
        const ok = result !== undefined && !result.isError;
        const matchCount = num(details?.matchCount);
        const fileCount = num(details?.fileCount);
        const filesSearched = num(details?.filesSearched);
        const scopePath = str(details?.scopePath);
        const parseErrors = strings(details?.parseErrors);
        const parseErrorsTotal = num(details?.parseErrorsTotal) ?? parseErrors.length;

        return [
            badges([
                lang && badge(lang, 'accent'),
                glob && `glob=${glob}`,
                sel && `sel=${sel}`,
                skip !== null && skip > 0 && `skip:${skip}`,
                ok && matchCount !== null && badge(plural(matchCount, 'match', 'matches'), matchCount === 0 ? 'warn' : 'ok'),
                ok && fileCount !== null && fileCount > 0 && plural(fileCount, 'file'),
                ok && filesSearched !== null && `searched ${filesSearched}`,
                ok && details?.limitReached === true && badge('limit reached', 'warn'),
            ]),
            ...(patterns.length === 0
                ? [invalidArg('pat')]
                : patterns.map((pat, i) => codeBlock(pat, lang, patterns.length > 1 ? `pattern ${i + 1}` : 'pattern', 12))),
            kvGrid([
                [paths.length === 1 ? 'path' : 'paths', paths.length > 0 && pathList(paths)],
                ['scope', scopePath && pathText(scopePath)],
            ]),
            parseErrors.length > 0 &&
                output(parseErrors.join('\n'), {
                    maxLines: 6,
                    title: parseErrorsTotal > parseErrors.length ? `parse issues (${parseErrorsTotal} total)` : 'parse issues',
                }),
            resultText(result, { maxLines: 12 }),
        ];
    },
};

interface AstEditDetails {
    totalReplacements: number | null;
    filesTouched: number | null;
    filesSearched: number | null;
    limitReached: boolean;
    scopePath: string | null;
    fileReplacements: Array<{ path: string; count: number | null }>;
    parseErrors: string[];
    parseErrorsTotal: number | null;
    displayContent: string | null;
}

function astEditDetails(d: Record<string, unknown> | null): AstEditDetails | null {
    if (!d) return null;
    const fileReplacements: AstEditDetails['fileReplacements'] = [];
    for (const fr of Array.isArray(d.fileReplacements) ? d.fileReplacements.filter(isRecord) : []) {
        const path = str(fr.path);
        if (path) fileReplacements.push({ path, count: num(fr.count) });
    }
    return {
        totalReplacements: num(d.totalReplacements),
        filesTouched: num(d.filesTouched),
        filesSearched: num(d.filesSearched),
        limitReached: d.limitReached === true,
        scopePath: str(d.scopePath),
        fileReplacements,
        parseErrors: strings(d.parseErrors),
        parseErrorsTotal: num(d.parseErrorsTotal),
        displayContent: str(d.displayContent),
    };
}

export const astEditRenderer: ToolRenderer = {
    summary({ args, result }) {
        const paths = strings(args.paths);
        const opCount = Array.isArray(args.ops) ? args.ops.length : 0;
        const details = astEditDetails(detailsRecord(result));
        return [
            paths.length > 0 ? pathText(paths[0]) : invalidArg('paths'),
            paths.length > 1 && h('span', 'tv-faint', `+${paths.length - 1} more`),
            badge(plural(opCount, 'op'), 'accent'),
            details?.totalReplacements != null &&
                badge(plural(details.totalReplacements, 'replacement'), details.totalReplacements > 0 ? 'ok' : 'warn'),
            details?.limitReached && badge('limit', 'warn'),
        ];
    },

    body({ args, result }) {
        const paths = strings(args.paths);
        const ops = Array.isArray(args.ops) ? args.ops.filter(isRecord) : [];
        const details = result?.isError ? null : astEditDetails(detailsRecord(result));
        const lang = paths.length > 0 ? languageFromPath(paths[0]) : null;
        const blocks: Child[] = [];
        if (paths.length > 1) blocks.push(h('div', 'tv-list', ...paths.map((p) => row(null, pathText(p)))));
        if (ops.length > 0) {
            blocks.push(
                h(
                    'div',
                    'tv-cells',
                    ...ops.map((op) => {
                        const pat = str(op.pat) ?? '';
                        const out = str(op.out) ?? '';
                        return h(
                            'div',
                            'tv-cell',
                            pat ? codeBlock(pat, lang, 'pattern', 10) : invalidArg('pattern'),
                            out ? codeBlock(out, lang, 'replacement', 10) : h('div', 'tv-muted', 'deletion — matched code is removed'),
                        );
                    }),
                ),
            );
        }
        if (details) {
            blocks.push(
                badges([
                    details.totalReplacements != null &&
                        badge(plural(details.totalReplacements, 'replacement'), details.totalReplacements > 0 ? 'ok' : 'warn'),
                    details.filesTouched != null && plural(details.filesTouched, 'file'),
                    details.filesSearched != null && `searched ${details.filesSearched}`,
                    details.scopePath && `in ${shortenPath(details.scopePath)}`,
                    details.limitReached && badge('limit reached', 'warn'),
                ]),
                details.fileReplacements.length > 0 &&
                    h(
                        'div',
                        'tv-list',
                        ...details.fileReplacements.map((fr) => row(fr.count != null && `×${fr.count}`, pathText(fr.path))),
                    ),
                details.limitReached && note('warn', 'limit reached; narrow path'),
                details.parseErrors.length > 0 &&
                    output(details.parseErrors.join('\n'), {
                        maxLines: 6,
                        title: `parse issues (${details.parseErrorsTotal ?? details.parseErrors.length})`,
                    }),
            );
        }
        blocks.push(details?.displayContent ? diffBlock(details.displayContent, 40) : resultText(result, { maxLines: 12 }));
        return blocks;
    },
};
