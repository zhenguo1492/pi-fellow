/**
 * Voice mode: the audio loop around the voice agent (docs/voice-agent-design.md §4, §5.1–§5.7).
 * Microphone (hidden Chrome, AEC3) → Silero VAD → segments / barge-in check → STT → the
 * conversation reducer → VoiceAgent turns → sentence-by-sentence TTS → the same Chrome page.
 *
 * Every decision is in conversation.ts; this file wires devices and runs effects. Each reply is one
 * cancellation scope (an AbortController): the voice agent's run, its TTS requests, the fallback
 * timer and the page's audio queue all stop on `cancelTurn`, and nothing of that turn reaches the
 * reducer afterwards. What plays, and when, comes from the audio page's reports, not estimates.
 */
import { voiceUserText, type VoiceAttachments } from '../shared/voiceViewProtocol';
import type { CodeAnchor } from './codeAnchors';
import { echoSource, floorFree, initialState, phaseOf, reduce, type ConvEvent, type ConvState, type Effect, type Metrics, type Phase } from './conversation';
import { classifyBargeIn, isHallucination, type BargeInVerdict } from './echoFilter';
import { findChrome, launchHiddenChrome, startBrowserAudio, type BrowserAudio, type PlaybackReport } from './browserAudio';
import { TtsClient, type Pcm, type TtsConfig } from './tts';
import type { ProactiveTurnHooks, VoiceAgent, VoiceTurnListener } from './voiceAgent';
import { SileroVad, VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE } from '../voice/sileroVad';
import { MicLevelMeter, frameDb, wavePoints } from '../voice/micLevel';
import { SpeechSegmenter } from '../voice/speechSegmenter';
import { SttClient, listSttModels, type SttConfig } from '../voice/stt';

export interface VoiceModeOptions {
    agent: VoiceAgent;
    vad: { modelPath: string; runtimeDir: string };
    stt: SttConfig;
    tts: TtsConfig;
    /** Silence that ends the user's turn (§5.2). */
    turnStopSecs: number;
    /** Silero probability at or above which a frame is speech. */
    vadConfidence: number;
    /** Extra hidden-Chrome flags; scripted tests feed a WAV file as the microphone. */
    chromeArgs: string[];
    /** Whether this window has the voice when voice mode starts (design §13 R9). */
    active: boolean;
    /**
     * Output-channel transcript of one user turn; `turnId` scopes the reply's audio events.
     * `metrics`: the exchange's timestamps as the prompt goes out (how long hearing it took).
     */
    transcript(text: string, source: 'text' | 'stt', turnId: number, metrics: Metrics): VoiceTurnListener;
    /** No Chromium browser found: open the audio page in the default browser instead. */
    openExternal(url: string): void;
    onPhase(phase: Phase): void;
    /** Microphone level 0..1 and its waveform (`wavePoints`), ~16 per second while listening. */
    onLevel?(level: number, wave?: number[]): void;
    /** Level 0..1 and waveform of the reply being played, ~16 per second while a sentence plays; 0 and none when it stops. */
    onBotLevel?(level: number, wave?: number[]): void;
    /**
     * Latency of reply `turnId`, user or proactive, once its audio is over or it is cut off (then
     * before its `cut` audio event).
     */
    onMetrics?(turnId: number, metrics: Metrics): void;
    /** Playback of reply `turnId`, for the voice panel's sentence states. */
    onAudio?(event: ReplyAudioEvent): void;
    /** The reply points at code: called as the sentence the anchors precede starts playing. */
    onAnchors?(anchors: CodeAnchor[]): void;
    log(line: string): void;
}

/**
 * `speak`: a sentence went to TTS; `playing` / `played`: the page reports it started / finished
 * playing; `idle`: the reply is over, generated and played (sentences that never played were not
 * heard); `cut`: the reply was cut off, by the user speaking or typing (`user`), the hush button
 * (`hush`), or the voice moving to another window (`standby`).
 */
export type ReplyAudioEvent =
    | { turnId: number; type: 'speak' | 'playing' | 'played'; text: string }
    | { turnId: number; type: 'idle' }
    | { turnId: number; type: 'cut'; by: 'user' | 'hush' | 'standby' };

