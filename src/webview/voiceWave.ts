/**
 * The wave in the voice bar (the input box's header): a voice-like line across the space between
 * the status and the buttons, showing the sound right now. Green is the user's microphone
 * (dictation, or voice mode unmuted), blue the bot's reply as it plays; both show when they sound
 * at once, travelling in opposite directions.
 *
 * The host measures the sound's spectrum (src/voice/micLevel.ts `spectrumBands`: energy 0..1 in 20
 * mel bands, ~16 reports a second; the webview cannot open the microphone or hear the bot). Every
 * band is one sine component: low bands long waves, high bands short ripples, each as strong as
 * its band's smoothed energy, so the line's shape is the sound's frequency content and its height
 * the sound's loudness. Wavelengths never change, only amplitudes (rising fast, falling slowly)
 * and phases (drifting at slightly different speeds), so the shape evolves without flickering.
 * Two fainter layers, the same bands out of phase and the upper bands alone, give it depth.
 * Silent, the user's line lies almost flat; the bot's disappears. The whole wave fades out once
 * neither line is open.
 */
import type { VoiceLevelSource } from '../shared/protocol';

const WAVE_ID = 'voice-wave';
const SOURCES = ['user', 'bot'] as const;
/** Components; the host's band count (`SPECTRUM_BANDS`). Reports with another count are resampled. */
const BANDS = 20;
/** Per-band smoothing time constants: a syllable shows at once and ebbs away instead of flickering. */
const ATTACK_MS = 70;
const RELEASE_MS = 260;
/** No report for this long reads as silence (a busy host, a dropped message). */
const STALE_MS = 300;
/** Mean band energy that fills the height: loud speech averages about 0.5 (micLevel.ts calibration). */
const FULL_ENERGY = 0.55;
/** Wavelength in CSS pixels of the lowest and the highest band's component; geometric in between. */
const LOWEST_WAVE_PX = 64;
const HIGHEST_WAVE_PX = 10;
/** Pixels a second the components travel at silence and at full energy. */
const REST_SPEED_PX = 5;
const FULL_SPEED_PX = 28;
/** The shape's RMS is scaled to this share of the swing before soft clipping, so peaks land near the edge. */
const SHAPE_RMS = 0.42;
/** Height of the open microphone's line at silence, as a share of the swing: "listening". */
const USER_FLOOR = 0.06;
/** Wavelength of that resting line, in CSS pixels. */
const FLOOR_WAVE_PX = 30;
/** Bot energy below this is not drawn: its line shows only while it makes a sound. */
const BOT_QUIET = 0.03;
/** Drawing resolution along the line, in CSS pixels. */
const STEP_PX = 1;
/** Matches the `.voice-wave` opacity transition in main.css. */
const FADE_MS = 250;

/** Spatial frequency (radians per px) of each band's component. */
const WAVENUMBER = Float64Array.from({ length: BANDS }, (_, i) => (2 * Math.PI) / (LOWEST_WAVE_PX * (HIGHEST_WAVE_PX / LOWEST_WAVE_PX) ** (i / (BANDS - 1))));
/** Per-band speed factors around 1, so components slide past each other and the shape keeps changing. */
const DRIFT = Float64Array.from({ length: BANDS }, (_, i) => 1 + 0.35 * Math.sin(i * 2.39 + 0.7));
/** Phase offsets of the second layer: the same sound seen from another angle. */
const ECHO_OFFSET = Float64Array.from({ length: BANDS }, (_, i) => 1.1 + i * 0.83);

/** The layers drawn per line: the main line, its out-of-phase echo, and the upper bands alone. */
const LAYERS = [
    { gain: 1, from: 0, offset: false },
    { gain: 0.7, from: 0, offset: true },
    { gain: 0.55, from: BANDS / 2, offset: false },
] as const;

interface Line {
    open: boolean;
    /** Latest reported band energies, 0..1. */
    target: Float64Array;
    /** Smoothed band energies drawn now, 0..1. */
    shown: Float64Array;
    /** Radians each component has travelled; the direction differs per line so overlapping lines stay apart. */
    phase: Float64Array;
    /** The resting line's phase. */
    floorPhase: number;
    direction: 1 | -1;
    reportedAt: number;
}

const newLine = (direction: 1 | -1, seed: number): Line => ({
    open: false,
    target: new Float64Array(BANDS),
    shown: new Float64Array(BANDS),
    phase: Float64Array.from({ length: BANDS }, (_, i) => seed + i * 1.93),
    floorPhase: seed,
    direction,
    reportedAt: 0,
});

const lines: Record<VoiceLevelSource, Line> = { user: newLine(1, 0), bot: newLine(-1, 2.1) };
let lastFrame = 0;
let frame: number | undefined;
let fadeTimer: number | undefined;

export const voiceWaveHtml = `<span id="${WAVE_ID}" class="voice-wave" title="Green: what the microphone hears. Blue: the bot speaking." aria-hidden="true" hidden>
        <svg>${(['bot', 'user'] as const)
            // The bot behind the user; within a line, the faint layers behind the main one.
            .flatMap((source) => LAYERS.map((_, layer) => `<path class="voice-wave-line" data-source="${source}" data-layer="${layer}"/>`).reverse())
            .join('')}</svg>
    </span>`;

