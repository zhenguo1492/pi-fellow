/**
 * Voice mode: the audio loop around the voice agent (docs/voice-agent-design.md §4, §5.1–§5.7).
 * Microphone (hidden Chrome, AEC3) → Silero VAD → segments / barge-in check → STT → the
 * conversation reducer → VoiceAgent turns → sentence-by-sentence TTS → the same Chrome page.
 *
 * Every decision is in conversation.ts; this file wires devices and runs effects. Each reply is one
 * cancellation scope (an AbortController): the voice agent's run, its TTS requests, the fallback
 * timer and the page's audio queue all stop on `cancelTurn`, and nothing of that turn reaches the
 * reducer afterwards. What plays, and when, comes from the audio page's reports, not estimates.
 *
 * Either speech service may be missing (§5.13): without STT the microphone is never opened and
 * the user types; without TTS nothing is synthesized or played and replies are only shown as
 * text; without both there is no audio page at all, and voice mode is a typed conversation.
 */
import { voiceUserText, type VoiceAttachments, type VoiceSpeechCall, type VoiceUnavailable } from '../shared/voiceViewProtocol';
import type { CodeAnchor } from './codeAnchors';
import { echoSource, floorFree, initialState, phaseOf, reduce, type ConvEvent, type ConvState, type Effect, type Metrics, type Phase } from './conversation';
import { classifyBargeIn, isEchoOf, isHallucination, type BargeInVerdict } from './echoFilter';
import { findChrome, launchHiddenChrome, startBrowserAudio, type BrowserAudio, type PlaybackReport } from './browserAudio';
import type { ReplayOutput } from './replay';
import { ClipLevelMeter } from './botLevel';
import { TtsClient, type Pcm, type TtsRequestConfig } from './tts';
import type { ProactiveTurnHooks, VoiceAgent, VoiceTurnListener } from './voiceAgent';
import { SileroVad, VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE } from '../voice/sileroVad';
import { MicLevelMeter, frameDb } from '../voice/micLevel';
import { SpeechSegmenter } from '../voice/speechSegmenter';
import { SHORT_SPEECH_SECS, describeVerdict, transcribeChecked, voiceVetoesBargeIn, type SpeechGate } from '../voice/speakerGate';
import { SttClient, listSttModels, type SttConfig } from '../voice/stt';
import { describeError } from '../voice/modelsProbe';
import { VoiceServiceError, explainVoiceError } from '../voice/voiceErrors';

export interface VoiceModeOptions {
    agent: VoiceAgent;
    vad: { modelPath: string; runtimeDir: string };
    /** Speech-to-text; undefined (or no URL): voice mode cannot hear, the microphone stays closed and the user types. */
    stt: SttConfig | undefined;
    /** Text-to-speech; undefined (or no URL): replies are not spoken, only shown as text. */
    tts: TtsRequestConfig | undefined;
    /** Why `stt` / `tts` was left out, in plain words: the voice bar's tags show it. */
    unavailable?: VoiceUnavailable;
    /**
     * Noise reduction and the voiceprint check (src/voice/voiceprint.ts): an utterance in another
     * voice is not your turn, and cannot cut a reply off. Absent: every voice is heard.
     */
    gate?: SpeechGate;
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
    /**
     * Reply `turnId` has finished playing, not cut off, and every sentence it spoke was synthesized:
     * its audio, sentence by sentence as sent to TTS, for the replay cache.
     */
    onSpoken?(turnId: number, pieces: Array<{ text: string; pcm: Pcm }>): void;
    /** Each STT or TTS request that returned: what it used, for the Bot view's usage. */
    onSpeechUsage?(usage: VoiceSpeechCall): void;
    log(line: string): void;
    /**
     * A speech service failed mid-session, the first time since it last worked (`message` in plain
     * words). The conversation goes on: typed messages still reach the voice agent and its replies
     * still show as text.
     */
    onServiceError?(service: 'stt' | 'tts', message: string): void;
    /** The audio page could (`undefined`) or could not open the microphone; `unavailable` says so. */
    onMicStatus?(error: string | undefined): void;
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
// Kept low: the browser's echo cancellation turns your voice down while the bot talks. The STT
// check and the echo comparison, not these, keep the bot's own voice from cutting it off.
const BARGE_IN_CONFIDENCE = 0.4;
const BARGE_IN_DB = -40;
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
/** After a replay has played, the microphone stays held this much longer: the room's echo tail. */
const REPLAY_TAIL_MS = 300;
/** Speech starting this soon after a replay is checked against its text and dropped if it is the echo. */
const REPLAY_ECHO_MS = 3000;
/**
 * With the voiceprint check on, speech is a sound until the check finds it is you. The first check
 * runs once there is audio enough to compare rather than let through as short (a little over
 * {@link SHORT_SPEECH_SECS}, pre-roll included); a rejected one runs again after as much more.
 */
const SOUND_CHECK_FRAMES = Math.ceil((SHORT_SPEECH_SECS * 1000) / FRAME_MS);
/** Each check compares only the latest 1.5 s: a noise before you started does not drown your voice. */
const SOUND_WINDOW_FRAMES = Math.round(1500 / FRAME_MS);

/** A replay on the audio page (the Bot view's speaker button). */
interface Replay {
    /** As spoken: the echo reference. */
    text: string;
    /** Clips on the page: what to call as each starts playing and once it has played. */
    clips: Map<number, { started?: () => void; ended: () => void }>;
    /** Aborted when voice mode takes the speakers back. */
    ctl: AbortController;
}

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
    /** Began while the bot's voice played: checks rule out its echo, not only other voices. */
    echo: boolean;
    /** What the confirming check heard; stands in if the whole utterance transcribes badly. */
    heardText?: string;
    /** Audio from just before the speech started until now. */
    frames: Int16Array[];
}