const FRAME_MS = (VAD_FRAME_SAMPLES / VAD_SAMPLE_RATE) * 1000;
/**
 * Mid-reply, nothing playing or synthesizing for this long means the bot has fallen silent (a
 * tool call): the status goes back to thinking (pipecat's BOT_VAD_STOP_FALLBACK_SECS).
 */
const BOT_STOP_FALLBACK_MS = 3000;
/** How long the hidden page may take to connect before voice mode gives up. */
const CONNECT_TIMEOUT_MS = 15_000;
/**
 * Barge-in (voice-loop prototype doc §4.3, §8 P5/P12). While the bot talks, speech is only a
 * candidate until STT shows real words that are not the bot's own echo.
 * Evidence = a confident VAD frame or a loud one: Chrome AEC3 chops the user's voice while the bot
 * plays (double-talk), so VAD alone rarely holds; converged residual echo stays below −41 dBFS.
 */
const BARGE_IN_CONFIDENCE = 0.6;
const BARGE_IN_DB = -35;
/** Evidence before the first STT check. */
const BARGE_IN_MS = 400;
/** A rejected check is retried whenever the evidence grows this much more; the user may start after some echo. */
const BARGE_IN_RECHECK_MS = 600;
/** Each check transcribes only the latest 1.5 s, so earlier echo does not drown the user's words. */
const BARGE_IN_WINDOW_FRAMES = Math.round(1500 / FRAME_MS);
/** A candidate going quiet before its first check still gets one with this much evidence ("停", "wait"). */
const MIN_FINAL_CHECK_MS = 150;
/** Quiet that ends an unconfirmed candidate. */
const BARGE_IN_GAP_MS = 800;
/** Audio kept in front of a candidate (0.5 s). */
const BARGE_IN_PREROLL_FRAMES = 16;
const MAX_SEGMENT_SECS = 28;
/** One bot level report per this much played audio (≈16 Hz, like the microphone's). */
const BOT_LEVEL_MS = 64;
/** dBFS mapped to bot level 0 and 1: TTS output is normalized loud, speech sits around -25..-10. */
const BOT_FLOOR_DB = -45;
const BOT_CEIL_DB = -15;

interface BargeIn {
    /** Speech-like evidence so far. */
    evidenceMs: number;
    /** `evidenceMs` at which the next STT check runs. */
    checkAtMs: number;
    /** Time since the last speech-like frame. */
    quietMs: number;
    verifying: boolean;
    /** The last-chance check for a short "停" / "wait" has been spent. */
    finalChecked: boolean;
    confirmed: boolean;
    /** What the confirming check heard; stands in if the whole utterance transcribes badly. */
    heardText?: string;
    /** Audio from just before the speech started until now. */
    frames: Int16Array[];
}

export class VoiceMode {
    private _state: ConvState;
    /** The reply in progress and its cancellation scope. */
    private _turn: { id: number; ctl: AbortController } | undefined;
    /** Anchors streamed since the last sentence went to TTS: they belong to the next one. */
    private _pendingAnchors: { turnId: number; anchors: CodeAnchor[] } | undefined;
    private readonly _speaker: Speaker;
    private readonly _stt: SttClient;
    private _segmenter: SpeechSegmenter;
    /** Owns the audio (the segmenter is not fed) from its first evidence until rejected or ended. */
    private _bargeIn: BargeIn | undefined;
    private readonly _recent: Int16Array[] = [];
    /** Transcripts are delivered in speaking order. */
    private _delivery: Promise<void> = Promise.resolve();
    private _buffered: Buffer = Buffer.alloc(0);
    private _draining = false;
    private _chrome: { kill(): void } | undefined;
    private _stopped = false;
    private _muted = false;
    private readonly _level: MicLevelMeter;

    private constructor(
        private readonly _options: VoiceModeOptions,
        private readonly _vad: SileroVad,
        private readonly _audio: BrowserAudio,
        /** The STT model in use: the configured one, else the first the server lists ('' if none). */
        readonly sttModel: string,
    ) {
        this._state = initialState(_options.active);
        this._stt = new SttClient(_options.stt);
        this._speaker = new Speaker(new TtsClient(_options.tts), _audio, (ev) => this._dispatch(ev), _options.log, (level, wave) =>
            _options.onBotLevel?.(level, wave),
        );
        this._segmenter = this._newSegmenter();
        this._level = new MicLevelMeter((level, wave) => _options.onLevel?.(level, wave));
    }

