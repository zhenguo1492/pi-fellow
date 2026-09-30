/**
 * Synthesized audio of Bot view messages (and chat paragraphs), sentence by sentence, for Alt+click: what voice mode
 * spoke live and each sentence read aloud since. In memory, first in first out, a fixed number of
 * messages (a message's sentences share one place). Keyed by entry id and the TTS settings that
 * made it, so a changed engine, server, model, voice or speed never replays the old voice.
 */
import { TTS_MODEL_ID, TTS_VOICE } from '../voice/builtinEngine/models';
import type { Pcm, TtsConfig } from './tts';

export interface SpokenPiece {
    /** As sent to TTS. */
    text: string;
    pcm: Pcm;
}

export const DEFAULT_REPLAY_CACHE_SIZE = 30;

/** Which voice the settings make: what an audio clip was made with. */
export function ttsCacheKey(t: TtsConfig): string {
    return JSON.stringify(
        t.engine === 'builtin'
            ? ['builtin', TTS_MODEL_ID, TTS_VOICE.id, t.speed]
            : ['custom', t.url.trim(), t.model.trim(), t.voice.trim(), t.speed, t.languageField],
    );
}

export class SpeechCache {
    /** Insertion order is age: the first key is the oldest. */
    private readonly _clips = new Map<string, SpokenPiece[]>();

    /** `capacity`: messages kept, read on every store (a setting). */
    constructor(private readonly _capacity: () => number = () => DEFAULT_REPLAY_CACHE_SIZE) {}

    get size(): number {
        return this._clips.size;
    }

    /**
     * The audio made with `ttsKey` that reads `text`, if any: `entryId`'s first, else another
     * message's (the same words in the same voice sound the same: a selection, or a chat paragraph
     * quoting a spoken reply). A lookup does not make it newer.
     */
    piece(entryId: string, ttsKey: string, text: string): SpokenPiece | undefined {
        const own = this._clips.get(`${entryId}\u0000${ttsKey}`)?.find((p) => p.text === text);
        if (own) {
            return own;
        }
        const suffix = `\u0000${ttsKey}`;
        for (const [key, pieces] of this._clips) {
            const found = key.endsWith(suffix) ? pieces.find((p) => p.text === text) : undefined;
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    /** A message's audio as voice mode spoke it, in place of any kept for it. */
    put(entryId: string, ttsKey: string, pieces: SpokenPiece[]): void {
        if (pieces.length > 0) {
            this._store(`${entryId}\u0000${ttsKey}`, pieces);
        }
    }

    /** One more sentence of a message's audio. */
    add(entryId: string, ttsKey: string, piece: SpokenPiece): void {
        const key = `${entryId}\u0000${ttsKey}`;
        this._store(key, [...(this._clips.get(key) ?? []).filter((p) => p.text !== piece.text), piece]);
    }

    /** Stores `pieces` under `key` as the newest, dropping the oldest beyond capacity. */
    private _store(key: string, pieces: SpokenPiece[]): void {
        this._clips.delete(key);
        this._clips.set(key, pieces);
        const capacity = Math.max(0, Math.floor(this._capacity()));
        for (const oldest of this._clips.keys()) {
            if (this._clips.size <= capacity) {
                break;
            }
            this._clips.delete(oldest);
        }
    }
}
