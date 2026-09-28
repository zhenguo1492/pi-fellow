import { afterEach, describe, expect, it, vi } from 'vitest';
import { SttClient, testSttConnectivity } from '../../../voice/stt';
import { TtsClient, testTtsConnectivity } from '../../../voiceAgent/tts';

/** Stubs an OpenAI-compatible server; records each request's URL and Authorization header. */
function stubServer(): Array<{ url: string; authorization: string | null }> {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        requests.push({ url, authorization: new Headers(init.headers).get('authorization') });
        if (url.endsWith('/models')) {
            return Response.json({ data: [{ id: 'model-a' }] });
        }
        if (url.endsWith('/audio/transcriptions')) {
            return Response.json({ text: 'hello' });
        }
        return new Response(new Uint8Array(wav()));
    });
    return requests;
}

describe('voice API keys', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('sends the STT key as a Bearer token on every request, and no header without one', async () => {
        const requests = stubServer();
        // Empty model: the client asks /models for one first.
        await new SttClient({ url: 'https://stt.example/v1', model: '', language: '', apiKey: async () => 'sk-stt' }).transcribe(new Int16Array(160), 16000);
        await testSttConnectivity('https://stt.example/v1', undefined, async () => 'sk-stt');
        expect(requests).toEqual([
            { url: 'https://stt.example/v1/models', authorization: 'Bearer sk-stt' },
            { url: 'https://stt.example/v1/audio/transcriptions', authorization: 'Bearer sk-stt' },
            { url: 'https://stt.example/v1/models', authorization: 'Bearer sk-stt' },
        ]);

        requests.length = 0;
        await new SttClient({ url: 'https://stt.example/v1', model: '', language: '', apiKey: async () => undefined }).transcribe(new Int16Array(160), 16000);
        await testSttConnectivity('https://stt.example/v1');
        expect(requests.map((r) => r.authorization)).toEqual([null, null, null]);
    });

    it('sends the TTS key on speech and /models requests, and no header without one', async () => {
        const requests = stubServer();
        const config = { engine: 'custom' as const, languageField: 'none' as const, url: 'https://tts.example/v1', model: '', voice: '', speed: 1 };
        await new TtsClient({ ...config, apiKey: async () => 'sk-tts' }).synthesize('Hello.', new AbortController().signal);
        await testTtsConnectivity({ ...config, apiKey: async () => 'sk-tts' });
        await new TtsClient(config).synthesize('Hello.', new AbortController().signal);
        await testTtsConnectivity({ ...config, apiKey: async () => '  ' });
        expect(requests).toEqual([
            { url: 'https://tts.example/v1/audio/speech', authorization: 'Bearer sk-tts' },
            { url: 'https://tts.example/v1/models', authorization: 'Bearer sk-tts' },
            { url: 'https://tts.example/v1/audio/speech', authorization: null },
            { url: 'https://tts.example/v1/models', authorization: null },
        ]);
    });

    it('reads the key at each request, so a changed key applies to a running client', async () => {
        const requests = stubServer();
        let key: string | undefined = 'sk-old';
        const tts = new TtsClient({ engine: 'custom', languageField: 'none', url: 'https://tts.example/v1', model: '', voice: '', speed: 1, apiKey: async () => key });
        await tts.synthesize('One.', new AbortController().signal);
        key = 'sk-new';
        await tts.synthesize('Two.', new AbortController().signal);
        key = undefined;
        await tts.synthesize('Three.', new AbortController().signal);
        expect(requests.map((r) => r.authorization)).toEqual(['Bearer sk-old', 'Bearer sk-new', null]);
    });
});

/** 0.01 s of silence as 16-bit mono WAV at 1 kHz. */
function wav(): Buffer {
    const data = Buffer.alloc(20);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(1000, 24);
    header.writeUInt32LE(2000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}
