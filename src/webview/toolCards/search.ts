/** `grep` (legacy `search`), `glob` (pi and legacy `find`) and pi's `ls`: workspace search cards. */
import { badge, badges, h, inline, invalidArg, note, resultText } from './parts';
import type { Child, ToolRenderer } from './types';
import { detailsRecord, isRecord, num, plural, resultTextOf, scopePaths, shortenPath, str, strings, truncate } from './util';

/** Flag badges across current and legacy grep arg dialects. */
function grepFlags(args: Record<string, unknown>): string[] {
    const flags: string[] = [];
    const glob = str(args.glob);
    if (glob) flags.push(`glob=${glob}`);
    const type = str(args.type);
    if (type) flags.push(`type=${type}`);
    if (args.i === true) flags.push('i');
    if (args.multiline === true) flags.push('multiline');
    if (args.gitignore === false) flags.push('no-gitignore');
    const skip = num(args.skip);
    if (skip !== null && skip > 0) flags.push(`skip=${skip}`);
    return flags;
}

/** `/pattern/ in paths`, the grep summary and body headline. */
function grepLine(args: Record<string, unknown>): Child[] {
    const pattern = str(args.pattern);
    const paths = scopePaths(args).map(shortenPath);
    return [
        pattern === null ? invalidArg('pattern') : h('span', 'tv-pattern', `/${pattern}/`),
        h('span', 'tv-muted', 'in'),
        h('span', 'tv-path', (paths.length > 0 ? paths : ['.']).join(', ')),
    ];
}

export const grepRenderer: ToolRenderer = {
    summary({ args }) {
        return [...grepLine(args), badges(grepFlags(args))];
    },

    body({ args, result }) {
        const details = detailsRecord(result);
        const matchCount = num(details?.matchCount);
        const fileCount = num(details?.fileCount);
        const error = str(details?.error);
        const missing = strings(details?.missingPaths).map(shortenPath);
        const counts = grepFlags(args);
        if (matchCount !== null) counts.push(plural(matchCount, 'match', 'matches'));
        if (fileCount !== null) counts.push(plural(fileCount, 'file'));
        return [
            inline('div', undefined, [...grepLine(args), badges(counts), details?.truncated === true && badge('truncated', 'warn')]),
            missing.length > 0 && note('warn', `skipped missing: ${missing.join(', ')}`),
            error !== null && !resultTextOf(result).trim() && note('err', error),
            resultText(result, { maxLines: 14, variant: 'code' }),
        ];
    },
};

export const globRenderer: ToolRenderer = {
    summary({ args }) {
        const raw = args.path ?? args.paths;
        if (raw !== undefined && typeof raw !== 'string' && !Array.isArray(raw)) return [invalidArg('path')];
        const scope = scopePaths(args).map(shortenPath).join(', ');
        // pi's `find` takes the glob in `pattern` and the directory in `path`; omp's `glob` has the globs in `path`.
        const pattern = str(args.pattern);
        if (pattern !== null) {
            return [h('span', 'tv-pattern', truncate(pattern, 120)), h('span', 'tv-muted', 'in'), h('span', 'tv-path', scope || '.')];
        }
        return [h('span', 'tv-pattern', truncate(scope || '*', 120))];
    },

    body({ args, result }) {
        const details = detailsRecord(result);
        const limit = num(args.limit);
        const timeout = num(args.timeout);
        const fileCount = num(details?.fileCount);
        const resultLimit = num(details?.resultLimitReached);
        const scopePath = str(details?.scopePath);
        const error = str(details?.error);
        const meta = isRecord(details?.meta) ? details.meta : null;
        const limits = isRecord(meta?.limits) ? meta.limits : null;
        const truncated =
            Boolean(details?.truncated) ||
            resultLimit !== null ||
            isRecord(details?.truncation) ||
            isRecord(meta?.truncation) ||
            Boolean(limits?.resultLimit);
        const missing = strings(details?.missingPaths).map(shortenPath);
        return [
            badges([
                limit !== null && `limit ${limit}`,
                args.gitignore === false && 'no-gitignore',
                args.hidden === false && 'no-hidden',
                timeout !== null && `timeout ${timeout}s`,
                fileCount !== null && badge(plural(fileCount, 'file'), 'accent'),
                scopePath !== null && `in ${shortenPath(scopePath)}`,
                truncated && badge(resultLimit !== null ? `truncated at ${resultLimit}` : 'truncated', 'warn'),
            ]),
            missing.length > 0 && note('warn', `skipped missing: ${missing.join(', ')}`),
            error !== null && !result?.isError && note('err', error),
            resultText(result, { maxLines: 12 }),
        ];
    },
};

/** pi's `ls`: one directory's entries, `/` after directories. */
export const lsRenderer: ToolRenderer = {
    summary({ args }) {
        const path = args.path === undefined ? '.' : str(args.path);
        return [path === null ? invalidArg('path') : h('span', 'tv-path', shortenPath(path))];
    },

    body({ args, result }) {
        const details = detailsRecord(result);
        const limit = num(args.limit);
        const entryLimit = num(details?.entryLimitReached);
        return [
            badges([
                limit !== null && `limit ${limit}`,
                (entryLimit !== null || isRecord(details?.truncation)) &&
                    badge(entryLimit !== null ? `truncated at ${entryLimit}` : 'truncated', 'warn'),
            ]),
            resultText(result, { maxLines: 12 }),
        ];
    },
};
