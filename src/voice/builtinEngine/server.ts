/**
 * The built-in voice engine: Moonshine (speech-to-text) and Piper (text-to-speech) on sherpa-onnx,
 * behind the OpenAI-compatible endpoints SttClient and TtsClient already call, plus two private
 * ones: speaker embeddings for the voiceprint check and GTCRN noise reduction. It runs in its own
 * process (VS Code's Electron as Node, started by ./engine.ts), so inference never blocks the
 * extension host.
 *
 * Config: env `OMP_VOICE_ENGINE`, an `EngineConfig` in JSON; only the models it names are loaded,
 * and endpoints of the others answer 503. Listens on 127.0.0.1 under `/<token>/v1`, prints
 * `{"port":N}` on stdout once its models are loaded, and exits when stdin closes (the extension
 * host is gone).
 */
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseWav } from '../../voiceAgent/tts';
import { encodeWav } from '../stt';
import { DENOISE_MODEL, SPEAKER_MODEL, STT_MODEL, TTS_MODEL_ID, TTS_VOICE } from './models';

export interface EngineConfig {
    /** First path segment of every endpoint: other local processes cannot use the server. */
    token: string;
    /** 0: any free port. */
    port: number;
    /** Each model directory given is loaded; one left out leaves its endpoints unavailable. */
    sttDir?: string;
    ttsDir?: string;
    speakerDir?: string;
    denoiseDir?: string;
}

/** The parts of sherpa-onnx-node used here (it ships no types). */
interface SherpaStream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
}
interface SherpaOnlineStream extends SherpaStream {
    inputFinished(): void;
}
interface SherpaRecognizer {
    createStream(): SherpaStream;
    decodeAsync(stream: SherpaStream): Promise<{ text: string }>;
}
interface SherpaTts {
    /** `enableExternalBuffer` must be false in Electron, whose V8 sandbox refuses external buffers. */
    generateAsync(request: { text: string; sid: number; speed: number; enableExternalBuffer: boolean }): Promise<{ samples: Float32Array; sampleRate: number }>;
}
/** Synchronous: one embedding of a few seconds of speech takes tens of milliseconds. */
interface SherpaSpeakerExtractor {
    readonly dim: number;
    createStream(): SherpaOnlineStream;
    /** Whether the stream holds enough audio for an embedding. */
    isReady(stream: SherpaOnlineStream): boolean;
    compute(stream: SherpaOnlineStream, enableExternalBuffer: boolean): Float32Array;
}
/** Synchronous, like the extractor. */
interface SherpaDenoiser {
    readonly sampleRate: number;
    run(request: { samples: Float32Array; sampleRate: number; enableExternalBuffer: boolean }): { samples: Float32Array; sampleRate: number };
}
interface Sherpa {
    OfflineRecognizer: { createAsync(config: object): Promise<SherpaRecognizer> };
    OfflineTts: { createAsync(config: object): Promise<SherpaTts> };
    SpeakerEmbeddingExtractor: new (config: { model: string; numThreads: number; debug: number }) => SherpaSpeakerExtractor;
    OfflineSpeechDenoiser: new (config: { model: { gtcrn: { model: string }; numThreads: number; debug: number } }) => SherpaDenoiser;
}

/** OpenAI's upload limit. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const NUM_THREADS = Math.max(1, Math.min(4, os.availableParallelism() >> 1));

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/** Runs jobs one at a time: one decode per model keeps latency predictable and CPU bounded. */
function serial(): <T>(job: () => Promise<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve();
    return (job) => {
        const run = tail.then(job, job);
        tail = run.catch(() => undefined);
        return run;
    };
}

/** A 16-bit mono WAV as samples in -1..1. */
function wavSamples(wav: Buffer): { samples: Float32Array; rate: number } {
    let pcm;
    try {
        pcm = parseWav(wav);
    } catch (err) {
        throw new HttpError(400, `file must be 16-bit mono WAV: ${err instanceof Error ? err.message : String(err)}`);
    }
    const samples = new Float32Array(pcm.data.length / 2);
    for (let i = 0; i < samples.length; i++) {
        samples[i] = pcm.data.readInt16LE(i * 2) / 32768;
    }
    return { samples, rate: pcm.rate };
}

/** Samples in -1..1 as a 16-bit mono WAV. */
function samplesWav(samples: Float32Array, rate: number): Uint8Array {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < pcm.length; i++) {
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    }
    return encodeWav(pcm, rate);
}

function unavailable(what: string): HttpError {
    return new HttpError(503, `this engine runs without ${what}; ask the extension for it`);
}

