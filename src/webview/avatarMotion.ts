/**
 * The voice agent's avatar in the voice bar talks while its reply plays: the mouth follows the
 * reply's level (the bot's `voiceLevel`, one report per 64 ms of audio). The level is remapped to
 * how open the mouth is (`--talk`, 0..1, main.css): the robot's mouth opens with it, a pixel-art
 * preset shows its closed, half or wide open frame (`data-mouth`, avatar.ts), every avatar bounces
 * and its box glows with it. Thinking needs no level: main.css tilts the avatar while the bar is in
 * the thinking phase.
 */

const ROBOT_SELECTOR = '#voice-bar .voice-bar-robot';
/**
 * Bot level (voiceMode.ts maps -45..-15 dBFS to 0..1) mapped to a closed and a fully open mouth.
 * TTS speech sits at -25..-10 dBFS, level 0.67 and up: syllables swing within this range, and the
 * mouth only moves with them when it spans just this.
 */
const MOUTH_SHUT_LEVEL = 0.5;
const MOUTH_WIDE_LEVEL = 0.9;
/** Rise and fall time constants: the mouth opens at once on a syllable and closes nearly as fast. */
const ATTACK_MS = 20;
const RELEASE_MS = 45;
/** Openness a pixel-art mouth needs for its half and wide open frames. */
const FRAME_AT = [0.2, 0.6];
/** A frame is left only this far below where it opens, so it does not chatter around one level. */
const FRAME_HYSTERESIS = 0.08;
/** A level above this is sound, not the silence between sentences. */
const SOUND = 0.05;
/** No report for this long reads as silence (a dropped message, the reply cut off), as the wave's `STALE_MS`. */
const STALE_MS = 200;
/** Still talking until the reply has been silent this long, so the robot's mouth stays between words. */
const HOLD_MS = 600;

let target = 0;
let shown = 0;
let reportedAt = 0;
let soundAt = -Infinity;
/** The pixel-art frame shown: 0 closed, 1 half, 2 wide open. */
let mouthFrame = 0;
let lastFrame = 0;
let frame: number | undefined;

/** One level report of the reply being played (0..1; 0 when it stops). */
export function pushTalkLevel(level: number): void {
    const now = performance.now();
    target = Math.min(1, Math.max(0, (level - MOUTH_SHUT_LEVEL) / (MOUTH_WIDE_LEVEL - MOUTH_SHUT_LEVEL)));
    reportedAt = now;
    if (level > SOUND) {
        soundAt = now;
    }
    if (frame === undefined) {
        lastFrame = now;
        frame = window.requestAnimationFrame(draw);
    }
}

function draw(now: number): void {
    frame = undefined;
    const dt = Math.min(now - lastFrame, 100);
    lastFrame = now;
    if (now - reportedAt > STALE_MS) {
        target = 0;
    }
    shown += (target - shown) * (1 - Math.exp(-dt / (target > shown ? ATTACK_MS : RELEASE_MS)));
    if (target === 0 && shown < 0.005) {
        shown = 0;
    }
    const talking = now - soundAt < HOLD_MS;
    while (mouthFrame < FRAME_AT.length && shown > FRAME_AT[mouthFrame]) {
        mouthFrame++;
    }
    while (mouthFrame > 0 && shown < FRAME_AT[mouthFrame - 1] - FRAME_HYSTERESIS) {
        mouthFrame--;
    }
    if (!talking) {
        mouthFrame = 0;
    }
    const robot = document.querySelector<HTMLElement>(ROBOT_SELECTOR);
    if (robot) {
        robot.classList.toggle('talking', talking);
        robot.style.setProperty('--talk', shown.toFixed(3));
        const img = robot.querySelector<HTMLImageElement>('img[data-mouth]');
        if (img) {
            img.dataset.restSrc ??= img.getAttribute('src') ?? '';
            const src = mouthFrame === 0 ? img.dataset.restSrc : img.dataset.mouth!.split(' ')[mouthFrame - 1];
            if (src && img.getAttribute('src') !== src) {
                img.setAttribute('src', src);
            }
        }
    }
    if (talking || shown > 0) {
        frame = window.requestAnimationFrame(draw);
    }
}
