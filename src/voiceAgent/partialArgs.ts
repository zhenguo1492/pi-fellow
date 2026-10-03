/**
 * A host tool call's arguments while the model is still writing them: the raw JSON streamed so far
 * (omp's and pi's `toolcall_delta` frames carry it piece by piece), read field by field.
 */

export interface PartialField {
    /** A string as far as it is written (escapes decoded); other values only once complete. */
    value: unknown;
    /** Its closing quote, or the delimiter after it, has arrived: the value is final. */
    complete: boolean;
}

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * The top-level fields of a JSON object streamed so far, in the order written. Reading stops at the
 * first field not yet readable: a key cut short, or a number, literal, array or object not yet closed.
 */
export function partialFields(json: string): Map<string, PartialField> {
    const fields = new Map<string, PartialField>();
    let i = skipSpace(json, 0);
    if (json[i] !== '{') {
        return fields;
    }
    i++;
    for (;;) {
        i = skipSpace(json, i);
        if (json[i] === ',') {
            i = skipSpace(json, i + 1);
        }
        if (json[i] !== '"') {
            return fields;
        }
        const key = readString(json, i);
        if (!key.complete) {
            return fields;
        }
        i = skipSpace(json, key.end);
        if (json[i] !== ':') {
            return fields;
        }
        i = skipSpace(json, i + 1);
        if (i >= json.length) {
            return fields;
        }
        if (json[i] === '"') {
            const value = readString(json, i);
            fields.set(key.text, { value: value.text, complete: value.complete });
            if (!value.complete) {
                return fields;
            }
            i = value.end;
            continue;
        }
        const end = json[i] === '{' || json[i] === '[' ? closingBracket(json, i) : tokenEnd(json, i);
        if (end === undefined) {
            return fields;
        }
        try {
            fields.set(key.text, { value: JSON.parse(json.slice(i, end)), complete: true });
        } catch {
            return fields;
        }
        i = end;
    }
}

function skipSpace(json: string, i: number): number {
    while (i < json.length && (json[i] === ' ' || json[i] === '\n' || json[i] === '\r' || json[i] === '\t')) {
        i++;
    }
    return i;
}

/**
 * The string starting at the quote `json[start]`, decoded as far as it goes. A partial escape at the
 * end is left out, and so is a high surrogate whose low half has not arrived yet.
 */
function readString(json: string, start: number): { text: string; complete: boolean; end: number } {
    let text = '';
    let i = start + 1;
    while (i < json.length) {
        const c = json[i];
        if (c === '"') {
            return { text, complete: true, end: i + 1 };
        }
        if (c !== '\\') {
            text += c;
            i++;
            continue;
        }
        const e = json[i + 1];
        if (e === undefined) {
            break;
        }
        if (e === 'u') {
            const hex = json.slice(i + 2, i + 6);
            if (hex.length < 4) {
                break;
            }
            text += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
        }
        text += ESCAPES[e] ?? e;
        i += 2;
    }
    const last = text.charCodeAt(text.length - 1);
    return { text: last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text, complete: false, end: json.length };
}

/** Where a number or literal starting at `start` ends; undefined while nothing after it shows it is whole. */
function tokenEnd(json: string, start: number): number | undefined {
    let i = start;
    while (i < json.length && /[-+.\w]/.test(json[i])) {
        i++;
    }
    return i > start && i < json.length ? i : undefined;
}

/** Just past the bracket that closes the one at `start`; undefined while it is still open. */
function closingBracket(json: string, start: number): number | undefined {
    let depth = 0;
    for (let i = start; i < json.length; i++) {
        const c = json[i];
        if (c === '"') {
            const s = readString(json, i);
            if (!s.complete) {
                return undefined;
            }
            i = s.end - 1;
        } else if (c === '{' || c === '[') {
            depth++;
        } else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0) {
                return i + 1;
            }
        }
    }
    return undefined;
}
