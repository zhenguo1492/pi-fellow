const { voiceConfig } = vi.hoisted(() => ({
    voiceConfig: { sttUrl: 'http://127.0.0.1:8010/v1', sttEngine: undefined as string | undefined },
}));

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (key: string, def: unknown) => key === 'sttUrl' ? voiceConfig.sttUrl : def,
            inspect: (key: string) => (key === 'sttEngine' ? { globalValue: voiceConfig.sttEngine } : undefined),
        }),
    },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testSttConnectivity } from '../../../voice/stt';
import { testTtsConnectivity } from '../../../voiceAgent/tts';
import { onVoiceReadinessChange, probeStt, readVoiceSettings, recordSttCheck, resolveSttConfig, resolveTtsConfig, sttCheck } from '../../../voice/voiceSettings';

describe('STT Connectivity and Validity', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        voiceConfig.sttUrl = 'http://127.0.0.1:8010/v1';
        voiceConfig.sttEngine = undefined;
        recordSttCheck(readVoiceSettings(), false, 'reset');
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('a wrong URL saved over a working one makes STT unusable once its check lands', async () => {
        recordSttCheck(readVoiceSettings(), true, 'ok');
        expect(sttCheck().ok).toBe(true);

        voiceConfig.sttUrl = 'http://127.0.0.1:8019/v1';
        globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }));
        await probeStt();
        expect(sttCheck()).toEqual({ ok: false, reason: expect.stringContaining("speech-to-text service isn't running at 127.0.0.1:8019") });
    });

    it('rejects empty URL without fetching', async () => {
        const fetchMock = vi.fn();
        globalThis.fetch = fetchMock;

        const res = await testSttConnectivity('');
        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/empty/i);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns ok: true when server responds with HTTP 200 and lists models', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            status: 200,
            json: async () => ({
                data: [{ id: 'whisper-1' }, { id: 'speaches-whisper' }],
            }),
        } as unknown as Response);

        const res = await testSttConnectivity('http://127.0.0.1:8010/v1');
        expect(res.ok).toBe(true);
        expect(res.status).toBe(200);
        expect(res.models).toEqual(['whisper-1', 'speaches-whisper']);
        expect(res.message).toContain('HTTP 200');
    });

    it('returns ok: false when server responds with HTTP 404 or 500', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            status: 500,
            text: async () => 'Internal Server Error',
        } as unknown as Response);

        const res = await testSttConnectivity('http://127.0.0.1:8010/v1');
        expect(res.ok).toBe(false);
        expect(res.status).toBe(500);
        expect(res.message).toContain('500');
    });

    it('returns ok: false when network error occurs', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:8010'));

        const res = await testSttConnectivity('http://127.0.0.1:8010/v1');
        expect(res.ok).toBe(false);
        expect(res.message).toContain('ECONNREFUSED');
    });
    it('does not reuse verification when the configured STT URL changes', () => {
        recordSttCheck(readVoiceSettings(), true, 'ok');
        expect(sttCheck().ok).toBe(true);

        voiceConfig.sttUrl = 'http://127.0.0.1:8210/v1';
        expect(sttCheck().ok).toBe(false);
    });

    it('explains why STT is unusable: no URL, or the failed check', () => {
        voiceConfig.sttEngine = 'custom';
        voiceConfig.sttUrl = '';
        expect(sttCheck()).toEqual({ ok: false, reason: expect.stringMatching(/not set up/) });

        voiceConfig.sttUrl = 'http://127.0.0.1:8010/v1';
        recordSttCheck(readVoiceSettings(), false, 'GET http://127.0.0.1:8010/v1/models failed: fetch failed (ECONNREFUSED)');
        expect(sttCheck().reason).toContain("isn't running at 127.0.0.1:8010");
    });

    it('uses the built-in engine unless a custom one is chosen or a URL is set, and does not probe it', async () => {
        const fetchMock = vi.fn();
        globalThis.fetch = fetchMock;

        // An existing setup (URL set, engine never chosen) keeps its server.
        recordSttCheck(readVoiceSettings(), false, 'HTTP 500');
        expect(sttCheck().ok).toBe(false);

        voiceConfig.sttUrl = '';
        expect(sttCheck()).toEqual({ ok: true });

        voiceConfig.sttUrl = 'http://127.0.0.1:8010/v1';
        voiceConfig.sttEngine = 'builtin';
        expect(sttCheck()).toEqual({ ok: true });
        await probeStt();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ignores a check of a URL that is no longer configured', () => {
        recordSttCheck({ ...readVoiceSettings(), sttUrl: 'http://127.0.0.1:9999/v1' }, true, 'ok');
        expect(sttCheck().ok).toBe(false);
    });

    it('fails TTS when the server does not list the configured model, and lists its models either way', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            status: 200,
            json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
        } as unknown as Response);

        const tts = { engine: 'custom' as const, languageField: 'none' as const, url: 'http://127.0.0.1:8881/v1', model: 'model-c', voice: '', speed: 1 };
        const res = await testTtsConnectivity(tts);
        expect(res.ok).toBe(false);
        expect(res.message).toContain('"model-c"');
        expect(res.models).toEqual(['model-a', 'model-b']);
        expect((await testTtsConnectivity({ ...tts, model: 'model-b' })).ok).toBe(true);
        // No model set: none is sent, so there is none to miss.
        expect(await testTtsConnectivity({ ...tts, model: '' })).toMatchObject({ ok: true, models: ['model-a', 'model-b'] });
    });

    it('does not accept HTTP 200 from a generic base page after /models fails', async () => {
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce({ status: 404 } as Response)
            .mockResolvedValueOnce({ status: 200 } as Response);

        const res = await testSttConnectivity('http://127.0.0.1:8210/v1');
        expect(res.ok).toBe(false);
    });

    it('does not accept an HTML page served at /models', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            status: 200,
            json: async () => { throw new SyntaxError('Unexpected token <'); },
        } as unknown as Response);

        const res = await testSttConnectivity('http://127.0.0.1:8210/v1');
        expect(res.ok).toBe(false);
    });


    it('notifies readiness listeners only when a check changes', () => {
        const calls: boolean[] = [];
        const sub = onVoiceReadinessChange(() => {
            calls.push(sttCheck().ok);
        });

        recordSttCheck(readVoiceSettings(), true, 'ok');
        expect(calls).toEqual([true]);

        // Duplicate result does not fire listener again
        recordSttCheck(readVoiceSettings(), true, 'ok');
        expect(calls).toEqual([true]);

        recordSttCheck(readVoiceSettings(), false, 'HTTP 500');
        expect(calls).toEqual([true, false]);

        sub.dispose();
        recordSttCheck(readVoiceSettings(), true, 'ok');
        expect(calls).toEqual([true, false]); // Disposed listener not called
    });
});

