import { describe, expect, it, vi } from 'vitest';
import {
    ECHO_VOICEPRINT_FLOOR,
    SpeakerGate,
    cosineSimilarity,
    transcribeChecked,
    voiceVetoesBargeIn,
    voiceprintCentroid,
    type SpeechGate,
} from '../../../voice/speakerGate';

const RATE = 16000;
const secs = (s: number) => new Int16Array(Math.round(s * RATE));

/** A gate whose voiceprint points along x; `embedding` is what the next utterance embeds to. */
function gate(embedding: number[], options: Partial<{ threshold: number; shortSpeech: 'accept' | 'stricter' }> = {}) {
    const embed = vi.fn(async () => embedding);
    return { embed, gate: new SpeakerGate({ centroid: [1, 0], threshold: 0.6, shortSpeech: 'stricter', ...options, embed }) };
}

describe('voiceprint centroid', () => {
    it('weighs every recording the same, however loud, and is of unit length', () => {
        // A plain mean would lean towards the first (10× longer) vector.
        const centroid = voiceprintCentroid([
            [10, 0],
            [0, 1],
        ]);
        expect(centroid[0]).toBeCloseTo(Math.SQRT1_2, 6);
        expect(centroid[1]).toBeCloseTo(Math.SQRT1_2, 6);
        expect(Math.hypot(...centroid)).toBeCloseTo(1, 6);
    });

    it('refuses no recordings, embeddings of different sizes, and an all-zero embedding', () => {
        expect(() => voiceprintCentroid([])).toThrow();
        expect(() => voiceprintCentroid([[1, 0], [1, 0, 0]])).toThrow(/differ in size/);
        expect(() => voiceprintCentroid([[0, 0]])).toThrow();
    });

    it('compares directions only: scale does not matter, opposite voices score -1', () => {
        expect(cosineSimilarity([1, 2], [10, 20])).toBeCloseTo(1, 9);
        expect(cosineSimilarity([1, 0], [0, 3])).toBe(0);
        expect(cosineSimilarity([1, 1], [-2, -2])).toBeCloseTo(-1, 9);
    });
});

describe('SpeakerGate', () => {
    it('takes a voice at or above the threshold and drops one below it, saying how close it was', async () => {
        // [3, 4] against [1, 0]: similarity exactly 0.6.
        expect(await gate([3, 4]).gate.check(secs(2), RATE)).toEqual({ accepted: true, reason: 'compared', seconds: 2, similarity: 0.6, threshold: 0.6 });
        expect(await gate([3, 4], { threshold: 0.65 }).gate.check(secs(2), RATE)).toMatchObject({ accepted: false, similarity: 0.6, threshold: 0.65 });
    });

    it('holds utterances under a second to a threshold 0.1 higher under "stricter"', async () => {
        const { gate: strict } = gate([3, 4], { threshold: 0.55 });
        expect(await strict.check(secs(1), RATE)).toMatchObject({ accepted: true, threshold: 0.55 });
        expect(await strict.check(secs(0.5), RATE)).toMatchObject({ accepted: false, threshold: 0.65 });
    });

    it('lets utterances under a second through unchecked under "accept"', async () => {
        const { gate: lenient, embed } = gate([0, 1], { shortSpeech: 'accept' });
        expect(await lenient.check(secs(0.5), RATE)).toEqual({ accepted: true, reason: 'short', seconds: 0.5 });
        expect(embed).not.toHaveBeenCalled();
        expect((await lenient.check(secs(1), RATE)).accepted).toBe(false);
    });

    it('compares short speech at the usual threshold when asked (barge-in), whatever the policy', async () => {
        // [0.28, 0.96] against [1, 0]: similarity 0.28, like a TV's short line.
        const { gate: lenient, embed } = gate([0.28, 0.96], { shortSpeech: 'accept' });
        expect(await lenient.check(secs(0.5), RATE, true)).toMatchObject({ accepted: false, reason: 'compared', threshold: 0.6 });
        expect(embed).toHaveBeenCalledOnce();
        const { gate: strict } = gate([3, 4], { threshold: 0.55 });
        expect(await strict.check(secs(0.5), RATE, true)).toMatchObject({ accepted: true, threshold: 0.55 });
    });

    it('steps aside when the embedding cannot be had, rather than dropping everything', async () => {
        const failing = new SpeakerGate({ centroid: [1, 0], threshold: 0.6, shortSpeech: 'stricter', embed: async () => Promise.reject(new Error('engine down')) });
        expect(await failing.check(secs(2), RATE)).toEqual({ accepted: true, reason: 'unavailable', seconds: 2, error: 'engine down' });
        const nan = new SpeakerGate({ centroid: [1, 0], threshold: 0.6, shortSpeech: 'stricter', embed: async () => [Number.NaN, 0] });
        expect(await nan.check(secs(2), RATE)).toMatchObject({ accepted: true, reason: 'unavailable' });
    });
});

describe('transcribeChecked', () => {
    it('transcribes and checks the prepared (noise-reduced) audio, not the raw one', async () => {
        const raw = secs(1);
        const clean = secs(1);
        const accept = vi.fn(async () => ({ accepted: false, reason: 'compared', seconds: 1, similarity: 0.1, threshold: 0.5 }) as const);
        const speech: SpeechGate = { active: true, prepare: async () => clean, accept };
        const transcribe = vi.fn(async () => 'hello');

        const heard = await transcribeChecked(transcribe, speech, raw, RATE);

        expect(transcribe).toHaveBeenCalledWith(clean, RATE);
        expect(accept).toHaveBeenCalledWith(clean, RATE, false);
        expect(heard).toEqual({ text: 'hello', verdict: expect.objectContaining({ accepted: false }) });
    });

    it('passes compareShort on to the gate', async () => {
        const accept = vi.fn(async () => ({ accepted: true, reason: 'off' }) as const);
        await transcribeChecked(async () => '', { active: true, prepare: async (pcm) => pcm, accept }, secs(0.5), RATE, true);
        expect(accept).toHaveBeenCalledWith(expect.any(Int16Array), RATE, true);
    });
});

describe('voiceVetoesBargeIn', () => {
    const compared = (similarity: number, threshold = 0.5) =>
        ({ accepted: similarity >= threshold, reason: 'compared', seconds: 1, similarity, threshold }) as const;

    it('without echo, the usual verdict stands', () => {
        expect(voiceVetoesBargeIn(compared(0.4), false)).toBe(true);
        expect(voiceVetoesBargeIn(compared(0.6), false)).toBe(false);
    });

    it('while the bot plays, refuses only a clearly other voice, below the floor', () => {
        // Your voice mixed with the echo: under the threshold, yet above the floor.
        expect(voiceVetoesBargeIn(compared(0.35), true)).toBe(false);
        // The TV seen in the logs.
        expect(voiceVetoesBargeIn(compared(0.09), true)).toBe(true);
        expect(voiceVetoesBargeIn(compared(ECHO_VOICEPRINT_FLOOR), true)).toBe(false);
    });

    it('never vetoes what the check let through unchecked', () => {
        expect(voiceVetoesBargeIn({ accepted: true, reason: 'short', seconds: 0.5 }, true)).toBe(false);
        expect(voiceVetoesBargeIn({ accepted: true, reason: 'unavailable', seconds: 1, error: 'down' }, false)).toBe(false);
    });
});
