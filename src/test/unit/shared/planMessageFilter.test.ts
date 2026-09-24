import { describe, it, expect } from 'vitest';
import {
    shouldHideMessageInChat,
    shouldHideRpivTodoToolInChat,
    stripPlanContentForChatDisplay,
} from '../../../shared/planMessageFilter';

describe('planMessageFilter', () => {
    it('hides rpiv-todo tool results', () => {
        expect(shouldHideRpivTodoToolInChat({ role: 'toolResult', toolName: 'todo' })).toBe(true);
        expect(shouldHideMessageInChat({ role: 'toolResult', toolName: 'todo', details: {} })).toBe(true);
    });

    it('hides proposed-plan custom messages', () => {
        expect(
            shouldHideMessageInChat({
                role: 'custom',
                customType: 'proposed-plan',
                content: '# Plan\n\n- step',
            }),
        ).toBe(true);
    });

    it('hides assistant message that is only proposed_plan block', () => {
        expect(
            shouldHideMessageInChat({
                role: 'assistant',
                content: '<proposed_plan>\n# Title\n\n1. step\n</proposed_plan>',
            }),
        ).toBe(true);
    });

    it('keeps assistant text outside proposed_plan', () => {
        const msg = {
            role: 'assistant',
            content: 'Here is the plan.\n<proposed_plan>\n# T\n</proposed_plan>\nAny questions?',
        };
        expect(shouldHideMessageInChat(msg)).toBe(false);
        expect(stripPlanContentForChatDisplay(msg.content as string)).toContain('Any questions?');
    });

    it('keeps an assistant step that only thinks and calls tools', () => {
        expect(
            shouldHideMessageInChat({
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'read the file first' },
                    { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
                ],
            }),
        ).toBe(false);
    });

    it('hides implement-plan user kickoff', () => {
        expect(
            shouldHideMessageInChat({
                role: 'user',
                content:
                    'Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:\n\n# Plan',
            }),
        ).toBe(true);
    });
});
