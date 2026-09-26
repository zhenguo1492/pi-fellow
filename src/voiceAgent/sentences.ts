/**
 * Splits streamed LLM text into TTS-sized pieces.
 * Pure; no I/O.
 */

/** Always ends a piece. */
const HARD_BREAK = /[。！？!?；;\n]/;
/** Ends a piece only when the piece is already long enough (or is the first one). */
const SOFT_BREAK = /[，,、：:]/;
/** The first piece goes out at a soft break once it is this long, to cut time-to-first-audio. */
const FIRST_PIECE_MIN_CHARS = 8;
/** Later pieces go out at a soft break once they are this long. */
const LONG_PIECE_CHARS = 60;

/** Markdown/code noise TTS should not read; collapses whitespace. */
export function cleanForSpeech(text: string): string {
    return text
        .replace(/```[\s\S]*?(```|$)/g, ' ')
        .replace(/[*_`#>~|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Pieces with no letters or digits (stray punctuation) are dropped. */
const SPEAKABLE = /[\p{L}\p{N}]/u;

/**
 * Takes the complete pieces off the front of `buffer`.
 * `firstPiece` = nothing of this reply is queued for audio yet, so cut early at a comma.
 */
export function takeSentences(buffer: string, firstPiece: boolean): { sentences: string[]; rest: string } {
    const sentences: string[] = [];
    let start = 0;
    // Inside a ``` fence nothing is cut, so the whole block is stripped by cleanForSpeech, not read line by line.
    let fenced = false;
    for (let i = 0; i < buffer.length; i++) {
        if (buffer.startsWith('```', i)) {
            fenced = !fenced;
            i += 2;
            continue;
        }
        if (fenced) {
            continue;
        }
        const ch = buffer[i];
        let cut = HARD_BREAK.test(ch);
        if (!cut && ch === '.') {
            // "0.3" and "e.g." stay whole; a period needs following whitespace. At the buffer end, wait.
            const next = buffer[i + 1];
            if (next === undefined) {
                break;
            }
            cut = /\s/.test(next);
        }
        if (!cut && SOFT_BREAK.test(ch)) {
            const len = cleanForSpeech(buffer.slice(start, i)).length;
            const isFirst = firstPiece && sentences.length === 0;
            cut = isFirst ? len >= FIRST_PIECE_MIN_CHARS : len >= LONG_PIECE_CHARS;
        }
        if (cut) {
            const piece = cleanForSpeech(buffer.slice(start, i + 1));
            if (SPEAKABLE.test(piece)) {
                sentences.push(piece);
            }
            start = i + 1;
        }
    }
    return { sentences, rest: buffer.slice(start) };
}

/** Whatever is left when the reply ends. */
export function flushSentence(rest: string): string | undefined {
    const piece = cleanForSpeech(rest);
    return SPEAKABLE.test(piece) ? piece : undefined;
}
