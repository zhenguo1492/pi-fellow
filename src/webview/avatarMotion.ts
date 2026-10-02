/**
 * The voice agent's avatar talks while its voice plays, a reply or a sentence read aloud (Alt+click):
 * the one carrying `.av-motion`, which is, while the Bot view shows, the avatar of the reply being
 * read aloud or else of the latest reply (voicePanel.ts), and otherwise the voice bar's. The motion
 * follows the bot's level (`voiceLevel` from src/voiceAgent/botLevel.ts, one report per 64 ms of audio),
 * remapped to how loud the voice is (`--talk`, 0..1, styles/chat/voiceBar.css): the avatar bounces
 * and its box glows with it, and a pixel-art preset that talks swaps its picture for its talking
 * frames (mouth closed, half or open by `--talk`, see avatarPresets.ts). While the voice agent
 * thinks, voiceBar.css scrolls flickering log lines on a screen in the robot's face, and a pixel-art
 * preset plays its own thinking animation here. Both are `img[data-animated]`, frames from avatar.ts
 * `avatarAnimations`, played by {@link AnimationRun}; talking wins over thinking, and either puts
 * the picture back at rest when it ends.
 */
import { frameIndex, type AvatarAnimation, type AvatarTrackPick } from '../shared/avatarPresets';
import { avatarAnimations } from './avatar';

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
/** The voice made sound within `HOLD_MS`, as of the last frame drawn. */
let talking = false;
/** The avatars posed last frame. */
let posed = new Set<HTMLElement>();

/** The voice agent is thinking (the voice bar's phase). */
let thinking = false;
let thinkTimer: number | undefined;
/** Thinking frames this far apart at most: an avatar that becomes `.av-motion` mid-thought (a new reply) starts soon. */
const THINK_POLL_MS = 250;

/**
 * One animation playing on one picture: each track's state over time, as its `pick` says. Random
 * picks (`random()`, 0..1) are passed in so the unit tests can choose them.
 */
export class AnimationRun {
    private readonly states: number[];
    /** When each `random` track picks its next state. */
    private readonly until: number[];
    /** The `level` track was past its first step at the last frame: leaving 0 again is a new syllable. */
    private open = false;

    constructor(
        private readonly animation: AvatarAnimation,
        private readonly start: number,
        private readonly random: () => number = Math.random,
    ) {
        this.states = animation.tracks.map(() => 0);
        this.until = animation.tracks.map(({ pick }) => (pick.kind === 'random' ? start + this.hold(pick.hold) : Infinity));
    }

    /** The frame at `now` with the voice at `level` (`--talk`, 0..1), and the ms until a timed track changes it (Infinity when none will). */
    frame(now: number, level = 0): { src: string; wait: number } {
        let wait = Infinity;
        const levelPick = this.animation.tracks
            .map(({ pick }) => pick)
            .find((pick): pick is Extract<AvatarTrackPick, { kind: 'level' }> => pick.kind === 'level');
        const opened = levelPick !== undefined && level >= levelPick.steps[0];
        const syllable = opened && !this.open;
        this.open = opened;
        this.animation.tracks.forEach(({ states, pick }, i) => {
            switch (pick.kind) {
                case 'loop': {
                    let t = (now - this.start) % pick.play.reduce((sum, [, ms]) => sum + ms, 0);
                    for (const [state, ms] of pick.play) {
                        if (t < ms) {
                            this.states[i] = state;
                            wait = Math.min(wait, ms - t);
                            break;
                        }
                        t -= ms;
                    }
                    break;
                }
                case 'random':
                    if (now >= this.until[i]) {
                        // Another state than the one shown: with two, the other one.
                        this.states[i] = (this.states[i] + 1 + Math.floor(this.random() * (states - 1))) % states;
                        this.until[i] = now + this.hold(pick.hold);
                    }
                    wait = Math.min(wait, this.until[i] - now);
                    break;
                case 'level':
                    this.states[i] = pick.steps.filter((step) => level >= step).length;
                    break;
                case 'syllable':
                    if (!opened) {
                        this.states[i] = 0;
                    } else if (syllable) {
                        let r = this.random() * pick.weights.reduce((sum, weight) => sum + weight, 0);
                        const picked = pick.weights.findIndex((weight) => (r -= weight) < 0);
                        this.states[i] = 1 + (picked < 0 ? pick.weights.length - 1 : picked);
                    }
                    break;
            }
        });
        return { src: this.animation.frames[frameIndex(this.animation.tracks, this.states)], wait };
    }

    private hold([min, max]: [number, number]): number {
        return min + this.random() * (max - min);
    }
}

/** A picture's resting `src` and the animations playing on it. */
interface Playing {
    rest: string;
    think?: AnimationRun;
    talk?: AnimationRun;
}
const playing = new WeakMap<HTMLImageElement, Playing>();
/** Pictures with an animation playing, put back at rest once they stop being `.av-motion` or it ends. */
let painted = new Set<HTMLImageElement>();

/**
 * Shows each animated picture's frame for now: talking while the voice plays (by `shown`), else
 * thinking while the voice agent thinks, else at rest. Returns the ms until a thinking frame is due.
 */
function paint(now: number): number {
    // Reduced motion keeps the pictures still. (jsdom, in the unit tests, has no `matchMedia`.)
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const live = new Set(still ? [] : document.querySelectorAll<HTMLImageElement>('.av-motion img[data-animated]'));
    const next = new Set<HTMLImageElement>();
    let wait = Infinity;
    for (const img of new Set([...live, ...painted])) {
        let play = playing.get(img);
        if (!play) {
            play = { rest: img.getAttribute('src') ?? '' };
            playing.set(img, play);
        }
        const animations = live.has(img) ? avatarAnimations(play.rest) : undefined;
        const talk = talking ? animations?.talk : undefined;
        const think = !talk && thinking ? animations?.think : undefined;
        play.talk = talk && (play.talk ?? new AnimationRun(talk, now));
        play.think = think && (play.think ?? new AnimationRun(think, now));
        let src = play.rest;
        if (play.talk) {
            src = play.talk.frame(now, shown).src;
        } else if (play.think) {
            const shot = play.think.frame(now);
            src = shot.src;
            wait = Math.min(wait, shot.wait);
        }
        if (img.getAttribute('src') !== src) {
            img.setAttribute('src', src);
        }
        if (play.talk || play.think) {
            next.add(img);
        }
    }
    painted = next;
    return wait;
}

/** The voice agent started or stopped thinking. */
export function setAvatarThinking(on: boolean): void {
    if (on === thinking) {
        return;
    }
    thinking = on;
    thinkStep();
}

/** Shows each thinking avatar's frame for now, and comes back when the next one is due. */
function thinkStep(): void {
    window.clearTimeout(thinkTimer);
    thinkTimer = undefined;
    const wait = paint(performance.now());
    if (thinking) {
        thinkTimer = window.setTimeout(thinkStep, Math.min(wait, THINK_POLL_MS));
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
    talking = now - soundAt < HOLD_MS;
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
    paint(now);
    if (talking || shown > 0) {
        frame = window.requestAnimationFrame(draw);
    }
}

function pose(el: HTMLElement, talking: boolean, talk: number): void {
    el.classList.toggle('talking', talking);
    el.style.setProperty('--talk', talk.toFixed(3));
}
