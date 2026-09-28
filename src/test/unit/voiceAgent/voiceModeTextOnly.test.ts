import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceReadiness } from '../../../shared/protocol';
import type * as SileroVadModule from '../../../voice/sileroVad';
import { encodeWav } from '../../../voice/stt';
import { VoiceServiceSync, type VoiceServiceSyncDeps } from '../../../voiceAgent/serviceSync';
import type { TtsRequestConfig } from '../../../voiceAgent/tts';
import type { BrowserAudio } from '../../../voiceAgent/browserAudio';
import type { Phase } from '../../../voiceAgent/conversation';
import type { VoiceTurnListener, VoiceTurnResult } from '../../../voiceAgent/voiceAgent';
import { VoiceMode, type ReplyAudioEvent, type VoiceModeOptions } from '../../../voiceAgent/voiceMode';

const page = vi.hoisted(() => ({
    audio: { url: 'http://127.0.0.1:1/?token=t', connected: true, play: vi.fn(), flush: vi.fn(), setMic: vi.fn(), enableCapture: vi.fn(), close: vi.fn() },
    start: vi.fn(),
}));

vi.mock('../../../voiceAgent/browserAudio', () => ({
    startBrowserAudio: page.start.mockImplementation(async () => page.audio as BrowserAudio),
    findChrome: () => undefined,
    launchHiddenChrome: vi.fn(),
}));

const vad = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock('../../../voice/sileroVad', async (importOriginal) => ({
    ...(await importOriginal<typeof SileroVadModule>()),
    SileroVad: { load: vad.load.mockImplementation(async () => ({ confidence: async () => 0, reset: () => {} })) },
}));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

const DONE: VoiceTurnResult = { reply: 'Hello there.', silent: false, toolCalls: [], lookups: [], interrupted: false };

function options(overrides: Partial<VoiceModeOptions>) {
    let reply: VoiceTurnListener | undefined;
    const phases: Phase[] = [];
    const audioEvents: ReplyAudioEvent[] = [];
    const say = vi.fn((_text: string, _source: string, listener: VoiceTurnListener) => {
        reply = listener;
        return new Promise<VoiceTurnResult>(() => {});
    });
    const opts = {
        agent: { say, floorReleased: vi.fn() },
        vad: { modelPath: '/nonexistent/silero.onnx', runtimeDir: '/nonexistent' },
        stt: undefined,
        tts: undefined,
        turnStopSecs: 1,
        vadConfidence: 0.5,
        chromeArgs: [],
        active: true,
        transcript: () => ({}),
        openExternal: vi.fn(),
        onPhase: (phase: Phase) => phases.push(phase),
        onAudio: (event: ReplyAudioEvent) => audioEvents.push(event),
        log: () => {},
        ...overrides,
    } as unknown as VoiceModeOptions;
    return { opts, say, phases, audioEvents, reply: () => reply };
}

