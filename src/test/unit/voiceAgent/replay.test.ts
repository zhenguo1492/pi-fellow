import { afterEach, describe, expect, it, vi } from 'vitest';
import { messagePlainText } from '../../../shared/voiceMessageText';
import type { VoiceReplay, VoiceViewHostMessage } from '../../../shared/voiceViewProtocol';
import { encodeWav } from '../../../voice/stt';
import type { BrowserAudio, PlaybackReport } from '../../../voiceAgent/browserAudio';
import { isEchoOf } from '../../../voiceAgent/echoFilter';
import { BotViewAudio, ReplayPlayer, type ReplayOutput } from '../../../voiceAgent/replay';
import { replayPieces } from '../../../voiceAgent/sentences';
import { SpeechCache, ttsCacheKey } from '../../../voiceAgent/speechCache';
import type { Pcm, TtsConfig } from '../../../voiceAgent/tts';
import type { VoiceTurnListener, VoiceTurnResult } from '../../../voiceAgent/voiceAgent';
import { VoiceMode, type VoiceModeOptions } from '../../../voiceAgent/voiceMode';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('message text for reading aloud and translation', () => {
    it('drops code anchors and <silent/>, and reads no code or Markdown aloud', () => {
        expect(messagePlainText('See ⟦src/a.ts:12-20⟧ here.<silent/>')).toBe('See here.');
        expect(replayPieces('**Done**. Look at ⟦src/a.ts#run⟧ this:\n```ts\nconst a = 1;\n```\nAll good').map((p) => p.text)).toEqual([
            'Done.',
            'Look at this:',
            'All good',
        ]);
        expect(replayPieces('⟦src/a.ts⟧ <silent/>')).toEqual([]);
    });

    it('says where in the message each piece is, words only, anchors inside it included', () => {
        const text = 'Hi there.  Look at ⟦src/a.ts:3⟧ the config.\nDone';
        const pieces = replayPieces(text);
        expect(pieces.map((p) => p.text)).toEqual(['Hi there.', 'Look at the config.', 'Done']);
        expect(pieces.map((p) => text.slice(...p.range!))).toEqual(['Hi there.', 'Look at ⟦src/a.ts:3⟧ the config.', 'Done']);
    });

    it('takes speech repeating a replayed message as its echo, one word only if the message has it', () => {
        expect(isEchoOf('the tests passed on the first', 'All the tests passed on the first try.')).toBe(true);
        expect(isEchoOf('passed', 'All the tests passed.')).toBe(true);
        expect(isEchoOf('wait', 'All the tests passed.')).toBe(false);
        expect(isEchoOf('can you open the config file', 'All the tests passed.')).toBe(false);
    });
});

const pcmOf = (rate: number, samples = 160): Pcm => ({ rate, data: Buffer.alloc(samples * 2) });

describe('SpeechCache', () => {
    it('keeps the newest messages, dropping the oldest first; a lookup does not make one newer', () => {
        const cache = new SpeechCache(() => 2);
        cache.put('a', 'k', [{ text: 'A.', pcm: pcmOf(1) }]);
        cache.put('b', 'k', [{ text: 'B.', pcm: pcmOf(2) }]);
        expect(cache.piece('a', 'k', 'A.')).toBeDefined();
        cache.put('c', 'k', [{ text: 'C.', pcm: pcmOf(3) }]);
        expect([cache.piece('a', 'k', 'A.'), cache.piece('b', 'k', 'B.'), cache.piece('c', 'k', 'C.')].map(Boolean)).toEqual([false, true, true]);

        // A sentence added to b makes it the newest: c goes first, and b keeps both sentences in one place.
        cache.add('b', 'k', { text: 'B2.', pcm: pcmOf(5) });
        cache.put('d', 'k', [{ text: 'D.', pcm: pcmOf(4) }]);
        expect([cache.piece('b', 'k', 'B.'), cache.piece('b', 'k', 'B2.'), cache.piece('c', 'k', 'C.'), cache.piece('d', 'k', 'D.')].map(Boolean)).toEqual([
            true,
            true,
            false,
            true,
        ]);
        expect(cache.size).toBe(2);
    });

    it('answers only for the same voice and the same sentence', () => {
        const cache = new SpeechCache();
        cache.put('a', 'voice-1', [{ text: 'One.', pcm: pcmOf(1) }]);
        expect(cache.piece('a', 'voice-2', 'One.')).toBeUndefined();
        expect(cache.piece('a', 'voice-1', 'Two.')).toBeUndefined();
        expect(cache.piece('a', 'voice-1', 'One.')?.pcm.rate).toBe(1);
    });

    it('tells voices apart by engine, server, model, voice and speed, but not the built-in engine by its unused URL', () => {
        const custom: TtsConfig = { engine: 'custom', languageField: 'none', url: 'http://tts.local/v1', model: 'kokoro', voice: 'af_heart', speed: 1 };
        const keys = [custom, { ...custom, url: 'http://other/v1' }, { ...custom, model: 'x' }, { ...custom, voice: 'bf_emma' }, { ...custom, speed: 1.2 }, { ...custom, engine: 'builtin' as const }].map(ttsCacheKey);
        expect(new Set(keys).size).toBe(keys.length);
        expect(ttsCacheKey({ ...custom, engine: 'builtin', url: '' })).toBe(ttsCacheKey({ ...custom, engine: 'builtin', url: 'http://ignored' }));
    });

});

