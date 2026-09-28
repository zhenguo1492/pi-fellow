/**
 * The built-in voice engine: Moonshine (speech-to-text) and Piper (text-to-speech) on sherpa-onnx,
 * behind the OpenAI-compatible endpoints SttClient and TtsClient already call. It runs in its own
 * process (VS Code's Electron as Node, started by ./engine.ts), so inference never blocks the
 * extension host.
 *
 * Config: env `OMP_VOICE_ENGINE`, an `EngineConfig` in JSON. Listens on 127.0.0.1 under
 * `/<token>/v1`, prints `{"port":N}` on stdout once both models are loaded, and exits when stdin
 * closes (the extension host is gone).
 */
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseWav } from '../../voiceAgent/tts';
import { encodeWav } from '../stt';
import { STT_MODEL, TTS_MODEL_ID, TTS_VOICE } from './models';

export interface EngineConfig {
    /** First path segment of every endpoint: other local processes cannot use the server. */
    token: string;
    /** 0: any free port. */
    port: number;
    sttDir: string;
    ttsDir: string;
}

/** The parts of sherpa-onnx-node used here (it ships no types). */
interface SherpaStream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
}
interface SherpaRecognizer {
    createStream(): SherpaStream;
    decodeAsync(stream: SherpaStream): Promise<{ text: string }>;
}
interface SherpaTts {
    /** `enableExternalBuffer` must be false in Electron, whose V8 sandbox refuses external buffers. */
    generateAsync(request: { text: string; sid: number; speed: number; enableExternalBuffer: boolean }): Promise<{ samples: Float32Array; sampleRate: number }>;
}
interface Sherpa {
    OfflineRecognizer: { createAsync(config: object): Promise<SherpaRecognizer> };
    OfflineTts: { createAsync(config: object): Promise<SherpaTts> };
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

async function main(): Promise<void> {
    const config = JSON.parse(process.env.OMP_VOICE_ENGINE ?? '') as EngineConfig;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native addon, kept out of the bundle
    const sherpa = require('sherpa-onnx-node') as Sherpa;
    const stt = (file: string) => path.join(config.sttDir, file);
    const tts = (file: string) => path.join(config.ttsDir, file);
    const loadStarted = performance.now();
    const [recognizer, synthesizer] = await Promise.all([
        sherpa.OfflineRecognizer.createAsync({
            featConfig: { sampleRate: 16000, featureDim: 80 },
            modelConfig: {
                moonshine: {
                    preprocessor: stt('preprocess.onnx'),
                    encoder: stt('encode.int8.onnx'),
                    uncachedDecoder: stt('uncached_decode.int8.onnx'),
                    cachedDecoder: stt('cached_decode.int8.onnx'),
                },
                tokens: stt('tokens.txt'),
                numThreads: NUM_THREADS,
                provider: 'cpu',
                debug: 0,
            },
            decodingMethod: 'greedy_search',
        }),
        sherpa.OfflineTts.createAsync({
            model: {
                vits: { model: tts(`${TTS_VOICE.id}.onnx`), tokens: tts('tokens.txt'), dataDir: tts('espeak-ng-data') },
                numThreads: NUM_THREADS,
                provider: 'cpu',
                debug: 0,
            },
            maxNumSentences: 1,
        }),
    ]);
    console.error(`models loaded in ${Math.round(performance.now() - loadStarted)} ms (${NUM_THREADS} threads)`);

    const sttQueue = serial();
    const ttsQueue = serial();

    const transcribe = async (req: http.IncomingMessage): Promise<object> => {
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
        let pcm;
        try {
            pcm = parseWav(Buffer.from(await file.arrayBuffer()));
        } catch (err) {
            throw new HttpError(400, `file must be 16-bit mono WAV: ${err instanceof Error ? err.message : String(err)}`);
        }
        const samples = new Float32Array(pcm.data.length / 2);
        for (let i = 0; i < samples.length; i++) {
            samples[i] = pcm.data.readInt16LE(i * 2) / 32768;
        }
        const started = performance.now();
        const result = await sttQueue(() => {
            const stream = recognizer.createStream();
            stream.acceptWaveform({ samples, sampleRate: pcm.rate });
            return recognizer.decodeAsync(stream);
        });
        console.error(`stt ${(samples.length / pcm.rate).toFixed(2)} s audio in ${Math.round(performance.now() - started)} ms`);
        return { text: result.text.trim() };
    };

    const speak = async (req: http.IncomingMessage): Promise<Uint8Array> => {
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
        const pcm = new Int16Array(audio.samples.length);
        for (let i = 0; i < pcm.length; i++) {
            pcm[i] = Math.max(-32768, Math.min(32767, Math.round(audio.samples[i] * 32767)));
        }
        return encodeWav(pcm, audio.sampleRate);
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
                        data: [STT_MODEL.id, TTS_MODEL_ID].map((id) => ({ id, object: 'model', owned_by: 'builtin' })),
                    }));
                case 'POST /audio/transcriptions':
                    return send(200, 'application/json', JSON.stringify(await transcribe(req)));
                case 'POST /audio/speech':
                    return send(200, 'audio/wav', await speak(req));
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
