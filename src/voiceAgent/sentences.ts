/**
 * Splits streamed LLM text into TTS-sized pieces.
 * Pure; no I/O. The webview uses it too, to find the sentence under the pointer.
 */
import { blankUnspoken } from '../shared/voiceMessageText';
import type { VoiceReplayPiece } from '../shared/voiceViewProtocol';

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
    const { pieces, restStart } = sentenceRanges(buffer, firstPiece);
    return { sentences: pieces.map((p) => p.text), rest: buffer.slice(restStart) };
}

/**
 * {@link takeSentences} with where each piece is: `start`..`end` (exclusive) in `buffer`, the text
 * the piece was cleaned from. `restStart`: where the unfinished rest begins.
 */
export function sentenceRanges(buffer: string, firstPiece: boolean): { pieces: Array<{ text: string; start: number; end: number }>; restStart: number } {
    const pieces: Array<{ text: string; start: number; end: number }> = [];
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
            const isFirst = firstPiece && pieces.length === 0;
            cut = isFirst ? len >= FIRST_PIECE_MIN_CHARS : len >= LONG_PIECE_CHARS;
        }
        if (cut) {
            const piece = cleanForSpeech(buffer.slice(start, i + 1));
            if (SPEAKABLE.test(piece)) {
                pieces.push({ text: piece, start, end: i + 1 });
            }
            start = i + 1;
        }
    }
    return { pieces, restStart: start };
}

/** Whatever is left when the reply ends. */
export function flushSentence(rest: string): string | undefined {
    const piece = cleanForSpeech(rest);
    return SPEAKABLE.test(piece) ? piece : undefined;
}

/**
 * A message as it is read aloud: without anchors, `<silent/>`, code blocks or Markdown, one
 * sentence per TTS request, each with the range of `text` it was read from (trimmed of the
 * whitespace around it), for the highlight.
 */
export function replayPieces(text: string): VoiceReplayPiece[] {
    // Blanked, not removed: offsets stay offsets into `text`.
    const blank = blankUnspoken(text);
    // The newline ends the last sentence, as the end of a streamed reply does.
    const { pieces, restStart } = sentenceRanges(`${blank}\n`, false);
    const last = flushSentence(blank.slice(restStart));
    const all = last ? [...pieces, { text: last, start: restStart, end: blank.length }] : pieces;
    return all.map((piece) => {
        let from = piece.start;
        let to = Math.min(piece.end, blank.length);
        while (from < to && /\s/.test(blank[from])) {
            from++;
        }
        while (to > from && /\s/.test(blank[to - 1])) {
            to--;
        }
        return { text: piece.text, range: [from, to] };
    });
}
