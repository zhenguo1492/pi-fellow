/**
 * The voiceprint check: is an utterance the enrolled speaker's voice? Its speaker embedding is
 * compared with the voiceprint (the normalized mean of the enrollment recordings' embeddings) by
 * cosine similarity. No `vscode` import: ./voiceprint.ts wires it to the settings and the engine.
 */
import type { ShortSpeechPolicy } from '../shared/voiceprint';

/** Utterances shorter than this carry too little voice for a reliable embedding. */
export const SHORT_SPEECH_SECS = 1;
/** How much higher the threshold is for short utterances under the `stricter` policy. */
export const SHORT_SPEECH_MARGIN = 0.1;

export function l2Normalize(v: ArrayLike<number>): Float32Array {
    let squares = 0;
    for (let i = 0; i < v.length; i++) {
        squares += v[i] * v[i];
    }
    const norm = Math.sqrt(squares);
    if (!(norm > 0) || !Number.isFinite(norm)) {
        throw new Error('The speaker embedding is empty (zero or not a number)');
    }
    return Float32Array.from(v, (x) => x / norm);
}

/**
 * The voiceprint of the enrollment embeddings: each normalized (every recording weighs the same,
 * however loud or long), averaged, and the mean normalized again.
 */
export function voiceprintCentroid(embeddings: readonly ArrayLike<number>[]): Float32Array {
    if (embeddings.length === 0) {
        throw new Error('A voiceprint needs at least one recording');
    }
    const dim = embeddings[0].length;
    const sum = new Float64Array(dim);
    for (const embedding of embeddings) {
        if (embedding.length !== dim) {
            throw new Error(`Speaker embeddings differ in size (${embedding.length} vs ${dim})`);
        }
        const unit = l2Normalize(embedding);
        for (let i = 0; i < dim; i++) {
            sum[i] += unit[i];
        }
    }
    return l2Normalize(sum);
}

/** Cosine similarity, -1..1; NaN when either vector has no direction (all zero, or not numbers). */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
    if (a.length !== b.length) {
        throw new Error(`Speaker embeddings differ in size (${a.length} vs ${b.length})`);
    }
    let dot = 0;
    let aa = 0;
    let bb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        aa += a[i] * a[i];
        bb += b[i] * b[i];
    }
    return dot / Math.sqrt(aa * bb);
}

/**
 * What the check made of an utterance. `off`: no check (no voiceprint, or turned off); `short`: too
 * short to judge and let through; `compared`: judged by its similarity; `unavailable`: the check
 * could not run (the engine failed) and let it through rather than drop everything.
 */
export type SpeakerVerdict =
    | { accepted: true; reason: 'off' }
    | { accepted: true; reason: 'short'; seconds: number }
    | { accepted: boolean; reason: 'compared'; seconds: number; similarity: number; threshold: number }
    | { accepted: true; reason: 'unavailable'; seconds: number; error: string };

export const ACCEPT_UNCHECKED: SpeakerVerdict = { accepted: true, reason: 'off' };

export interface SpeakerGateOptions {
    /** The voiceprint. */
    centroid: ArrayLike<number>;
    /** Similarity at or above which a voice is the enrolled speaker's. */
    threshold: number;
    shortSpeech: ShortSpeechPolicy;
    /** The speaker embedding of an utterance. */
    embed(pcm: Int16Array, sampleRate: number): Promise<ArrayLike<number>>;
}

export class SpeakerGate {
    constructor(private readonly _options: SpeakerGateOptions) {}

    /** The threshold `seconds` of speech must reach; undefined: short speech let through unchecked. */
    thresholdFor(seconds: number): number | undefined {
        const { threshold, shortSpeech } = this._options;
        if (seconds >= SHORT_SPEECH_SECS) {
            return threshold;
        }
        return shortSpeech === 'accept' ? undefined : Math.min(1, threshold + SHORT_SPEECH_MARGIN);
    }