describe('VoiceMode without speech services', () => {
    it('starts with neither STT nor TTS: no audio page, and a typed message gets a reply shown as text', async () => {
        const { opts, say, phases, audioEvents, reply } = options({
            unavailable: { stt: 'The speech-to-text service isn\'t running at 127.0.0.1:8010.', tts: 'Text-to-speech is not set up.' },
        });
        const mode = await VoiceMode.start(opts);

        expect(page.start).not.toHaveBeenCalled();
        expect(mode.unavailable).toEqual({ stt: "The speech-to-text service isn't running at 127.0.0.1:8010.", tts: 'Text-to-speech is not set up.' });
        expect(phases).toEqual(['listening']);
        // A replay has no page to play on: the Bot view plays it.
        expect(mode.beginReplay('Hello.')).toBeUndefined();

        mode.type('Hi');
        expect(say).toHaveBeenCalledOnce();
        expect(say.mock.calls[0][0]).toBe('Hi');
        reply()!.onText!('Hello there. ');
        expect(phases.at(-1)).toBe('thinking');
        reply()!.onEnd!(DONE);

        expect(phases).toEqual(['listening', 'thinking', 'listening']);
        expect(audioEvents).toEqual([{ turnId: 1, type: 'idle' }]);
        expect(mode.floorBusy).toBe(false);
        await mode.stop();
    });

    it('does not fail when STT fails its check: it runs without listening, and says why', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })));
        const { opts } = options({ stt: { url: 'http://127.0.0.1:8010/v1', model: '', language: '' } });
        const mode = await VoiceMode.start(opts);

        expect(mode.unavailable.stt).toMatch(/speech-to-text service isn't running/);
        expect(mode.unavailable.tts).toBeDefined();
        expect(page.start).not.toHaveBeenCalled();
        await mode.stop();
    });

    it('with TTS but no STT, opens a playback-only page and never turns its microphone on', async () => {
        const tts = { engine: 'custom', languageField: 'none', url: 'http://tts.local/v1', model: '', voice: '', speed: 1 } as const;
        const { opts } = options({ tts, unavailable: { stt: 'Speech-to-text is not set up.' } });
        const mode = await VoiceMode.start(opts);

        expect(page.start).toHaveBeenCalledWith(expect.anything(), { capture: false });
        expect(page.audio.setMic.mock.calls.every(([on]) => on === false)).toBe(true);
        mode.setActive(false);
        mode.setActive(true);
        mode.setMuted(true);
        expect(mode.muted).toBe(false);
        expect(page.audio.setMic.mock.calls.every(([on]) => on === false)).toBe(true);
        expect(mode.unavailable).toEqual({ stt: 'Speech-to-text is not set up.' });
        await mode.stop();
    });
});

const TTS: TtsRequestConfig = { engine: 'custom', languageField: 'none', url: 'http://tts.local/v1', model: '', voice: 'good', speed: 1 };
const STT = { url: 'http://stt.local/v1', model: '', language: '' };

/** A server for every speech request: /models lists one model, /audio/speech answers with `speech()`. */
function stubServers(speech: () => Response = () => new Response(encodeWav(new Int16Array(160), 16000), { status: 200 })): string[] {
    const requests: string[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            const voice = typeof init?.body === 'string' ? (JSON.parse(init.body) as { voice?: string }).voice : undefined;
            requests.push(voice ? `${url} ${voice}` : url);
            return url.endsWith('/models') ? Response.json({ data: [{ id: 'whisper' }] }) : speech();
        }),
    );
    return requests;
}

/** A service sync driving `mode`, with readiness and settings the test sets. */
function sync(mode: VoiceMode, started: { stt?: string; tts?: string }) {
    const readiness: VoiceReadiness = { stt: { ok: false, reason: 'down' }, tts: { ok: false, reason: 'down' } };
    const settings = { stt: started.stt ?? 'stt:a', tts: started.tts ?? 'tts:a' };
    const tts = { ...TTS };
    const changes: string[] = [];
    const deps: VoiceServiceSyncDeps = {
        readiness: () => readiness,
        settings: (service) => settings[service],
        resolveStt: async () => STT,
        resolveTts: async () => ({ ...tts }),
        onChange: (service, how) => changes.push(`${service} ${how}`),
        log: () => {},
    };
    return { sync: new VoiceServiceSync(mode, { stt: started.stt, tts: started.tts }, deps), readiness, settings, tts, changes };
}

