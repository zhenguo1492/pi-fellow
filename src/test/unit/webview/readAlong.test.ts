// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClickGate, DOUBLE_CLICK_MS, seekPoint } from '../../../webview/readAlong';

describe('seekPoint', () => {
    const text = 'Hello there world. Second sentence here.';
    const parts: Array<[number, number]> = [
        [0, 18],
        [19, 40],
    ];

    it('reads on from the start of the word under the double-click, as a fraction of its sentence', () => {
        // Anywhere in "world" (and at its end) is from "world".
        const world = text.indexOf('world');
        for (const offset of [world, world + 3, world + 5]) {
            expect(seekPoint(text, parts, offset)).toEqual({ part: 0, fraction: world / 18 });
        }
        expect(seekPoint(text, parts, text.lastIndexOf('here') + 1)).toEqual({ part: 1, fraction: (text.lastIndexOf('here') - 19) / 21 });
        expect(seekPoint(text, parts, 2)).toEqual({ part: 0, fraction: 0 });
    });

    it('reads the next sentence from its start between sentences, and nothing after the last', () => {
        const gap: Array<[number, number]> = [
            [0, 10],
            [15, 20],
        ];
        expect(seekPoint('x'.repeat(25), gap, 12)).toEqual({ part: 1, fraction: 0 });
        expect(seekPoint('x'.repeat(25), gap, 22)).toBeUndefined();
    });

    it('takes a Chinese character as a word of its own', () => {
        const zh = '今天天气很好。';
        expect(seekPoint(zh, [[0, 7]], 4)).toEqual({ part: 0, fraction: 4 / 7 });
    });
});

describe('ClickGate', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function gate() {
        const events: string[] = [];
        const g = new ClickGate({ click: () => events.push('click'), double: (x, y) => events.push(`double ${x},${y}`) });
        const click = (x: number, y: number, at: number, endX = x) => {
            const double = g.press(x, y, at);
            g.release(endX, y, at + 50);
            return double;
        };
        return { g, events, click };
    }

    it('acts on a click only once the double-click window has passed', () => {
        const { events, click } = gate();
        expect(click(10, 10, 0)).toBe(false);
        vi.advanceTimersByTime(DOUBLE_CLICK_MS - 1);
        expect(events).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(events).toEqual(['click']);
    });

    it('makes a second press close by a double-click, and the click never acts', () => {
        const { events, click } = gate();
        click(10, 10, 0);
        expect(click(12, 11, 200)).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(events).toEqual(['double 12,11']);
    });

    it('takes a second press too late or too far away as another click', () => {
        const { events, click } = gate();
        click(10, 10, 0);
        vi.advanceTimersByTime(DOUBLE_CLICK_MS);
        expect(click(10, 10, 50 + DOUBLE_CLICK_MS + 10)).toBe(false);
        vi.advanceTimersByTime(DOUBLE_CLICK_MS);
        expect(events).toEqual(['click', 'click']);

        // Far away within the window: the first click acts at once, the second waits its turn.
        events.length = 0;
        click(10, 10, 5000);
        expect(click(40, 10, 5100)).toBe(false);
        expect(events).toEqual(['click']);
        vi.advanceTimersByTime(DOUBLE_CLICK_MS);
        expect(events).toEqual(['click', 'click']);
    });

    it('ignores a drag, and forgets a waiting click when cancelled', () => {
        const { g, events, click } = gate();
        click(10, 10, 0, 30);
        click(10, 10, 1000);
        g.cancel();
        vi.advanceTimersByTime(1000);
        expect(events).toEqual([]);
    });
});
