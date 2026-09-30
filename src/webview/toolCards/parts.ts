/**
 * DOM building blocks for tool cards (the `tv-` classes in styles/chat/toolCards.css).
 * Everything renders synchronously, so a card has its final height on insertion.
 */
import { el } from '../chat/helpers';
import type { Child, ToolResultPayload } from './types';
import { cleanOutput, clipLines, highlight, resultImagesOf, resultTextOf, shortenPath } from './util';

export type Tone = 'accent' | 'ok' | 'err' | 'warn';

/** `el` plus children; falsy and empty-string children are skipped. */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const node = el(tag, className);
    for (const child of children) {
        if (child) node.append(child);
    }
    return node;
}

/** Inline items separated by single spaces; falsy items are skipped. */
export function inline<K extends 'span' | 'div'>(tag: K, className: string | undefined, items: Child[]): HTMLElementTagNameMap[K] {
    const node = el(tag, className);
    for (const item of items) {
        if (!item) continue;
        if (node.childNodes.length > 0) node.append(' ');
        node.append(item);
    }
    return node;
}

export function badge(text: string, tone?: Tone): HTMLElement {
    return h('span', tone ? `tv-badge tv-badge--${tone}` : 'tv-badge', text);
}

/** Chip row; strings become plain badges. `null` when every item is empty. */
export function badges(items: Child[]): HTMLElement | null {
    const visible = items.filter((item): item is Node | string => !!item);
    if (visible.length === 0) return null;
    return h('span', 'tv-badges', ...visible.map((item) => (typeof item === 'string' ? badge(item) : item)));
}

/** File path with an optional `:from-to` range or `:sel` selector suffix. */
export function pathText(path: string, from?: number | null, to?: number | null, sel?: string | null): HTMLElement {
    let range = '';
    if (from != null || to != null) {
        const start = from ?? 1;
        range = to != null ? `:${start}-${to}` : `:${start}`;
    }
    return h(
        'span',
        'tv-path',
        shortenPath(path),
        range && h('span', 'tv-lines', range),
        sel && h('span', 'tv-lines', `:${sel}`),
    );
}

/** Key/value grid; rows with an empty value are dropped. `null` when none remain. */
export function kvGrid(rows: Array<[string, Child]>): HTMLElement | null {
    const grid = h('div', 'tv-kv');
    for (const [key, value] of rows) {
        if (value) grid.append(h('span', 'tv-kv-key', key), h('span', 'tv-kv-val', value));
    }
    return grid.childElementCount > 0 ? grid : null;
}

/** Labeled row inside a `.tv-list`. */
export function row(key: Child, ...children: Child[]): HTMLElement {
    return h('div', 'tv-row', key && h('span', 'tv-row-key', key), h('span', 'tv-row-val', ...children));
}

export function note(tone: 'err' | 'warn' | 'ok' | undefined, ...children: Child[]): HTMLElement | null {
    if (!children.some(Boolean)) return null;
    return h('div', tone ? `tv-note tv-note--${tone}` : 'tv-note', ...children);
}

/** Marker for an argument that arrived with the wrong JSON type. */
export function invalidArg(what = 'arg'): HTMLElement {
    return h('span', 'tv-err-text', `[invalid ${what}]`);
}

/**
 * Collapse `lines` to `maxLines` behind a "⋯ N more lines" / "collapse" toggle.
 * `paint` renders the visible lines into the block.
 */
function expandable(
    out: HTMLElement,
    lines: readonly string[],
    maxLines: number,
    paint: (visible: readonly string[]) => void,
): void {
    const { shown, hidden } = clipLines(lines, maxLines);
    paint(shown);
    if (hidden === 0) return;
    const more = `⋯ ${hidden} more lines`;
    const toggle = h('button', 'tv-expand', more);
    toggle.type = 'button';
    let expanded = false;
    toggle.addEventListener('click', () => {
        expanded = !expanded;
        paint(expanded ? lines : shown);
        toggle.textContent = expanded ? 'collapse' : more;
    });
    out.append(toggle);
}

export interface OutputOptions {
    /** Lines shown before collapsing. */
    maxLines?: number;
    /** highlight.js language; only applied when the page exposes hljs. */
    lang?: string | null;
    error?: boolean;
    /** `code`: no wrap, horizontal scroll. `plain`: soft-wrapped. */
    variant?: 'code' | 'plain';
    /** Uppercase mini-title above the block. */
    title?: string;
}

/** Expandable text block for command output, file previews, and search results. */
export function output(text: string, opts: OutputOptions = {}): HTMLElement {
    const { maxLines = 10, lang, error = false, variant = 'plain', title } = opts;
    let cls = 'tv-pre';
    if (variant === 'plain') cls += ' tv-pre--wrap';
    if (error) cls += ' tv-pre--error';
    const pre = h('pre', cls);
    const out = h('div', 'tv-out', title && h('div', 'tv-out-title', title), pre);
    expandable(out, cleanOutput(text).split('\n'), maxLines, (visible) => {
        const shown = visible.join('\n');
        const html = error ? null : highlight(shown, lang);
        if (html === null) pre.textContent = shown;
        else pre.innerHTML = html;
    });
    return out;
}

/** Source code: inset, no soft wrap. `null` for empty code. */
export function codeBlock(code: string, lang?: string | null, title?: string, maxLines = 14): HTMLElement | null {
    return code ? output(code, { lang, title, maxLines, variant: 'code' }) : null;
}

/** A result's text, styled as an error when the result is one. `null` when there is no text. */
export function resultText(result: ToolResultPayload | undefined, opts: OutputOptions = {}): HTMLElement | null {
    const text = resultTextOf(result).trim();
    if (!text) return null;
    const error = result?.isError === true;
    return output(text, {
        ...opts,
        error,
        lang: error ? null : opts.lang,
        variant: opts.variant ?? (opts.lang ? 'code' : 'plain'),
    });
}

/** Thumbnails of every image block in a result. */
export function resultImages(result: ToolResultPayload | undefined): HTMLElement | null {
    const images = resultImagesOf(result);
    if (images.length === 0) return null;
    return h(
        'div',
        'tv-imgs',
        ...images.map((img, i) => {
            const node = h('img', 'tv-img');
            node.src = `data:${img.mimeType};base64,${img.data}`;
            node.alt = `tool result ${i + 1}`;
            return node;
        }),
    );
}

/** Unified-diff-ish rows: `+` added, `-` removed, `@@` faint, blank rows as `…` gaps. */
export function diffBlock(diff: string, maxLines = 80): HTMLElement {
    const rows = h('div', 'tv-diff');
    const out = h('div', 'tv-out', rows);
    expandable(out, cleanOutput(diff).split('\n'), maxLines, (visible) => {
        rows.replaceChildren(
            ...visible.map((line) => {
                const blank = line.trim().length === 0;
                let cls = 'tv-diff-row';
                if (blank) cls += ' tv-diff-row--gap';
                else if (line.startsWith('+')) cls += ' tv-diff-row--add';
                else if (line.startsWith('-')) cls += ' tv-diff-row--del';
                else if (line.startsWith('@@')) cls += ' tv-diff-row--hunk';
                return h('div', cls, blank ? '…' : line);
            }),
        );
    });
    return out;
}