describe('VoiceMode picks a speech service back up while running', () => {
    it('started without TTS, speaks once TTS readiness turns ok; a reply already being shown stays text', async () => {
        const requests = stubServers();
        const { opts, reply, phases } = options({ unavailable: { stt: 'No STT.', tts: 'Unknown voice "bad".' } });
        const mode = await VoiceMode.start(opts);
        const s = sync(mode, {});

        mode.type('First');
        reply()!.onText!('Shown as text. ');
        await s.sync.sync();
        expect(s.changes).toEqual([]); // not ready yet
        s.readiness.tts = { ok: true };
        await s.sync.sync();

        expect(s.changes).toEqual(['tts attached']);
        expect(mode.uses('tts')).toBe(true);
        expect(mode.unavailable).toEqual({ stt: 'No STT.' });
        // A playback-only page: no microphone without STT.
        expect(page.start).toHaveBeenCalledWith(expect.anything(), { capture: false });
        // The reply under way is not voiced from its middle…
        reply()!.onText!('Still text. ');
        reply()!.onEnd!(DONE);
        expect(requests.filter((r) => r.includes('/audio/speech'))).toEqual([]);
        // …the next one is.
        mode.type('Second');
        reply()!.onText!('Spoken now. ');
        await vi.waitFor(() => expect(page.audio.play).toHaveBeenCalledOnce());
        expect(phases).toContain('synthesizing');
        await mode.stop();
    });

    it('started without STT, loads the VAD and has the playback-only page open the microphone once STT is ready', async () => {
        stubServers();
        const { opts } = options({ tts: TTS, unavailable: { stt: "The speech-to-text service isn't running." } });
        const mode = await VoiceMode.start(opts);
        expect(vad.load).not.toHaveBeenCalled();
        const s = sync(mode, { tts: 'tts:a' });

        s.readiness.stt = { ok: true };
        s.readiness.tts = { ok: true };
        await s.sync.sync();

        expect(s.changes).toEqual(['stt attached']);
        expect(vad.load).toHaveBeenCalledOnce();
        expect(page.audio.enableCapture).toHaveBeenCalled();
        expect(page.audio.setMic).toHaveBeenLastCalledWith(true);
        expect(mode.unavailable).toEqual({});
        expect(mode.sttModel).toBe('whisper');
        // Now there is a microphone to mute.
        mode.setMuted(true);
        expect(mode.muted).toBe(true);
        await mode.stop();
    });

    it('started with neither, opens a capturing page once STT is ready, its microphone off while standing by', async () => {
        stubServers();
        const { opts } = options({ active: false, unavailable: { stt: 'No STT.', tts: 'No TTS.' } });
        const mode = await VoiceMode.start(opts);
        expect(page.start).not.toHaveBeenCalled();
        const s = sync(mode, {});
        s.readiness.stt = { ok: true };
        await s.sync.sync();

        expect(page.start).toHaveBeenCalledWith(expect.anything(), { capture: true });
        expect(page.audio.setMic.mock.calls.every(([on]) => on === false)).toBe(true);
        mode.setActive(true);
        expect(page.audio.setMic).toHaveBeenLastCalledWith(true);
        expect(mode.unavailable).toEqual({ tts: 'No TTS.' });
        await mode.stop();
    });

    it('keeps TTS through a failure mid-session, speaks again once it works, and takes new settings at once', async () => {
        let failing = true;
        const requests = stubServers(() => (failing ? new Response('busy', { status: 503 }) : new Response(encodeWav(new Int16Array(160), 16000), { status: 200 })));
        const { opts, reply, phases } = options({ tts: TTS, unavailable: { stt: 'No STT.' } });
        const mode = await VoiceMode.start(opts);
        const s = sync(mode, { tts: 'tts:a' });

        mode.type('One');
        reply()!.onText!('Not heard. ');
        reply()!.onEnd!(DONE);
        // TTS failed: the reply was only shown, and nothing is stuck synthesizing.
        await vi.waitFor(() => expect(phases.at(-1)).toBe('listening'));
        expect(page.audio.play).not.toHaveBeenCalled();
        s.readiness.tts = { ok: false, reason: 'busy' };
        await s.sync.sync();
        expect(mode.uses('tts')).toBe(true);
        expect(s.changes).toEqual([]);

        failing = false;
        s.readiness.tts = { ok: true };
        await s.sync.sync();
        mode.type('Two');
        reply()!.onText!('Heard. ');
        await vi.waitFor(() => expect(page.audio.play).toHaveBeenCalledOnce());

        // New settings: the next sentence goes out with them.
        s.tts.voice = 'better';
        s.settings.tts = 'tts:b';
        await s.sync.sync();
        expect(s.changes).toEqual(['tts updated']);
        mode.type('Three');
        reply()!.onText!('New voice. ');
        await vi.waitFor(() => expect(requests.at(-1)).toMatch(/audio\/speech better$/));
        await mode.stop();
    });
});
