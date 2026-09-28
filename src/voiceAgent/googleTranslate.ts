/**
 * Alt+right-click on a sentence (Bot view or chat): text into the language the user picked
 * (`voiceAgent.translateTo`) through Google's free translate endpoint, ported from echo-read-edge's
 * GoogleTranslationProvider. Runs in the extension host (the webview's CSP allows no requests).
 * Code is never sent for translation: inline code and fenced blocks are swapped for numbered
 * placeholders that Google keeps as they are, and put back.
 */
import { CODE_SPAN, messagePlainText } from '../shared/voiceMessageText';

const TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';

/**
 * The public "gtx" client shares one quota bucket with every scraper on the internet, so Google's
 * abuse system answers it with a network-wide 429 that no amount of client-side pacing can lift.
 * Chrome's own dictionary client id is served from a separate bucket and answers normally.
 */
const TRANSLATE_CLIENT = 'dict-chrome-ex';
const REQUEST_TIMEOUT_MS = 20_000;
/** Google rejects longer `q`; longer text goes in pieces cut at line ends. */
const MAX_REQUEST_CHARS = 4500;

export class TranslationError extends Error {
    readonly status?: number;
    readonly retryAfterMs?: number;

    constructor(message: string, options: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
        super(message, { cause: options.cause });
        this.name = 'TranslationError';
        this.status = options.status;
        this.retryAfterMs = options.retryAfterMs;
    }
}

/** One sentence as Google split and translated it: `payload[0][i]` is `[translated, source, …]`. */
export interface TranslationSegment {
    translated: string;
    source: string;
}

export interface GoogleTranslation {
    translation: string;
    detectedLanguage?: string;
    segments?: TranslationSegment[];
}