    /** Checks STT, loads the VAD, opens the audio page and waits until it is connected. */
    static async start(options: VoiceModeOptions): Promise<VoiceMode> {
        const { stt, tts, log } = options;
        if (!stt.url) {
            throw new Error('Voice mode needs a speech-to-text service: set oh-my-pi-chater.voice.sttUrl.');
        }
        if (!tts.url) {
            throw new Error('Voice mode needs a text-to-speech service: set oh-my-pi-chater.voiceAgent.tts.url.');
        }
        const models = await listSttModels(stt.url).catch((err: unknown) => {
            throw new Error(`Speech-to-text service unreachable (${stt.url}): ${err instanceof Error ? err.message : String(err)}`);
        });
        const vad = await SileroVad.load(options.vad.modelPath, options.vad.runtimeDir);
        let mode: VoiceMode | undefined;
        const connected = Promise.withResolvers<void>();
        const audio = await startBrowserAudio({
            mic: (chunk) => mode?._onMic(chunk),
            playback: (report) => mode?._speaker.onPlayback(report),
            connected: (on) => {
                log(on ? 'Audio page connected.' : 'Audio page disconnected.');
                if (on) {
                    connected.resolve();
                }
            },
            log,
        });
        mode = new VoiceMode(options, vad, audio, stt.model.trim() || (models[0] ?? ''));
        audio.setMic(options.active);
        const chrome = findChrome();
        if (chrome) {
            mode._chrome = launchHiddenChrome(chrome, audio.url, options.chromeArgs, log);
            log(`Hidden browser: ${chrome}`);
            const timeout = setTimeout(() => connected.reject(new Error('The hidden audio page did not connect.')), CONNECT_TIMEOUT_MS);
            try {
                await connected.promise;
            } catch (err) {
                await mode.stop();
                throw err;
            } finally {
                clearTimeout(timeout);
            }
        } else {
            log('No Chrome, Edge, Chromium or Brave found: opening the audio page in the default browser. Keep that tab open.');
            options.openExternal(audio.url);
        }
        options.onPhase(phaseOf(mode._state));
        return mode;
    }

    /** Someone is talking, being transcribed, or being answered: the voice agent should not speak up. */
    get floorBusy(): boolean {
        return !floorFree(this._state);
    }

    /**
     * Scopes a reply the voice agent starts on its own; an aborted signal if the floor is taken.
     * `turnId` scopes the reply's audio events.
     */
    proactiveTurn(log: VoiceTurnListener): ProactiveTurnHooks & { turnId?: number } {
        this._dispatch({ type: 'proactiveStart', at: Date.now() });
        const turn = this._turn;
        if (!turn || turn.id !== this._state.bot?.turnId) {
            return { listener: log, signal: AbortSignal.abort() };
        }
        return { listener: this._replyListener(turn, log), signal: turn.ctl.signal, turnId: turn.id };
    }

    get muted(): boolean {
        return this._muted;
    }

    /**
     * Muted, the page's microphone is off and nothing is heard; a reply keeps playing. Speech in
     * progress is dropped, like standing by.
     */
    setMuted(muted: boolean): void {
        if (this._stopped || muted === this._muted) {
            return;
        }
        this._muted = muted;
        this._audio.setMic(this._state.active && !muted);
        if (muted) {
            this._dropHeardAudio();
            if (this._state.userSpeaking) {
                const now = Date.now();
                this._dispatch({ type: 'userSpeechEnd', at: now, silenceAt: now });
                this._dispatch({ type: 'transcript', text: '', at: now });
            }
            this._options.onLevel?.(0);
        }
        this._options.log(muted ? 'Microphone muted.' : 'Microphone unmuted.');
    }

    /** Stops the reply being spoken, as if the user had interrupted it without a new message. */
    hush(): void {
        this._dispatch({ type: 'hush', at: Date.now() });
    }

