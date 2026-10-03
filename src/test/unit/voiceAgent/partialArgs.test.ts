import { describe, expect, it } from 'vitest';
import { partialFields } from '../../../voiceAgent/partialArgs';

/** The fields as [key, value, complete] rows, in the order written. */
const rows = (json: string) => [...partialFields(json)].map(([key, f]) => [key, f.value, f.complete]);

describe('partialFields', () => {
    it('reads every prefix of a call without throwing, each field complete once its end has arrived', () => {
        const json = JSON.stringify({ path: 'src/a.ts', nearLine: 12, oldText: 'a\n\t"b"', newText: 'é ✓ 😀\\' });
        for (let i = 0; i <= json.length; i++) {
            const fields = partialFields(json.slice(0, i));
            for (const [, field] of fields) {
                if (!field.complete) {
                    expect(typeof field.value).toBe('string');
                }
            }
        }
        expect(rows(json)).toEqual([
            ['path', 'src/a.ts', true],
            ['nearLine', 12, true],
            ['oldText', 'a\n\t"b"', true],
            ['newText', 'é ✓ 😀\\', true],
        ]);
    });

    it('gives a string as far as it is written, leaving out an escape cut in two and half a surrogate pair', () => {
        expect(rows('{"path":"a.ts","newText":"line\\')).toEqual([
            ['path', 'a.ts', true],
            ['newText', 'line', false],
        ]);
        expect(rows('{"newText":"x\\u00')).toEqual([['newText', 'x', false]]);
        expect(rows('{"newText":"x\\ud83d')).toEqual([['newText', 'x', false]]);
        expect(rows('{"newText":"x\\ud83d\\ude00')).toEqual([['newText', 'x😀', false]]);
    });

    it('stops at a key, number, literal or nested value not yet whole', () => {
        expect(rows('{"pa')).toEqual([]);
        expect(rows('{"nearLine":1')).toEqual([]);
        expect(rows('{"nearLine":12,"recursive":tr')).toEqual([['nearLine', 12, true]]);
        expect(rows('{"keys":["down","en')).toEqual([]);
        expect(rows('{"keys":["down","enter"],"text":"y"}')).toEqual([
            ['keys', ['down', 'enter'], true],
            ['text', 'y', true],
        ]);
    });
});
