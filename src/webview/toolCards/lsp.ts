/** `lsp`: language-server queries; diagnostics and location lists parsed into rows. */
import { type Tone, badge, badges, h, invalidArg, kvGrid, output, pathText, resultText, row } from './parts';
import type { Child, ToolRenderer } from './types';
import { detailsRecord, normalizeWs, num, plural, resultTextOf, str, truncate } from './util';

/** `file:line:col [severity] message`, the tool's diagnostics line format. */
const DIAG_RE = /^(.*):(\d+):(\d+)\s+\[(\w+)\]\s*(.*)$/;
/** Bare `file:line:col` (references, definitions, implementations). */
const LOC_RE = /^(.+):(\d+):(\d+)$/;
/** Actions whose result text is a list of locations. */
const LOCATION_ACTIONS: Record<string, true> = { definition: true, references: true, type_definition: true, implementation: true };
const MAX_ROWS = 24;

export interface LspRow {
    file: string;
    line: string;
    col: string;
    /** Diagnostics only. */
    severity?: string;
    message?: string;
}

/** Result lines in the diagnostics (with severity and message) or bare location format. */
export function parseLspRows(text: string, kind: 'diagnostics' | 'locations'): LspRow[] {
    const rows: LspRow[] = [];
    for (const raw of text.split('\n')) {
        const m = raw.trim().match(kind === 'diagnostics' ? DIAG_RE : LOC_RE);
        if (!m) continue;
        rows.push(
            kind === 'diagnostics'
                ? { file: m[1], line: m[2], col: m[3], severity: m[4].toLowerCase(), message: normalizeWs(m[5]) }
                : { file: m[1], line: m[2], col: m[3] },
        );
    }
    return rows;
}

const SEVERITY_TONE: Record<string, Tone> = { error: 'err', warning: 'warn', info: 'accent' };

/** `N error(s)`-style counters in the tool's result text, as badges. */
function counter(text: string, re: RegExp, word: string, tone: Tone): HTMLElement | null {
    const m = text.match(re);
    return m ? badge(plural(Number(m[1]), word), tone) : null;
}

function rowList(rows: LspRow[]): HTMLElement {
    const shown = rows.slice(0, MAX_ROWS);
    return h(
        'div',
        'tv-list',
        ...shown.map((r) =>
            row(
                r.severity && badge(r.severity, SEVERITY_TONE[r.severity]),
                pathText(r.file, null, null, `${r.line}:${r.col}`),
                r.message && h('span', 'tv-muted', ` ${truncate(r.message, 160)}`),
            ),
        ),
        rows.length > shown.length && row(null, h('span', 'tv-faint', `… ${rows.length - shown.length} more`)),
    );
}

/** Kv value for an optional arg: hidden when absent, `[invalid k]` when mistyped. */
function argValue(k: string, raw: unknown, val: Child): Child {
    if (raw === undefined) return null;
    return val || invalidArg(k);
}

export const lspRenderer: ToolRenderer = {
    summary({ args }) {
        const action = str(args.action);
        const file = str(args.file);
        const line = num(args.line);
        const symbol = str(args.symbol);
        const query = str(args.query);
        const newName = str(args.new_name);
        return [
            badge(action ? action.replace(/_/g, ' ') : 'request', 'accent'),
            file === '*' && badge('workspace'),
            file && file !== '*' && pathText(file, line),
            !file && line != null && h('span', 'tv-faint', `line ${line}`),
            symbol && h('span', 'tv-pattern', truncate(normalizeWs(symbol), 48)),
            query && h('span', 'tv-muted', truncate(normalizeWs(query), 48)),
            newName && h('span', 'tv-muted', `→ ${truncate(normalizeWs(newName), 48)}`),
        ];
    },

    body({ args, result }) {
        const details = detailsRecord(result);
        const file = str(args.file);
        const line = num(args.line);
        const symbol = str(args.symbol);
        const query = str(args.query);
        const newName = str(args.new_name);
        const timeout = num(args.timeout);
        const payload = str(args.payload);
        const action = str(args.action) ?? str(details?.action);

        const text = result && !result.isError ? resultTextOf(result) : '';
        const diags = text ? parseLspRows(text, 'diagnostics') : [];
        const locs =
            diags.length === 0 && text && ((action !== null && LOCATION_ACTIONS[action]) || /\d+\s+reference\(s\)/.test(text))
                ? parseLspRows(text, 'locations')
                : [];

        let outcome: Child[];
        if (diags.length > 0) {
            outcome = [
                badges([
                    counter(text, /(\d+)\s+error\(s\)/, 'error', 'err'),
                    counter(text, /(\d+)\s+warning\(s\)/, 'warning', 'warn'),
                ]),
                rowList(diags),
            ];
        } else if (locs.length > 0) {
            outcome = [badges([counter(text, /(\d+)\s+reference\(s\)/, 'reference', 'accent')]), rowList(locs)];
        } else {
            outcome = [resultText(result, { maxLines: 12 })];
        }

        return [
            kvGrid([
                ['action', argValue('action', args.action, str(args.action)?.replace(/_/g, ' '))],
                ['file', argValue('file', args.file, file === '*' ? badge('workspace') : file && pathText(file, line))],
                ['line', !file && argValue('line', args.line, line !== null && String(line))],
                ['symbol', argValue('symbol', args.symbol, symbol && truncate(normalizeWs(symbol), 120))],
                ['query', argValue('query', args.query, query && truncate(normalizeWs(query), 120))],
                ['new name', argValue('new name', args.new_name, newName && truncate(normalizeWs(newName), 120))],
                ['apply', argValue('apply', args.apply, typeof args.apply === 'boolean' && (args.apply ? 'yes' : 'no'))],
                ['timeout', argValue('timeout', args.timeout, timeout !== null && `${timeout}s`)],
                ['payload', args.payload !== undefined && payload === null && invalidArg('payload')],
                ['server', str(details?.serverName)],
            ]),
            payload && output(payload, { lang: 'json', variant: 'code', maxLines: 8, title: 'payload' }),
            ...outcome,
        ];
    },
};