    /**
     * This window gained or lost the voice. Standing by, the page's microphone is off, a reply in
     * progress is cut off, half-heard speech is dropped, and proactive turns wait.
     */
    setActive(active: boolean): void {
        if (this._stopped || active === this._state.active) {
            return;
        }
        this._audio.setMic(active && !this._muted);
        if (!active) {
            this._dropHeardAudio();
        }
        this._options.log(active ? 'This window has the voice.' : 'Another VS Code window has the voice; this one stands by.');
        this._dispatch({ type: 'active', active, at: Date.now() });
    }

    /** A message typed while voice mode is on: cuts the reply off and goes out like speech. */
    type(text: string, attachments?: VoiceAttachments): void {
        this._dispatch({ type: 'typed', text, attachments, at: Date.now() });
    }

    async stop(): Promise<void> {
        if (this._stopped) {
            return;
        }
        this._stopped = true;
        this._turn?.ctl.abort();
        this._chrome?.kill();
        this._audio.close();
    }

    private _dispatch(ev: ConvEvent): void {
        if (this._stopped) {
            return;
        }
        const before = this._state;
        const step = reduce(before, ev);
        this._state = step.state;
        for (const effect of step.effects) {
            this._runEffect(effect, ev);
        }
        if (ev.type === 'sentencePlaying') {
            this._options.onAudio?.({ turnId: ev.turnId, type: 'playing', text: ev.text });
        } else if (ev.type === 'sentencePlayed') {
            this._options.onAudio?.({ turnId: ev.turnId, type: 'played', text: ev.text });
        }
        const after = this._state;
        // The reply retired generated and played, not cut off.
        if (after.lastMetrics && after.lastMetrics !== before.lastMetrics && before.bot) {
            const turnId = before.bot.turnId;
            this._options.onAudio?.({ turnId, type: 'idle' });
            this._logLatency(after.lastMetrics);
            this._options.onMetrics?.(turnId, after.lastMetrics);
        }
        if (phaseOf(after) !== phaseOf(before)) {
            this._options.onPhase(phaseOf(after));
        }
        // The reply finished playing, or the user's words came to nothing: the agent may speak up again.
        if (floorFree(after) && !floorFree(before)) {
            this._options.agent.floorReleased();
        }
    }

    private _runEffect(effect: Effect, cause: ConvEvent): void {
        switch (effect.type) {
            case 'prompt': {
                const turn = { id: effect.turnId, ctl: new AbortController() };
                this._turn = turn;
                const shown = voiceUserText(effect.text, effect.attachments);
                const listener = this._replyListener(turn, this._options.transcript(shown, effect.source, turn.id, this._state.metrics));
                // A turn that cannot run ends through the listener with its error (VoiceAgent.say never rejects).
                void this._options.agent.say(effect.text, effect.source, listener, {
                    signal: turn.ctl.signal,
                    interrupted: effect.interrupted,
                    attachments: effect.attachments,
                });
                return;
            }
            case 'adopt':
                this._turn = { id: effect.turnId, ctl: new AbortController() };
                return;
            case 'speak':
                if (this._turn?.id === effect.turnId) {
                    this._options.onAudio?.({ turnId: effect.turnId, type: 'speak', text: effect.text });
                    const anchors = this._pendingAnchors?.turnId === effect.turnId ? this._pendingAnchors.anchors : [];
                    this._pendingAnchors = undefined;
                    const onPlaying = anchors.length > 0 ? () => this._options.onAnchors?.(anchors) : undefined;
                    this._speaker.enqueue(this._turn.ctl.signal, effect.turnId, effect.text, onPlaying);
                }
                return;
            case 'cancelTurn':
                if (this._turn?.id === effect.turnId) {
                    this._options.log(`Reply ${effect.turnId} cut off.`);
                    this._turn.ctl.abort();
                }
                this._options.onMetrics?.(effect.turnId, effect.metrics);
                this._options.onAudio?.({
                    turnId: effect.turnId,
                    type: 'cut',
                    by: cause.type === 'hush' ? 'hush' : cause.type === 'active' ? 'standby' : 'user',
                });
                return;
        }
    }