/** Stubs the TTS server: each sentence comes back as a WAV whose sample rate names it. Returns the inputs asked for. */
function stubTts(rates: Record<string, number>, fail?: string): string[] {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string; signal?: AbortSignal }) => {
        const { input }: { input: string } = JSON.parse(init.body);
        asked.push(input);
        if (input === fail) {
            return new Response('boom', { status: 500 });
        }
        return new Response(encodeWav(new Int16Array(160).fill(4000), rates[input] ?? 16000));
    });
    return asked;
}

/** An output whose clips start and end when the test says. */
function fakeOutput() {
    const ctl = new AbortController();
    const played: number[] = [];
    const clips: Array<{ start?: () => void; end: () => void }> = [];
    let ends = 0;
    const output: ReplayOutput = {
        signal: ctl.signal,
        play: (pcm: Pcm, onPlaying?: () => void) => {
            const { promise, resolve } = Promise.withResolvers<void>();
            played.push(pcm.rate);
            clips.push({ start: onPlaying, end: resolve });
            return promise;
        },
        end: () => {
            ends++;
            clips.splice(0).forEach((clip) => clip.end());
        },
    };
    return {
        ctl,
        output,
        played,
        start: (i: number) => clips[i].start?.(),
        finish: (i: number) => clips[i].end(),
        ends: () => ends,
    };
}

const sentence = (text: string, start = 0) => ({ text, range: [start, start + text.length] as [number, number] });

function player(output: () => ReplayOutput | string, cache = new SpeechCache(), ttsKey = 'voice-1') {
    const changes: Array<VoiceReplay | undefined> = [];
    const errors: string[] = [];
    const replay = new ReplayPlayer({
        cache,
        ttsKey: () => ttsKey,
        tts: async () => ({ engine: 'custom', languageField: 'none', url: 'http://tts.local', model: '', voice: '', speed: 1 }),
        output,
        onChange: (current) => changes.push(current),
        onError: (message) => errors.push(message),
        log: () => {},
    });
    return { replay, changes, errors };
}