/** A segment being heard while the voiceprint check is on, not yet found to be your voice. */
interface HeardSound {
    /** The latest {@link SOUND_WINDOW_FRAMES} frames. */
    frames: Int16Array[];
    /** Frames heard so far, pre-roll included. */
    heard: number;
    /** `heard` at which the next check runs. */
    checkAt: number;
    checking: boolean;
}

export class VoiceMode {
    private _state: ConvState;
    /** The reply in progress and its cancellation scope. */
    private _turn: { id: number; ctl: AbortController } | undefined;
    /** Anchors streamed since the last sentence went to TTS: they belong to the next one. */
    private _pendingAnchors: { turnId: number; anchors: CodeAnchor[] } | undefined;
    /** Absent without TTS: replies are only shown. Attached later when TTS becomes available (`useTts`). */
    private _speaker: Speaker | undefined;
    /** Absent without STT, like the VAD: the microphone is never opened. Attached later by `useStt`. */
    private _stt: SttClient | undefined;
    private _vad: SileroVad | undefined;
    /** Absent without STT and TTS: nothing to hear or play. Opened when one of them is attached. */
    private _audio: BrowserAudio | undefined;
    /** The audio page being opened, for callers attaching a service meanwhile. */
    private _opening: Promise<void> | undefined;
    /** STT failed on the last utterance: its next failure is not reported again. */
    private _sttFailed = false;
    private _segmenter: SpeechSegmenter;
    /** Owns the audio (the segmenter is not fed) from its first evidence until rejected or ended. */
    private _bargeIn: BargeIn | undefined;
    /** A segment being heard that the voiceprint check has not yet found to be you. */
    private _sound: HeardSound | undefined;
    private readonly _recent: Int16Array[] = [];
    /** Transcripts are delivered in speaking order. */
    private _delivery: Promise<void> = Promise.resolve();
    private _buffered: Buffer = Buffer.alloc(0);
    private _draining = false;
    private _chrome: { kill(): void } | undefined;
    private _stopped = false;
    private _muted = false;
    /** Clip ids on the audio page, shared by replies and replays. */
    private _nextClipId = 1;
    private _replay: Replay | undefined;
    /** Microphone input is dropped until then after a replay, for its echo tail. */
    private _replayTailUntil = 0;
    /** The last replay's text: an echo reference for speech starting before `until`. */
    private _replayEcho: { text: string; until: number } | undefined;
    /** Input was held for a replay: the VAD and segmenter start over once it is heard again. */
    private _heldForReplay = false;
    private readonly _level: MicLevelMeter;
    /** The audio page could not open the microphone (getUserMedia failed): why, until it can. */
    private _micError: string | undefined;

    private constructor(
        private readonly _options: VoiceModeOptions,
        devices: { vad?: SileroVad; audio?: BrowserAudio; stt?: SttConfig; tts?: TtsRequestConfig },
        /** The STT model in use: the configured one, else the first the server lists ('' if none or no STT). */
        private _sttModel: string,
        /** The speech services voice mode runs without, and why; an entry goes when its service is attached. */
        private readonly _without: VoiceUnavailable,
    ) {
        this._audio = devices.audio;
        this._vad = devices.vad;
        this._stt = devices.stt && this._sttClient(devices.stt);
        this._speaker = devices.tts && this._newSpeaker(devices.tts);
        this._state = initialState(_options.active, this._speaker !== undefined);
        this._segmenter = this._newSegmenter();
        this._level = new MicLevelMeter((level, wave) => _options.onLevel?.(level, wave));
    }

