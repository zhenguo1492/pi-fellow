import { describe, it, expect } from 'vitest';
import {
    extractImages,
    extractText,
    extractThinking,
    extractToolCalls,
    failedConnectionFromAssistant,
    findLastUserMessageIndex,
    getAssistantPlainForCopy,
    getUserMessagePlainForCopy,
    isTurnPrompt,
    lastAssistantMessage,
    messageFingerprint,
    thinkingBlockText,
} from '../../../../webview/chat/messageContent';

describe('extractText', () => {
    it('returns string content as-is', () => {
        expect(extractText({ content: 'hello' })).toBe('hello');
    });

    it('joins only text blocks from array content without separators', () => {
        expect(
            extractText({
                content: [
                    { type: 'text', text: 'a' },
                    { type: 'thinking', thinking: 'ignored' },
                    { type: 'image', data: 'x' },
                    { type: 'text', text: 'b' },
                ],
            }),
        ).toBe('ab');
    });

    it('falls back to msg.text, then empty string', () => {
        expect(extractText({ text: 'legacy' })).toBe('legacy');
        expect(extractText({})).toBe('');
    });
});

describe('thinkingBlockText / extractThinking', () => {
    it('uses a placeholder for redacted thinking without data', () => {
        expect(thinkingBlockText({ type: 'redacted_thinking' })).toBe('[Thinking redacted by provider]');
        expect(thinkingBlockText({ type: 'redacted_thinking', data: '   ' })).toBe('[Thinking redacted by provider]');
        expect(thinkingBlockText({ type: 'redacted_thinking', data: 'opaque' })).toBe('opaque');
    });

    it('prefers thinking over text on thinking blocks and ignores other types', () => {
        expect(thinkingBlockText({ type: 'thinking', thinking: 't', text: 'x' })).toBe('t');
        expect(thinkingBlockText({ type: 'thinking', text: 'x' })).toBe('x');
        expect(thinkingBlockText({ type: 'text', text: 'x' })).toBe('');
        expect(thinkingBlockText(null)).toBe('');
    });

    it('joins non-blank thinking blocks with blank lines', () => {
        expect(
            extractThinking({
                content: [
                    { type: 'thinking', thinking: 'one' },
                    { type: 'thinking', thinking: '  ' },
                    { type: 'text', text: 'answer' },
                    { type: 'redacted_thinking' },
                ],
            }),
        ).toBe('one\n\n[Thinking redacted by provider]');
    });

    it('reads a string thinking field when content is not an array', () => {
        expect(extractThinking({ content: 'x', thinking: 'plan' })).toBe('plan');
        expect(extractThinking({ content: 'x', thinking: 42 })).toBe('');
    });
});

describe('extractImages', () => {
    it('keeps image blocks with non-empty string data and defaults the mime type', () => {
        expect(
            extractImages({
                content: [
                    { type: 'image', data: 'AAA', name: 'a.png' },
                    { type: 'image', data: 'BBB', mimeType: 'image/jpeg' },
                    { type: 'image', data: '' },
                    { type: 'image' },
                    { type: 'text', text: 'hi' },
                ],
            }),
        ).toEqual([
            { mimeType: 'image/png', data: 'AAA', name: 'a.png' },
            { mimeType: 'image/jpeg', data: 'BBB', name: undefined },
        ]);
    });

    it('returns no images for string content', () => {
        expect(extractImages({ content: 'text' })).toEqual([]);
    });
});

describe('extractToolCalls', () => {
    it('prefers toolCalls, then tool_calls, then tool blocks in content', () => {
        const a = { id: 'a' };
        const b = { id: 'b' };
        expect(extractToolCalls({ toolCalls: [a], tool_calls: [b] })).toEqual([a]);
        expect(extractToolCalls({ toolCalls: [], tool_calls: [b] })).toEqual([b]);
        const blocks = [
            { type: 'toolCall', id: '1' },
            { type: 'text', text: 'x' },
            { type: 'tool_call', id: '2' },
            { type: 'tool_use', id: '3' },
        ];
        expect(extractToolCalls({ content: blocks }).map((c) => c.id)).toEqual(['1', '2', '3']);
        expect(extractToolCalls({ content: 'x' })).toEqual([]);
    });
});

