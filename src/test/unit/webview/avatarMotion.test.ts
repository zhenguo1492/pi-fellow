// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarAnimation, AvatarAnimations, AvatarTrackPick } from '../../../shared/avatarPresets';

/** An animation whose frames are named by their tracks' states (`0.2` = first track 0, second 2), in frameIndex order. */
function animation(tracks: Array<{ states: number; pick: AvatarTrackPick }>): AvatarAnimation {
    const all = tracks.reduce<number[][]>((acc, { states }) => acc.flatMap((c) => Array.from({ length: states }, (_, s) => [...c, s])), [[]]);
    return { frames: all.map((states) => states.join('.')), tracks };
}

const MOUTH: { states: number; pick: AvatarTrackPick } = { states: 3, pick: { kind: 'level', steps: [0.25, 0.6] } };
const BROWS: { states: number; pick: AvatarTrackPick } = { states: 3, pick: { kind: 'syllable', weights: [4, 1] } };

const animations = vi.hoisted(() => ({ value: undefined as AvatarAnimations | undefined }));
vi.mock('../../../webview/avatar', () => ({ avatarAnimations: () => animations.value }));

import { AnimationRun, pushTalkLevel, setAvatarThinking } from '../../../webview/avatarMotion';

describe('AnimationRun', () => {
    it('opens the mouth by the level: closed below 0.25, half below 0.6, open from there', () => {
        const run = new AnimationRun(animation([MOUTH]), 0);
        expect([0, 0.24, 0.25, 0.59, 0.6, 1].map((level, t) => run.frame(t, level).src)).toEqual(['0', '0', '1', '1', '2', '2']);
    });

    it('raises the brows on each syllable, one in five only the right one, and lowers them when the mouth closes', () => {
        const picks = [0.5, 0.9, 0.79, 0.8];
        const run = new AnimationRun(animation([MOUTH, BROWS]), 0, () => picks.shift()!);
        // 0.5 of 5 falls in the first weight (both raised), 0.9 in the second (right only).
        expect(run.frame(0, 0.1).src).toBe('0.0');
        expect(run.frame(1, 0.4).src).toBe('1.1');
        // The same syllable keeps its brows as the mouth opens wider.
        expect(run.frame(2, 0.8).src).toBe('2.1');
        expect(run.frame(3, 0.1).src).toBe('0.0');
        expect(run.frame(4, 0.7).src).toBe('2.2');
        expect(run.frame(5, 0).src).toBe('0.0');
        expect(run.frame(6, 0.3).src).toBe('1.1');
    });

    it('switches a random track to another state after a hold within its range', () => {
        const run = new AnimationRun(animation([{ states: 2, pick: { kind: 'random', hold: [500, 1200] } }]), 1000, () => 0.5);
        expect(run.frame(1000)).toEqual({ src: '0', wait: 850 });
        expect(run.frame(1849).src).toBe('0');
        expect(run.frame(1850)).toEqual({ src: '1', wait: 850 });
        expect(run.frame(2700).src).toBe('0');
    });

    it('plays a fixed list from its start, looping', () => {
        const run = new AnimationRun(animation([{ states: 2, pick: { kind: 'loop', play: [[0, 100], [1, 50]] } }]), 1000);
        expect(run.frame(1120)).toEqual({ src: '1', wait: 30 });
        expect(run.frame(1160)).toEqual({ src: '0', wait: 90 });
    });
});

describe('avatar motion on the page', () => {
    const img = () => document.querySelector('img')!;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
        document.body.innerHTML = '<span class="av-motion"><img src="rest" data-animated alt=""></span>';
        animations.value = {
            think: { frames: ['think-a', 'think-b'], tracks: [{ states: 2, pick: { kind: 'loop', play: [[0, 100], [1, 100]] } }] },
            talk: animation([MOUTH]),
        };
    });

    afterEach(() => {
        setAvatarThinking(false);
        vi.useRealTimers();
    });

    /** Reports a bot level every 64 ms for `ms`, as the audio page does. */
    const speak = (level: number, ms: number) => {
        for (let t = 0; t < ms; t += 64) {
            pushTalkLevel(level);
            vi.advanceTimersByTime(64);
        }
    };

    it('swaps the picture by the voice level while talking, over thinking, and puts it back when the voice stops', () => {
        setAvatarThinking(true);
        expect(img().getAttribute('src')).toBe('think-a');
        // Level 0.9 is full motion (--talk 1): the mouth wide open.
        speak(0.9, 320);
        expect(img().getAttribute('src')).toBe('2');
        expect(document.querySelector('.av-motion')!.classList.contains('talking')).toBe(true);
        // Level 0.7 is half way (--talk 0.5).
        speak(0.7, 320);
        expect(img().getAttribute('src')).toBe('1');
        // Silence: the mouth closes, then talking ends and thinking shows again.
        speak(0, 320);
        expect(img().getAttribute('src')).toBe('0');
        vi.advanceTimersByTime(1000);
        expect(img().getAttribute('src')).toMatch(/^think-/);
        setAvatarThinking(false);
        expect(img().getAttribute('src')).toBe('rest');
    });

    it('leaves the picture at rest once it is no longer the talking avatar', () => {
        speak(0.9, 320);
        expect(img().getAttribute('src')).toBe('2');
        document.querySelector('.av-motion')!.classList.remove('av-motion');
        speak(0.9, 64);
        expect(img().getAttribute('src')).toBe('rest');
        speak(0, 1200);
    });
});
