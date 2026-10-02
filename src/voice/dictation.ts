/**
 * One dictation run: microphone → Silero VAD → speech segments → a handler (STT) → results.
 *
 * VS Code webviews cannot open the microphone, so audio is captured in the
 * extension host by a command-line recorder (ALSA `arecord`, PulseAudio
 * `parecord`, sox `rec`) writing raw 16 kHz mono s16le to stdout — the same
 * fallback Claude Code's extension uses. The VAD cuts the recording into utterances; each is
 * handled as soon as it ends (`asSpoken`: the settings dry run and voiceprint recordings) or all of
 * them once the recording stops (`onStop`: the composer mic). Results are delivered in speaking order.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DictationStatus, VoiceSettings } from '../shared/protocol';
import { findChrome, launchHiddenChrome, startBrowserAudio, type BrowserAudio } from './browserAudio';
import { MicLevelMeter, frameDb } from './micLevel';
import { describeError } from './modelsProbe';
import { transcribeChecked, type SpeechGate } from './speakerGate';
import { SpeechSegmenter, type SegmenterParams } from './speechSegmenter';
import { VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE, type SileroVad } from './sileroVad';
import type { SttClient } from './stt';

export interface DictationEvents<T> {
    status(status: DictationStatus): void;
    /** What the handler made of an utterance, in speaking order. */
    result(result: T): void;
    /** Microphone level 0..1 and its waveform ({@link wavePoints}), ~16 times a second while recording. */
    level(level: number, wave: number[]): void;
    error(message: string): void;
}

/** Turns an utterance (16 kHz) into what the session delivers; undefined delivers nothing. */
export type SegmentHandler<T> = (pcm: Int16Array) => Promise<T | undefined>;

/**
 * Dictation's handler: the transcript of each utterance, noise-reduced and checked against your
 * voiceprint by `gate` while it is transcribed. Someone else's voice, or silence, delivers nothing.
 */
export function transcribeUtterance(stt: SttClient, gate: SpeechGate | undefined): SegmentHandler<string> {
    return async (pcm) => {
        const { text, verdict } = await transcribeChecked((audio, rate) => stt.transcribe(audio, rate), gate, pcm, VAD_SAMPLE_RATE);
        return verdict.accepted && text ? text : undefined;
    };
}

const FRAME_BYTES = VAD_FRAME_SAMPLES * 2;
/** After a replay has played, dictation keeps dropping audio this much longer: the room's echo tail. */
const PAUSE_TAIL_MS = 300;

/** When captured utterances go to STT: as each ends, or all at once when the recording stops. */
export type TranscribeWhen = 'asSpoken' | 'onStop';

