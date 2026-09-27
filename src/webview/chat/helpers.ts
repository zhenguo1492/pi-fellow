export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
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
