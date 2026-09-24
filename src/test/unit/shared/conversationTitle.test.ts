import { describe, expect, it } from 'vitest';
import {
    deriveConversationTitle,
    extractConversationMessageText,
} from '../../../shared/conversationTitle';

describe('conversationTitle', () => {
    it('prefers an explicit session name', () => {
        expect(
            deriveConversationTitle('  Architecture review  ', [
                { role: 'user', content: 'Inspect this project' },
            ]),
        ).toBe('Architecture review');
    });

    it('uses the first user prompt when the session is unnamed', () => {
        expect(
            deriveConversationTitle(undefined, [
                { role: 'assistant', content: 'Hello' },
                { role: 'user', content: '查看这个项目的架构' },
                { role: 'user', content: 'A later message' },
            ]),
        ).toBe('查看这个项目的架构');
    });

    it('supports array content and normalizes whitespace', () => {
        const message = {
            role: 'user',
            content: [
                { type: 'text', text: 'Review\nthis' },
                { type: 'image', data: 'ignored' },
                { type: 'text', text: ' project' },
            ],
        };
        expect(extractConversationMessageText(message)).toBe('Review\nthis\n project');
        expect(deriveConversationTitle(undefined, [message])).toBe('Review this project');
    });

    it('can use a prompt before it appears in synchronized messages', () => {
        expect(deriveConversationTitle(undefined, [], '  First prompt  ')).toBe('First prompt');
    });
});
