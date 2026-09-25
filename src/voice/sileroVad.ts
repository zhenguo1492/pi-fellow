/**
 * Silero VAD v5 (the model pipecat ships as `silero_vad.onnx`) on the
 * onnxruntime-web WASM backend, so the extension carries no native binaries.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { InferenceSession, Tensor, env } from 'onnxruntime-web';

export const VAD_SAMPLE_RATE = 16000;
/** Silero consumes 512-sample (32 ms) windows at 16 kHz. */
export const VAD_FRAME_SAMPLES = 512;
/** Tail of the previous window the model expects in front of each new one. */
const CONTEXT_SAMPLES = 64;
/**
 * Windows between unconditional state resets (5 s, as pipecat's silero.py does). Without them the
 * recurrent state drifts on a long stream until real speech scores ~0: measured on a 55 s
 * echo-cancelled mic recording, speech at 45 s scored 0.0 with continuous state and 0.9 with resets.
 */
const RESET_EVERY_FRAMES = Math.round((5 * VAD_SAMPLE_RATE) / VAD_FRAME_SAMPLES);

export class SileroVad {
    private readonly input = new Float32Array(CONTEXT_SAMPLES + VAD_FRAME_SAMPLES);
    private readonly sampleRate = new Tensor('int64', BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), []);
    private state!: Tensor;
    private framesSinceReset = 0;

    private constructor(private readonly session: InferenceSession) {
        this.reset();
    }

    /**
     * @param modelPath silero_vad.onnx
     * @param runtimeDir directory holding onnxruntime-web's `ort-wasm-simd-threaded.{mjs,wasm}`
     */
    static async load(modelPath: string, runtimeDir: string): Promise<SileroVad> {
        // Single-threaded: no worker_threads in the extension host, and one
        // 32 ms window costs well under a millisecond.
        env.wasm.numThreads = 1;
        env.wasm.wasmPaths = pathToFileURL(runtimeDir + path.sep).href;
        return new SileroVad(await InferenceSession.create(modelPath));
    }

    /** Clears the recurrent state; call between independent utterances. */
    reset(): void {
        this.state = new Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
        this.input.fill(0, 0, CONTEXT_SAMPLES);
        this.framesSinceReset = 0;
    }

    /** Speech probability (0..1) for one {@link VAD_FRAME_SAMPLES}-sample window. */
    async confidence(frame: Int16Array): Promise<number> {
        for (let i = 0; i < VAD_FRAME_SAMPLES; i++) {
            this.input[CONTEXT_SAMPLES + i] = frame[i] / 32768;
        }
        const out = await this.session.run({
            input: new Tensor('float32', this.input, [1, this.input.length]),
            state: this.state,
            sr: this.sampleRate,
        });
        this.state = out.stateN;
        this.input.copyWithin(0, VAD_FRAME_SAMPLES);
        if (++this.framesSinceReset >= RESET_EVERY_FRAMES) {
            this.reset();
        }
        return (out.output.data as Float32Array)[0];
    }
}