describe('own servers', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('never get the API key stored for a cloud service', async () => {
        const stt = { sttEngine: 'custom' as const, sttUrl: '', sttModel: '', language: '', vadConfidence: 0.5, vadStopSecs: 0.8 };
        expect((await resolveSttConfig({ ...stt, sttUrl: 'http://127.0.0.1:8010/v1' }, 'sk-typed')).apiKey).toBeUndefined();
        expect(await (await resolveSttConfig({ ...stt, sttUrl: 'https://api.groq.com/openai/v1/' }, 'sk-typed')).apiKey?.()).toBe('sk-typed');
        const tts = { engine: 'custom' as const, languageField: 'none' as const, url: 'http://127.0.0.1:8880/v1', model: '', voice: '', speed: 1 };
        expect((await resolveTtsConfig(tts, 'sk-typed')).apiKey).toBeUndefined();
        expect((await resolveTtsConfig({ ...tts, url: 'https://api.openai.com/v1' })).apiKey).toBeDefined();
    });

    it('list only the models for the task asked, when the server marks each (speaches serves both)', async () => {
        vi.stubGlobal('fetch', async () =>
            Response.json({
                data: [
                    { id: 'speaches-ai/Kokoro-82M-v1.0-ONNX', task: 'text-to-speech' },
                    { id: 'Systran/faster-whisper-large-v3', task: 'automatic-speech-recognition' },
                    { id: 'untagged' },
                ],
            }),
        );
        expect((await testSttConnectivity('http://127.0.0.1:8000/v1')).models).toEqual(['Systran/faster-whisper-large-v3', 'untagged']);
        const tts = { engine: 'custom' as const, languageField: 'none' as const, url: 'http://127.0.0.1:8000/v1', model: '', voice: '', speed: 1 };
        expect((await testTtsConnectivity(tts)).models).toEqual(['speaches-ai/Kokoro-82M-v1.0-ONNX', 'untagged']);
    });
});
