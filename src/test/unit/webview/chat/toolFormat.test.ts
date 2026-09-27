import { describe, it, expect } from 'vitest';
import {
    extractToolResultText,
    findPrecedingAssistant,
    findToolCallArgs,
    findToolCallInMessages,
    formatToolArgs,
    getToolLabel,
    toolFooterParts,
} from '../../../../webview/chat/toolFormat';

describe('getToolLabel', () => {
    it('uses tool-specific phrasing, case-insensitively', () => {
        expect(getToolLabel('Bash', { command: 'ls -la' })).toBe('ls -la');
        expect(getToolLabel('read', { path: 'a.ts' })).toBe('Read a.ts');
        expect(getToolLabel('WRITE', { path: 'b.ts' })).toBe('Write b.ts');
        expect(getToolLabel('edit', { path: 'c.ts' })).toBe('Edit c.ts');
        expect(getToolLabel('glob', { pattern: '**/*.ts' })).toBe('Glob **/*.ts');
        expect(getToolLabel('grep', { pattern: 'foo' })).toBe('Grep foo');
    });

    it('falls back to a generic phrase when the key argument is missing', () => {
        expect(getToolLabel('bash', undefined)).toBe('Execute command');
        expect(getToolLabel('read', {})).toBe('Read file');
        expect(getToolLabel('write', {})).toBe('Write file');
        expect(getToolLabel('edit', {})).toBe('Edit file');
        expect(getToolLabel('glob', {})).toBe('Find files');
        expect(getToolLabel('grep', {})).toBe('Search files');
    });

    it('truncates bash commands at 60 chars and paths/patterns at 50', () => {
        const long = 'x'.repeat(80);
        expect(getToolLabel('bash', { command: long })).toBe(`${'x'.repeat(60)}...`);
        expect(getToolLabel('read', { path: long })).toBe(`Read ${'x'.repeat(50)}...`);
        expect(getToolLabel('grep', { pattern: long })).toBe(`Grep ${'x'.repeat(50)}...`);
        expect(getToolLabel('bash', { command: 'x'.repeat(60) })).toBe('x'.repeat(60));
    });

    it('labels unknown tools with the first hint in precedence order', () => {
        const all = { query: 'q', path: 'p', file: 'f', action: 'a', url: 'u', name: 'n', command: 'c' };
        expect(getToolLabel('web', all)).toBe('web: q');
        expect(getToolLabel('web', { ...all, query: undefined })).toBe('web: p');
        expect(getToolLabel('web', { file: 'f', action: 'a' })).toBe('web: f');
        expect(getToolLabel('web', { action: 'a', url: 'u' })).toBe('web: a');
        expect(getToolLabel('web', { url: 'u', name: 'n' })).toBe('web: u');
        expect(getToolLabel('web', { name: 'n', command: 'c' })).toBe('web: n');
        expect(getToolLabel('web', { command: 'c' })).toBe('web: c');
        expect(getToolLabel('web', { query: 'y'.repeat(60) })).toBe(`web: ${'y'.repeat(50)}...`);
    });

    it('uses the bare name when the chosen hint is not a non-blank string', () => {
        expect(getToolLabel('web', { query: '   ', path: 'p' })).toBe('web');
        expect(getToolLabel('web', { query: 42, path: 'p' })).toBe('web');
        expect(getToolLabel('web', 'not an object')).toBe('web');
        expect(getToolLabel('web', null)).toBe('web');
    });
});

describe('formatToolArgs', () => {
    it('renders one key: value per line, JSON-encoding non-strings', () => {
        expect(formatToolArgs({ path: 'a.ts', limit: 5, opts: { x: [1] } })).toBe(
            'path: a.ts\nlimit: 5\nopts: {"x":[1]}',
        );
    });

    it('is empty for non-objects and empty objects', () => {
        expect(formatToolArgs(undefined)).toBe('');
        expect(formatToolArgs('raw')).toBe('');
        expect(formatToolArgs({})).toBe('');
    });
});

describe('extractToolResultText', () => {
    it('returns empty for nullish and strings as-is', () => {
        expect(extractToolResultText(undefined)).toBe('');
        expect(extractToolResultText(null)).toBe('');
        expect(extractToolResultText('out')).toBe('out');
    });

    it('joins string/text items of an array, dropping empties', () => {
        expect(extractToolResultText(['a', { text: 'b' }, { type: 'image' }, ''])).toBe('a\nb');
    });

    it('prefers content items, then text, then output', () => {
        expect(extractToolResultText({ content: [{ text: 'c' }], text: 't', output: 'o' })).toBe('c');
        expect(extractToolResultText({ content: [{ type: 'image' }], text: 't' })).toBe('t');
        expect(extractToolResultText({ output: 'o' })).toBe('o');
    });

    it('falls back to pretty JSON', () => {
        expect(extractToolResultText({ exitCode: 1 })).toBe('{\n  "exitCode": 1\n}');
        expect(extractToolResultText(7)).toBe('7');
    });
});

