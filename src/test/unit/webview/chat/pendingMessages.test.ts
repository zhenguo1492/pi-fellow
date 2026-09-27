import { describe, it, expect } from 'vitest';
import { reconcileSteeringQueue } from '../../../../webview/chat/pendingMessages';

describe('reconcileSteeringQueue', () => {
    it('keeps the turns of entries still queued after the RPC consumed from the front', () => {
        const previous = [
            { text: 'a', turn: 0 },
            { text: 'b', turn: 1 },
            { text: 'c', turn: 2 },
        ];
        expect(reconcileSteeringQueue(previous, ['b', 'c', 'd'], 5)).toEqual([
            { text: 'b', turn: 1 },
            { text: 'c', turn: 2 },
            { text: 'd', turn: 5 },
        ]);
    });

    it('assigns the current turn to every entry when nothing overlaps', () => {
        const previous = [
            { text: 'a', turn: 0 },
            { text: 'b', turn: 1 },
        ];
        expect(reconcileSteeringQueue(previous, ['x', 'y'], 3)).toEqual([
            { text: 'x', turn: 3 },
            { text: 'y', turn: 3 },
        ]);
    });

    it('matches only a suffix of the previous queue, not an interior run', () => {
        // 'a' is the head of the new queue but not the tail of the old one.
        const previous = [
            { text: 'a', turn: 0 },
            { text: 'b', turn: 1 },
        ];
        expect(reconcileSteeringQueue(previous, ['a'], 4)).toEqual([{ text: 'a', turn: 4 }]);
    });

    it('treats repeated texts by the longest matching suffix', () => {
        const previous = [
            { text: 'x', turn: 0 },
            { text: 'x', turn: 1 },
        ];
        expect(reconcileSteeringQueue(previous, ['x', 'x', 'x'], 2)).toEqual([
            { text: 'x', turn: 0 },
            { text: 'x', turn: 1 },
            { text: 'x', turn: 2 },
        ]);
    });

    it('empties when the RPC steering queue is empty', () => {
        expect(reconcileSteeringQueue([{ text: 'a', turn: 0 }], [], 1)).toEqual([]);
    });

    it('does not mutate the previous queue', () => {
        const previous = [
            { text: 'a', turn: 0 },
            { text: 'b', turn: 1 },
        ];
        const snapshot = structuredClone(previous);
        reconcileSteeringQueue(previous, ['b', 'c'], 2);
        expect(previous).toEqual(snapshot);
    });
});