describe('messageFingerprint', () => {
    it('combines role, text and timestamp', () => {
        expect(messageFingerprint({ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 5 })).toBe(
            'user:hi:5',
        );
        expect(messageFingerprint({ content: 'x' })).toBe(':x:');
    });

    it('differs when only the timestamp differs', () => {
        expect(messageFingerprint({ role: 'user', content: 'hi', timestamp: 1 })).not.toBe(
            messageFingerprint({ role: 'user', content: 'hi', timestamp: 2 }),
        );
    });
});

describe('isTurnPrompt / findLastUserMessageIndex', () => {
    it('treats user messages as turn prompts unless they are steering', () => {
        expect(isTurnPrompt({ role: 'user' })).toBe(true);
        expect(isTurnPrompt({ role: 'user', steering: false })).toBe(true);
        expect(isTurnPrompt({ role: 'user', steering: true })).toBe(false);
        expect(isTurnPrompt({ role: 'assistant' })).toBe(false);
        expect(isTurnPrompt(null)).toBe(false);
        expect(isTurnPrompt('user')).toBe(false);
    });

    it('finds the last turn-starting user message, skipping steering', () => {
        const messages = [
            { role: 'user' },
            { role: 'assistant' },
            { role: 'user' },
            { role: 'assistant' },
            { role: 'user', steering: true },
            { role: 'assistant' },
        ];
        expect(findLastUserMessageIndex(messages)).toBe(2);
    });

    it('returns -1 when there is no turn prompt', () => {
        expect(findLastUserMessageIndex([])).toBe(-1);
        expect(findLastUserMessageIndex([{ role: 'user', steering: true }, { role: 'assistant' }])).toBe(-1);
    });
});

describe('lastAssistantMessage', () => {
    it('returns the latest assistant message', () => {
        const last = { role: 'assistant', id: 2 };
        expect(lastAssistantMessage([{ role: 'assistant', id: 1 }, last, { role: 'user' }])).toBe(last);
    });

    it('returns undefined for empty, missing, or assistant-free lists', () => {
        expect(lastAssistantMessage(undefined)).toBeUndefined();
        expect(lastAssistantMessage([])).toBeUndefined();
        expect(lastAssistantMessage([{ role: 'user' }, null])).toBeUndefined();
    });
});

describe('failedConnectionFromAssistant', () => {
    it('reports a trimmed error message for error stops', () => {
        expect(failedConnectionFromAssistant({ stopReason: 'error', errorMessage: '  rate limited \n' })).toEqual({
            phase: 'failed',
            message: 'rate limited',
        });
    });

    it('uses a default message when the error text is blank or not a string', () => {
        expect(failedConnectionFromAssistant({ stopReason: 'error', errorMessage: '   ' })).toEqual({
            phase: 'failed',
            message: 'Request failed',
        });
        expect(failedConnectionFromAssistant({ stopReason: 'error', errorMessage: 500 })).toEqual({
            phase: 'failed',
            message: 'Request failed',
        });
    });

    it('ignores messages that did not stop with an error', () => {
        expect(failedConnectionFromAssistant({ stopReason: 'stop', errorMessage: 'x' })).toBeUndefined();
        expect(failedConnectionFromAssistant(undefined)).toBeUndefined();
    });
});

describe('copy helpers', () => {
    it('copies user text without attached file blocks', () => {
        const msg = { role: 'user', content: '<file name="src/a.ts">body</file>\nPlease fix' };
        expect(getUserMessagePlainForCopy(msg)).toBe('Please fix');
    });

    it('falls back to the raw user text when nothing displayable remains', () => {
        const raw = '<file name="src/a.ts">body</file>';
        expect(getUserMessagePlainForCopy({ role: 'user', content: raw })).toBe(raw);
    });

    it('strips proposed plan blocks from assistant text', () => {
        const msg = {
            role: 'assistant',
            content: [{ type: 'text', text: 'Intro\n<proposed_plan>\n# Plan\n</proposed_plan>' }],
        };
        expect(getAssistantPlainForCopy(msg)).toBe('Intro');
        expect(getAssistantPlainForCopy({ role: 'assistant', content: [] })).toBe('');
    });
});
