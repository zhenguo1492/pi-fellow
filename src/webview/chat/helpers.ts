export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

const HTML_TEXT_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '\u00a0': '&nbsp;',
};

/**
 * Escape text for HTML element content. Same output as serializing a Text node
 * (`textContent` → `innerHTML`): `&`, `<`, `>` and U+00A0 are escaped; quotes are left alone.
 */
export function escHtml(s: string): string {
    return s.replace(/[&<>\u00a0]/g, (ch) => HTML_TEXT_ESCAPES[ch]);
}

/** Escape text for a double-quoted HTML attribute value. */
export function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Local wall-clock time for an RPC timestamp given in seconds or milliseconds; `''` when absent. */
export function formatTimestamp(ts: number): string {
    if (!ts) return '';
    const d = new Date(ts < 1e12 ? ts * 1000 : ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '...';
}

/** Parsed JSON, or the input string unchanged when it is not valid JSON. */
export function tryParseJSON(s: string): any {
    try { return JSON.parse(s); } catch { return s; }
}