    /**
     * Whether `pcm` is the enrolled speaker's voice. Never rejects: a failing embedding lets it through (`unavailable`).
     * `compareShort`: short speech is compared at the usual threshold too (barge-in, where a TV's short line must not pass).
     */
    async check(pcm: Int16Array, sampleRate: number, compareShort = false): Promise<SpeakerVerdict> {
        const seconds = pcm.length / sampleRate;
        const threshold = compareShort ? this._options.threshold : this.thresholdFor(seconds);
        if (threshold === undefined) {
            return { accepted: true, reason: 'short', seconds };
        }
        let similarity: number;
        try {
            similarity = cosineSimilarity(this._options.centroid, await this._options.embed(pcm, sampleRate));
            if (!Number.isFinite(similarity)) {
                throw new Error('the speaker embedding is not a number');
            }
        } catch (err) {
            return { accepted: true, reason: 'unavailable', seconds, error: err instanceof Error ? err.message : String(err) };
        }
        return { accepted: similarity >= threshold, reason: 'compared', seconds, similarity, threshold };
    }
}

/**
 * While the bot plays, a barge-in is refused as another voice only below this similarity: your voice
 * mixed with the echo scores lower than usual, a TV or a child far lower (0.08–0.16 seen).
 */
export const ECHO_VOICEPRINT_FLOOR = 0.25;

/**
 * Whether the voiceprint alone refuses a barge-in. Without echo the usual verdict stands; while the bot
 * plays (`echo`), only a clearly other voice is refused and the echo check decides the rest.
 */
export function voiceVetoesBargeIn(verdict: SpeakerVerdict, echo: boolean): boolean {
    if (verdict.accepted) {
        return false;
    }
    return !echo || (verdict.reason === 'compared' && verdict.similarity < ECHO_VOICEPRINT_FLOOR);
}

/** A verdict in words, for the logs. */
export function describeVerdict(verdict: SpeakerVerdict): string {
    switch (verdict.reason) {
        case 'off':
            return 'no voiceprint check';
        case 'short':
            return `${verdict.seconds.toFixed(1)} s: too short to check, let through`;
        case 'unavailable':
            return `${verdict.seconds.toFixed(1)} s: the check failed (${verdict.error}), let through`;
        case 'compared':
            return `${verdict.seconds.toFixed(1)} s: similarity ${verdict.similarity.toFixed(2)} ${verdict.accepted ? '≥' : '<'} ${verdict.threshold.toFixed(2)}, ${verdict.accepted ? 'your voice' : 'not your voice'}`;
    }
}

/** What speech input runs each finished utterance through before using it (./voiceprint.ts `speechGate`). */
export interface SpeechGate {
    /** `accept` compares voices now (a voiceprint is enrolled and turned on). */
    readonly active: boolean;
    /** The utterance as speech-to-text and the check should hear it: with the noise taken out, when that is on. */
    prepare(pcm: Int16Array, sampleRate: number): Promise<Int16Array>;
    /** Whether `pcm` is the enrolled speaker's voice; never rejects. `compareShort`: see `SpeakerGate.check`. */
    accept(pcm: Int16Array, sampleRate: number, compareShort?: boolean): Promise<SpeakerVerdict>;
}

/**
 * Transcribes an utterance and checks its voice at the same time, after `gate.prepare`. Speech-to-text
 * failing rejects, as without a gate; the verdict says whether to use the text.
 */
export async function transcribeChecked(
    transcribe: (pcm: Int16Array, sampleRate: number) => Promise<string>,
    gate: SpeechGate | undefined,
    pcm: Int16Array,
    sampleRate: number,
    compareShort = false,
): Promise<{ text: string; verdict: SpeakerVerdict }> {
    if (!gate) {
        return { text: await transcribe(pcm, sampleRate), verdict: ACCEPT_UNCHECKED };
    }
    const clean = await gate.prepare(pcm, sampleRate);
    const [text, verdict] = await Promise.all([transcribe(clean, sampleRate), gate.accept(clean, sampleRate, compareShort)]);
    return { text, verdict };
}
