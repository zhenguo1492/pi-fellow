/** Pure helpers shared by tool-card renderers; no DOM. */
import type { ToolResultPayload } from './types';

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** String passthrough; anything else → null. */
export function str(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

export function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Display string for any JSON value (`''` for null/undefined). */
export function display(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return String(value);
    }
}

/** `/home/<user>/x` or `/Users/<user>/x` → `~/x`. */
export function shortenPath(p: string): string {
    for (const prefix of ['/Users/', '/home/']) {
        if (p.startsWith(prefix)) {
            const rest = p.slice(prefix.length);
            const slash = rest.indexOf('/');
            return slash < 0 ? '~' : `~${rest.slice(slash)}`;
        }
    }
    return p;
}

/** Search scope from `path` (string, JSON-encoded array, or array), else legacy `paths`. */
export function scopePaths(args: Record<string, unknown>): string[] {
    const raw = args.path ?? args.paths;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed: unknown = JSON.parse(trimmed);
                if (Array.isArray(parsed) && parsed.every((p): p is string => typeof p === 'string')) return parsed;
            } catch {
                // Not JSON: the whole string is one path.
            }
        }
        return [raw];
    }
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
}

export function truncate(s: string, maxLen = 100): string {
    return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
}

/** Collapse whitespace runs (one-line summaries). */
export function normalizeWs(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

// CSI and OSC escape sequences.
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/** Terminal output → display text: ANSI stripped, tabs widened, trailing newlines dropped. */
export function cleanOutput(s: string): string {
    return s.replace(ANSI_RE, '').replace(/\t/g, '   ').replace(/\n+$/, '');
}

/**
 * Lines an output block shows collapsed. A block only collapses when that
 * hides at least two lines; "⋯ 1 more line" would cost as much as the line.
 */
export function clipLines(lines: readonly string[], maxLines: number): { shown: readonly string[]; hidden: number } {
    if (lines.length <= maxLines + 1) return { shown: lines, hidden: 0 };
    return { shown: lines.slice(0, maxLines), hidden: lines.length - maxLines };
}

export function plural(n: number, word: string, many = `${word}s`): string {
    return `${n} ${n === 1 ? word : many}`;
}

const EXT_TO_LANG: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', sql: 'sql',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', jsonc: 'json', json5: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
    xml: 'xml', svg: 'xml', md: 'markdown', mdx: 'markdown',
    lua: 'lua', zig: 'zig', diff: 'diff', patch: 'diff',
};

export function languageFromPath(filePath: string): string | null {
    const base = filePath.split('/').pop() ?? '';
    if (/^dockerfile$/i.test(base)) return 'dockerfile';
    return EXT_TO_LANG[base.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

/** Joined text blocks of a result (`''` when absent). */
export function resultTextOf(result: ToolResultPayload | undefined): string {
    if (!result) return '';
    const parts: string[] = [];
    for (const block of result.content) {
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
}

export interface ResultImage {
    data: string;
    mimeType: string;
}

export function resultImagesOf(result: ToolResultPayload | undefined): ResultImage[] {
    const images: ResultImage[] = [];
    for (const block of result?.content ?? []) {
        if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
            images.push({ data: block.data, mimeType: block.mimeType });
        }
    }
    return images;
}

/** `result.details` when it is a plain object. */
export function detailsRecord(result: ToolResultPayload | undefined): Record<string, unknown> | null {
    return result && isRecord(result.details) ? result.details : null;
}

/** Strings of an array-valued field, non-strings dropped. */
export function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** One-line JSON digest of args (generic summary). */
export function argsDigest(args: Record<string, unknown>, maxLen = 96): string {
    return Object.keys(args).length === 0 ? '' : truncate(normalizeWs(display(args)), maxLen);
}

/** A trailing `:chunk` that reads as an omp read selector: line ranges, `raw`, `conflicts`. */
const READ_SEL_CHUNK = /^(raw|conflicts|\d+(?:[-+]\d*)?(?:,\d+(?:[-+]\d*)?)*)$/i;

/** Split a `path:sel` read argument (up to two chunks, e.g. `a.ts:50-100:raw`). */
export function splitPathSel(rawPath: string): { path: string; sel: string | null } {
    let path = rawPath;
    const chunks: string[] = [];
    for (let i = 0; i < 2; i++) {
        const idx = path.lastIndexOf(':');
        if (idx <= 0 || !READ_SEL_CHUNK.test(path.slice(idx + 1))) break;
        chunks.unshift(path.slice(idx + 1));
        path = path.slice(0, idx);
    }
    return { path, sel: chunks.length > 0 ? chunks.join(':') : null };
}

declare global {
    /** highlight.js, when the host page ships it (the chat webview does not). */
    var hljs:
        | {
              getLanguage(name: string): unknown;
              highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
          }
        | undefined;
}

/** Highlighted HTML when the page exposes highlight.js; `null` → render plain text. */
export function highlight(code: string, lang: string | null | undefined): string | null {
    const hljs = globalThis.hljs;
    if (!lang || typeof hljs?.highlight !== 'function') return null;
    try {
        return hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : null;
    } catch {
        return null;
    }
}
