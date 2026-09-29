import { afterEach, describe, expect, it, vi } from 'vitest';
import { DictationSession, transcribeUtterance } from '../../../voice/dictation';
import type { SpeakerVerdict, SpeechGate } from '../../../voice/speakerGate';
import type { SileroVad } from '../../../voice/sileroVad';
import type { SttClient } from '../../../voice/stt';

afterEach(() => vi.useRealTimers());

/** 0.5 s of 16 kHz audio the fake VAD scores as speech. */
const SPEECH = Buffer.alloc(16000);

function session(gate?: SpeechGate) {
    const vad = { confidence: vi.fn(async () => 0.9), reset: vi.fn() };
    const stt = { transcribe: vi.fn(async (_pcm: Int16Array, _rate: number) => 'heard') };
    const texts: string[] = [];
    const dictation = new DictationSession(
        vad as unknown as SileroVad,
        transcribeUtterance(stt as unknown as SttClient, gate),
        { confidence: 0.5, startSecs: 0.05, stopSecs: 0.2, preRollSecs: 0.1, maxSegmentSecs: 28 },
        { status: () => {}, result: (text) => texts.push(text), level: () => {}, error: () => {} },
        'onStop',
    );
    // Stands in for the recorder process start() spawns: marks it recording and feeds its stdout.
    type Recorder = { recording: boolean; draining?: Promise<void>; onAudio(chunk: Buffer): void };
    const internals: Recorder = dictation as unknown as Recorder;
    internals.recording = true;
    /** Feeds a chunk and waits until it has been processed. */
    const hear = async (chunk: Buffer) => {
        internals.onAudio(chunk);
        await internals.draining;
    };
    return { dictation, vad, stt, texts, hear };
}

describe('dictation while a Bot view message is replayed', () => {
    it('drops the utterance in progress and everything heard until just after the replay', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { dictation, vad, stt, hear } = session();
        await hear(SPEECH);
        expect(vad.confidence).toHaveBeenCalledTimes(15);

        dictation.setPaused(true);
        await hear(SPEECH);
        dictation.setPaused(false);
        await hear(SPEECH); // the echo tail, still dropped
        await dictation.stop();
        await dictation.settled;

        expect(vad.confidence).toHaveBeenCalledTimes(15);
        expect(stt.transcribe).not.toHaveBeenCalled();
    });

    it('takes the user again once the echo tail is over', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { dictation, stt, texts, hear } = session();
        dictation.setPaused(true);
        await hear(SPEECH);
        dictation.setPaused(false);
        vi.setSystemTime(Date.now() + 400);
        await hear(SPEECH);
        await dictation.stop();
        await dictation.settled;

        expect(stt.transcribe).toHaveBeenCalledOnce();
        expect(texts).toEqual(['heard']);
    });
});

describe('dictation with the voiceprint check', () => {
    it('drops the utterances in another voice and delivers the rest in speaking order', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        // Utterances 1 and 3 are yours; 2 is someone else's. The first check answers last.
        const checks: Array<PromiseWithResolvers<SpeakerVerdict>> = [];
        const verdict = (accepted: boolean): SpeakerVerdict => ({ accepted, reason: 'compared', seconds: 0.5, similarity: accepted ? 0.8 : 0.1, threshold: 0.5 });
        const gate: SpeechGate = {
            active: true,
            prepare: async (pcm) => pcm,
            accept: () => {
                checks.push(Promise.withResolvers<SpeakerVerdict>());
                return checks[checks.length - 1].promise;
            },
        };
        const { dictation, vad, stt, texts, hear } = session(gate);
        let said = 0;
        stt.transcribe.mockImplementation(async () => `utterance ${++said}`);
        for (let i = 0; i < 3; i++) {
            vad.confidence.mockImplementation(async () => 0.9);
            await hear(SPEECH);
            // A pause that ends the utterance.
            vad.confidence.mockImplementation(async () => 0.1);
            await hear(Buffer.alloc(16000));
        }
        await dictation.stop();
        await vi.waitFor(() => expect(checks).toHaveLength(3));
        checks[2].resolve(verdict(true));
        checks[1].resolve(verdict(false));
        checks[0].resolve(verdict(true));
        await dictation.settled;

        expect(texts).toEqual(['utterance 1', 'utterance 3']);
    });
});
