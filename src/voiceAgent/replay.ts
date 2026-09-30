/**
 * Alt+click on a sentence (Bot view or chat): reads it aloud with the TTS as configured (built-in engine and
 * API keys resolved on each replay). The audio comes from the {@link SpeechCache} when voice mode
 * spoke this sentence, or it was read before, with the same voice; else from TTS, and is kept there
 * with the rest of its message's (for the chat, its paragraph's). A paragraph (Alt+Shift+click) or
 * a selection is read sentence by sentence (`VoiceReplayPiece.parts`), as the cache keeps them:
 * cached sentences play at once, only the others go to TTS, and each clip is queued as soon as it
 * is ready, so the first sentence plays while the rest are synthesized. Where it plays is the
 * caller's choice (`ReplayPlayerOptions.output`): voice mode's hidden audio page while voice mode
 * runs, so Chrome's echo canceller removes it from the microphone and voice mode holds its input
 * meanwhile; otherwise the Bot view itself ({@link BotViewAudio}), with dictation paused while it
 * plays. Either reports when each sentence really starts, which moves the read to `playing` and to
 * that sentence (`part`, the highlight), as for live speech.
 *
 * Pause lets the speakers go (voice mode hears the microphone again, dictation resumes) and keeps
 * the read: its sentences' audio and where it was heard (the clip's start report plus the time
 * since). Resume takes the speakers again and queues the rest of that sentence's audio, then the
 * next ones; a seek (double-click on a word) does the same from a place estimated by characters,
 * as the TTS gives no word timings.
 */
import type { VoiceReplay, VoiceReplayPiece, VoiceViewHostMessage } from '../shared/voiceViewProtocol';
import { describeError } from '../voice/modelsProbe';
import { explainVoiceError } from '../voice/voiceErrors';
import { ClipLevelMeter } from './botLevel';
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
    /** Level 0..1 and waveform of the sentence being read as it plays, as voice mode's replies report theirs; 0 and none when it stops. */
    onLevel(level: number, wave?: number[]): void;
    log(line: string): void;
}

/** A resume starts this far before where the pause was heard, so no syllable is lost to the report's delay. */
const RESUME_OVERLAP_SECS = 0.15;
/** A seek to a word starts this far before its estimated place (by characters), so the word is heard whole. */
const SEEK_LEAD_SECS = 0.2;

/** A sentence of a read: its audio once it is known, and its synthesis while it is being made. */
interface Part {
    text: string;
    pcm?: Pcm;
    made?: Promise<Pcm>;
}

/** Where a run of the read starts: a part, and a sample in it, or a fraction of its length (a seek). */
type StartAt = { part: number; sample: number } | { part: number; fraction: number };

/** The speakers taken for part of a read: from a start, or a resume or seek, until the end, a pause or another seek. */
interface Run {
    ctl: AbortController;
    from: StartAt;
    /** The clip on the speakers: its part, the sample it starts at, when it was heard to start. */
    heard?: { part: number; sample: number; at: number };
}

interface Read extends VoiceReplay {
    /** The whole read: stop, the end, a failure, or the speakers taken back abort it. */
    ctl: AbortController;
    parts: Part[];
    tts?: Promise<TtsClient>;
    /** One synthesis at a time, in the order asked. */
    queue: Promise<unknown>;
    run?: Run;
    /** Where a resume continues. */
    pausedAt?: StartAt;
    ended: () => void;
}

/** The samples of 16-bit mono `pcm`. */
const samplesOf = (pcm: Pcm): number => pcm.data.length >> 1;

/**
 * One read at a time, a sentence or several (a paragraph, a selection) one after another; another
 * one stops it, and so does the same one again. A read can be paused, resumed where it was, and
 * moved to a sentence and a place in it.
 */
export class ReplayPlayer {
    private _current: Read | undefined;
    /** The level of the clip on the speakers, from its start report. */
    private readonly _meter: ClipLevelMeter;

    constructor(private readonly _options: ReplayPlayerOptions) {
        this._meter = new ClipLevelMeter((level, wave) => _options.onLevel(level, wave));
    }

    get current(): VoiceReplay | undefined {
        const c = this._current;
        return c && { entryId: c.entryId, piece: c.piece, phase: c.phase, part: c.part };
    }

    /**
     * Reads `piece` of `entryId` aloud (from `fraction` into sentence `part` of `from`, else from
     * its start), or stops if that sentence (same words at the same place) is being read. Resolves
     * once the read is over.
     */
    toggle(entryId: string, piece: VoiceReplayPiece, from?: { part: number; fraction: number }): Promise<void> {
        const reading = this._current?.entryId === entryId ? this._current.piece : undefined;
        if (reading?.text === piece.text && reading.sentence === piece.sentence && reading.range?.join() === piece.range?.join()) {
            this.stop();
            return Promise.resolve();
        }
        this.stop();
        const ttsKey = this._options.ttsKey();
        const { promise, resolve } = Promise.withResolvers<void>();
        const read: Read = {
            entryId,
            piece,
            phase: 'loading',
            part: 0,
            ctl: new AbortController(),
            parts: (piece.parts ?? [piece.text]).map((text) => {
                const cached = this._options.cache.piece(entryId, ttsKey, text);
                this._options.log(`Replay ${entryId}: cache ${cached ? 'hit' : 'miss'}: ${JSON.stringify(text)}`);
                return { text, pcm: cached?.pcm };
            }),
            queue: Promise.resolve(),
            ended: resolve,
        };
        this._current = read;
        this._options.onChange(this.current);
        const parts = read.parts.length;
        const start: StartAt = from && from.part >= 0 && from.part < parts ? { part: from.part, fraction: Math.min(1, Math.max(0, from.fraction)) } : { part: 0, sample: 0 };
        void this._run(read, start, ttsKey);
        return promise;
    }

