import { describe, expect, it } from 'vitest';
import { patchInputPaths } from '../../../../webview/toolCards/edit';
import { parseLspRows } from '../../../../webview/toolCards/lsp';
import { cleanOutput, clipLines, scopePaths, splitPathSel } from '../../../../webview/toolCards/util';

describe('splitPathSel', () => {
    it('splits compound line-range and raw selectors off a read path', () => {
        expect(splitPathSel('src/a.ts:50-100:raw')).toEqual({ path: 'src/a.ts', sel: '50-100:raw' });
        expect(splitPathSel('src/a.ts:5+10,40-')).toEqual({ path: 'src/a.ts', sel: '5+10,40-' });
    });

    it('keeps colons that are not selectors', () => {
        expect(splitPathSel('notes:draft.md')).toEqual({ path: 'notes:draft.md', sel: null });
        expect(splitPathSel(':12')).toEqual({ path: ':12', sel: null });
    });
});

describe('clipLines', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);

    it('does not collapse when that would hide a single line', () => {
        expect(clipLines(lines(11), 10)).toEqual({ shown: lines(11), hidden: 0 });
    });

    it('collapses to maxLines and reports the hidden count', () => {
        const clipped = clipLines(lines(12), 10);
        expect(clipped.shown).toEqual(lines(10));
        expect(clipped.hidden).toBe(2);
    });
});

describe('cleanOutput', () => {
    it('strips ANSI color and OSC sequences, widens tabs, drops trailing newlines', () => {
        expect(cleanOutput('\x1b[31merr\x1b[0m\ta\x1b]8;;http://x\x07link\x1b]8;;\x07\n\n')).toBe('err   alink');
    });
});

describe('scopePaths', () => {
    it('accepts a plain path, a JSON-encoded array, an array, or legacy `paths`', () => {
        expect(scopePaths({ path: 'src' })).toEqual(['src']);
        expect(scopePaths({ path: '["a.ts","b.ts"]' })).toEqual(['a.ts', 'b.ts']);
        expect(scopePaths({ path: ['a', 1, 'b'] })).toEqual(['a', 'b']);
        expect(scopePaths({ paths: ['x'] })).toEqual(['x']);
        expect(scopePaths({})).toEqual([]);
    });
});

describe('patchInputPaths', () => {
    it('reads hashline headers (tag and quotes stripped) and apply_patch file headers in order', () => {
        const input = [
            '[src/a.ts#1A2B]',
            'PUT 1.=1:',
            '+x',
            "['dir with space/b.md']",
            '*** Update File: src/c.ts',
            '*** Add File: d.ts',
        ].join('\n');
        expect(patchInputPaths(input)).toEqual(['src/a.ts', 'dir with space/b.md', 'src/c.ts', 'd.ts']);
    });
});

describe('parseLspRows', () => {
    it('parses diagnostics with lowercased severity and collapsed message whitespace', () => {
        const text = '2 error(s)\nsrc/a.ts:3:7 [Error]  Type  mismatch\nnoise';
        expect(parseLspRows(text, 'diagnostics')).toEqual([
            { file: 'src/a.ts', line: '3', col: '7', severity: 'error', message: 'Type mismatch' },
        ]);
    });

    it('parses bare locations and skips other lines', () => {
        expect(parseLspRows('3 reference(s)\n  src/a.ts:10:2\nsrc/b.ts:1:1', 'locations')).toEqual([
            { file: 'src/a.ts', line: '10', col: '2' },
            { file: 'src/b.ts', line: '1', col: '1' },
        ]);
    });
});