/** Which lines are shown. A closing line ebbs away; with neither open the wave fades out and hides. */
export function setWaveOpen(next: Record<VoiceLevelSource, boolean>): void {
    for (const source of SOURCES) {
        const line = lines[source];
        line.open = next[source];
        if (!line.open) {
            line.target.fill(0);
        }
    }
    const wave = document.getElementById(WAVE_ID);
    if (!wave) {
        return;
    }
    if (next.user || next.bot) {
        window.clearTimeout(fadeTimer);
        fadeTimer = undefined;
        wave.classList.remove('is-fading');
        wave.hidden = false;
        animate();
        return;
    }
    if (wave.hidden || fadeTimer !== undefined) {
        return;
    }
    animate();
    wave.classList.add('is-fading');
    fadeTimer = window.setTimeout(() => {
        fadeTimer = undefined;
        wave.hidden = true;
        wave.classList.remove('is-fading');
        for (const source of SOURCES) {
            lines[source].shown.fill(0);
        }
    }, FADE_MS);
}

/** One spectrum report for a line (band energies 0..1, lowest first; absent is silence). Ignored while the line is closed. */
export function pushSpectrum(source: VoiceLevelSource, bands: number[] | undefined): void {
    const line = lines[source];
    if (!line.open) {
        return;
    }
    line.reportedAt = performance.now();
    const n = bands?.length ?? 0;
    for (let i = 0; i < BANDS; i++) {
        line.target[i] = n > 0 ? (bands![Math.floor((i * n) / BANDS)] ?? 0) : 0;
    }
    animate();
}

function animate(): void {
    if (frame === undefined) {
        lastFrame = performance.now();
        frame = window.requestAnimationFrame(draw);
    }
}

function draw(now: number): void {
    frame = undefined;
    const dt = Math.min(now - lastFrame, 100);
    lastFrame = now;
    let moving = false;
    for (const source of SOURCES) {
        const line = lines[source];
        const { target, shown } = line;
        if (now - line.reportedAt > STALE_MS) {
            target.fill(0);
        }
        let sum = 0;
        for (let i = 0; i < BANDS; i++) {
            const gap = target[i] - shown[i];
            shown[i] = Math.abs(gap) < 0.002 ? target[i] : shown[i] + gap * (1 - Math.exp(-dt / (gap > 0 ? ATTACK_MS : RELEASE_MS)));
            sum += shown[i];
            moving ||= shown[i] > 0 || target[i] > 0;
        }
        const energy = Math.min(1, sum / BANDS / FULL_ENERGY);
        const speed = (REST_SPEED_PX + (FULL_SPEED_PX - REST_SPEED_PX) * energy) * line.direction * (dt / 1000);
        for (let i = 0; i < BANDS; i++) {
            line.phase[i] += WAVENUMBER[i] * speed * DRIFT[i];
        }
        line.floorPhase += ((2 * Math.PI) / FLOOR_WAVE_PX) * speed;
        // The open microphone keeps the loop alive while reports arrive, so the stale check can run.
        moving ||= line.open && source === 'user' && now - line.reportedAt <= STALE_MS;
    }
    const svg = document.querySelector<SVGSVGElement>(`#${WAVE_ID} svg`);
    if (!svg) {
        return;
    }
    const { width, height } = svg.getBoundingClientRect();
    if (width > 0) {
        const viewBox = `0 0 ${width} ${height}`;
        if (svg.getAttribute('viewBox') !== viewBox) {
            svg.setAttribute('viewBox', viewBox);
        }
        for (const source of SOURCES) {
            LAYERS.forEach((layer, index) => {
                svg.querySelector(`[data-source="${source}"][data-layer="${index}"]`)!.setAttribute('d', layerPath(lines[source], source, layer, width, height));
            });
        }
    }
    if (moving) {
        frame = window.requestAnimationFrame(draw);
    }
}

/** One layer of a line: the sum of its bands' components, scaled to the line's loudness and tapered at both ends. */
function layerPath(line: Line, source: VoiceLevelSource, layer: (typeof LAYERS)[number], width: number, height: number): string {
    const { shown } = line;
    let sum = 0;
    let power = 0;
    for (let i = layer.from; i < BANDS; i++) {
        sum += shown[i];
        power += shown[i] * shown[i];
    }
    const energy = Math.min(1, (layer.from === 0 ? sum / BANDS : (sum * 2) / BANDS) / FULL_ENERGY);
    const floor = layer === LAYERS[0] && source === 'user' && line.open ? USER_FLOOR : 0;
    if (source === 'bot' ? energy < BOT_QUIET : floor === 0 && energy < 0.005) {
        return '';
    }
    const mid = height / 2;
    const swing = mid - 1;
    const amp = swing * energy * layer.gain;
    // A sum of sines with unrelated phases has RMS sqrt(Σa²/2); scaled to SHAPE_RMS of the swing, then soft-clipped.
    const norm = power > 1e-8 ? SHAPE_RMS / Math.sqrt(power / 2) : 0;
    let d = '';
    for (let x = 0; x <= width + STEP_PX / 2; x += STEP_PX) {
        const at = Math.min(x, width);
        // Tapers to the midline at both ends, so the line eases in and out of the header.
        const taper = Math.sin((Math.PI * at) / width) ** 2;
        const u = at - width / 2;
        let s = 0;
        for (let i = layer.from; i < BANDS; i++) {
            if (shown[i] > 0.002) {
                s += shown[i] * Math.sin(WAVENUMBER[i] * u + line.phase[i] + (layer.offset ? ECHO_OFFSET[i] : 0));
            }
        }
        const y = amp * Math.tanh(s * norm) + swing * floor * Math.sin(((2 * Math.PI) / FLOOR_WAVE_PX) * u + line.floorPhase);
        d += `${d ? 'L' : 'M'}${at.toFixed(1)} ${(mid - taper * y).toFixed(2)}`;
    }
    return d;
}