    /** Plays on the audio page, which is open whenever replies are voiced. */
    private _newSpeaker(tts: TtsRequestConfig): Speaker {
        return new Speaker(
            this._ttsClient(tts),
            {
                play: (pcm) => {
                    const clipId = this._nextClipId++;
                    this._audio?.play(clipId, pcm.data, pcm.rate);
                    return clipId;
                },
                // A flush drops every clip on the page, a replay's too.
                flush: () => {
                    this._preemptReplay('a reply was cut off');
                    this._audio?.flush();
                },
            },
            (ev) => this._dispatch(ev),
            this._options.log,
            (level, wave) => this._options.onBotLevel?.(level, wave),
            (message) => this._options.onServiceError?.('tts', message),
        );
    }

    private _sttClient(config: SttConfig): SttClient {
        return new SttClient(config, (usage) => this._options.onSpeechUsage?.({ service: 'stt', ...usage }));
    }

    private _ttsClient(config: TtsRequestConfig): TtsClient {
        return new TtsClient(config, (usage) => this._options.onSpeechUsage?.({ service: 'tts', ...usage }));
    }

    /** The STT model in use: the configured one, else the first the server listed ('' if unknown or no STT). */
    get sttModel(): string {
        return this._sttModel;
    }

    /**
     * Why voice mode runs without hearing (`stt`) or speaking (`tts`), in plain words: a service it
     * runs without, or a microphone the audio page cannot open.
     */
    get unavailable(): VoiceUnavailable {
        const mic = this._micError && `Can't open the microphone (${this._micError}). Check that one is connected and no other app holds it, then start the voice agent again.`;
        const stt = this._without.stt ?? mic;
        return { ...this._without, ...(stt ? { stt } : {}) };
    }

    /** Whether voice mode hears with STT / speaks with TTS now (it may still fail request by request). */
    uses(service: 'stt' | 'tts'): boolean {
        return service === 'stt' ? this._stt !== undefined : this._speaker !== undefined;
    }

    /**
     * Hears with `config` from now on (design §5.13). Voice mode running without STT checks it,
     * loads the VAD and has the audio page open the microphone (opening the page if there is none);
     * already hearing, the next utterance goes to the new settings. Throws, and stays as it was, if
     * the service or the page fails; `unavailable.stt` then says why.
     */
    async useStt(config: SttConfig): Promise<void> {
        if (this._stopped) {
            return;
        }
        if (this._stt) {
            this._stt = this._sttClient(config);
            this._sttModel = config.model.trim();
            this._sttFailed = false;
            return;
        }
        try {
            const models = await listSttModels(config.url, config.apiKey).catch(async (err: unknown) => {
                config.onOutcome?.(err);
                throw new VoiceServiceError('stt', err, Boolean((await config.apiKey?.())?.trim()));
            });
            const vad = this._vad ?? (await SileroVad.load(this._options.vad.modelPath, this._options.vad.runtimeDir));
            if (this._stopped || this._stt) {
                return;
            }
            this._vad = vad;
            this._stt = this._sttClient(config);
            this._sttModel = config.model.trim() || (models[0] ?? '');
            this._sttFailed = false;
            this._dropHeardAudio();
            await this._openAudio();
        } catch (err) {
            this._stt = undefined;
            this._without.stt = explainVoiceError(err, { service: 'stt' }).message;
            throw err;
        }
        delete this._without.stt;
        this._options.log('Speech-to-text is available: voice mode listens again.');
    }

    /**
     * Speaks with `config` from now on (design §5.13). Voice mode running without TTS opens the
     * audio page if there is none and voices replies from the next one on (a reply being shown as
     * text stays text); already speaking, the next sentence goes to the new settings. Throws, and
     * stays as it was, if the page fails; `unavailable.tts` then says why.
     */
    async useTts(config: TtsRequestConfig): Promise<void> {
        if (this._stopped) {
            return;
        }
        if (this._speaker) {
            this._speaker.setClient(this._ttsClient(config));
            return;
        }
        try {
            await this._openAudio();
        } catch (err) {
            this._without.tts = explainVoiceError(err, { service: 'tts' }).message;
            throw err;
        }
        if (this._stopped || this._speaker) {
            return;
        }
        this._speaker = this._newSpeaker(config);
        delete this._without.tts;
        this._dispatch({ type: 'voiced', voiced: true, at: Date.now() });
        this._options.log('Text-to-speech is available: replies are spoken again, from the next one.');
    }

