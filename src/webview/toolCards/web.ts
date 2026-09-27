/** `fetch` (reader-mode URL fetch) and `web_search` (answer plus sources). */
import { badge, badges, h, invalidArg, kvGrid, note, resultText, row } from './parts';
import type { ToolRenderer } from './types';
import { detailsRecord, isRecord, normalizeWs, num, plural, resultTextOf, str, strings, truncate } from './util';

export const fetchRenderer: ToolRenderer = {
    summary({ args, result }) {
        const url = str(args.url) ?? str(args.path);
        const method = (str(args.method) ?? '').toUpperCase();
        return [
            url ? h('span', 'tv-path', truncate(url, 90)) : invalidArg('url'),
            method && method !== 'GET' && badge(method, 'accent'),
            args.raw === true && badge('raw'),
            detailsRecord(result)?.truncated === true && badge('truncated', 'warn'),
        ];
    },

    body({ args, result }) {
        const url = str(args.url) ?? str(args.path);
        const method = (str(args.method) ?? '').toUpperCase();
        const timeout = num(args.timeout);
        const details = detailsRecord(result);
        const finalUrl = str(details?.finalUrl);
        const requestedUrl = str(details?.url);
        const notes = strings(details?.notes);
        return [
            kvGrid([
                ['url', url ?? invalidArg('url')],
                ['method', method && method !== 'GET' && badge(method, 'accent')],
                ['raw', args.raw === true && badge('raw')],
                ['timeout', timeout !== null && `${timeout}s`],
                ['final url', finalUrl && requestedUrl && finalUrl !== requestedUrl && finalUrl],
                ['content-type', str(details?.contentType)],
                ['via', str(details?.method)],
                ['notes', notes.join('; ')],
                ['truncated', details?.truncated === true && badge('output truncated', 'warn')],
            ]),
            resultText(result, { maxLines: 12, lang: 'markdown' }),
        ];
    },
};

function formatAge(seconds: number | null): string {
    if (seconds === null || seconds < 0) return '';
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m}m ago`;
    const hours = Math.floor(m / 60);
    if (hours < 24) return `${hours}h ago`;
    const d = Math.floor(hours / 24);
    return d < 365 ? `${d}d ago` : `${Math.floor(d / 365)}y ago`;
}

function sourceRow(source: Record<string, unknown>, index: number): HTMLElement {
    const url = str(source.url) ?? '';
    const title = str(source.title)?.trim() || url || 'Untitled';
    let domain = '';
    try {
        domain = url ? new URL(url).hostname.replace(/^www\./, '') : '';
    } catch {
        // Not a URL: no domain suffix.
    }
    const age = formatAge(num(source.ageSeconds)) || (str(source.publishedDate) ?? '');
    let link: HTMLElement | string = title;
    if (url) {
        const anchor = h('a', undefined, title);
        anchor.href = url;
        link = anchor;
    }
    return row(
        String(index + 1),
        link,
        domain && h('span', 'tv-faint', ` (${domain})`),
        age && h('span', 'tv-muted', ` · ${age}`),
    );
}

const AUTH_LABEL: Record<string, string> = { oauth: 'OAuth', api_key: 'API' };

export const webSearchRenderer: ToolRenderer = {
    summary({ args }) {
        const query = str(args.query);
        const recency = str(args.recency);
        return [
            query === null ? invalidArg('query') : h('span', 'tv-pattern', truncate(normalizeWs(query), 80)),
            recency && badge(recency),
        ];
    },

    body({ args, result }) {
        const query = str(args.query);
        const recency = str(args.recency);
        const limit = num(args.limit);
        const numResults = num(args.num_search_results);

        const details = detailsRecord(result);
        const response = isRecord(details?.response) ? details.response : null;
        const errorMsg = str(details?.error);
        const provider = str(response?.provider);
        const model = str(response?.model);
        const authMode = str(response?.authMode);
        const sources = Array.isArray(response?.sources) ? response.sources.filter(isRecord) : [];

        let providerInfo = model && provider ? `${model} @ ${provider}` : (model ?? provider ?? '');
        if (providerInfo && authMode) providerInfo += ` (${AUTH_LABEL[authMode] ?? authMode})`;

        const usage = isRecord(response?.usage) ? response.usage : null;
        const usageParts: string[] = [];
        for (const [key, label] of [['inputTokens', 'in'], ['outputTokens', 'out'], ['totalTokens', 'total'], ['searchRequests', 'search']]) {
            const value = num(usage?.[key]);
            if (value !== null) usageParts.push(`${label} ${value}`);
        }

        return [
            badges([
                recency && `recency=${recency}`,
                limit !== null && `limit=${limit}`,
                numResults !== null && `results=${numResults}`,
                response && plural(sources.length, 'source'),
            ]),
            kvGrid([
                ['query', query],
                ['provider', providerInfo],
                ['usage', usageParts.join(' · ')],
            ]),
            errorMsg && !resultTextOf(result) && note('err', errorMsg),
            resultText(result, { maxLines: 14, lang: 'markdown' }),
            sources.length > 0 && h('div', 'tv-list', ...sources.map(sourceRow)),
        ];
    },
};
