/**
 * Code anchors: markers the voice model writes in its reply to point at code while it talks.
 * `⟦path:12-20⟧` lines, `⟦path:12⟧` one line, `⟦path#symbol⟧` a symbol, `⟦path:12#name⟧` one name
 * on that line (a variable, parameter, field), `⟦path⟧` the file.
 * They are never shown or spoken: `AnchorStream` takes them out of the streamed reply.
 * Pure; no I/O.
 */

/**
 * Lines are 1-based and inclusive; neither lines nor symbol means the whole file. Lines with a
 * symbol: that name as written on those lines, not a declared symbol.
 */
export interface CodeAnchor {
    path: string;
    startLine?: number;
    endLine?: number;
    symbol?: string;
}

/** Streamed text, or an anchor at that point in it. */
export type ReplyPart = { text: string } | { anchor: CodeAnchor };

const OPEN = '⟦';
const CLOSE = '⟧';
/** A `⟦` whose `⟧` has not come after this many characters is not an anchor. */
const MAX_ANCHOR_CHARS = 300;
const LINES = /^(.+?):(\d+)(?:\s*-\s*(\d+))?$/;

/** `undefined` for a body that names no file. */
export function parseAnchor(body: string): CodeAnchor | undefined {
    const text = body.trim();
    const hash = text.lastIndexOf('#');
    const symbol = hash >= 0 ? text.slice(hash + 1).trim() : undefined;
    const where = hash >= 0 ? text.slice(0, hash).trim() : text;
    if (symbol === '') {
        return undefined;
    }
    const lines = LINES.exec(where);
    if (lines) {
        const a = Number(lines[2]);
        const b = lines[3] === undefined ? a : Number(lines[3]);
        const path = lines[1].trim();
        return a >= 1 && b >= 1 ? { path, startLine: Math.min(a, b), endLine: Math.max(a, b), ...(symbol ? { symbol } : {}) } : undefined;
    }
    if (!where) {
        return undefined;
    }
    return symbol ? { path: where, symbol } : { path: where };
}

/** The anchor as the model writes it, without the brackets: for logs. */
export function formatAnchor(anchor: CodeAnchor): string {
    const lines = anchor.startLine === undefined ? '' : anchor.endLine === anchor.startLine ? `:${anchor.startLine}` : `:${anchor.startLine}-${anchor.endLine}`;
    return `${anchor.path}${lines}${anchor.symbol ? `#${anchor.symbol}` : ''}`;
}

/**
 * Splits a streamed reply into text and anchors, in order. An anchor split across deltas is held
 * until it closes; a `⟦` that never becomes an anchor (a newline, another `⟦`, or no `⟧` in
 * MAX_ANCHOR_CHARS) passes through as text. Bodies naming no file are dropped.
 */
export class AnchorStream {
    private _held = '';

    push(delta: string): ReplyPart[] {
        const parts: ReplyPart[] = [];
        let buffer = this._held + delta;
        this._held = '';
        let text = '';
        while (buffer.length > 0) {
            const open = buffer.indexOf(OPEN);
            if (open < 0) {
                text += buffer;
                break;
            }
            text += buffer.slice(0, open);
            const rest = buffer.slice(open + 1);
            const end = rest.search(/[⟦⟧\n]/);
            if (end >= 0 && rest[end] === CLOSE && end <= MAX_ANCHOR_CHARS) {
                const anchor = parseAnchor(rest.slice(0, end));
                if (anchor) {
                    if (text) {
                        parts.push({ text });
                        text = '';
                    }
                    parts.push({ anchor });
                }
                buffer = rest.slice(end + 1);
            } else if (end < 0 && rest.length <= MAX_ANCHOR_CHARS) {
                // May still close in a later delta.
                this._held = buffer.slice(open);
                break;
            } else {
                text += OPEN;
                buffer = rest;
            }
        }
        if (text) {
            parts.push({ text });
        }
        return parts;
    }

    /** At the end of the reply: an anchor that never closed is dropped, not read out. */
    flush(): void {
        this._held = '';
    }
}
