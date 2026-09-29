import { describe, it, expect } from 'vitest';
import { cleanTerminalOutput, insideFolder, locateEdit, pickName } from '../../../voiceAgent/pairText';

describe('pair: where an edit goes', () => {
    const text = 'a\nreturn x;\nb\nreturn x;\nc\n';

    it('places a unique match, and a repeated one only by nearLine', () => {
        expect(locateEdit(text, 'b\n', undefined)).toEqual({ start: 12, end: 14 });
        expect(locateEdit(text, 'return x;')).toEqual({ error: expect.stringContaining('lines 2, 4') });
        expect(locateEdit(text, 'return x;', 5)).toEqual({ start: 14, end: 23 });
        expect(locateEdit(text, 'return x;', 1)).toEqual({ start: 2, end: 11 });
    });

    it('refuses text that is not there, and an empty oldText unless the file is empty', () => {
        expect(locateEdit(text, 'return  x;')).toEqual({ error: expect.stringContaining('not in the file') });
        expect(locateEdit(text, '')).toEqual({ error: expect.stringContaining('empty') });
        expect(locateEdit('', '')).toEqual({ start: 0, end: 0 });
    });
});

describe('pair: terminal output', () => {
    it('drops colours and prompts escapes, and keeps a progress line as it ended', () => {
        const raw = '\x1b]633;C\x07\x1b[32m✓ passes\x1b[0m\r\n 10%\r 50%\r100%\r\n\x1b[1mdone\x1b[22m\r\n\r\n';
        expect(cleanTerminalOutput(raw)).toBe('✓ passes\n100%\ndone');
    });

    it('keeps only the tail of long output, and says so', () => {
        const raw = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
        const out = cleanTerminalOutput(raw, 3);
        expect(out).toBe('…(earlier output omitted)\nline 98\nline 99\nline 100');
    });
});

describe('pair: which output', () => {
    const names = ['Git', 'GitHub', 'Tasks', 'Terminal: bash', 'Terminal: Pi'];

    it('prefers the exact name over names containing it, case aside', () => {
        expect(pickName(names, 'git', 'output')).toEqual({ name: 'Git' });
        expect(pickName(names, 'task', 'output')).toEqual({ name: 'Tasks' });
    });

    it('refuses an ambiguous or unknown name', () => {
        expect(pickName(names, 'terminal', 'output')).toEqual({ error: expect.stringContaining('Terminal: bash, Terminal: Pi') });
        expect(pickName(names, 'npm', 'output')).toEqual({ error: expect.stringContaining('No output named npm') });
    });
});

describe('pair: paths stay in the workspace', () => {
    it('takes the folder and what is under it, including names that start with dots', () => {
        expect(insideFolder('/ws', '/ws')).toBe(true);
        expect(insideFolder('/ws', '/ws/src/a.ts')).toBe(true);
        expect(insideFolder('/ws', '/ws/..cache/a')).toBe(true);
    });

    it('refuses the parent, siblings sharing a prefix, and elsewhere', () => {
        expect(insideFolder('/ws', '/')).toBe(false);
        expect(insideFolder('/ws', '/ws2/a.ts')).toBe(false);
        expect(insideFolder('/ws', '/tmp/a.ts')).toBe(false);
    });
});