/** Linux tools first: sox `rec` there takes ~2 s to start delivering audio. */
const RECORDERS: { bin: string; args: string[] }[] = [
    { bin: 'arecord', args: ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw'] },
    { bin: 'parecord', args: ['--raw', '--format=s16le', '--rate=16000', '--channels=1'] },
    { bin: 'rec', args: ['-q', '--buffer', '1024', '-t', 'raw', '-r', '16000', '-e', 'signed', '-b', '16', '-c', '1', '-'] },
];

/**
 * Where a recorder sits when `PATH` does not say so: a macOS app launched from the Dock inherits a
 * minimal `PATH` without Homebrew, so the `rec` that `brew install sox` just put in
 * `/opt/homebrew/bin` would be invisible. Same fallback the CLI search uses (`piCliPaths.ts`).
 */
const EXTRA_RECORDER_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** The directories {@link findRecorder} looks in, `PATH` first. */
export function recorderSearchDirs(
    pathEnv: string = process.env.PATH ?? '',
    platform: NodeJS.Platform = process.platform,
): string[] {
    const dirs = pathEnv.split(platform === 'win32' ? ';' : ':').filter(Boolean);
    if (platform === 'win32') {
        return dirs;
    }
    return [...dirs, ...EXTRA_RECORDER_DIRS.filter((dir) => !dirs.includes(dir))];
}

/** What to install, in the words of the platform the user is on. Neither way of capturing is there. */
export function noRecorderMessage(platform: NodeJS.Platform = process.platform): string {
    const install =
        platform === 'darwin'
            ? 'install Google Chrome, or SoX (`brew install sox`)'
            : platform === 'linux'
              ? 'install alsa-utils (`sudo apt install alsa-utils`), pulseaudio-utils, SoX, or Google Chrome'
              : 'install Google Chrome, or SoX so that `rec` is on PATH';
    return `No way to record found. To use the microphone, ${install}.`;
}

/** getUserMedia's error name, in words that say what to do about it. */
export function micErrorMessage(error: string): string {
    if (/NotFound|DevicesNotFound|OverconstrainedError/i.test(error)) {
        return `No microphone found (${error}). Plug one in and select it as the input device in the system sound settings.`;
    }
    if (/NotAllowed|PermissionDenied|SecurityError/i.test(error)) {
        return `Microphone access was denied (${error}). Allow it for VS Code in the system privacy settings.`;
    }
    if (/NotReadable|TrackStart/i.test(error)) {
        return `The microphone could not be read (${error}). Close whatever else is using it, then try again.`;
    }
    return `The microphone could not be opened: ${error}`;
}

/** A recorder that quit on its own says why in its own words; add what that usually means. */
export function recorderExitHint(detail: string): string {
    return /can ?not open audio device|no such (audio )?device|unable to open/i.test(detail)
        ? ' — usually no microphone is connected, or none is selected as the input device.'
        : '';
}

export interface Recorder {
    command: string;
    args: string[];
}

/** How a run will capture: a command-line recorder if the machine has one, else the hidden browser. */
export type Capture = { kind: 'recorder'; recorder: Recorder } | { kind: 'browser'; chrome: string } | undefined;

/** Both lookups are arguments so this answers for a given machine, not only for the one running it. */
export function chooseCapture(
    dirs: string[] = recorderSearchDirs(),
    chrome: () => string | undefined = findChrome,
): Capture {
    const recorder = findRecorder(dirs);
    if (recorder) {
        return { kind: 'recorder', recorder };
    }
    // macOS ships no recorder at all, so without this fallback dictation needs `brew install sox`.
    const browser = chrome();
    return browser ? { kind: 'browser', chrome: browser } : undefined;
}

function findRecorder(dirs: string[] = recorderSearchDirs()): Recorder | undefined {
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
    for (const { bin, args } of RECORDERS) {
        for (const dir of dirs) {
            for (const ext of exts) {
                const candidate = path.join(dir, bin + ext);
                try {
                    fs.accessSync(candidate, fs.constants.X_OK);
                    return { command: candidate, args };
                } catch {
                    // keep looking
                }
            }
        }
    }
    return undefined;
}

/** How dictation cuts the microphone into utterances; shared by the chat mic and the settings dry run. */
export function dictationSegmenterParams(s: VoiceSettings): SegmenterParams {
    return { confidence: s.vadConfidence, startSecs: 0.15, stopSecs: s.vadStopSecs, preRollSecs: 0.3, maxSegmentSecs: 28 };
}

export class DictationSession<T = string> {
    private proc: ChildProcess | undefined;
    private browser: BrowserAudio | undefined;
    private chrome: { kill(): void } | undefined;
    private draining: Promise<void> | undefined;
    private buffered: Buffer = Buffer.alloc(0);
    private segmenter: SpeechSegmenter;
    private recording = false;
    private pending = 0;
    private readonly level: MicLevelMeter;
    private stderr = '';
    /** Chains result delivery so results arrive in speaking order. */
    private delivery: Promise<void> = Promise.resolve();
    /** Utterances waiting for `stop` (`onStop`), in speaking order. */
    private held: Int16Array[] = [];
    /** Audio is dropped until then: a replayed message is (or just was) coming out of the speakers. */
    private pausedUntil = 0;

    constructor(
        private readonly vad: SileroVad,
        private readonly handle: SegmentHandler<T>,
        private readonly vadParams: SegmenterParams,
        private readonly events: DictationEvents<T>,
        private readonly when: TranscribeWhen,
    ) {
        this.segmenter = new SpeechSegmenter(vadParams, VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE);
        this.level = new MicLevelMeter((level, wave) => this.events.level(level, wave));
    }

    get isRecording(): boolean {
        return this.recording;
    }

    /** Resolves once every result requested so far has been delivered. */
    get settled(): Promise<void> {
        return this.delivery;
    }

    /**
     * Paused while a Bot view message is replayed through the speakers: without echo cancellation
     * the microphone hears it, so the utterance in progress and everything captured until
     * {@link PAUSE_TAIL_MS} after the pause ends is dropped, never transcribed.
     */
    setPaused(paused: boolean): void {
        if (paused) {
            this.pausedUntil = Infinity;
            this.dropSpeech();
        } else if (this.pausedUntil === Infinity) {
            this.pausedUntil = Date.now() + PAUSE_TAIL_MS;
        }
    }

    start(): void {
        const capture = chooseCapture();
        if (!capture) {
            throw new Error(noRecorderMessage());
        }
        this.vad.reset();
        this.recording = true;
        this.emitStatus();
        if (capture.kind === 'recorder') {
            this.captureWithRecorder(capture.recorder);
        } else {
            this.captureWithBrowser(capture.chrome);
        }
    }

    private captureWithRecorder(recorder: Recorder): void {
        const proc = spawn(recorder.command, recorder.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        this.proc = proc;

        proc.stdout!.on('data', (chunk: Buffer) => this.onAudio(chunk));
        proc.stderr!.on('data', (chunk: Buffer) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-500);
        });
        proc.on('error', (err) => {
            this.events.error(`${path.basename(recorder.command)}: ${err.message}`);
            void this.stop();
        });
        proc.on('close', (code) => {
            if (this.recording) {
                // The recorder quit on its own (no device, permission, unplugged mic).
                const detail = this.stderr.trim() || `exit code ${code}`;
                this.events.error(`${path.basename(recorder.command)} stopped: ${detail}${recorderExitHint(detail)}`);
                void this.stop();
            }
        });
    }

    /**
     * The microphone through the same hidden browser voice mode uses: its page streams 16 kHz mono
     * s16le over a local WebSocket, the very format a recorder writes to stdout, and WebRTC gives
     * echo cancellation for free. Starting it takes a browser launch, so `start` does not wait.
     */
    private captureWithBrowser(chrome: string): void {
        void (async () => {
            try {
                const audio = await startBrowserAudio({
                    mic: (chunk) => this.onAudio(chunk),
                    micStatus: (error) => {
                        if (error !== undefined && this.recording) {
                            this.events.error(micErrorMessage(error));
                            void this.stop();
                        }
                    },
                    playback: () => undefined,
                    connected: () => undefined,
                    log: () => undefined,
                });
                if (!this.recording) {
                    // Stopped while the browser was coming up.
                    audio.close();
                    return;
                }
                this.browser = audio;
                this.chrome = launchHiddenChrome(chrome, audio.url, [], () => undefined);
            } catch (err) {
                if (this.recording) {
                    this.events.error(describeError(err));
                    void this.stop();
                }
            }
        })();
    }

    /** Stops the microphone; speech captured and not yet transcribed is transcribed now. */
    async stop(): Promise<void> {
        if (!this.recording) {
            return;
        }
        this.recording = false;
        this.proc?.kill();
        this.proc = undefined;
        this.chrome?.kill();
        this.chrome = undefined;
        this.browser?.close();
        this.browser = undefined;
        await this.draining;
        this.buffered = Buffer.alloc(0);
        const tail = this.segmenter.flush();
        if (tail) {
            this.held.push(tail);
        }
        for (const pcm of this.held) {
            this.transcribe(pcm);
        }
        this.held = [];
        this.emitStatus();
    }

    private onAudio(chunk: Buffer): void {
        if (!this.recording) {
            return;
        }
        this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
        this.draining ??= this.drain().finally(() => {
            this.draining = undefined;
        });
    }

    private async drain(): Promise<void> {
        while (this.buffered.length >= FRAME_BYTES) {
            const bytes = this.buffered.subarray(0, FRAME_BYTES);
            this.buffered = this.buffered.subarray(FRAME_BYTES);
            if (Date.now() < this.pausedUntil) {
                continue;
            }
            const frame = new Int16Array(VAD_FRAME_SAMPLES);
            for (let i = 0; i < VAD_FRAME_SAMPLES; i++) {
                frame[i] = bytes.readInt16LE(i * 2);
            }
            this.level.push(frame, frameDb(frame));

            let confidence: number;
            try {
                confidence = await this.vad.confidence(frame);
            } catch (err) {
                this.events.error(`VAD failed: ${err instanceof Error ? err.message : String(err)}`);
                void this.stop();
                return;
            }
            if (Date.now() < this.pausedUntil) {
                continue; // paused while this frame was being scored
            }
            const wasSpeaking = this.segmenter.inSpeech;
            for (const event of this.segmenter.push(frame, confidence)) {
                if (event.type !== 'segment') {
                    continue;
                }
                if (this.when === 'onStop') {
                    this.held.push(event.pcm);
                } else {
                    this.transcribe(event.pcm);
                }
            }
            if (!this.segmenter.inSpeech && wasSpeaking) {
                this.vad.reset();
            }
            if (this.segmenter.inSpeech !== wasSpeaking) {
                this.emitStatus();
            }
        }
    }

    /** Forgets the utterance in progress; the VAD starts over. */
    private dropSpeech(): void {
        const wasSpeaking = this.segmenter.inSpeech;
        this.segmenter = new SpeechSegmenter(this.vadParams, VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE);
        this.vad.reset();
        if (wasSpeaking) {
            this.emitStatus();
        }
    }

    private transcribe(pcm: Int16Array): void {
        this.pending++;
        this.emitStatus();
        // Utterances are handled concurrently; only delivery is serialized.
        const result = this.handle(pcm).then(
            (value) => ({ value }),
            (error: unknown) => ({ error: describeError(error) }),
        );
        this.delivery = this.delivery.then(async () => {
            const outcome = await result;
            this.pending--;
            if ('error' in outcome) {
                this.events.error(outcome.error);
            } else if (outcome.value !== undefined) {
                this.events.result(outcome.value);
            }
            this.emitStatus();
        });
    }

    private emitStatus(): void {
        this.events.status({
            recording: this.recording,
            speaking: this.recording && this.segmenter.inSpeech,
            pending: this.pending,
        });
    }
}
