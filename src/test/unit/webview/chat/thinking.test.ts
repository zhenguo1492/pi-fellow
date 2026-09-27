import { describe, it, expect } from 'vitest';
import { thinkingLabel } from '../../../../webview/chat/thinking';

describe('thinkingLabel', () => {
    it('shows the live label while active, regardless of duration', () => {
        expect(thinkingLabel(true)).toBe('Thinking…');
        expect(thinkingLabel(true, 12)).toBe('Thinking…');
    });

    it('pluralizes the finished duration', () => {
        expect(thinkingLabel(false, 1)).toBe('Thought for 1 second');
        expect(thinkingLabel(false, 5)).toBe('Thought for 5 seconds');
    });

    it('omits a missing or non-positive duration', () => {
        expect(thinkingLabel(false)).toBe('Thought');
        expect(thinkingLabel(false, 0)).toBe('Thought');
        expect(thinkingLabel(false, -3)).toBe('Thought');
    });
});