    /**
     * Feeds one reply's text and end into the reducer, besides `log`; silent once the turn is cut off.
     * Anchors go to `log` as they stream and to `onAnchors` as the sentence they precede starts playing.
     */
    private _replyListener(turn: { id: number; ctl: AbortController }, log: VoiceTurnListener): VoiceTurnListener {
        const live = () => !turn.ctl.signal.aborted;
        return {
            ...log,
            onText: (delta) => {
                log.onText?.(delta);
                if (live()) {
                    this._dispatch({ type: 'llmText', turnId: turn.id, delta, at: Date.now() });
                }
            },
            onAnchor: (anchor) => {
                log.onAnchor?.(anchor);
                if (!live()) {
                    return;
                }
                if (this._pendingAnchors?.turnId !== turn.id) {
                    this._pendingAnchors = { turnId: turn.id, anchors: [] };
                }
                this._pendingAnchors.anchors.push(anchor);
            },
            onEnd: (result) => {
                log.onEnd?.(result);
                if (result.error) {
                    this._options.log(`Voice agent error: ${result.error}`);
                }
                if (live()) {
                    this._dispatch({ type: 'llmEnd', turnId: turn.id, at: Date.now() });
                }
                // Anchors after the last spoken words point at once.
                if (live() && this._pendingAnchors?.turnId === turn.id) {
                    this._options.onAnchors?.(this._pendingAnchors.anchors);
                    this._pendingAnchors = undefined;
                }
            },
        };
    }

    private _logLatency(m: Metrics): void {
        if (!m.silenceAt || !m.firstAudioAt) {
            return;
        }
        const secs = (from?: number, to?: number) => (from && to ? `${((to - from) / 1000).toFixed(2)}s` : '—');
        this._options.log(
            `Latency: end of speech ${secs(m.silenceAt, m.endDetectedAt)} · STT ${secs(m.endDetectedAt, m.sttDoneAt)} · ` +
                `first text ${secs(m.promptAt, m.firstTextAt)} · first sentence ${secs(m.firstTextAt, m.firstSpeakAt)} · ` +
                `TTS to first sound ${secs(m.firstSpeakAt, m.firstAudioAt)} · whole reply generated ${secs(m.promptAt, m.llmDoneAt)} · ` +
                `stopped talking → heard reply ${secs(m.silenceAt, m.firstAudioAt)}`,
        );
    }

    /** Forgets audio heard but not yet acted on: partial frames, a barge-in candidate, the segment in progress. */
    private _dropHeardAudio(): void {
        this._buffered = Buffer.alloc(0);
        this._bargeIn = undefined;
        this._segmenter = this._newSegmenter();
        this._vad.reset();
    }

    // ── microphone → VAD → segments / barge-in → STT ─────────────────────────

    private _newSegmenter(): SpeechSegmenter {
        return new SpeechSegmenter(
            {
                confidence: this._options.vadConfidence,
                startSecs: 0.2,
                stopSecs: this._options.turnStopSecs,
                preRollSecs: 0.3,
                maxSegmentSecs: MAX_SEGMENT_SECS,
            },
            VAD_FRAME_SAMPLES,
            VAD_SAMPLE_RATE,
        );
    }

    private _onMic(chunk: Buffer): void {
        // Standing by or muted: the page's track is off, and any frames still in flight are not ours to hear.
        if (!this._state.active || this._muted) {
            return;
        }
        this._buffered = this._buffered.length ? Buffer.concat([this._buffered, chunk]) : chunk;
        if (!this._draining) {
            void this._drain();
        }
    }