async function main(): Promise<void> {
    const config = JSON.parse(process.env.OMP_VOICE_ENGINE ?? '') as EngineConfig;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native addon, kept out of the bundle
    const sherpa = require('sherpa-onnx-node') as Sherpa;
    const { sttDir, ttsDir, speakerDir, denoiseDir } = config;
    const loadStarted = performance.now();
    const [recognizer, synthesizer] = await Promise.all([
        sttDir &&
            sherpa.OfflineRecognizer.createAsync({
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    moonshine: {
                        preprocessor: path.join(sttDir, 'preprocess.onnx'),
                        encoder: path.join(sttDir, 'encode.int8.onnx'),
                        uncachedDecoder: path.join(sttDir, 'uncached_decode.int8.onnx'),
                        cachedDecoder: path.join(sttDir, 'cached_decode.int8.onnx'),
                    },
                    tokens: path.join(sttDir, 'tokens.txt'),
                    numThreads: NUM_THREADS,
                    provider: 'cpu',
                    debug: 0,
                },
                decodingMethod: 'greedy_search',
            }),
        ttsDir &&
            sherpa.OfflineTts.createAsync({
                model: {
                    vits: { model: path.join(ttsDir, `${TTS_VOICE.id}.onnx`), tokens: path.join(ttsDir, 'tokens.txt'), dataDir: path.join(ttsDir, 'espeak-ng-data') },
                    numThreads: NUM_THREADS,
                    provider: 'cpu',
                    debug: 0,
                },
                maxNumSentences: 1,
            }),
    ]);
    // Small models, one thread each: they run beside a transcription without slowing it much.
    const extractor = speakerDir && new sherpa.SpeakerEmbeddingExtractor({ model: path.join(speakerDir, SPEAKER_MODEL.required[0]), numThreads: 1, debug: 0 });
    const denoiser = denoiseDir && new sherpa.OfflineSpeechDenoiser({ model: { gtcrn: { model: path.join(denoiseDir, DENOISE_MODEL.required[0]) }, numThreads: 1, debug: 0 } });
    const loaded = [recognizer && STT_MODEL.id, synthesizer && TTS_MODEL_ID, extractor && SPEAKER_MODEL.id, denoiser && DENOISE_MODEL.id].filter(Boolean);
    console.error(`models loaded in ${Math.round(performance.now() - loadStarted)} ms (${NUM_THREADS} threads): ${loaded.join(', ')}`);

    // One queue per model: a voiceprint check or noise reduction never waits behind a transcription.
    const sttQueue = serial();
    const ttsQueue = serial();
    const speakerQueue = serial();
    const denoiseQueue = serial();

    const transcribe = async (req: http.IncomingMessage): Promise<object> => {
        if (!recognizer) {
            throw unavailable('speech-to-text');
        }
        const body = await readBody(req);
        const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData();
        const file = form.get('file');
        const model = form.get('model');
        if (!(file instanceof Blob)) {
            throw new HttpError(400, 'multipart field "file" is missing');
        }
        if (model && model !== STT_MODEL.id) {
            throw new HttpError(400, `unknown model "${String(model)}"; this server has ${STT_MODEL.id}`);
        }
        const { samples, rate } = wavSamples(Buffer.from(await file.arrayBuffer()));
        const started = performance.now();
        const result = await sttQueue(() => {
            const stream = recognizer.createStream();
            stream.acceptWaveform({ samples, sampleRate: rate });
            return recognizer.decodeAsync(stream);
        });
        console.error(`stt ${(samples.length / rate).toFixed(2)} s audio in ${Math.round(performance.now() - started)} ms`);
        return { text: result.text.trim() };
    };

    const speak = async (req: http.IncomingMessage): Promise<Uint8Array> => {
        if (!synthesizer) {
            throw unavailable('text-to-speech');
        }
        let request: { model?: unknown; input?: unknown; voice?: unknown; speed?: unknown; response_format?: unknown };
        try {
            request = JSON.parse((await readBody(req)).toString('utf8'));
        } catch {
            throw new HttpError(400, 'body must be JSON');
        }
        const { model, input, voice, speed, response_format: format } = request;
        if (typeof input !== 'string' || !input.trim()) {
            throw new HttpError(400, '"input" must be non-empty text');
        }
        if (model !== undefined && model !== TTS_MODEL_ID) {
            throw new HttpError(400, `unknown model "${String(model)}"; this server has ${TTS_MODEL_ID}`);
        }
        if (voice !== undefined && voice !== TTS_VOICE.id) {
            throw new HttpError(400, `unknown voice "${String(voice)}"; this server has ${TTS_VOICE.id}`);
        }
        if (format !== undefined && format !== 'wav') {
            throw new HttpError(400, 'only response_format "wav" is supported');
        }
        const rate = typeof speed === 'number' && speed >= 0.25 && speed <= 4 ? speed : 1;
        const started = performance.now();
        const audio = await ttsQueue(() => synthesizer.generateAsync({ text: input, sid: 0, speed: rate, enableExternalBuffer: false }));
        console.error(`tts ${input.length} chars → ${(audio.samples.length / audio.sampleRate).toFixed(2)} s audio in ${Math.round(performance.now() - started)} ms`);
        return samplesWav(audio.samples, audio.sampleRate);
    };

    /** Body: a WAV. Answers the speaker embedding of the voice in it, as `{ model, embedding }`. */
    const embed = async (req: http.IncomingMessage): Promise<object> => {
        if (!extractor) {
            throw unavailable('the voiceprint model');
        }
        const { samples, rate } = wavSamples(await readBody(req));
        const embedding = await speakerQueue(async () => {
            const stream = extractor.createStream();
            stream.acceptWaveform({ samples, sampleRate: rate });
            stream.inputFinished();
            if (!extractor.isReady(stream)) {
                throw new HttpError(400, 'too little audio for a voiceprint');
            }
            return extractor.compute(stream, false);
        });
        return { model: SPEAKER_MODEL.id, embedding: Array.from(embedding) };
    };

    /** Body: a WAV. Answers it with the background noise taken out, as a WAV. */
    const denoise = async (req: http.IncomingMessage): Promise<Uint8Array> => {
        if (!denoiser) {
            throw unavailable('noise reduction');
        }
        const { samples, rate } = wavSamples(await readBody(req));
        if (rate !== denoiser.sampleRate) {
            throw new HttpError(400, `audio must be ${denoiser.sampleRate} Hz`);
        }
        const clean = await denoiseQueue(async () => denoiser.run({ samples, sampleRate: rate, enableExternalBuffer: false }));
        return samplesWav(clean.samples, clean.sampleRate);
    };

    const prefix = `/${config.token}/v1`;
    const server = http.createServer((req, res) => {
        const send = (status: number, type: string, body: string | Uint8Array) => {
            res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
            res.end(body);
        };
        const handle = async (): Promise<void> => {
            const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
            const route = pathname.startsWith(`${prefix}/`) ? `${req.method} ${pathname.slice(prefix.length)}` : '';
            switch (route) {
                case 'GET /models':
                    return send(200, 'application/json', JSON.stringify({
                        object: 'list',
                        data: [recognizer && STT_MODEL.id, synthesizer && TTS_MODEL_ID].filter(Boolean).map((id) => ({ id, object: 'model', owned_by: 'builtin' })),
                    }));
                case 'POST /audio/transcriptions':
                    return send(200, 'application/json', JSON.stringify(await transcribe(req)));
                case 'POST /audio/speech':
                    return send(200, 'audio/wav', await speak(req));
                case 'POST /speaker/embed':
                    return send(200, 'application/json', JSON.stringify(await embed(req)));
                case 'POST /audio/denoise':
                    return send(200, 'audio/wav', await denoise(req));
                default:
                    throw new HttpError(404, 'not found');
            }
        };
        handle().catch((err: unknown) => {
            const status = err instanceof HttpError ? err.status : 500;
            const message = err instanceof Error ? err.message : String(err);
            if (status === 500) {
                console.error(err instanceof Error ? err.stack : message);
            }
            if (!res.headersSent) {
                send(status, 'application/json', JSON.stringify({ error: { message } }));
            }
        });
    });

    const listen = (port: number) => server.listen(port, '127.0.0.1');
    server.on('listening', () => {
        const address = server.address();
        console.log(JSON.stringify({ port: typeof address === 'object' && address ? address.port : 0 }));
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
        // A restart asks for the previous port so clients keep working; when it is taken, any port will do.
        if (err.code === 'EADDRINUSE' && config.port !== 0) {
            config.port = 0;
            listen(0);
            return;
        }
        console.error(err.stack);
        process.exit(1);
    });
    listen(config.port);

    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
}

async function readBody(req: http.IncomingMessage): Promise<Buffer<ArrayBuffer>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            throw new HttpError(413, `body is over ${MAX_BODY_BYTES} bytes`);
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
});
