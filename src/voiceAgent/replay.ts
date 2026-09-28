/**
 * Alt+click on a sentence (Bot view or chat): reads it aloud with the TTS as configured (built-in engine and
 * API keys resolved on each replay). The audio comes from the {@link SpeechCache} when voice mode
 * spoke this sentence, or it was read before, with the same voice; else from TTS, and is kept there
 * with the rest of its message's (for the chat, its paragraph's). Where it plays is the caller's choice (`ReplayPlayerOptions.output`):
 * voice mode's hidden audio page while voice mode runs, so Chrome's echo canceller removes it from
 * the microphone and voice mode holds its input meanwhile; otherwise the Bot view itself
 * ({@link BotViewAudio}), with dictation paused while it plays. Either reports when the sentence
 * really starts, which moves it to `playing` (the highlight), as for live speech.
 */
import type { VoiceReplay, VoiceReplayPiece, VoiceViewHostMessage } from '../shared/voiceViewProtocol';
import { describeError } from '../voice/modelsProbe';
import { explainVoiceError } from '../voice/voiceErrors';
import type { SpeechCache } from './speechCache';
import { TtsClient, type Pcm, type TtsRequestConfig } from './tts';

/** Speakers a replay plays on, taken for one replay. */
export interface ReplayOutput {
    /** Aborted when the output takes its speakers back: the voice agent speaks, hush, standby, voice mode stops. */
    readonly signal: AbortSignal;
    /**
     * Queues one clip after the ones before; `onPlaying` runs as its audio actually starts. Resolves
     * once it has played, or was dropped.
     */
    play(pcm: Pcm, onPlaying?: () => void): Promise<void>;
    /** The replay is over (played, stopped or failed): drops what is still queued and releases the output. Idempotent. */
    end(): void;
}

export interface ReplayPlayerOptions {
    cache: SpeechCache;
    /** Which voice the TTS settings make now ({@link ttsCacheKey}). */
    ttsKey(): string;
    /** The TTS as configured now; only asked for on a cache miss. */
    tts(): Promise<TtsRequestConfig>;
    /** Where the replay of `text` (as spoken) plays, or why it cannot now. */
    output(text: string): ReplayOutput | string;
    /** A replay started, changed phase, or ended. */
    onChange(current: VoiceReplay | undefined): void;
    /** A replay could not start or failed, in plain words. */
    onError(message: string): void;
    log(line: string): void;
}

/** One sentence at a time; another one stops it, and so does the same one again. */
export class ReplayPlayer {
    private _current: (VoiceReplay & { ctl: AbortController }) | undefined;

    constructor(private readonly _options: ReplayPlayerOptions) {}

    get current(): VoiceReplay | undefined {
        const c = this._current;
        return c && { entryId: c.entryId, piece: c.piece, phase: c.phase };
    }

    /** Reads `piece` of `entryId` aloud, or stops if that sentence (same words at the same place) is playing. */
    toggle(entryId: string, piece: VoiceReplayPiece): Promise<void> {
        const playing = this._current?.entryId === entryId ? this._current.piece : undefined;
        if (playing?.text === piece.text && playing.sentence === piece.sentence && playing.range?.join() === piece.range?.join()) {
            this.stop();
            return Promise.resolve();
        }
        return this._play(entryId, piece);
    }

    stop(): void {
        this._current?.ctl.abort();
    }