describe('findToolCallInMessages', () => {
    const call = { id: 'tc1', name: 'read', arguments: { path: 'a' } };

    it('finds calls in toolCalls, tool_calls, and content blocks', () => {
        expect(findToolCallInMessages([{ role: 'assistant', toolCalls: [call] }], 1, 'tc1')).toBe(call);
        expect(findToolCallInMessages([{ role: 'assistant', tool_calls: [call] }], 1, 'tc1')).toBe(call);
        const block = { type: 'tool_use', toolCallId: 'tc2', input: {} };
        expect(findToolCallInMessages([{ role: 'assistant', content: [{ type: 'text' }, block] }], 1, 'tc2')).toBe(block);
    });

    it('only looks before beforeIndex and only in assistant messages', () => {
        const messages = [
            { role: 'assistant', toolCalls: [call] },
            { role: 'user', toolCalls: [{ id: 'tc1', fake: true }] },
            { role: 'toolResult', toolCallId: 'tc1' },
        ];
        expect(findToolCallInMessages(messages, 3, 'tc1')).toBe(call);
        expect(findToolCallInMessages(messages, 0, 'tc1')).toBeUndefined();
        expect(findToolCallInMessages(messages, 3, 'missing')).toBeUndefined();
        expect(findToolCallInMessages(messages, 3, '')).toBeUndefined();
    });
});

describe('findToolCallArgs', () => {
    const at = (tc: object) => [{ role: 'assistant', toolCalls: [{ id: 't', ...tc }] }];

    it('parses string JSON arguments', () => {
        expect(findToolCallArgs(at({ arguments: '{"path":"a"}' }), 1, 't')).toEqual({ path: 'a' });
    });

    it('returns object args untouched, checking arguments, args, input in order', () => {
        const obj = { path: 'b' };
        expect(findToolCallArgs(at({ arguments: obj, args: { x: 1 } }), 1, 't')).toBe(obj);
        expect(findToolCallArgs(at({ args: obj, input: { x: 1 } }), 1, 't')).toBe(obj);
        expect(findToolCallArgs(at({ input: obj }), 1, 't')).toBe(obj);
    });

    it('keeps invalid JSON as the raw string and defaults to {}', () => {
        expect(findToolCallArgs(at({ arguments: '{bad' }), 1, 't')).toBe('{bad');
        expect(findToolCallArgs(at({}), 1, 't')).toEqual({});
        expect(findToolCallArgs([], 0, 't')).toEqual({});
    });
});

describe('findPrecedingAssistant', () => {
    it('returns the nearest earlier assistant, but not across a user message', () => {
        const a1 = { role: 'assistant', n: 1 };
        const a2 = { role: 'assistant', n: 2 };
        const messages = [a1, { role: 'user' }, a2, { role: 'toolResult' }, { role: 'toolResult' }];
        expect(findPrecedingAssistant(messages, 4)).toBe(a2);
        expect(findPrecedingAssistant(messages, 2)).toBeNull();
        expect(findPrecedingAssistant(messages, 1)).toBe(a1);
        expect(findPrecedingAssistant(messages, 0)).toBeNull();
    });
});

describe('toolFooterParts', () => {
    it('adds positive usage of the issuing assistant step', () => {
        const usage = { input: 1200, output: 0 };
        const messages = [{ role: 'assistant', usage }, { role: 'toolResult' }];
        expect(toolFooterParts(messages[1], messages, 1)).toEqual([`${(1200).toLocaleString()} in`]);
        usage.output = 3;
        expect(toolFooterParts(messages[1], messages, 1)).toEqual([`${(1200).toLocaleString()} in`, '3 out']);
    });

    it('puts the timestamp first and is empty without timestamp or usage', () => {
        const messages = [{ role: 'assistant', usage: { input: 5, output: 0 } }, { role: 'toolResult', timestamp: 1_700_000_000 }];
        const parts = toolFooterParts(messages[1], messages, 1);
        expect(parts).toHaveLength(2);
        expect(parts[0]).not.toBe('');
        expect(parts[1]).toBe('5 in');
        expect(toolFooterParts({ role: 'toolResult' }, [{ role: 'user' }], 1)).toEqual([]);
    });
});
