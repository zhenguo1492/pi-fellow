export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

/** One formatter for every footer: `toLocaleTimeString` builds a new one per call, which dominates long rebuilds. */
const TIME_FORMAT = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Local wall-clock time for an RPC timestamp given in seconds or milliseconds; `''` when absent. */
export function formatTimestamp(ts: number): string {
    if (!ts) return '';
    return TIME_FORMAT.format(ts < 1e12 ? ts * 1000 : ts);
}

export function truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '...';
}

/** Parsed JSON, or the input string unchanged when it is not valid JSON. */
export function tryParseJSON(s: string): any {
    try { return JSON.parse(s); } catch { return s; }
}
