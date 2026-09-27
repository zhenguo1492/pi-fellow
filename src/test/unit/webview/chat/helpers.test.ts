import { describe, it, expect } from 'vitest';
import { formatTimestamp, truncate, tryParseJSON } from '../../../../webview/chat/helpers';

describe('truncate', () => {
    it('keeps strings at exactly maxLen', () => {
        expect(truncate('abcde', 5)).toBe('abcde');
    });

    it('cuts to maxLen and appends an ellipsis when longer', () => {
        expect(truncate('abcdef', 5)).toBe('abcde...');
    });
});

describe('tryParseJSON', () => {
    it('parses valid JSON', () => {
        expect(tryParseJSON('{"a":[1,2]}')).toEqual({ a: [1, 2] });
    });

    it('returns the original string when JSON is invalid', () => {
        expect(tryParseJSON('{not json')).toBe('{not json');
    });
});

describe('formatTimestamp', () => {
    it('returns empty string for a missing timestamp', () => {
        expect(formatTimestamp(0)).toBe('');
    });

    it('treats values below 1e12 as seconds and larger ones as milliseconds', () => {
        const ms = Date.UTC(2024, 0, 2, 3, 4, 5);
        expect(formatTimestamp(ms / 1000)).toBe(formatTimestamp(ms));
        expect(formatTimestamp(ms)).not.toBe('');
    });

    it('distinguishes times one second apart', () => {
        const ms = Date.UTC(2024, 0, 2, 3, 4, 5);
        expect(formatTimestamp(ms + 1000)).not.toBe(formatTimestamp(ms));
    });
});
