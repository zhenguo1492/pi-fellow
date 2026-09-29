/**
 * The built-in engine's private endpoints (./server.ts): the speaker embedding of an utterance (the
 * voiceprint check) and noise reduction. `url` is the engine's base URL (`builtinVoiceEngineUrl`).
 */
import { parseWav } from '../../voiceAgent/tts';
import { encodeWav } from '../stt';

const REQUEST_TIMEOUT_MS = 15_000;

async function post(url: string, pcm: Int16Array, sampleRate: number): Promise<Response> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: encodeWav(pcm, sampleRate),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`POST ${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res;
}

/** The speaker embedding of the voice in `pcm` (16-bit mono), and the model that made it. */
export async function speakerEmbedding(url: string, pcm: Int16Array, sampleRate: number): Promise<{ model: string; embedding: number[] }> {
    const body: unknown = await (await post(`${url}/speaker/embed`, pcm, sampleRate)).json();
    if (
        !body ||
        typeof body !== 'object' ||
        !('model' in body) ||
        typeof body.model !== 'string' ||
        !('embedding' in body) ||
        !Array.isArray(body.embedding) ||
        !body.embedding.every((x) => typeof x === 'number')
    ) {
        throw new Error('The built-in voice engine answered an unexpected speaker embedding');
    }
    return { model: body.model, embedding: body.embedding };
}

/** `pcm` (16-bit mono, 16 kHz) with the background noise taken out. */
export async function denoiseSpeech(url: string, pcm: Int16Array, sampleRate: number): Promise<Int16Array> {
    const wav = parseWav(Buffer.from(await (await post(`${url}/audio/denoise`, pcm, sampleRate)).arrayBuffer()));
    // Copy into a fresh buffer: an Int16Array view needs an even byte offset.
    return new Int16Array(new Uint8Array(wav.data).buffer);
}
