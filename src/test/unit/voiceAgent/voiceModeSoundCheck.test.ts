import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as SileroVadModule from '../../../voice/sileroVad';
import type { SpeakerVerdict, SpeechGate } from '../../../voice/speakerGate';
import type { BrowserAudio } from '../../../voiceAgent/browserAudio';
import type { Phase } from '../../../voiceAgent/conversation';
import { VoiceMode, type VoiceModeOptions } from '../../../voiceAgent/voiceMode';

const page = vi.hoisted(() => ({
    audio: { url: 'http://127.0.0.1:1/?token=t', connected: true, play: () => {}, flush: () => {}, setMic: () => {}, enableCapture: () => {}, close: () => {} },
    mic: undefined as ((chunk: Buffer) => void) | undefined,
}));

vi.mock('../../../voiceAgent/browserAudio', () => ({
    startBrowserAudio: async (handlers: { mic: (chunk: Buffer) => void }) => {
        page.mic = handlers.mic;
        return page.audio as unknown as BrowserAudio;
    },
    findChrome: () => undefined,
    launchHiddenChrome: () => {},
}));

// A frame is speech when its samples are not silent.
vi.mock('../../../voice/sileroVad', async (importOriginal) => ({
    ...(await importOriginal<typeof SileroVadModule>()),
    SileroVad: { load: async () => ({ confidence: async (frame: Int16Array) => (frame[0] !== 0 ? 0.9 : 0), reset: () => {} }) },
}));

afterEach(() => {
    vi.unstubAllGlobals();
});

const FRAME = 512;
const RATE = 16000;

/** `secs` of audio as the page sends it: speech (a constant non-zero signal) or silence. */
function audio(secs: number, speech: boolean): Buffer {
    const frames = Math.round((secs * RATE) / FRAME);
    const pcm = new Int16Array(frames * FRAME).fill(speech ? 1000 : 0);
    return Buffer.from(pcm.buffer);
}

const verdict = (accepted: boolean): SpeakerVerdict => ({ accepted, reason: 'compared', seconds: 1, similarity: accepted ? 0.8 : 0.1, threshold: 0.5 });

async function start(gate: SpeechGate | undefined) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => (url.endsWith('/models') ? Response.json({ data: [{ id: 'whisper' }] }) : Response.json({ text: 'run the tests' }))),
    );
    const phases: Phase[] = [];
    const say = vi.fn(() => Promise.withResolvers<never>().promise);
    const opts = {
        agent: { say, floorReleased: () => {} },
        vad: { modelPath: '/nonexistent/silero.onnx', runtimeDir: '/nonexistent' },
        stt: { url: 'http://stt.local/v1', model: '', language: '' },
        tts: undefined,
        unavailable: { tts: 'No TTS.' },
        gate,
        turnStopSecs: 0.5,
        vadConfidence: 0.5,
        chromeArgs: [],
        active: true,
        transcript: () => ({}),
        openExternal: () => {},
        onPhase: (phase: Phase) => phases.push(phase),
        log: () => {},
    } as unknown as VoiceModeOptions;
    const mode = await VoiceMode.start(opts);
    return { mode, phases, say };
}

/** A gate whose verdict the test sets; it records how much audio each check heard. */
function gate(accepted: boolean) {
    const heard: number[] = [];
    const g: SpeechGate = {
        active: true,
        prepare: async (pcm) => pcm,
        accept: async (pcm) => {
            heard.push(pcm.length / RATE);
            return verdict(accepted);
        },
    };
    return { gate: g, heard };
}

describe('VoiceMode: speech is only a sound until the voiceprint check finds it is you', () => {
    it('shows detecting speech first, then hearing you once an early check passes while you still talk', async () => {
        const { gate: g, heard } = gate(true);
        const { mode, phases, say } = await start(g);

        page.mic!(audio(0.5, true));
        await vi.waitFor(() => expect(phases).toContain('soundDetected'));
        expect(phases).not.toContain('userSpeaking');
        page.mic!(audio(1, true));
        await vi.waitFor(() => expect(phases).toContain('userSpeaking'));
        // Checked early, on enough audio to compare (not let through as short), before the segment ended.
        expect(heard[0]).toBeGreaterThanOrEqual(1);
        expect(phases.indexOf('soundDetected')).toBeLessThan(phases.indexOf('userSpeaking'));

        page.mic!(audio(1, false));
        await vi.waitFor(() => expect(say).toHaveBeenCalledOnce());
        expect(say.mock.calls[0]).toContain('run the tests');
        await mode.stop();
    });

    it('never shows hearing you for another voice, and goes back to listening', async () => {
        const { gate: g, heard } = gate(false);
        const { mode, phases, say } = await start(g);

        page.mic!(audio(2.5, true));
        await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(2)); // rechecked as more came in
        page.mic!(audio(1, false));
        await vi.waitFor(() => expect(phases.at(-1)).toBe('listening'));
        expect(phases).toContain('soundDetected');
        expect(phases).not.toContain('userSpeaking');
        expect(say).not.toHaveBeenCalled();
        await mode.stop();
    });

    it('without the voiceprint check, hears you at once as before', async () => {
        const { mode, phases } = await start(undefined);

        page.mic!(audio(0.5, true));
        await vi.waitFor(() => expect(phases).toContain('userSpeaking'));
        expect(phases).not.toContain('soundDetected');
        await mode.stop();
    });
});
