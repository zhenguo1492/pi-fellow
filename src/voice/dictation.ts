/**
 * One dictation run: microphone → Silero VAD → speech segments → STT → text.
 *
 * VS Code webviews cannot open the microphone, so audio is captured in the
 * extension host by a command-line recorder (ALSA `arecord`, PulseAudio
 * `parecord`, sox `rec`) writing raw 16 kHz mono s16le to stdout — the same
 * fallback Claude Code's extension uses. The VAD cuts the recording into utterances; each is
 * transcribed as soon as it ends (`asSpoken`: the settings dry run) or all of them once the
 * recording stops (`onStop`: the composer mic). Transcripts are delivered in speaking order.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DictationStatus, VoiceSettings } from '../shared/protocol';
import { MicLevelMeter, frameDb } from './micLevel';
import { describeError } from './modelsProbe';
import { SpeechSegmenter, type SegmenterParams } from './speechSegmenter';
import { VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE, type SileroVad } from './sileroVad';
import type { SttClient } from './stt';

export interface DictationEvents {
    status(status: DictationStatus): void;
    text(text: string): void;
    /** Microphone level 0..1 and its waveform ({@link wavePoints}), ~16 times a second while recording. */
    level(level: number, wave: number[]): void;
    error(message: string): void;
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

function findRecorder(): { command: string; args: string[] } | undefined {
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
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

export class DictationSession {
    private proc: ChildProcess | undefined;
    private draining: Promise<void> | undefined;
    private buffered: Buffer = Buffer.alloc(0);
    private segmenter: SpeechSegmenter;
    private recording = false;
    private pending = 0;
    private readonly level: MicLevelMeter;
    private stderr = '';
    /** Chains transcript delivery so text arrives in speaking order. */
    private delivery: Promise<void> = Promise.resolve();
    /** Utterances waiting for `stop` (`onStop`), in speaking order. */
    private held: Int16Array[] = [];
    /** Audio is dropped until then: a replayed message is (or just was) coming out of the speakers. */
    private pausedUntil = 0;

    constructor(
        private readonly vad: SileroVad,
        private readonly stt: SttClient,
        private readonly vadParams: SegmenterParams,
        private readonly events: DictationEvents,
        private readonly when: TranscribeWhen,
    ) {
        this.segmenter = new SpeechSegmenter(vadParams, VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE);
        this.level = new MicLevelMeter((level, wave) => this.events.level(level, wave));
    }

    get isRecording(): boolean {
        return this.recording;
    }

    /** Resolves once every transcription requested so far has been delivered. */
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
        const recorder = findRecorder();
        if (!recorder) {
            throw new Error(
                'No audio recorder found. Install SoX (`rec`) or, on Linux, alsa-utils (`arecord`) / pulseaudio-utils (`parecord`).',
            );
        }
        this.vad.reset();
        const proc = spawn(recorder.command, recorder.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        this.proc = proc;
        this.recording = true;
        this.emitStatus();

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
                this.events.error(`${path.basename(recorder.command)} stopped: ${detail}`);
                void this.stop();
            }
        });
    }

    /** Stops the microphone; speech captured and not yet transcribed is transcribed now. */
    async stop(): Promise<void> {
        if (!this.recording) {
            return;
        }
        this.recording = false;
        this.proc?.kill();
        this.proc = undefined;
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
        // Requests run concurrently; only delivery is serialized.
        const result = this.stt.transcribe(pcm, VAD_SAMPLE_RATE).then(
            (text) => ({ text }),
            (error: unknown) => ({ error: describeError(error) }),
        );
        this.delivery = this.delivery.then(async () => {
            const outcome = await result;
            this.pending--;
            if ('error' in outcome) {
                this.events.error(outcome.error);
            } else if (outcome.text) {
                this.events.text(outcome.text);
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
