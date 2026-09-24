import { describe, it, expect } from 'vitest';
import { SpeechSegmenter, type SegmenterEvent } from '../../../voice/speechSegmenter';

// 10 frames per second keeps the frame counts in the assertions readable.
const FRAME = 100;
const RATE = 1000;

function segmenter(overrides: Partial<ConstructorParameters<typeof SpeechSegmenter>[0]> = {}) {
    return new SpeechSegmenter(
        { confidence: 0.5, startSecs: 0.2, stopSecs: 0.3, preRollSecs: 0.1, maxSegmentSecs: 10, ...overrides },
        FRAME,
        RATE,
    );
}

/** Feeds frames tagged with their index (first sample) and speech flag; returns every event. */
function feed(seg: SpeechSegmenter, pattern: string, startIndex = 0): SegmenterEvent[] {
    const events: SegmenterEvent[] = [];
    [...pattern].forEach((c, i) => {
        const frame = new Int16Array(FRAME).fill(startIndex + i);
        events.push(...seg.push(frame, c === 'S' ? 0.9 : 0.1));
    });
    return events;
}

/** Frame indices a segment is made of. */
function frameIds(pcm: Int16Array): number[] {
    const ids: number[] = [];
    for (let i = 0; i < pcm.length; i += FRAME) {
        ids.push(pcm[i]);
    }
    return ids;
}

describe('SpeechSegmenter', () => {
    it('ignores speech shorter than startSecs', () => {
        const seg = segmenter();
        expect(feed(seg, '..S..S..')).toEqual([]);
        expect(seg.inSpeech).toBe(false);
        expect(seg.flush()).toBeUndefined();
    });

    it('emits a segment with pre-roll once silence reaches stopSecs', () => {
        const seg = segmenter();
        const events = feed(seg, '...SSSS...');
        expect(events.map((e) => e.type)).toEqual(['speechStart', 'segment']);
        const segment = events[1] as Extract<SegmenterEvent, { type: 'segment' }>;
        // One pre-roll frame (2), speech 3–6, trailing silence 7–9.
        expect(frameIds(segment.pcm)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
        expect(seg.inSpeech).toBe(false);
    });

    it('keeps a segment open across pauses shorter than stopSecs', () => {
        const seg = segmenter();
        const events = feed(seg, 'SSS..SS...');
        expect(events.filter((e) => e.type === 'segment')).toHaveLength(1);
    });

    it('keeps speech open through dips just below the threshold, but needs the full threshold to start', () => {
        const seg = segmenter();
        const dip = (pattern: string) =>
            [...pattern].flatMap((c, i) => seg.push(new Int16Array(FRAME).fill(i), c === 'S' ? 0.9 : c === 'd' ? 0.4 : 0.1));
        // 0.4 is below 0.5 but above 0.5 - 0.15: never starts speech on its own...
        expect(dip('dddd')).toEqual([]);
        // ...yet a run of it inside speech does not end the segment.
        expect(dip('SSddddSS').filter((e) => e.type === 'segment')).toEqual([]);
        expect(seg.inSpeech).toBe(true);
    });

    it('cuts long speech at maxSegmentSecs without ending the utterance', () => {
        const seg = segmenter({ maxSegmentSecs: 0.5 });
        const events = feed(seg, 'SSSSSSS');
        const segments = events.filter((e) => e.type === 'segment');
        expect(segments).toHaveLength(1);
        expect(frameIds((segments[0] as Extract<SegmenterEvent, { type: 'segment' }>).pcm)).toEqual([0, 1, 2, 3, 4]);
        expect(seg.inSpeech).toBe(true);
        expect(frameIds(seg.flush()!)).toEqual([5, 6]);
    });

    it('flush returns speech still in progress and resets', () => {
        const seg = segmenter();
        feed(seg, '.SSS.');
        expect(frameIds(seg.flush()!)).toEqual([0, 1, 2, 3, 4]);
        expect(seg.inSpeech).toBe(false);
        expect(seg.flush()).toBeUndefined();
    });
});