    stop(): void {
        if (this._current) {
            this._end(this._current);
        }
    }

    /** Holds the read where the speakers are: they are let go until {@link resume}. */
    pause(): void {
        const read = this._current;
        const run = read?.run;
        if (!read || !run || read.phase === 'paused') {
            return;
        }
        let at: StartAt = run.from;
        const heard = run.heard;
        const pcm = heard && read.parts[heard.part].pcm;
        if (heard && pcm) {
            const sample = heard.sample + Math.round(((Date.now() - heard.at) / 1000 - RESUME_OVERLAP_SECS) * pcm.rate);
            at = sample < samplesOf(pcm) ? { part: heard.part, sample: Math.max(0, sample) } : { part: heard.part + 1, sample: 0 };
        }
        read.pausedAt = at;
        read.run = undefined;
        run.ctl.abort();
        this._update(read, 'paused', Math.min(at.part, read.parts.length - 1));
    }

    /** Reads on from where {@link pause} held it. */
    resume(): void {
        const read = this._current;
        if (read?.phase === 'paused' && read.pausedAt) {
            void this._run(read, read.pausedAt, this._options.ttsKey());
        }
    }

    /** Reads on from `fraction` (by characters) into sentence `part`, paused or not. */
    seek(part: number, fraction: number): void {
        const read = this._current;
        if (read && part >= 0 && part < read.parts.length) {
            void this._run(read, { part, fraction: Math.min(1, Math.max(0, fraction)) }, this._options.ttsKey());
        }
    }

    /** The audio of `part`: kept, or from TTS (one sentence at a time), and then kept. */
    private _pcm(read: Read, index: number, ttsKey: string): Promise<Pcm> {
        const part = read.parts[index];
        if (part.pcm) {
            return Promise.resolve(part.pcm);
        }
        if (!part.made) {
            // Only a miss needs TTS; the built-in engine may download its models and start here.
            const made = read.queue.then(async () => {
                const tts = await (read.tts ??= this._options.tts().then((config) => new TtsClient(config)));
                const pcm = await tts.synthesize(part.text, read.ctl.signal);
                read.ctl.signal.throwIfAborted();
                this._options.cache.add(read.entryId, ttsKey, { text: part.text, pcm });
                part.pcm = pcm;
                return pcm;
            });
            part.made = made;
            // A failure is reported by the run waiting for it; asked again (a resume), it is tried again.
            read.queue = made.catch(() => {
                part.made = undefined;
            });
        }
        return part.made;
    }

    /** Takes the speakers and queues the parts from `from` on, each as soon as its audio is ready. */
    private async _run(read: Read, from: StartAt, ttsKey: string): Promise<void> {
        if (this._current !== read) {
            return;
        }
        read.run?.ctl.abort();
        const run: Run = { ctl: new AbortController(), from };
        read.run = run;
        read.pausedAt = undefined;
        this._update(read, read.parts[from.part]?.pcm ? 'queued' : 'loading', Math.min(from.part, read.parts.length - 1));
        const output = this._options.output(read.piece.text);
        if (typeof output === 'string') {
            this._options.onError(output);
            this._end(read);
            return;
        }
        // The speakers taken back (the voice agent speaks, hush, standby) end the read.
        output.signal.addEventListener('abort', () => this._end(read), { once: true });
        const signal = AbortSignal.any([read.ctl.signal, run.ctl.signal, output.signal]);
        signal.addEventListener(
            'abort',
            () => {
                this._meter.stop();
                output.end();
            },
            { once: true },
        );
        try {
            const played: Array<Promise<void>> = [];
            for (let i = from.part; i < read.parts.length; i++) {
                const pcm = await this._pcm(read, i, ttsKey);
                if (signal.aborted) {
                    return;
                }
                let sample = 0;
                if (i === from.part) {
                    sample = 'sample' in from ? from.sample : from.fraction > 0 ? Math.round(from.fraction * samplesOf(pcm) - SEEK_LEAD_SECS * pcm.rate) : 0;
                    sample = Math.min(Math.max(0, sample), samplesOf(pcm));
                }
                const clip = sample > 0 ? { rate: pcm.rate, data: pcm.data.subarray(sample * 2) } : pcm;
                if (played.length === 0 && read.phase === 'loading') {
                    this._update(read, 'queued', read.part);
                }
                played.push(
                    output.play(clip, () => {
                        if (read.run === run) {
                            const at = Date.now();
                            run.heard = { part: i, sample, at };
                            this._meter.start(clip, at);
                            this._update(read, 'playing', i);
                        }
                    }),
                );
            }
            await Promise.all(played);
            if (!signal.aborted) {
                this._end(read);
            }
        } catch (err) {
            if (!signal.aborted) {
                this._options.log(`Replay failed: ${describeError(err)}`);
                this._options.onError(explainVoiceError(err, { service: 'tts' }).message);
                this._end(read);
            }
        } finally {
            // A seek has another run on the speakers by now: its level is not this run's to stop.
            if (read.run === run) {
                this._meter.stop();
            }
            output.end();
        }
    }

    /** The read is over: played through, stopped, failed, or its speakers taken back. */
    private _end(read: Read): void {
        read.ctl.abort();
        read.run?.ctl.abort();
        if (this._current === read) {
            this._current = undefined;
            this._options.onChange(undefined);
        }
        read.ended();
    }

    private _update(read: Read, phase: VoiceReplay['phase'], part: number): void {
        if (this._current === read && (read.phase !== phase || read.part !== part)) {
            read.phase = phase;
            read.part = part;
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
