/**
 * The wave in the voice bar (the input box's header): an oscilloscope line of the sound right now,
 * across the space between the status and the buttons. Green is the user's microphone (dictation,
 * or voice mode unmuted), blue the bot's reply as it plays; both show when they sound at once.
 *
 * The host sends the real waveform of each latest 64 ms (src/voice/micLevel.ts `wavePoints`: 160
 * signed peaks, one fixed gain, ~16 reports a second; the webview cannot open the microphone or
 * hear the bot), and the line draws those points as they are. The only processing here is a short
 * crossfade from one report to the next, so the line does not strobe 16 times a second. Silence
 * is a flat line (the bot's disappears); the whole wave fades out once neither line is open.
 */
import type { VoiceLevelSource } from '../shared/protocol';

const WAVE_ID = 'voice-wave';
const SOURCES = ['user', 'bot'] as const;
/** Crossfade time constant between reports: ~90% of the change lands within the 64 ms report period. */
const CROSSFADE_MS = 28;
/** No report for this long reads as silence (a busy host, a dropped message, the end of a sentence). */
const STALE_MS = 200;
/** A bot line whose points all stay within this is not drawn: it shows only while the bot makes a sound. */
const BOT_QUIET = 0.02;
/** Matches the `.voice-wave` opacity transition in styles/chat/voiceBar.css. */
const FADE_MS = 250;

interface Line {
    open: boolean;
    /** Latest reported points, -1..1, oldest first; empty until the first report. */
    target: Float64Array;
    /** Points drawn now. */
    shown: Float64Array;
    reportedAt: number;
}

const newLine = (): Line => ({ open: false, target: new Float64Array(0), shown: new Float64Array(0), reportedAt: 0 });

const lines: Record<VoiceLevelSource, Line> = { user: newLine(), bot: newLine() };
let lastFrame = 0;
let frame: number | undefined;
let fadeTimer: number | undefined;

export const voiceWaveHtml = `<span id="${WAVE_ID}" class="voice-wave" title="Green: what the microphone hears. Blue: the bot speaking." aria-hidden="true" hidden>
        <svg><path class="voice-wave-line" data-source="bot"/><path class="voice-wave-line" data-source="user"/></svg>
    </span>`;

/** Which lines are shown. A closing line settles flat; with neither open the wave fades out and hides. */
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

/** One waveform report for a line (points -1..1, oldest first; absent is silence). Ignored while the line is closed. */
export function pushWave(source: VoiceLevelSource, wave: number[] | undefined): void {
    const line = lines[source];
    if (!line.open) {
        return;
    }
    line.reportedAt = performance.now();
    if (!wave || wave.length === 0) {
        line.target.fill(0);
    } else {
        if (wave.length !== line.target.length) {
            // First report, or another point count: start from a flat line of that length.
            line.target = new Float64Array(wave.length);
            line.shown = new Float64Array(wave.length);
        }
        line.target.set(wave);
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
    const blend = 1 - Math.exp(-dt / CROSSFADE_MS);
    let moving = false;
    for (const source of SOURCES) {
        const line = lines[source];
        const { target, shown } = line;
        if (now - line.reportedAt > STALE_MS) {
            target.fill(0);
        }
        for (let i = 0; i < shown.length; i++) {
            const gap = target[i] - shown[i];
            shown[i] = Math.abs(gap) < 0.002 ? target[i] : shown[i] + gap * blend;
            moving ||= shown[i] !== 0 || target[i] !== 0;
        }
        // The open microphone keeps the loop alive while reports arrive, so the stale check can run.
        moving ||= line.open && now - line.reportedAt <= STALE_MS;
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
        const mid = height / 2;
        const swing = mid - 1;
        for (const source of SOURCES) {
            const { open, shown } = lines[source];
            const quiet = shown.every((v) => Math.abs(v) < BOT_QUIET);
            let d = '';
            if (source === 'user' ? open : !quiet) {
                // Before the first report, the open microphone is a flat line.
                const n = Math.max(2, shown.length);
                for (let i = 0; i < n; i++) {
                    d += `${d ? 'L' : 'M'}${((i * width) / (n - 1)).toFixed(1)} ${(mid - swing * (shown[i] ?? 0)).toFixed(2)}`;
                }
            }
            svg.querySelector(`[data-source="${source}"]`)!.setAttribute('d', d);
        }
    }
    if (moving) {
        frame = window.requestAnimationFrame(draw);
    }
}