    private async _drain(): Promise<void> {
        this._draining = true;
        const frameBytes = VAD_FRAME_SAMPLES * 2;
        try {
            while (this._buffered.length >= frameBytes && !this._stopped) {
                const bytes = this._buffered.subarray(0, frameBytes);
                this._buffered = this._buffered.subarray(frameBytes);
                const frame = new Int16Array(VAD_FRAME_SAMPLES);
                for (let i = 0; i < VAD_FRAME_SAMPLES; i++) {
                    frame[i] = bytes.readInt16LE(i * 2);
                }
                await this._onFrame(frame);
            }
        } catch (err) {
            this._options.log(`Microphone processing failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            this._draining = false;
        }
    }

    private async _onFrame(frame: Int16Array): Promise<void> {
        const db = frameDb(frame);
        this._level.push(frame, db);
        const loud = db >= BARGE_IN_DB;
        const confidence = await this._vad.confidence(frame);
        if (!this._state.active || this._muted) {
            return; // lost the voice or got muted while this frame was being scored
        }
        this._recent.push(frame);
        if (this._recent.length > BARGE_IN_PREROLL_FRAMES) {
            this._recent.shift();
        }
        if (this._bargeIn) {
            this._onBargeInFrame(this._bargeIn, frame, confidence, loud);
            return;
        }
        // Echo only exists while sound comes out; speech while the reply is still synthesizing is a plain interruption.
        if (this._state.botSpeaking && (confidence >= BARGE_IN_CONFIDENCE || loud)) {
            this._bargeIn = {
                evidenceMs: 0,
                checkAtMs: BARGE_IN_MS,
                quietMs: 0,
                verifying: false,
                finalChecked: false,
                confirmed: false,
                frames: this._recent.slice(0, -1),
            };
            this._segmenter = this._newSegmenter(); // the candidate owns this audio now
            this._onBargeInFrame(this._bargeIn, frame, confidence, loud);
            return;
        }
        const wasSpeaking = this._segmenter.inSpeech;
        for (const ev of this._segmenter.push(frame, confidence)) {
            if (ev.type === 'speechStart') {
                this._dispatch({ type: 'userSpeechStart', at: Date.now() });
            } else {
                this._finishSegment(ev.pcm);
            }
        }
        if (wasSpeaking && !this._segmenter.inSpeech) {
            this._vad.reset();
        }
    }

    /** Barge-in bookkeeping for one frame (prototype doc §4.3 state diagram). */
    private _onBargeInFrame(candidate: BargeIn, frame: Int16Array, confidence: number, loud: boolean): void {
        candidate.frames.push(frame);
        const speechLike = confidence >= this._options.vadConfidence || loud;
        candidate.quietMs = speechLike ? 0 : candidate.quietMs + FRAME_MS;
        if (confidence >= BARGE_IN_CONFIDENCE || loud) {
            candidate.evidenceMs += FRAME_MS;
        }
        if (candidate.confirmed) {
            if (candidate.quietMs >= this._options.turnStopSecs * 1000 || candidate.frames.length * FRAME_MS >= MAX_SEGMENT_SECS * 1000) {
                this._finishSegment(concatFrames(candidate.frames), candidate.heardText);
                this._endBargeIn();
            }
            return;
        }
        if (candidate.verifying) {
            return;
        }
        if (candidate.quietMs < BARGE_IN_GAP_MS) {
            if (candidate.evidenceMs >= candidate.checkAtMs) {
                this._verifyBargeIn(candidate);
            }
        } else if (!candidate.finalChecked && candidate.evidenceMs >= MIN_FINAL_CHECK_MS) {
            candidate.finalChecked = true;
            this._verifyBargeIn(candidate);
        } else {
            this._options.log(`Barge-in not confirmed (${Math.round(candidate.evidenceMs)} ms of evidence), dropped.`);
            this._endBargeIn();
        }
    }

    private _verifyBargeIn(candidate: BargeIn): void {
        candidate.verifying = true;
        const pcm = concatFrames(candidate.frames.slice(-BARGE_IN_WINDOW_FRAMES));
        const botText = echoSource(this._state);
        this._stt
            .transcribe(pcm, VAD_SAMPLE_RATE)
            .then(
                (text) => ({ text, verdict: classifyBargeIn(text, botText) }),
                (err: unknown) => ({ text: '', verdict: { kind: 'reject', reason: `STT failed: ${String(err)}` } as BargeInVerdict }),
            )
            .then(({ text, verdict }) => {
                if (this._bargeIn !== candidate) {
                    return; // ended meanwhile
                }
                candidate.verifying = false;
                if (verdict.kind === 'user') {
                    this._options.log(`Barge-in confirmed: "${text}"`);
                    candidate.confirmed = true;
                    candidate.heardText = text;
                    this._dispatch({ type: 'userSpeechStart', at: Date.now() });
                    return;
                }
                this._options.log(`Barge-in rejected (${verdict.reason}): "${text}"`);
                candidate.checkAtMs = candidate.evidenceMs + BARGE_IN_RECHECK_MS;
            });
    }

    private _endBargeIn(): void {
        this._bargeIn = undefined;
        this._segmenter = this._newSegmenter();
        this._vad.reset();
    }

    /** One utterance ended. `fallback`: text a barge-in check already heard, for when the whole transcribes badly. */
    private _finishSegment(pcm: Int16Array, fallback?: string): void {
        const now = Date.now();
        this._dispatch({ type: 'userSpeechEnd', at: now, silenceAt: now - this._options.turnStopSecs * 1000 });
        const result = this._stt.transcribe(pcm, VAD_SAMPLE_RATE).then(
            (text) => ({ text }),
            (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
        );
        this._delivery = this._delivery.then(async () => {
            const outcome = await result;
            let text = 'text' in outcome ? outcome.text : '';
            if ('error' in outcome) {
                this._options.log(`Speech-to-text failed: ${outcome.error}`);
            }
            if (isHallucination(text)) {
                this._options.log(`Dropped a speech-to-text hallucination: "${text}"`);
                text = '';
            }
            if (!text.trim() && fallback) {
                // The bot was already cut off for this speech; answering nothing would leave it silent.
                text = fallback;
            }
            this._dispatch({ type: 'transcript', text, at: Date.now() });
        });
    }
}

function concatFrames(frames: Int16Array[]): Int16Array {
    const pcm = new Int16Array(frames.length * VAD_FRAME_SAMPLES);
    frames.forEach((f, i) => pcm.set(f, i * VAD_FRAME_SAMPLES));
    return pcm;
}

/** Level (0..1) and waveform of each {@link BOT_LEVEL_MS} of a clip: what the voice bar shows as it plays. */
function speechLevels(pcm: Pcm): { level: number; wave: number[] }[] {
    const window = Math.max(1, Math.round((pcm.rate * BOT_LEVEL_MS) / 1000));
    const samples = new Int16Array(pcm.data.length >> 1);
    for (let i = 0; i < samples.length; i++) {
        samples[i] = pcm.data.readInt16LE(i * 2);
    }
    const out: { level: number; wave: number[] }[] = [];
    for (let start = 0; start < samples.length; start += window) {
        const end = Math.min(samples.length, start + window);
        const db = frameDb(samples.subarray(start, end));
        out.push({
            level: Math.min(1, Math.max(0, (db - BOT_FLOOR_DB) / (BOT_CEIL_DB - BOT_FLOOR_DB))),
            wave: wavePoints(samples, start, end, BOT_CEIL_DB),
        });
    }
    return out;
}

interface Clip {
    turnId: number;
    text: string;
    signal: AbortSignal;
    audio: Promise<Pcm>;
    /** Called when the clip starts playing, or when it cannot be synthesized or played. */
    onPlaying?: () => void;
}

/**
 * Synthesizes sentences concurrently and plays them in order on the audio page, which reports when
 * each clip really starts and ends (pipecat's output transport). Everything is scoped to the turn's
 * signal: on abort, queued clips are dropped, in-flight TTS requests and the fallback timer
 * cancelled, and the page's audio queue flushed; no report of that turn gets through afterwards.
 */
class Speaker {
    private _queue: Clip[] = [];
    private _pumping = false;
    /** Clips sent to the page, by clip id, until it reports them ended. */
    private readonly _onPage = new Map<number, { clip: Clip; pcm: Pcm; started: boolean }>();
    private _nextClipId = 1;
    private _turnSignal: AbortSignal | undefined;
    private _ttsFailed = false;
    /** Armed while nothing is synthesizing or playing: the bot has fallen silent once it fires. */
    private _fallback: NodeJS.Timeout | undefined;
    /** Reports the level of the clip playing now, timed from the page's `started` report. */
    private _meter: { clipId: number; timer: NodeJS.Timeout } | undefined;

    constructor(
        private readonly _tts: TtsClient,
        private readonly _audio: BrowserAudio,
        private readonly _dispatch: (ev: ConvEvent) => void,
        private readonly _log: (line: string) => void,
        private readonly _onLevel: (level: number, wave?: number[]) => void,
    ) {}

    enqueue(signal: AbortSignal, turnId: number, text: string, onPlaying?: () => void): void {
        if (signal.aborted) {
            return;
        }
        if (signal !== this._turnSignal) {
            this._turnSignal = signal;
            signal.addEventListener('abort', () => this._silence(), { once: true });
        }
        clearTimeout(this._fallback);
        const audio = this._tts.synthesize(text, signal);
        // A cut-off turn drops its queued clips unawaited; their aborted requests are expected.
        audio.catch(() => undefined);
        this._queue.push({ turnId, text, signal, audio, onPlaying });
        void this._pump();
    }

    /** The page's report on a clip; clips of a cut-off turn are no longer known here. */
    onPlayback(report: PlaybackReport): void {
        const entry = this._onPage.get(report.clipId);
        if (!entry) {
            return;
        }
        const { clip } = entry;
        if (report.type === 'started') {
            entry.started = true;
            this._meterStart(report.clipId, entry.pcm, report.at);
            this._dispatch({ type: 'sentencePlaying', turnId: clip.turnId, text: clip.text, durationMs: report.durationMs, at: report.at });
            clip.onPlaying?.();
            return;
        }
        this._onPage.delete(report.clipId);
        if (this._meter?.clipId === report.clipId) {
            this._meterStop();
        }
        if (entry.started) {
            this._dispatch({ type: 'sentencePlayed', turnId: clip.turnId, text: clip.text, at: report.at });
        } else {
            clip.onPlaying?.(); // never heard, like a clip TTS failed on
        }
        this._maybeIdle(clip);
    }

    private _silence(): void {
        this._queue = [];
        this._meterStop();
        this._onPage.clear();
        this._audio.flush();
        clearTimeout(this._fallback);
    }

    private async _pump(): Promise<void> {
        if (this._pumping) {
            return;
        }
        this._pumping = true;
        let last: Clip | undefined;
        while (this._queue.length > 0) {
            const clip = this._queue[0];
            let pcm: Pcm | undefined;
            try {
                pcm = await clip.audio;
                this._ttsFailed = false;
            } catch (err) {
                if (!clip.signal.aborted && !this._ttsFailed) {
                    // Once per failure streak: a dead service would otherwise log every sentence.
                    this._ttsFailed = true;
                    this._log(`Text-to-speech failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (this._queue[0] !== clip) {
                continue; // the turn was cancelled while this clip was being synthesized
            }
            this._queue.shift();
            last = clip;
            if (pcm) {
                const clipId = this._nextClipId++;
                this._onPage.set(clipId, { clip, pcm, started: false });
                this._audio.play(clipId, pcm.data, pcm.rate);
            } else {
                clip.onPlaying?.();
            }
        }
        this._pumping = false;
        if (last) {
            this._maybeIdle(last);
        }
    }

    private _meterStart(clipId: number, pcm: Pcm, at: number): void {
        clearInterval(this._meter?.timer);
        const windows = speechLevels(pcm);
        const timer = setInterval(() => {
            // The window playing now; a late tick skips ahead rather than replaying what was heard.
            const i = Math.floor((Date.now() - at) / BOT_LEVEL_MS);
            if (i >= windows.length) {
                this._meterStop();
                return;
            }
            const { level, wave } = windows[Math.max(0, i)];
            this._onLevel(level, wave);
        }, BOT_LEVEL_MS);
        this._meter = { clipId, timer };
    }

    private _meterStop(): void {
        if (this._meter) {
            clearInterval(this._meter.timer);
            this._meter = undefined;
            this._onLevel(0);
        }
    }

    /**
     * Once nothing is synthesizing or on the page, the turn's audio is idle; if its reply is still
     * being generated and stays silent for {@link BOT_STOP_FALLBACK_MS}, the bot stopped speaking.
     */
    private _maybeIdle(clip: Clip): void {
        if (clip.signal.aborted || this._pumping || this._queue.length > 0 || this._onPage.size > 0) {
            return;
        }
        const { turnId } = clip;
        this._dispatch({ type: 'audioIdle', turnId, at: Date.now() });
        clearTimeout(this._fallback);
        this._fallback = setTimeout(() => this._dispatch({ type: 'botStoppedSpeaking', turnId, at: Date.now() }), BOT_STOP_FALLBACK_MS);
    }
}