    private async _play(entryId: string, piece: VoiceReplayPiece): Promise<void> {
        this.stop();
        const ctl = new AbortController();
        const current: VoiceReplay & { ctl: AbortController } = { entryId, piece, phase: 'loading', ctl };
        this._current = current;
        this._options.onChange(this.current);
        const ttsKey = this._options.ttsKey();
        const cached = this._options.cache.piece(entryId, ttsKey, piece.text);
        this._options.log(`Replay ${entryId}: cache ${cached ? 'hit' : 'miss'}: ${JSON.stringify(piece.text)}`);
        let out: ReplayOutput | undefined;
        try {
            // Only a miss needs TTS; the built-in engine may download its models and start here.
            const tts = cached ? undefined : new TtsClient(await this._options.tts());
            if (ctl.signal.aborted) {
                return;
            }
            const output = this._options.output(piece.text);
            if (typeof output === 'string') {
                this._options.onError(output);
                return;
            }
            out = output;
            const signal = AbortSignal.any([ctl.signal, output.signal]);
            signal.addEventListener('abort', () => output.end(), { once: true });
            const pcm = cached ? cached.pcm : await tts!.synthesize(piece.text, signal);
            if (signal.aborted) {
                return;
            }
            if (!cached) {
                this._options.cache.add(entryId, ttsKey, { text: piece.text, pcm });
            }
            this._setPhase(current, 'queued');
            await output.play(pcm, () => this._setPhase(current, 'playing'));
        } catch (err) {
            if (!ctl.signal.aborted && !out?.signal.aborted) {
                this._options.log(`Replay failed: ${describeError(err)}`);
                this._options.onError(explainVoiceError(err, { service: 'tts' }).message);
            }
        } finally {
            out?.end();
            if (this._current === current) {
                this._current = undefined;
                this._options.onChange(undefined);
            }
        }
    }

    private _setPhase(replay: VoiceReplay, phase: VoiceReplay['phase']): void {
        if (this._current === replay) {
            replay.phase = phase;
            this._options.onChange(this.current);
        }
    }
}

/** A view that never reports a clip (closed, reloaded) still releases the replay this long after it should have ended. */
const VIEW_CLIP_SLACK_MS = 3000;

/**
 * Replay without voice mode: the chat webview (the Bot view's and the chat's sentences alike) plays
 * the clips with Web Audio (the webview has no microphone, so there is nothing to cancel echo for;
 * dictation, which records in the extension host, pauses instead). It answers `replayClipStarted`
 * and `replayClipEnded` for each clip.
 */
export class BotViewAudio {
    private _nextClipId = 1;
    private readonly _pending = new Map<number, { resolve: () => void; timer: NodeJS.Timeout; onPlaying?: () => void }>();
    /** When the view's queue runs dry, for the fallback timers. */
    private _queueEndsAt = 0;

    constructor(private readonly _post: (message: VoiceViewHostMessage) => void) {}

    output(): ReplayOutput {
        const clips = new Set<number>();
        let ended = false;
        return {
            // The view never takes its speakers back; the player stops the replay.
            signal: new AbortController().signal,
            play: (pcm, onPlaying) =>
                new Promise<void>((resolve) => {
                    if (ended) {
                        resolve();
                        return;
                    }
                    const clipId = this._nextClipId++;
                    const now = Date.now();
                    this._queueEndsAt = Math.max(now, this._queueEndsAt) + (pcm.data.length / 2 / pcm.rate) * 1000;
                    const timer = setTimeout(() => this.clipEnded(clipId), this._queueEndsAt - now + VIEW_CLIP_SLACK_MS);
                    clips.add(clipId);
                    this._pending.set(clipId, {
                        resolve: () => {
                            clips.delete(clipId);
                            resolve();
                        },
                        timer,
                        onPlaying,
                    });
                    this._post({ type: 'replayAudio', clipId, rate: pcm.rate, pcm: pcm.data.toString('base64') });
                }),
            end: () => {
                if (ended) {
                    return;
                }
                ended = true;
                if (clips.size > 0) {
                    this._post({ type: 'replayHalt' });
                    this._queueEndsAt = 0;
                }
                for (const clipId of [...clips]) {
                    this.clipEnded(clipId);
                }
            },
        };
    }

    /** The view started playing the clip. */
    clipStarted(clipId: number): void {
        const pending = this._pending.get(clipId);
        const onPlaying = pending?.onPlaying;
        if (pending && onPlaying) {
            pending.onPlaying = undefined;
            onPlaying();
        }
    }

    /** The view played the clip, or it was dropped. */
    clipEnded(clipId: number): void {
        const pending = this._pending.get(clipId);
        if (pending) {
            this._pending.delete(clipId);
            clearTimeout(pending.timer);
            pending.resolve();
        }
    }
}
