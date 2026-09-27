import { describe, it, expect } from 'vitest';
import { escAttr, escHtml, formatTimestamp, truncate, tryParseJSON } from '../../../../webview/chat/helpers';

describe('escHtml', () => {
    it('escapes &, <, > like Text node serialization', () => {
        expect(escHtml('a & b <tag> c')).toBe('a &amp; b &lt;tag&gt; c');
    });

    it('does not double-escape existing entities beyond the ampersand', () => {
        expect(escHtml('&lt;')).toBe('&amp;lt;');
    });

    it('leaves quotes untouched', () => {
        expect(escHtml(`"double" 'single'`)).toBe(`"double" 'single'`);
    });

    it('serializes non-breaking spaces as &nbsp; but keeps regular spaces', () => {
        expect(escHtml('a\u00a0b c')).toBe('a&nbsp;b c');
    });
});

describe('escAttr', () => {
    it('escapes double quotes (unlike escHtml) along with &, <, >', () => {
        expect(escAttr('say "hi" & <go>')).toBe('say &quot;hi&quot; &amp; &lt;go&gt;');
    });

    it('escapes & first so produced entities are not re-escaped', () => {
        expect(escAttr('"')).toBe('&quot;');
    });

    it('leaves single quotes and non-breaking spaces alone', () => {
        expect(escAttr("it's\u00a0x")).toBe("it's\u00a0x");
    });
});

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