describe('ReplayPlayer', () => {
    it('is loading while with TTS, queued until the output reports it playing, and over once it has played', async () => {
        stubTts({ 'First one.': 8001 });
        const out = fakeOutput();
        const { replay, changes } = player(() => out.output);

        const done = replay.toggle('e1', sentence('First one.'));
        await vi.waitFor(() => expect(out.played).toEqual([8001]));
        expect(replay.current?.phase).toBe('queued');
        out.start(0);
        expect(replay.current?.phase).toBe('playing');
        out.finish(0);
        await done;
        expect(changes.map((c) => c?.phase)).toEqual(['loading', 'queued', 'playing', undefined]);
        expect(replay.current).toBeUndefined();
    });

    it("synthesizes a sentence once per voice, kept with its message's other sentences", async () => {
        const asked = stubTts({});
        const cache = new SpeechCache();
        const read = async (text: string, ttsKey = 'voice-1') => {
            const out = fakeOutput();
            const done = player(() => out.output, cache, ttsKey).replay.toggle('e1', sentence(text));
            await vi.waitFor(() => expect(out.played).toHaveLength(1));
            out.finish(0);
            await done;
        };

        await read('One.');
        await read('Two.');
        await read('One.');
        await read('Two.');
        expect(asked).toEqual(['One.', 'Two.']);
        expect(cache.size).toBe(1);
        await read('One.', 'voice-2');
        expect(asked).toEqual(['One.', 'Two.', 'One.']);
    });

    it('reads a sentence voice mode spoke from its live audio', async () => {
        const asked = stubTts({});
        const cache = new SpeechCache();
        cache.put('e1', 'voice-1', [
            { text: 'Spoken live.', pcm: pcmOf(7001) },
            { text: 'Twice.', pcm: pcmOf(7002) },
        ]);
        const out = fakeOutput();
        const done = player(() => out.output, cache).replay.toggle('e1', { text: 'Twice.', sentence: 1 });
        await vi.waitFor(() => expect(out.played).toEqual([7002]));
        out.finish(0);
        await done;
        expect(asked).toEqual([]);
    });

    it('stops when the same sentence is clicked again, even while it is with TTS, and caches nothing half-made', async () => {
        // TTS that answers only by failing once the request is aborted.
        let requested = false;
        vi.stubGlobal('fetch', (_url: string, init: { body: string; signal: AbortSignal }) => {
            requested = true;
            const { promise, reject } = Promise.withResolvers<Response>();
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
            return promise;
        });
        const cache = new SpeechCache();
        const out = fakeOutput();
        const { replay, errors } = player(() => out.output, cache);

        const done = replay.toggle('e1', sentence('Two.', 5));
        await vi.waitFor(() => expect(requested).toBe(true));
        expect(replay.current?.phase).toBe('loading');
        await replay.toggle('e1', sentence('Two.', 5));
        await done;
        expect(out.ends()).toBeGreaterThan(0);
        expect(replay.current).toBeUndefined();
        expect(cache.size).toBe(0);
        expect(errors).toEqual([]);
    });

    it('stops when its output takes the speakers back (the voice agent starts speaking)', async () => {
        stubTts({});
        const out = fakeOutput();
        const { replay, errors } = player(() => out.output);

        const done = replay.toggle('e1', sentence('One.'));
        await vi.waitFor(() => expect(out.played).toHaveLength(1));
        out.ctl.abort();
        await done;
        expect(out.ends()).toBeGreaterThan(0);
        expect(replay.current).toBeUndefined();
        expect(errors).toEqual([]);
    });

    it('reports why it cannot play, and a TTS failure', async () => {
        stubTts({}, 'Broken.');
        const refused = player(() => 'The voice agent is speaking.');
        await refused.replay.toggle('e1', sentence('Hello.'));
        expect(refused.errors).toEqual(['The voice agent is speaking.']);

        const out = fakeOutput();
        const failing = player(() => out.output);
        await failing.replay.toggle('e2', sentence('Broken.'));
        expect(failing.errors).toHaveLength(1);
        expect(failing.replay.current).toBeUndefined();
        expect(out.ends()).toBeGreaterThan(0);
    });
});

describe('BotViewAudio', () => {
    it("reports a clip starting and resolves it when the view says it ended; ending drops the rest and halts the view's audio", async () => {
        const posted: VoiceViewHostMessage[] = [];
        const audio = new BotViewAudio((message) => posted.push(message));
        const out = audio.output();
        const pcm = { rate: 16000, data: Buffer.alloc(3200) };
        let first = false;
        let second = false;
        const started = vi.fn();
        void out.play(pcm, started).then(() => (first = true));
        void out.play(pcm).then(() => (second = true));
        const clipIds = posted.flatMap((m) => (m.type === 'replayAudio' ? [m.clipId] : []));
        expect(clipIds).toHaveLength(2);

        audio.clipStarted(clipIds[0]);
        audio.clipStarted(clipIds[0]);
        expect(started).toHaveBeenCalledOnce();
        audio.clipEnded(clipIds[0]);
        await vi.waitFor(() => expect(first).toBe(true));
        expect(second).toBe(false);

        out.end();
        await vi.waitFor(() => expect(second).toBe(true));
        expect(posted.at(-1)).toEqual({ type: 'replayHalt' });
    });
});