/** One request: `text` from `source` (default: detect it) into `target`, the language Google detected, and its sentences. */
export async function googleTranslate(text: string, target: string, signal: AbortSignal, source = 'auto'): Promise<GoogleTranslation> {
    const parameters = new URLSearchParams({ client: TRANSLATE_CLIENT, sl: source, tl: target, dt: 't', ie: 'UTF-8', oe: 'UTF-8' });
    let response: Response;
    try {
        response = await fetch(`${TRANSLATE_URL}?${parameters.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ q: text }).toString(),
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
        throw new TranslationError('Google Translate could not be reached.', { cause: error });
    }
    if (!response.ok) {
        throw new TranslationError(
            response.status === 429 ? 'Google Translate is limiting requests (HTTP 429).' : `Translation failed with HTTP ${response.status}.`,
            { status: response.status, retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')) },
        );
    }
    const payload: unknown = await response.json();
    const translation = parseTranslation(payload);
    if (!translation) {
        throw new TranslationError('The translation response was empty.');
    }
    return { translation, detectedLanguage: parseDetectedLanguage(payload), segments: parseSegments(payload) };
}

/** Extracts only the translated strings from the undocumented nested response: `payload[0][*][0]`. */
export function parseTranslation(payload: unknown): string | null {
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
        return null;
    }
    const parts = payload[0]
        .filter((item): item is unknown[] => Array.isArray(item))
        .map((item) => item[0])
        .filter((value): value is string => typeof value === 'string');
    const translation = parts.join('').trim();
    return translation || null;
}

/** The sentences of the response with both their translation and their source. */
export function parseSegments(payload: unknown): TranslationSegment[] {
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
        return [];
    }
    return payload[0].flatMap((item: unknown) =>
        Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string' ? [{ translated: item[0], source: item[1] }] : [],
    );
}

/** The detected source language, `payload[2]` (`en`, `zh-CN`, …). */
export function parseDetectedLanguage(payload: unknown): string | undefined {
    return Array.isArray(payload) && typeof payload[2] === 'string' ? payload[2] : undefined;
}

/** Reads the delay-seconds or HTTP-date forms Retry-After is allowed to take. */
export function parseRetryAfter(header: string | null): number | undefined {
    if (!header) {
        return undefined;
    }
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds) * 1_000;
    }
    const deadline = Date.parse(header);
    return Number.isNaN(deadline) ? undefined : Math.max(0, deadline - Date.now());
}

const PLACEHOLDER = /⟪\s*(\d+)\s*⟫/g;

/** Code spans swapped for `⟪n⟫`, which Google keeps as written (checked against the live service). */
export function maskCode(text: string): { masked: string; code: string[] } {
    const code: string[] = [];
    const masked = text.replace(CODE_SPAN, (span) => `⟪${code.push(span) - 1}⟫`);
    return { masked, code };
}

/** The code put back; undefined unless every placeholder came back exactly once. */
export function unmaskCode(translated: string, code: string[]): string | undefined {
    const seen = new Set<number>();
    let intact = true;
    const text = translated.replace(PLACEHOLDER, (placeholder, n: string) => {
        const i = Number(n);
        if (i >= code.length || seen.has(i)) {
            intact = false;
            return placeholder;
        }
        seen.add(i);
        return code[i];
    });
    return intact && seen.size === code.length ? text : undefined;
}

/** `text` in pieces of at most `max` characters, cut at line ends where it can be. */
function requestPieces(text: string, max: number): string[] {
    const pieces: string[] = [];
    let piece = '';
    for (const line of text.split('\n')) {
        const joined = piece ? `${piece}\n${line}` : line;
        if (joined.length <= max) {
            piece = joined;
            continue;
        }
        if (piece) {
            pieces.push(piece);
        }
        let rest = line;
        while (rest.length > max) {
            pieces.push(rest.slice(0, max));
            rest = rest.slice(max);
        }
        piece = rest;
    }
    return piece ? [...pieces, piece] : pieces;
}

export type Translation = { text: string } | { alreadyInTarget: true };

/**
 * Written in `target` already, by the language Google detected: the same language, and for a code
 * with a region (`zh-CN`, `zh-TW`) the same region too, since Google converts between those.
 */
function isTarget(detected: string | undefined, target: string): boolean {
    const [lang, region] = target.toLowerCase().split('-');
    const [detectedLang, detectedRegion] = (detected ?? '').toLowerCase().split('-');
    return detectedLang === lang && (region === undefined || detectedRegion === region);
}

/**
 * Text into a language by its Google code. After a 429 it asks nothing until Google's Retry-After
 * (else a minute) has passed, failing at once instead.
 */
export class Translator {
    private _retryAt = 0;

    constructor(private readonly _translate: typeof googleTranslate = googleTranslate) {}

    async translate(message: string, target: string, signal: AbortSignal): Promise<Translation> {
        const wait = this._retryAt - Date.now();
        if (wait > 0) {
            throw new TranslationError(`Google Translate is limiting requests; try again in ${Math.ceil(wait / 1000)} s.`, { status: 429 });
        }
        try {
            return await this._translateMessage(messagePlainText(message), target, signal);
        } catch (err) {
            if (err instanceof TranslationError && err.status === 429) {
                this._retryAt = Date.now() + (err.retryAfterMs ?? 60_000);
            }
            throw err;
        }
    }

    private async _translateMessage(text: string, target: string, signal: AbortSignal): Promise<Translation> {
        const { masked, code } = maskCode(text);
        if (!/\p{L}/u.test(masked.replace(PLACEHOLDER, ''))) {
            return { text }; // only code, numbers and punctuation: nothing to translate
        }
        const whole = await this._translatePieces(masked, target, signal);
        if (whole.alreadyInTarget) {
            return { alreadyInTarget: true };
        }
        const restored = unmaskCode(whole.text, code);
        if (restored !== undefined) {
            return { text: restored };
        }
        // A placeholder came back changed: translate the prose between the code spans one by one.
        const parts = masked.split(PLACEHOLDER);
        const out: string[] = [];
        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 1) {
                out.push(code[Number(parts[i])]);
                continue;
            }
            const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(parts[i])!;
            out.push(lead, /\p{L}/u.test(core) ? (await this._translatePieces(core, target, signal)).text : core, trail);
        }
        return { text: out.join('') };
    }

    private async _translatePieces(text: string, target: string, signal: AbortSignal): Promise<{ text: string; alreadyInTarget: boolean }> {
        const translated: string[] = [];
        let detected: string | undefined;
        for (const piece of requestPieces(text, MAX_REQUEST_CHARS)) {
            const result = await this._translate(piece, target, signal);
            detected ??= result.detectedLanguage;
            translated.push(isTarget(detected, target) ? result.translation : await this._retryUntranslated(result, target, signal));
        }
        return { text: translated.join('\n'), alreadyInTarget: isTarget(detected, target) };
    }

    /**
     * Google now and then answers a long text with some sentences left as they were: the segment's
     * translation is its source, word for word (seen live: 6 of 11 English sentences). Each such
     * sentence is asked for again on its own, from the language Google detected, and put back in its
     * place. One that still comes back unchanged (a name, a term) stays as it is.
     */
    private async _retryUntranslated(result: GoogleTranslation, target: string, signal: AbortSignal): Promise<string> {
        const segments = result.segments ?? [];
        const untranslated = segments.filter(
            (s) => s.translated.trim() === s.source.trim() && /\p{L}/u.test(s.source.replace(PLACEHOLDER, '')),
        );
        if (untranslated.length === 0) {
            return result.translation;
        }
        const repaired: string[] = [];
        for (const segment of segments) {
            if (!untranslated.includes(segment)) {
                repaired.push(segment.translated);
                continue;
            }
            const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment.translated)!;
            const again = await this._translate(core, target, signal, result.detectedLanguage ?? 'auto');
            // The space that separated the source's sentences: Chinese and Japanese ones follow each other directly.
            repaired.push(lead, again.translation, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u.test(again.translation.slice(-1)) ? '' : trail);
        }
        return repaired.join('').trim();
    }
}
