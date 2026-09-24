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
import { isSttValid, readVoiceSettings, setSttValid, onSttValidityChange } from '../../../voice/voiceSettings';

describe('STT Connectivity and Validity', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        voiceConfig.sttUrl = 'http://127.0.0.1:8010/v1';
        setSttValid(false);
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
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
        setSttValid(true);
        expect(readVoiceSettings().sttValid).toBe(true);

        voiceConfig.sttUrl = 'http://127.0.0.1:8210/v1';
        expect(isSttValid()).toBe(false);
        expect(readVoiceSettings().sttValid).toBe(false);
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


    it('tracks sttValid and notifies listeners on change', () => {
        expect(isSttValid()).toBe(false);

        const states: boolean[] = [];
        const sub = onSttValidityChange((valid) => {
            states.push(valid);
        });

        setSttValid(true);
        expect(isSttValid()).toBe(true);
        expect(states).toEqual([true]);

        // Duplicate set does not fire listener again
        setSttValid(true);
        expect(states).toEqual([true]);

        setSttValid(false);
        expect(isSttValid()).toBe(false);
        expect(states).toEqual([true, false]);

        sub.dispose();
        setSttValid(true);
        expect(states).toEqual([true, false]); // Disposed listener not called
    });
});
