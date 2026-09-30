/**
 * The voice agent's avatar talks while its voice plays, a reply or a sentence read aloud (Alt+click):
 * the one carrying `.av-motion`, which is, while the Bot view shows, the avatar of the reply being
 * read aloud or else of the latest reply (voicePanel.ts), and otherwise the voice bar's. The motion
 * follows the bot's level (`voiceLevel` from src/voiceAgent/botLevel.ts, one report per 64 ms of audio),
 * remapped to how loud the voice is (`--talk`, 0..1, styles/chat/voiceBar.css): the avatar bounces
 * and its box glows with it. While the voice agent thinks, voiceBar.css scrolls flickering log lines
 * on a screen in the robot's face, and a pixel-art preset plays its own thinking animation here
 * (`img[data-think]`, frames from avatar.ts `avatarThinking`).
 */
import { avatarThinking } from './avatar';

/**
 * Bot level (botLevel.ts maps -45..-15 dBFS to 0..1) mapped to still and full motion. TTS speech
 * sits at -25..-10 dBFS, level 0.67 and up: syllables swing within this range, and the avatar only
 * moves with them when it spans just this.
 */
const QUIET_LEVEL = 0.5;
const LOUD_LEVEL = 0.9;
/** Rise and fall time constants: the avatar moves at once on a syllable and settles nearly as fast. */
const ATTACK_MS = 20;
const RELEASE_MS = 45;
/** A level above this is sound, not the silence between sentences. */
const SOUND = 0.05;
/** No report for this long reads as silence (a dropped message, the reply cut off), as the wave's `STALE_MS`. */
const STALE_MS = 200;
/** Still talking until the reply has been silent this long, so the glow stays between words. */
const HOLD_MS = 600;

let target = 0;
let shown = 0;
let reportedAt = 0;
let soundAt = -Infinity;
let lastFrame = 0;
let frame: number | undefined;
/** The avatars posed last frame. */
let posed = new Set<HTMLElement>();

/** The voice agent is thinking (the voice bar's phase), and since when: the thinking animations play from its start. */
let thinking = false;
let thinkingSince = 0;
let thinkTimer: number | undefined;
/** Pictures showing a thinking frame, put back at rest once they stop being `.av-motion` or thinking ends. */
let thinkPosed = new Set<HTMLImageElement>();
/** Thinking frames this far apart at most: an avatar that becomes `.av-motion` mid-thought (a new reply) starts soon. */
const THINK_POLL_MS = 250;

/** The voice agent started or stopped thinking. */
export function setAvatarThinking(on: boolean): void {
    if (on === thinking) {
        return;
    }
    thinking = on;
    thinkingSince = performance.now();
    thinkStep();
}

/** Shows each thinking avatar's frame for now, and comes back when the next one is due. */
function thinkStep(): void {
    window.clearTimeout(thinkTimer);
    thinkTimer = undefined;
    const elapsed = performance.now() - thinkingSince;
    // Reduced motion keeps the picture still. (jsdom, in the unit tests, has no `matchMedia`.)
    const still = !thinking || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const shown = new Set(still ? [] : document.querySelectorAll<HTMLImageElement>('.av-motion img[data-think]'));
    let wait = THINK_POLL_MS;
    // Those showing a frame that no longer should (not `.av-motion`, or thinking is over) go back to rest.
    for (const img of new Set([...shown, ...thinkPosed])) {
        img.dataset.restSrc ??= img.getAttribute('src') ?? '';
        const anim = shown.has(img) ? avatarThinking(img.dataset.restSrc) : undefined;
        let src = img.dataset.restSrc;
        if (anim) {
            let t = elapsed % anim.play.reduce((sum, [, ms]) => sum + ms, 0);
            for (const [frame, ms] of anim.play) {
                if (t < ms) {
                    src = anim.frames[frame];
                    wait = Math.min(wait, ms - t);
                    break;
                }
                t -= ms;
            }
        }
        if (img.getAttribute('src') !== src) {
            img.setAttribute('src', src);
        }
    }
    thinkPosed = shown;
    if (thinking) {
        thinkTimer = window.setTimeout(thinkStep, wait);
    }
}

/** One level report of the reply being played (0..1; 0 when it stops). */
export function pushTalkLevel(level: number): void {
    const now = performance.now();
    target = Math.min(1, Math.max(0, (level - QUIET_LEVEL) / (LOUD_LEVEL - QUIET_LEVEL)));
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
    const avatars = new Set(document.querySelectorAll<HTMLElement>('.av-motion'));
    for (const el of avatars) {
        pose(el, talking, shown);
    }
    // An avatar that stopped being the talking one mid-sentence goes back to rest.
    for (const el of posed) {
        if (!avatars.has(el)) {
            pose(el, false, 0);
        }
    }
    posed = avatars;
    if (talking || shown > 0) {
        frame = window.requestAnimationFrame(draw);
    }
}

function pose(el: HTMLElement, talking: boolean, talk: number): void {
    el.classList.toggle('talking', talking);
    el.style.setProperty('--talk', talk.toFixed(3));
}
