/**
 * One dictation run: microphone → Silero VAD → speech segments → STT → text.
 *
 * VS Code webviews cannot open the microphone, so audio is captured in the
 * extension host by a command-line recorder (ALSA `arecord`, PulseAudio
 * `parecord`, sox `rec`) writing raw 16 kHz mono s16le to stdout — the same
 * fallback Claude Code's extension uses. Each utterance is transcribed as soon
 * as the VAD sees it end, so text lands in the composer while the user keeps
 * talking; transcripts are delivered in speaking order.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DictationStatus } from '../shared/protocol';
import { SpeechSegmenter, type SegmenterParams } from './speechSegmenter';
import { VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE, type SileroVad } from './sileroVad';
import type { SttClient } from './stt';

export interface DictationEvents {
    status(status: DictationStatus): void;
    text(text: string): void;
    /** Microphone level 0..1, ~10 times a second while recording. */
    level(level: number): void;
    error(message: string): void;
}

const FRAME_BYTES = VAD_FRAME_SAMPLES * 2;
/** Frames between level reports (2 × 32 ms ≈ 16 Hz, enough for a live waveform). */
const LEVEL_EVERY_FRAMES = 2;
/** dBFS mapped to level 0 and 1: laptop-mic room noise sits near -50, conversational speech at arm's length -35..-20. */
const LEVEL_FLOOR_DB = -50;
const LEVEL_CEIL_DB = -25;

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

export class DictationSession {
    private proc: ChildProcess | undefined;
    private draining: Promise<void> | undefined;
    private buffered: Buffer = Buffer.alloc(0);
    private readonly segmenter: SpeechSegmenter;
    private recording = false;
    private pending = 0;
    private frameCount = 0;
    private levelPeak = 0;
    private stderr = '';
    /** Chains transcript delivery so text arrives in speaking order. */
    private delivery: Promise<void> = Promise.resolve();

    constructor(
        private readonly vad: SileroVad,
        private readonly stt: SttClient,
        vadParams: SegmenterParams,
        private readonly events: DictationEvents,
    ) {
        this.segmenter = new SpeechSegmenter(vadParams, VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE);
    }

    get isRecording(): boolean {
        return this.recording;
    }

    /** Resolves once every transcription requested so far has been delivered. */
    get settled(): Promise<void> {
        return this.delivery;
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

    /** Stops the microphone; speech already captured is still transcribed. */
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
            this.transcribe(tail);
        }
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
            const frame = new Int16Array(VAD_FRAME_SAMPLES);
            let sumSquares = 0;
            for (let i = 0; i < VAD_FRAME_SAMPLES; i++) {
                const s = bytes.readInt16LE(i * 2);
                frame[i] = s;
                sumSquares += s * s;
            }
            this.reportLevel(Math.sqrt(sumSquares / VAD_FRAME_SAMPLES) / 32768);

            let confidence: number;
            try {
                confidence = await this.vad.confidence(frame);
            } catch (err) {
                this.events.error(`VAD failed: ${err instanceof Error ? err.message : String(err)}`);
                void this.stop();
                return;
            }
            const wasSpeaking = this.segmenter.inSpeech;
            for (const event of this.segmenter.push(frame, confidence)) {
                if (event.type === 'segment') {
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

    /** RMS → 0..1 between {@link LEVEL_FLOOR_DB} and {@link LEVEL_CEIL_DB}, peak-held over each report window. */
    private reportLevel(rms: number): void {
        const db = 20 * Math.log10(Math.max(rms, 1e-6));
        const level = (db - LEVEL_FLOOR_DB) / (LEVEL_CEIL_DB - LEVEL_FLOOR_DB);
        this.levelPeak = Math.max(this.levelPeak, Math.min(1, Math.max(0, level)));
        if (++this.frameCount % LEVEL_EVERY_FRAMES === 0) {
            this.events.level(this.levelPeak);
            this.levelPeak = 0;
        }
    }

    private transcribe(pcm: Int16Array): void {
        this.pending++;
        this.emitStatus();
        // Requests run concurrently; only delivery is serialized.
        const result = this.stt.transcribe(pcm, VAD_SAMPLE_RATE).then(
            (text) => ({ text }),
            (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
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