    /**
     * Opens the audio page if it is not open (a hidden Chrome, else the default browser) and waits
     * until it connects; it captures the microphone while STT is attached.
     */
    private async _openAudio(): Promise<void> {
        if (!this._audio) {
            this._opening ??= this._launchAudio().finally(() => {
                this._opening = undefined;
            });
            await this._opening;
        }
        if (this._stt) {
            this._audio?.enableCapture();
        }
        this._setMic(this._state.active);
    }

    private async _launchAudio(): Promise<void> {
        const { log } = this._options;
        const connected = Promise.withResolvers<void>();
        const audio = await startBrowserAudio(
            {
                mic: (chunk) => this._onMic(chunk),
                micStatus: (error) => this._onMicStatus(error),
                playback: (report) => this._onPlayback(report),
                connected: (on) => {
                    log(on ? 'Audio page connected.' : 'Audio page disconnected.');
                    if (on) {
                        connected.resolve();
                    }
                },
                log,
            },
            { capture: this._stt !== undefined },
        );
        if (this._stopped) {
            audio.close();
            return;
        }
        this._audio = audio;
        this._setMic(this._state.active);
        const chrome = findChrome();
        if (!chrome) {
            log('No Chrome, Edge, Chromium or Brave found: opening the audio page in the default browser. Keep that tab open.');
            this._options.openExternal(audio.url);
            return;
        }
        const hidden = launchHiddenChrome(chrome, audio.url, this._options.chromeArgs, log);
        this._chrome = hidden;
        log(`Hidden browser: ${chrome}`);
        const timeout = setTimeout(() => connected.reject(new Error('The hidden audio page did not connect.')), CONNECT_TIMEOUT_MS);
        try {
            await connected.promise;
        } catch (err) {
            // Nothing is left half open: the next attempt starts over.
            hidden.kill();
            audio.close();
            if (this._audio === audio) {
                this._audio = undefined;
                this._chrome = undefined;
            }
            throw err;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Checks STT, loads the VAD, opens the audio page and waits until it is connected. A speech
     * service left out, or STT failing its check, is not an error: voice mode runs without it
     * (`unavailable` says why), and without both it opens no audio page.
     */
    static async start(options: VoiceModeOptions): Promise<VoiceMode> {
        const { log } = options;
        const unavailable: VoiceUnavailable = {};
        let stt = options.stt?.url ? options.stt : undefined;
        const tts = options.tts?.url ? options.tts : undefined;
        if (!stt) {
            unavailable.stt = options.unavailable?.stt ?? 'Speech-to-text is not set up: choose it in Settings → Voice.';
        }
        if (!tts) {
            unavailable.tts = options.unavailable?.tts ?? 'Text-to-speech is not set up: choose it in Settings → Voice.';
        }
        let sttModel = '';
        if (stt) {
            const config = stt;
            try {
                const models = await listSttModels(config.url, config.apiKey);
                sttModel = config.model.trim() || (models[0] ?? '');
            } catch (err) {
                // A real failure of the service: readiness hears of it too.
                config.onOutcome?.(err);
                const hasKey = Boolean((await config.apiKey?.())?.trim());
                unavailable.stt = explainVoiceError(new VoiceServiceError('stt', err, hasKey)).message;
                log(`Speech-to-text failed its check: ${unavailable.stt} (${describeError(err)})`);
                stt = undefined;
            }
        }
        if (unavailable.stt) {
            log('Voice mode does not listen: speech-to-text is unavailable. Type to the voice agent instead.');
        }
        if (unavailable.tts) {
            log('Voice mode does not speak: text-to-speech is unavailable. Replies are shown as text.');
        }
        const vad = stt ? await SileroVad.load(options.vad.modelPath, options.vad.runtimeDir) : undefined;
        const mode = new VoiceMode(options, { vad, stt, tts }, sttModel, unavailable);
        if (stt || tts) {
            try {
                await mode._openAudio();
            } catch (err) {
                await mode.stop();
                throw err;
            }
        } else {
            log('Neither speech service is available: no audio page. Type to the voice agent; its replies are shown as text.');
        }
        options.onPhase(phaseOf(mode._state));
        return mode;
    }

    /** Someone is talking, being transcribed, or being answered, or a message is being replayed: the voice agent should not speak up. */
    get floorBusy(): boolean {
        return !floorFree(this._state) || this._replay !== undefined;
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
     * progress is dropped, like standing by. Without STT there is no microphone to mute.
     */
    setMuted(muted: boolean): void {
        if (this._stopped || muted === this._muted || !this._stt) {
            return;
        }
        this._muted = muted;
        this._setMic(this._state.active);
        if (muted) {
            this._abandonHeardSpeech();
        }
        this._options.log(muted ? 'Microphone muted.' : 'Microphone unmuted.');
    }

    /** The page's microphone is on while this window has the voice, unmuted, and there is STT to hear with. */
    private _setMic(active: boolean): void {
        this._audio?.setMic(this._stt !== undefined && active && !this._muted);
    }

    /**
     * Takes the audio page for a replay of `text` (the Bot view's speaker button), which Chrome's echo
     * canceller then removes from the microphone like a reply. Refused while a reply is being
     * synthesized or played. Until the replay is over, and {@link REPLAY_TAIL_MS} after, microphone
     * input is dropped, and for {@link REPLAY_ECHO_MS} speech that repeats `text` is dropped as its
     * echo. The voice agent starting to speak, hush, standing by or stopping ends it (`signal`).
     * Undefined without an audio page (no STT and no TTS): the Bot view plays it.
     */
    beginReplay(text: string): ReplayOutput | string | undefined {
        if (this._stopped) {
            return 'Voice mode is stopping.';
        }
        const audio = this._audio;
        if (!audio) {
            return undefined;
        }
        if (this._state.ttsActive || this._state.botSpeaking) {
            return 'The voice agent is speaking; replay the message once it has finished.';
        }
        this._endReplay(this._replay);
        const replay: Replay = { text, clips: new Map(), ctl: new AbortController() };
        this._replay = replay;
        this._abandonHeardSpeech();
        this._options.log('Replaying a message: the microphone is held until it has played.');
        return {
            signal: replay.ctl.signal,
            play: (pcm, onPlaying) =>
                new Promise<void>((resolve) => {
                    if (this._replay !== replay) {
                        resolve();
                        return;
                    }
                    const clipId = this._nextClipId++;
                    replay.clips.set(clipId, { started: onPlaying, ended: resolve });
                    audio.play(clipId, pcm.data, pcm.rate);
                }),
            end: () => this._endReplay(replay),
        };
    }

    /** Stops the reply being spoken, as if the user had interrupted it without a new message; a replay too. */
    hush(): void {
        this._preemptReplay('hushed');
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
        this._setMic(active);
        if (!active) {
            this._preemptReplay('another window has the voice');
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
        this._preemptReplay('voice mode stopped');
        this._turn?.ctl.abort();
        this._chrome?.kill();
        this._audio?.close();
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
            const spoken = this._speaker?.takeSpoken(turnId);
            if (spoken) {
                this._options.onSpoken?.(turnId, spoken);
            }
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
                if (this._turn?.id === effect.turnId && this._speaker) {
                    // The voice agent speaks: a replay stops before the reply's audio reaches the page.
                    this._preemptReplay('the voice agent is speaking');
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
     * Anchors go to `log` as they stream and to `onAnchors` as the sentence they precede starts
     * playing, or at once when replies are not spoken.
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
                if (!this._speaker) {
                    this._options.onAnchors?.([anchor]);
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
        this._sound = undefined;
        this._segmenter = this._newSegmenter();
        this._vad?.reset();
    }

    /** Drops what is being heard, ending the user's turn in progress with nothing said, and zeroes the mic level. */
    private _abandonHeardSpeech(): void {
        this._dropHeardAudio();
        if (this._state.userSpeaking || this._state.soundDetected) {
            const now = Date.now();
            this._dispatch({ type: 'userSpeechEnd', at: now, silenceAt: now });
            this._dispatch({ type: 'transcript', text: '', at: now });
        }
        this._options.onLevel?.(0);
    }

    // ── replays of Bot view messages ─────────────────────────────────────────

    /** A replay holds the microphone while it plays and for its echo tail. */
    private _replayHoldsInput(): boolean {
        return this._replay !== undefined || Date.now() < this._replayTailUntil;
    }

    /** The replay text speech starting at `at` could be the echo of, else ''. */
    private _replayEchoText(at: number): string {
        return this._replay?.text ?? (this._replayEcho && at < this._replayEcho.until ? this._replayEcho.text : '');
    }

    /** Ends `replay` if it is the current one: drops its clips still on the page and starts the echo tail. */
    private _endReplay(replay: Replay | undefined): void {
        if (!replay || this._replay !== replay) {
            return;
        }
        this._replay = undefined;
        if (replay.clips.size > 0) {
            // Only the replay is on the page: a reply refuses or ends a replay before its audio goes out.
            this._audio?.flush();
            for (const clip of replay.clips.values()) {
                clip.ended();
            }
            replay.clips.clear();
        }
        const now = Date.now();
        this._replayTailUntil = now + REPLAY_TAIL_MS;
        this._replayEcho = { text: replay.text, until: now + REPLAY_ECHO_MS };
    }

    /** Voice mode takes the speakers back from a replay. */
    private _preemptReplay(why: string): void {
        const replay = this._replay;
        if (replay) {
            this._options.log(`Replay stopped: ${why}.`);
            this._endReplay(replay);
            replay.ctl.abort();
        }
    }

    /** The page's report on a clip: a replay's, else the reply speaker's. */
    private _onPlayback(report: PlaybackReport): void {
        const clip = this._replay?.clips.get(report.clipId);
        if (!clip) {
            this._speaker?.onPlayback(report);
            return;
        }
        if (report.type === 'started') {
            clip.started?.();
        } else {
            this._replay!.clips.delete(report.clipId);
            clip.ended();
        }
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

    /** The page reports whether it could open the microphone; only a change is passed on. */
    private _onMicStatus(error: string | undefined): void {
        if (this._stopped || error === this._micError) {
            return;
        }
        this._micError = error;
        this._options.log(error ? `The audio page could not open the microphone: ${error}` : 'The audio page opened the microphone.');
        this._options.onMicStatus?.(error);
    }

    private _onMic(chunk: Buffer): void {
        // Standing by or muted: the page's track is off, and any frames still in flight are not ours to hear.
        // Without STT the page captures nothing; nothing is ours to hear either.
        if (!this._stt || !this._state.active || this._muted) {
            return;
        }
        // A replay plays: whatever the microphone hears now is not the user's turn.
        if (this._replayHoldsInput()) {
            this._heldForReplay = true;
            return;
        }
        if (this._heldForReplay) {
            this._heldForReplay = false;
            this._dropHeardAudio();
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
        const vad = this._vad;
        if (!vad) {
            return;
        }
        const db = frameDb(frame);
        this._level.push(frame, db);
        const loud = db >= BARGE_IN_DB;
        const confidence = await vad.confidence(frame);
        if (!this._state.active || this._muted || this._replayHoldsInput()) {
            return; // lost the voice, got muted or a replay started while this frame was being scored
        }
        this._recent.push(frame);
        if (this._recent.length > BARGE_IN_PREROLL_FRAMES) {
            this._recent.shift();
        }
        if (this._bargeIn) {
            this._onBargeInFrame(this._bargeIn, frame, confidence, loud);
            return;
        }
        // Echo only exists while sound comes out; speech while the reply is still synthesizing is a plain
        // interruption. With the voiceprint check on, speech during any reply must be yours before it cuts the reply off.
        const speechLike = confidence >= BARGE_IN_CONFIDENCE || loud;
        if (speechLike && (this._state.botSpeaking || (this._state.bot !== undefined && this._options.gate?.active === true))) {
            this._bargeIn = {
                evidenceMs: 0,
                checkAtMs: BARGE_IN_MS,
                quietMs: 0,
                verifying: false,
                finalChecked: false,
                confirmed: false,
                echo: this._state.botSpeaking,
                frames: this._recent.slice(0, -1),
            };
            this._segmenter = this._newSegmenter(); // the candidate owns this audio now
            this._sound = undefined;
            if (this._state.soundDetected) {
                this._dispatch({ type: 'userSoundEnd', at: Date.now() });
            }
            this._onBargeInFrame(this._bargeIn, frame, confidence, loud);
            return;
        }
        const wasSpeaking = this._segmenter.inSpeech;
        for (const ev of this._segmenter.push(frame, confidence)) {
            if (ev.type === 'segment') {
                this._sound = undefined;
                this._finishSegment(ev.pcm);
            } else if (this._options.gate?.active) {
                // Only a sound until the voiceprint check finds it is you (`_checkSound`).
                this._sound = { frames: this._recent.slice(-SOUND_WINDOW_FRAMES), heard: this._recent.length, checkAt: SOUND_CHECK_FRAMES, checking: false };
                this._dispatch({ type: 'userSoundStart', at: Date.now() });
            } else {
                this._dispatch({ type: 'userSpeechStart', at: Date.now() });
            }
        }
        const sound = this._sound;
        if (sound && this._segmenter.inSpeech && sound.frames.at(-1) !== frame) {
            sound.frames.push(frame);
            sound.heard++;
            if (sound.frames.length > SOUND_WINDOW_FRAMES) {
                sound.frames.shift();
            }
        }
        if (sound && !sound.checking && sound.heard >= sound.checkAt) {
            this._checkSound(sound);
        }
        if (wasSpeaking && !this._segmenter.inSpeech) {
            vad.reset();
        }
    }

    /**
     * The voiceprint check on the latest audio of a sound still being heard, as soon as there is enough
     * of it to judge: your voice turns it into speech (`userSpeechStart`, "Hearing you") while you are
     * still talking; another voice or noise stays a sound, checked again as more comes in. The finished
     * segment is checked on its own either way, and that check decides whether its words count.
     */
    private _checkSound(sound: HeardSound): void {
        const gate = this._options.gate;
        if (!gate) {
            return; // unreachable: sounds are only heard with a gate
        }
        sound.checking = true;
        const pcm = concatFrames(sound.frames);
        gate.prepare(pcm, VAD_SAMPLE_RATE)
            .then((clean) => gate.accept(clean, VAD_SAMPLE_RATE))
            .then(
                (verdict) => {
                    if (this._sound !== sound) {
                        return; // the segment ended or was dropped meanwhile
                    }
                    sound.checking = false;
                    if (verdict.accepted) {
                        this._sound = undefined;
                        this._options.log(`Hearing you (${describeVerdict(verdict)}).`);
                        this._dispatch({ type: 'userSpeechStart', at: Date.now() });
                        return;
                    }
                    sound.checkAt = sound.heard + SOUND_CHECK_FRAMES;
                },
                (err: unknown) => {
                    this._options.log(`Voiceprint check of the sound failed: ${describeError(err)}`);
                    if (this._sound === sound) {
                        sound.checking = false;
                        sound.checkAt = sound.heard + SOUND_CHECK_FRAMES;
                    }
                },
            );
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
        const stt = this._stt;
        if (!stt) {
            return; // unreachable: without STT nothing is captured
        }
        candidate.verifying = true;
        const pcm = concatFrames(candidate.frames.slice(-BARGE_IN_WINDOW_FRAMES));
        const botText = `${echoSource(this._state)} ${this._replayEchoText(Date.now())}`.trim();
        // Barge-in windows are often under a second: compare them anyway, or a TV's short line cuts the bot off.
        transcribeChecked((audio, rate) => stt.transcribe(audio, rate), this._options.gate, pcm, VAD_SAMPLE_RATE, true)
            .then(
                ({ text, verdict: voice }) => {
                    this._options.log(`Barge-in voice: ${describeVerdict(voice)}.`);
                    let verdict: BargeInVerdict;
                    // While the bot plays, its echo mixes into your voice and drags the voiceprint score
                    // down, so there only a clearly other voice (TV, children) is refused; the echo check
                    // below decides the rest. The finished segment still goes through the voiceprint.
                    if (voiceVetoesBargeIn(voice, candidate.echo)) {
                        verdict = { kind: 'reject', reason: `not your voice: ${describeVerdict(voice)}` };
                    } else if (candidate.echo) {
                        verdict = classifyBargeIn(text, botText);
                    } else {
                        // Nothing plays, so no echo: any real words in your voice cut the reply off.
                        verdict = isHallucination(text) || !text.trim() ? { kind: 'reject', reason: 'no words' } : { kind: 'user' };
                    }
                    return { text, verdict };
                },
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
        this._vad?.reset();
    }

    /** One utterance ended. `fallback`: text a barge-in check already heard, for when the whole transcribes badly. */
    private _finishSegment(pcm: Int16Array, fallback?: string): void {
        const stt = this._stt;
        if (!stt) {
            return; // unreachable: without STT nothing is captured
        }
        const now = Date.now();
        const echoOf = this._replayEchoText(now - (pcm.length / VAD_SAMPLE_RATE) * 1000);
        this._dispatch({ type: 'userSpeechEnd', at: now, silenceAt: now - this._options.turnStopSecs * 1000 });
        // Heard and checked against the voiceprint at once; the check never fails the transcription.
        const result = transcribeChecked((audio, rate) => stt.transcribe(audio, rate), this._options.gate, pcm, VAD_SAMPLE_RATE).then(
            (heard) => heard,
            (err: unknown) => ({ error: describeError(err) }),
        );
        this._delivery = this._delivery.then(async () => {
            const outcome = await result;
            let text = 'text' in outcome ? outcome.text : '';
            if ('verdict' in outcome && !outcome.verdict.accepted) {
                // Someone else's voice: not a turn. The transcript event still goes out, empty, to close the userSpeechEnd above.
                this._options.log(`Dropped an utterance in another voice (${describeVerdict(outcome.verdict)}): "${text}"`);
                text = '';
            }
            if ('error' in outcome) {
                const message = explainVoiceError(outcome.error, { service: 'stt' }).message;
                this._options.log(`Speech-to-text failed: ${message} (${outcome.error})`);
                if (!this._sttFailed) {
                    this._options.onServiceError?.('stt', message);
                }
            }
            this._sttFailed = 'error' in outcome;
            if (isHallucination(text)) {
                this._options.log(`Dropped a speech-to-text hallucination: "${text}"`);
                text = '';
            }
            if (echoOf && text.trim() && isEchoOf(text, echoOf)) {
                this._options.log(`Dropped the echo of a replayed message: "${text}"`);
                text = '';
            }
            if (!text.trim() && fallback) {
                // The bot was already cut off for this speech (by words the voiceprint check let through); answering nothing would leave it silent.
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

interface Clip {
    turnId: number;
    text: string;
    signal: AbortSignal;
    audio: Promise<Pcm>;
    /** Called when the clip starts playing, or when it cannot be synthesized or played. */
    onPlaying?: () => void;
}

/** The audio page as the reply speaker uses it: `play` names the clip (ids are shared with replays). */
interface SpeakerAudio {
    play(pcm: Pcm): number;
    flush(): void;
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
    private _turnSignal: AbortSignal | undefined;
    private _ttsFailed = false;
    /** Armed while nothing is synthesizing or playing: the bot has fallen silent once it fires. */
    private _fallback: NodeJS.Timeout | undefined;
    /** Reports the level of the clip playing now, timed from the page's `started` report. */
    private readonly _meter: ClipLevelMeter;
    /** The clip `_meter` reports. */
    private _meterClip: number | undefined;
    /** The audio of the reply being spoken, sentence by sentence; `undefined` for a sentence TTS failed on. */
    private _spoken: { turnId: number; pieces: Array<{ text: string; pcm?: Pcm }> } | undefined;

    constructor(
        private _tts: TtsClient,
        private readonly _audio: SpeakerAudio,
        private readonly _dispatch: (ev: ConvEvent) => void,
        private readonly _log: (line: string) => void,
        onLevel: (level: number, wave?: number[]) => void,
        /** TTS failed, the first time since it last worked: what went wrong, in plain words. */
        private readonly _onError: (message: string) => void,
    ) {
        this._meter = new ClipLevelMeter(onLevel);
    }

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

    /** New TTS settings: sentences from now on are synthesized with `tts`; those already sent keep theirs. */
    setClient(tts: TtsClient): void {
        this._tts = tts;
        this._ttsFailed = false;
    }

    /** Reply `turnId`'s audio, if every sentence of it was synthesized; forgotten either way. */
    takeSpoken(turnId: number): Array<{ text: string; pcm: Pcm }> | undefined {
        const spoken = this._spoken?.turnId === turnId ? this._spoken.pieces : [];
        this._spoken = undefined;
        return spoken.length > 0 && spoken.every((piece): piece is { text: string; pcm: Pcm } => piece.pcm !== undefined) ? spoken : undefined;
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
            this._meterClip = report.clipId;
            this._meter.start(entry.pcm, report.at);
            this._dispatch({ type: 'sentencePlaying', turnId: clip.turnId, text: clip.text, durationMs: report.durationMs, at: report.at });
            clip.onPlaying?.();
            return;
        }
        this._onPage.delete(report.clipId);
        if (this._meterClip === report.clipId) {
            this._meter.stop();
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
        this._meter.stop();
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
                    const message = explainVoiceError(err, { service: 'tts' }).message;
                    this._log(`Text-to-speech failed: ${message} (${describeError(err)})`);
                    this._onError(message);
                }
            }
            if (this._queue[0] !== clip) {
                continue; // the turn was cancelled while this clip was being synthesized
            }
            this._queue.shift();
            last = clip;
            if (this._spoken?.turnId !== clip.turnId) {
                this._spoken = { turnId: clip.turnId, pieces: [] };
            }
            this._spoken.pieces.push({ text: clip.text, pcm });
            if (pcm) {
                // Reports arrive asynchronously: registering after `play` misses none.
                this._onPage.set(this._audio.play(pcm), { clip, pcm, started: false });
            } else {
                clip.onPlaying?.();
            }
        }
        this._pumping = false;
        if (last) {
            this._maybeIdle(last);
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
