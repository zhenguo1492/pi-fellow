import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: vi.fn() } }));

import { formatTimestamp } from '../../../../webview/chat/helpers';
import { messageFooterParts } from '../../../../webview/chat/messageRender';

describe('messageFooterParts', () => {
    it('shows a user prompt the input tokens of the first assistant reply that reports them', () => {
        const messages = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', usage: { input: 0, output: 5 } },
            { role: 'toolResult' },
            { role: 'assistant', usage: { input: 150, output: 7 } },
            { role: 'assistant', usage: { input: 999, output: 7 } },
        ];
        expect(messageFooterParts(messages[0], 0, messages)).toEqual(['150 input tokens']);
    });

    it('does not borrow input tokens from a reply to a later user prompt', () => {
        const messages = [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
            { role: 'assistant', usage: { input: 99, output: 1 } },
        ];
        expect(messageFooterParts(messages[0], 0, messages)).toEqual([]);
        expect(messageFooterParts(messages[1], 1, messages)).toEqual(['99 input tokens']);
    });

    it('computes tok/s from a timestamp given in seconds', () => {
        const msg = {
            role: 'assistant',
            timestamp: 1_000_000,
            _messageEndTime: 1_000_000 * 1000 + 2000,
            usage: { output: 40 },
        };
        expect(messageFooterParts(msg, 0, [msg])).toEqual([
            formatTimestamp(msg.timestamp),
            '20.0 tok/s',
            '40 output tokens',
        ]);
    });

    it('computes tok/s from a timestamp given in milliseconds', () => {
        const msg = {
            role: 'assistant',
            timestamp: 1_700_000_000_000,
            _messageEndTime: 1_700_000_004_000,
            usage: { output: 40 },
        };
        expect(messageFooterParts(msg, 0, [msg]).slice(1)).toEqual(['10.0 tok/s', '40 output tokens']);
    });

    it('omits tok/s when the end time is not after the start', () => {
        const msg = {
            role: 'assistant',
            timestamp: 1_700_000_000_000,
            _messageEndTime: 1_700_000_000_000,
            usage: { output: 40 },
        };
        expect(messageFooterParts(msg, 0, [msg]).slice(1)).toEqual(['40 output tokens']);
    });

    it('is empty for an assistant message without timestamp or output usage', () => {
        const msg = { role: 'assistant', usage: { input: 10, output: 0 } };
        expect(messageFooterParts(msg, 0, [msg])).toEqual([]);
    });

    it('is empty for roles that have no footer', () => {
        const msg = { role: 'toolResult', timestamp: 1_700_000_000_000, usage: { output: 40 } };
        expect(messageFooterParts(msg, 0, [msg])).toEqual([]);
    });
});
