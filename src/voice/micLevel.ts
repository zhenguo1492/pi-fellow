/** Frames between level reports (2 × 32 ms ≈ 16 Hz, enough for a live spectrum). */
const LEVEL_EVERY_FRAMES = 2;
/** dBFS mapped to level 0 and 1: laptop-mic room noise sits near -50, conversational speech at arm's length -35..-20. */
const MIC_FLOOR_DB = -50;
const MIC_CEIL_DB = -25;

/** Bars of the voice bar's spectrum: mel-spaced bands, lowest first. */
export const SPECTRUM_BANDS = 20;
/** The spectrum's range: voice fundamentals up to the top of 16 kHz audio. */
const SPECTRUM_LOW_HZ = 80;
const SPECTRUM_HIGH_HZ = 7600;
/** A band this far (dB) below its full mark is empty. */
const SPECTRUM_RANGE_DB = 36;
/** A band is full this far above the source's level ceiling, so only the loudest moments peg it. */
const SPECTRUM_HEADROOM_DB = 6;
/**
 * Lift per octave above {@link TILT_FROM_HZ}: voiced speech loses about 6 dB an octave, and wider
 * mel bands at the top win back about 3, so without it the right-hand bars would barely rise.
 */
const TILT_DB_PER_OCTAVE = 3;
const TILT_FROM_HZ = 500;

/** dBFS of one 16-bit PCM frame. */
export function frameDb(frame: Int16Array): number {
    let sumSquares = 0;
    for (const s of frame) {
        sumSquares += s * s;
    }
    return 20 * Math.log10(Math.max(Math.sqrt(sumSquares / frame.length) / 32768, 1e-6));
}

const mel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
const hzOfMel = (m: number): number => 700 * (10 ** (m / 2595) - 1);

/** FFT size, Hann window and each band's bin range and level offset, per sample rate. */
interface SpectrumPlan {
    size: number;
    hann: Float64Array;
    /** Scales |X|² to the share of mean-square power (0..1 full scale) in that bin. */
    norm: number;
    bands: { from: number; to: number; offsetDb: number }[];
}

const plans = new Map<number, SpectrumPlan>();

function spectrumPlan(rate: number): SpectrumPlan {
    let plan = plans.get(rate);
    if (plan) {
        return plan;
    }
    // About 32 ms per transform: 512 points at 16 kHz, 1024 at 24 kHz.
    let size = 256;
    while (size < rate * 0.032) {
        size *= 2;
    }
    const hann = new Float64Array(size);
    let windowPower = 0;
    for (let i = 0; i < size; i++) {
        hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
        windowPower += hann[i] * hann[i];
    }
    const binHz = rate / size;
    const high = Math.min(SPECTRUM_HIGH_HZ, rate / 2 - binHz);
    const lowMel = mel(SPECTRUM_LOW_HZ);
    const step = (mel(high) - lowMel) / SPECTRUM_BANDS;
    const bands: SpectrumPlan['bands'] = [];
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
        const loHz = hzOfMel(lowMel + b * step);
        const hiHz = hzOfMel(lowMel + (b + 1) * step);
        // At least one bin, so narrow low bands at coarse resolution still see their frequency.
        const from = Math.max(1, Math.round(loHz / binHz));
        const to = Math.max(from + 1, Math.round(hiHz / binHz));
        const centre = Math.sqrt(loHz * hiHz);
        bands.push({ from, to, offsetDb: TILT_DB_PER_OCTAVE * Math.max(0, Math.log2(centre / TILT_FROM_HZ)) });
    }
    plan = { size, hann, norm: 2 / (size * windowPower * 32768 * 32768), bands };
    plans.set(rate, plan);
    return plan;
}

/** In-place radix-2 FFT; `re.length` is a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) {
            j ^= bit;
        }
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const angle = (-2 * Math.PI) / len;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < len >> 1; k++) {
                const a = i + k;
                const b = a + (len >> 1);
                const tr = re[b] * cr - im[b] * ci;
                const ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
            }
        }
    }
}

/**
 * Energy of `pcm[start, end)` in each of {@link SPECTRUM_BANDS} mel bands, 0..1 with two
 * decimals: what the voice bar's spectrum shows. Hann-windowed ~32 ms transforms averaged over the
 * stretch (the last one ends at `end`; a shorter stretch is zero-padded). A band is full at
 * {@link SPECTRUM_HEADROOM_DB} over `ceilDb` (after the high-frequency lift), empty {@link SPECTRUM_RANGE_DB} below that.
 */
export function spectrumBands(pcm: Int16Array, start: number, end: number, rate: number, ceilDb: number): number[] {
    const plan = spectrumPlan(rate);
    const { size, hann } = plan;
    const power = new Float64Array(size >> 1);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    let transforms = 0;
    for (let to = end; transforms === 0 || to - size >= start; to -= size) {
        const from = to - size;
        for (let i = 0; i < size; i++) {
            const at = from + i;
            re[i] = at >= start && at < end ? pcm[at] * hann[i] : 0;
            im[i] = 0;
        }
        fft(re, im);
        for (let k = 1; k < size >> 1; k++) {
            power[k] += re[k] * re[k] + im[k] * im[k];
        }
        transforms++;
    }
    // Spread evenly, full-scale sound would put 1/BANDS of its power in each band: judge bands against that share.
    const shareDb = 10 * Math.log10(SPECTRUM_BANDS);
    return plan.bands.map(({ from, to, offsetDb }) => {
        let sum = 0;
        for (let k = from; k < to; k++) {
            sum += power[k];
        }
        const db = 10 * Math.log10(Math.max((sum * plan.norm) / transforms, 1e-12)) + shareDb + offsetDb;
        return Math.round(Math.min(1, Math.max(0, (db - ceilDb - SPECTRUM_HEADROOM_DB + SPECTRUM_RANGE_DB) / SPECTRUM_RANGE_DB)) * 100) / 100;
    });
}

/**
 * Microphone level and spectrum for the voice bar: each frame's dBFS mapped to 0..1 between
 * {@link MIC_FLOOR_DB} and {@link MIC_CEIL_DB}, peak-held over each report window, with the
 * {@link spectrumBands} of that window.
 */
export class MicLevelMeter {
    private _peak = 0;
    private _frames: Int16Array[] = [];

    constructor(
        private readonly _report: (level: number, bands: number[]) => void,
        private readonly _rate: number,
    ) {}

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
        this._report(this._peak, spectrumBands(window, 0, window.length, this._rate, MIC_CEIL_DB));
        this._peak = 0;
        this._frames = [];
    }
}
