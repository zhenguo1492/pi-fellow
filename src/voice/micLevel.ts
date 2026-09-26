/** Frames between level reports (2 × 32 ms ≈ 16 Hz, enough for a live waveform). */
const LEVEL_EVERY_FRAMES = 2;
/** dBFS mapped to level 0 and 1: laptop-mic room noise sits near -50, conversational speech at arm's length -35..-20. */
const MIC_FLOOR_DB = -50;
const MIC_CEIL_DB = -25;

/** Points of each waveform report: the voice bar draws them across its width, oldest on the left. */
export const WAVE_POINTS = 160;
/**
 * Fixed gain of the waveform: speech at the source's `ceilDb` RMS peaks near this share of full
 * height (speech peaks run about 4× its RMS). One gain for all sound, so quiet speech looks quiet.
 */
const WAVE_PEAK_AT_CEIL = 1.6;
const SPEECH_CREST = 4;

/** dBFS of one 16-bit PCM frame. */
export function frameDb(frame: Int16Array): number {
    let sumSquares = 0;
    for (const s of frame) {
        sumSquares += s * s;
    }
    return 20 * Math.log10(Math.max(Math.sqrt(sumSquares / frame.length) / 32768, 1e-6));
}

/**
 * The real waveform of `pcm[start, end)` for the voice bar: {@link WAVE_POINTS} points, -1..1 with
 * two decimals. Each point is the sample furthest from zero in its stretch, sign kept (picking
 * every Nth sample would alias), times a fixed gain set by `ceilDb`; tanh only keeps the loudest
 * peaks from clipping flat.
 */
export function wavePoints(pcm: Int16Array, start: number, end: number, ceilDb: number): number[] {
    const gain = WAVE_PEAK_AT_CEIL / (SPEECH_CREST * 10 ** (ceilDb / 20) * 32768);
    const span = (end - start) / WAVE_POINTS;
    const points = new Array<number>(WAVE_POINTS);
    for (let p = 0; p < WAVE_POINTS; p++) {
        const from = start + Math.floor(p * span);
        const to = Math.min(end, Math.max(from + 1, start + Math.floor((p + 1) * span)));
        let peak = 0;
        for (let i = from; i < to; i++) {
            if (Math.abs(pcm[i]) > Math.abs(peak)) {
                peak = pcm[i];
            }
        }
        points[p] = Math.round(Math.tanh(peak * gain) * 100) / 100;
    }
    return points;
}

/**
 * Microphone level and waveform for the voice bar: each frame's dBFS mapped to 0..1 between
 * {@link MIC_FLOOR_DB} and {@link MIC_CEIL_DB}, peak-held over each report window, with the
 * {@link wavePoints} of that window.
 */
export class MicLevelMeter {
    private _peak = 0;
    private _frames: Int16Array[] = [];

    constructor(private readonly _report: (level: number, wave: number[]) => void) {}

    /** One frame and its dBFS ({@link frameDb}, which the caller needs as well). */
    push(frame: Int16Array, db: number): void {
        this._peak = Math.max(this._peak, Math.min(1, Math.max(0, (db - MIC_FLOOR_DB) / (MIC_CEIL_DB - MIC_FLOOR_DB))));
        this._frames.push(frame);
        if (this._frames.length < LEVEL_EVERY_FRAMES) {
            return;
        }
        const window = new Int16Array(this._frames.reduce((n, f) => n + f.length, 0));
        let at = 0;
        for (const f of this._frames) {
            window.set(f, at);
            at += f.length;
        }
        this._report(this._peak, wavePoints(window, 0, window.length, MIC_CEIL_DB));
        this._peak = 0;
        this._frames = [];
    }
}
