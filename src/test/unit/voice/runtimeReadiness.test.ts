const { settings } = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: (section: string) => ({
            get: (key: string, def: unknown) => settings[`${section}.${key}`] ?? def,
            inspect: (key: string) => ({ globalValue: settings[`${section}.${key}`] }),
        }),
    },
}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SttClient, encodeWav } from '../../../voice/stt';
import { probeTts, readTtsSettings, readVoiceSettings, recordSttCheck, recordTtsCheck, resolveSttConfig, resolveTtsConfig, voiceReadiness } from '../../../voice/voiceSettings';
import { TtsClient } from '../../../voiceAgent/tts';

const wav = () => new Response(encodeWav(new Int16Array(1600), 16000), { status: 200 });
const refused = () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }));
const tts = async () => new TtsClient(await resolveTtsConfig(readTtsSettings()));
const stt = async () => new SttClient(await resolveSttConfig(readVoiceSettings()));

beforeEach(() => {
    for (const key of Object.keys(settings)) {
        delete settings[key];
    }
    Object.assign(settings, {
        'oh-my-pi-chater.voice.sttUrl': 'http://127.0.0.1:8010/v1',
        'oh-my-pi-chater.voice.sttModel': 'whisper',
        'oh-my-pi-chater.voiceAgent.tts.url': 'http://127.0.0.1:8881/v1',
        'oh-my-pi-chater.voiceAgent.tts.model': 'kokoro',
        'oh-my-pi-chater.voiceAgent.tts.voice': 'af_wrong',
    });
    // The startup probe's guess: both reachable.
    recordSttCheck(readVoiceSettings(), true, 'Connected');
    recordTtsCheck(readTtsSettings(), true, 'Connected');
});

afterEach(() => vi.unstubAllGlobals());

describe('TTS readiness from real synthesis', () => {
    it('a rejected voice marks TTS unavailable, a probe does not clear it, a synthesized sentence does', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"unknown voice af_wrong"}', { status: 400 })));
        const client = await tts();
        await expect(client.synthesize('Hello.', new AbortController().signal)).rejects.toThrow(/HTTP 400/);
        expect(voiceReadiness().tts).toEqual({ ok: false, reason: expect.stringContaining('unknown voice af_wrong') });

        // /models answering says nothing about the voice.
        recordTtsCheck(readTtsSettings(), true, 'Connected');
        expect(voiceReadiness().tts.ok).toBe(false);

        vi.stubGlobal('fetch', vi.fn(async () => wav()));
        await client.synthesize('Hello.', new AbortController().signal);
        expect(voiceReadiness().tts).toEqual({ ok: true });
    });

    it('a WAV it cannot play is a failure too', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>hi</html>', { status: 200 })));
        await expect((await tts()).synthesize('Hello.', new AbortController().signal)).rejects.toThrow(/did not return WAV/);
        expect(voiceReadiness().tts.ok).toBe(false);
    });

    it('a service that was not running is ready again once the probe reaches it', async () => {
        vi.stubGlobal('fetch', vi.fn(refused));
        await expect((await tts()).synthesize('Hello.', new AbortController().signal)).rejects.toThrow();
        expect(voiceReadiness().tts).toEqual({ ok: false, reason: expect.stringContaining("isn't running at 127.0.0.1:8881") });
        recordTtsCheck(readTtsSettings(), true, 'Connected');
        expect(voiceReadiness().tts).toEqual({ ok: true });
    });

    it('a sentence cut off by the caller changes nothing; the caller’s own deadline running out does', async () => {
        const hanging = vi.fn(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    const signal = init.signal!;
                    if (signal.aborted) {
                        reject(signal.reason);
                    }
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                }),
        );
        vi.stubGlobal('fetch', hanging);
        const client = await tts();
        const cut = new AbortController();
        const pending = client.synthesize('Hello.', cut.signal);
        cut.abort();
        await expect(pending).rejects.toThrow();
        expect(voiceReadiness().tts).toEqual({ ok: true });

        const deadline = new AbortController();
        const late = client.synthesize('Hello.', deadline.signal);
        deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        await expect(late).rejects.toThrow();
        expect(voiceReadiness().tts).toEqual({ ok: false, reason: expect.stringContaining("didn't answer in time") });
    });

    it('ignores results of settings that are no longer the configured ones', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('bad voice', { status: 400 })));
        const old = await tts();
        settings['oh-my-pi-chater.voiceAgent.tts.voice'] = 'af_sarah';
        recordTtsCheck(readTtsSettings(), true, 'Connected');
        await expect(old.synthesize('Hello.', new AbortController().signal)).rejects.toThrow();
        expect(voiceReadiness().tts).toEqual({ ok: true });
    });

    it('marks the built-in engine unavailable when it cannot start, and tries it again after a probe', async () => {
        settings['oh-my-pi-chater.voiceAgent.tts.engine'] = 'builtin';
        expect(voiceReadiness().tts).toEqual({ ok: true });
        // No engine is activated in tests: starting it fails.
        await expect(resolveTtsConfig(readTtsSettings())).rejects.toThrow(/not available/);
        expect(voiceReadiness().tts).toEqual({ ok: false, reason: expect.stringMatching(/^The built-in text-to-speech engine failed: .*not available/) });
        await probeTts();
        expect(voiceReadiness().tts).toEqual({ ok: true });
    });
});

describe('STT readiness from real transcription', () => {
    it('an HTTP error marks STT unavailable; an empty transcript is a success', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
        const client = await stt();
        await expect(client.transcribe(new Int16Array(160), 16000)).rejects.toThrow(/HTTP 401/);
        expect(voiceReadiness().stt).toEqual({ ok: false, reason: expect.stringContaining('needs an API key') });

        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ text: '' })));
        expect(await client.transcribe(new Int16Array(160), 16000)).toBe('');
        expect(voiceReadiness().stt).toEqual({ ok: true });
    });

    it('a model the server does not have stays unavailable through a probe, until another model is set', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('model whisper not found', { status: 404 })));
        await expect((await stt()).transcribe(new Int16Array(160), 16000)).rejects.toThrow(/HTTP 404/);
        recordSttCheck(readVoiceSettings(), true, 'Connected');
        expect(voiceReadiness().stt.ok).toBe(false);

        settings['oh-my-pi-chater.voice.sttModel'] = 'whisper-1';
        recordSttCheck(readVoiceSettings(), true, 'Connected');
        expect(voiceReadiness().stt).toEqual({ ok: true });
    });

    it('ignores a transcription with a URL that is no longer configured', async () => {
        vi.stubGlobal('fetch', vi.fn(refused));
        const old = await stt();
        settings['oh-my-pi-chater.voice.sttUrl'] = 'http://127.0.0.1:8011/v1';
        recordSttCheck(readVoiceSettings(), true, 'Connected');
        await expect(old.transcribe(new Int16Array(160), 16000)).rejects.toThrow();
        expect(voiceReadiness().stt).toEqual({ ok: true });
    });
});
