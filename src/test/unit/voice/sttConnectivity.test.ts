const { voiceConfig } = vi.hoisted(() => ({
    voiceConfig: { sttUrl: 'http://127.0.0.1:8010/v1' },
}));

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (key: string, def: unknown) => key === 'sttUrl' ? voiceConfig.sttUrl : def,
        }),
    },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testSttConnectivity } from '../../../voice/stt';
import { testTtsConnectivity } from '../../../voiceAgent/tts';
import { onVoiceReadinessChange, probeStt, recordSttCheck, sttCheck } from '../../../voice/voiceSettings';

describe('STT Connectivity and Validity', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        voiceConfig.sttUrl = 'http://127.0.0.1:8010/v1';
        recordSttCheck(voiceConfig.sttUrl, false, 'reset');
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('a wrong URL saved over a working one makes STT unusable once its check lands', async () => {
        recordSttCheck(voiceConfig.sttUrl, true, 'ok');
        expect(sttCheck().ok).toBe(true);

        voiceConfig.sttUrl = 'http://127.0.0.1:8019/v1';
        globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }));
        await probeStt();
        expect(sttCheck()).toEqual({ ok: false, reason: expect.stringContaining('8019/v1/models failed: fetch failed (ECONNREFUSED)') });
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
        recordSttCheck(voiceConfig.sttUrl, true, 'ok');
        expect(sttCheck().ok).toBe(true);

        voiceConfig.sttUrl = 'http://127.0.0.1:8210/v1';
        expect(sttCheck().ok).toBe(false);
    });

    it('explains why STT is unusable: no URL, or the failed check', () => {
        voiceConfig.sttUrl = '';
        expect(sttCheck()).toEqual({ ok: false, reason: expect.stringMatching(/not configured/) });

        voiceConfig.sttUrl = 'http://127.0.0.1:8010/v1';
        recordSttCheck(voiceConfig.sttUrl, false, 'GET http://127.0.0.1:8010/v1/models failed: fetch failed (ECONNREFUSED)');
        expect(sttCheck().reason).toContain('ECONNREFUSED');
    });

    it('ignores a check of a URL that is no longer configured', () => {
        recordSttCheck('http://127.0.0.1:9999/v1', true, 'ok');
        expect(sttCheck().ok).toBe(false);
    });

    it('fails TTS when the server does not list the model requests will name', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            status: 200,
            json: async () => ({ data: [{ id: 'chatterbox-multilingual' }] }),
        } as unknown as Response);

        const tts = { provider: 'kokoro' as const, url: 'http://127.0.0.1:8881/v1', model: '', voice: '', speed: 1 };
        const res = await testTtsConnectivity(tts);
        expect(res.ok).toBe(false);
        expect(res.message).toContain('"kokoro"');
        expect((await testTtsConnectivity({ ...tts, provider: 'chatterbox' })).ok).toBe(true);
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

        recordSttCheck(voiceConfig.sttUrl, true, 'ok');
        expect(calls).toEqual([true]);

        // Duplicate result does not fire listener again
        recordSttCheck(voiceConfig.sttUrl, true, 'ok');
        expect(calls).toEqual([true]);

        recordSttCheck(voiceConfig.sttUrl, false, 'HTTP 500');
        expect(calls).toEqual([true, false]);

        sub.dispose();
        recordSttCheck(voiceConfig.sttUrl, true, 'ok');
        expect(calls).toEqual([true, false]); // Disposed listener not called
    });
});
