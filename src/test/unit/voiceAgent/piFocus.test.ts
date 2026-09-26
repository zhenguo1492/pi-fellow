import { describe, it, expect } from 'vitest';
import { changedLines, editPaths, findName, readTarget } from '../../../voiceAgent/piFocus';

describe('Pi focus: what a tool call looks at', () => {
    it("reads omp's line selectors and pi's offset/limit", () => {
        expect(readTarget({ path: 'src/a.ts:50-80' })).toEqual({ path: 'src/a.ts', startLine: 50, endLine: 80 });
        expect(readTarget({ path: 'src/a.ts:50+30' })).toEqual({ path: 'src/a.ts', startLine: 50, endLine: 79 });
        expect(readTarget({ path: 'src/a.ts:5-16,960-973' })).toEqual({ path: 'src/a.ts', startLine: 5, endLine: 16 });
        expect(readTarget({ path: 'src/a.ts:raw' })).toEqual({ path: 'src/a.ts' });
        expect(readTarget({ file_path: '/abs/b.py', offset: 10, limit: 5 })).toEqual({ path: '/abs/b.py', startLine: 10, endLine: 14 });
        expect(readTarget({ path: 'https://example.com/' })).toBeUndefined();
    });

    it('finds every file an omp patch touches, once each', () => {
        const input = '[src/a.ts#1A2B]\nPUT 3.=4:\n+x\n[src/b.ts#3C4D]\nCUT 1.=1\n[src/a.ts#1A2B]\nPUT >9:\n+y\n';
        expect(editPaths({ input })).toEqual(['src/a.ts', 'src/b.ts']);
        expect(editPaths({ path: 'c.ts', content: '[not.a#header]' })).toEqual(['c.ts']);
    });
});

describe('Pi focus: lines a write changed', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');

    it('spans from the first to the last changed line of the new text', () => {
        expect(changedLines(before, ['a', 'B', 'c', 'D', 'e'].join('\n'))).toEqual({ startLine: 2, endLine: 4 });
        expect(changedLines(before, ['a', 'b', 'x', 'y', 'c', 'd', 'e'].join('\n'))).toEqual({ startLine: 3, endLine: 4 });
    });

    it('points after a pure deletion, and at the whole of a new file', () => {
        expect(changedLines(before, ['a', 'b', 'e'].join('\n'))).toEqual({ startLine: 3, endLine: 3 });
        expect(changedLines(before, ['a', 'b', 'c', 'd'].join('\n'))).toEqual({ startLine: 4, endLine: 4 });
        expect(changedLines(undefined, 'x\ny\n')).toEqual({ startLine: 1, endLine: 3 });
        expect(changedLines(before, before)).toBeUndefined();
    });
});

describe('Pi focus: a name on a line', () => {
    const lines = ['const max = 1;', 'let x = max + x2;', '', 'return x;'];
    const lineText = (line: number) => lines[line - 1];

    it('matches the name as a whole word, not inside another', () => {
        expect(findName(lineText, 'x', 2, 2)).toEqual({ line: 2, start: 4, end: 5 });
        expect(findName(lineText, 'max', 2, 2)).toEqual({ line: 2, start: 8, end: 11 });
    });

    it('looks at the nearest lines when the given ones lack it, and gives up further off', () => {
        expect(findName(lineText, 'x', 3, 3)).toEqual({ line: 2, start: 4, end: 5 });
        expect(findName(lineText, 'max', 4, 4)).toEqual({ line: 2, start: 8, end: 11 });
        expect(findName(lineText, 'y', 1, 4)).toBeUndefined();
    });
});