describe('VoiceMode: a replay on the audio page', () => {
    type Devices = { vad?: unknown; audio?: BrowserAudio; stt?: VoiceModeOptions['stt']; tts?: VoiceModeOptions['tts'] };
    const Construct = VoiceMode as unknown as new (options: VoiceModeOptions, devices: Devices, sttModel: string, unavailable: object) => VoiceMode;

    function voiceMode() {
        let reply: VoiceTurnListener | undefined;
        const vad = { confidence: vi.fn(async () => 0), reset: vi.fn() };
        const audio = { url: '', connected: true, play: vi.fn(), flush: vi.fn(), setMic: vi.fn(), enableCapture: vi.fn(), close: vi.fn() };
        const options = {
            agent: {
                say: vi.fn((_text: string, _source: string, listener: VoiceTurnListener) => {
                    reply = listener;
                    return new Promise(() => {});
                }),
                floorReleased: vi.fn(),
            },
            vad: { modelPath: '', runtimeDir: '' },
            stt: { url: 'http://stt.local', model: 'm', language: '' },
            tts: { engine: 'custom', languageField: 'none', url: 'http://tts.local', model: '', voice: '', speed: 1 },
            turnStopSecs: 1,
            vadConfidence: 0.5,
            chromeArgs: [],
            active: true,
            transcript: () => ({}),
            openExternal: () => {},
            onPhase: () => {},
            onSpoken: vi.fn(),
            log: () => {},
        } as unknown as VoiceModeOptions;
        const mode = new Construct(options, { vad, audio: audio as BrowserAudio, stt: options.stt, tts: options.tts }, 'm', {});
        // The hidden audio page's microphone and playback callbacks; private, as only startBrowserAudio calls them.
        type Page = { _onMic(chunk: Buffer): void; _onPlayback(report: PlaybackReport): void };
        const internals: Page = mode as unknown as Page;
        return {
            mode,
            vad,
            audio,
            options,
            mic: (chunk: Buffer) => internals._onMic(chunk),
            report: (report: PlaybackReport) => internals._onPlayback(report),
            reply: () => reply,
        };
    }

    it('hears nothing while the replay plays and for its echo tail, then listens again', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { mode, vad, mic } = voiceMode();
        const replay = mode.beginReplay('All the tests passed.');
        if (!replay || typeof replay === 'string') {
            throw new Error(replay);
        }
        expect(mode.floorBusy).toBe(true);

        mic(Buffer.alloc(1024));
        await Promise.resolve();
        expect(vad.confidence).not.toHaveBeenCalled();

        replay.end();
        mic(Buffer.alloc(1024));
        await Promise.resolve();
        expect(vad.confidence).not.toHaveBeenCalled();

        vi.setSystemTime(Date.now() + 400);
        mic(Buffer.alloc(1024));
        await vi.waitFor(() => expect(vad.confidence).toHaveBeenCalled());
        expect(mode.floorBusy).toBe(false);
    });

    it('gives the speakers back as soon as the voice agent speaks, and refuses a replay while it does', async () => {
        vi.stubGlobal('fetch', () => new Promise(() => {}));
        const { mode, audio, reply } = voiceMode();
        const replay = mode.beginReplay('Old message.');
        if (!replay || typeof replay === 'string') {
            throw new Error(replay);
        }
        void replay.play({ rate: 16000, data: Buffer.alloc(320) });
        expect(audio.play).toHaveBeenCalledOnce();

        mode.type('What now?');
        reply()!.onText!('Here is the plan. ');

        expect(replay.signal.aborted).toBe(true);
        expect(audio.flush).toHaveBeenCalled();
        expect(mode.beginReplay('Old message.')).toMatch(/speaking/);
    });

    it("moves a replay's highlight by the page's own start reports", () => {
        const { mode, audio, report } = voiceMode();
        const replay = mode.beginReplay('One. Two.');
        if (!replay || typeof replay === 'string') {
            throw new Error(replay);
        }
        const started = vi.fn();
        void replay.play({ rate: 16000, data: Buffer.alloc(320) }, started);
        const clipId: number = audio.play.mock.calls[0][0];
        expect(started).not.toHaveBeenCalled();
        report({ type: 'started', clipId, at: Date.now(), durationMs: 10 });
        expect(started).toHaveBeenCalledOnce();
    });

    it('hands a reply it spoke whole to the cache, sentence by sentence', async () => {
        stubTts({ 'Hello there.': 8001, 'All done.': 8002 });
        const { mode, audio, options, report, reply } = voiceMode();
        mode.type('Hi');
        reply()!.onText!('Hello there. All done.');
        const result: VoiceTurnResult = { reply: 'Hello there. All done.', silent: false, toolCalls: [], lookups: [], interrupted: false };
        reply()!.onEnd!(result);

        await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
        for (const [clipId] of audio.play.mock.calls) {
            report({ type: 'started', clipId, at: Date.now(), durationMs: 10 });
            report({ type: 'ended', clipId, at: Date.now() });
        }
        await vi.waitFor(() => expect(options.onSpoken).toHaveBeenCalledOnce());
        const [, spoken] = vi.mocked(options.onSpoken!).mock.calls[0];
        expect(spoken.map((p) => [p.text, p.pcm.rate])).toEqual([
            ['Hello there.', 8001],
            ['All done.', 8002],
        ]);
    });
});
