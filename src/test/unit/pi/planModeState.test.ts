import { describe, it, expect } from 'vitest';
import { readPlanModeInfoFromContext } from '../../../pi/planModeState';

describe('readPlanModeInfoFromContext', () => {
    it('uses the latest plan-mode-state entry, not an older disabled snapshot', () => {
        const info = readPlanModeInfoFromContext({
            jsonlEntries: [
                { type: 'custom', customType: 'plan-mode-state', data: { enabled: false } },
                { type: 'custom', customType: 'plan-mode-state', data: { enabled: true, awaitingAction: false } },
            ],
            activeToolNames: ['read', 'bash', 'plan_mode_question'],
        });
        expect(info.enabled).toBe(true);
        expect(info.statusLabel).toBe('planning');
    });

    it('respects persisted disabled even when plan_mode_question is still registered', () => {
        const info = readPlanModeInfoFromContext({
            jsonlEntries: [{ type: 'custom', customType: 'plan-mode-state', data: { enabled: false } }],
            activeToolNames: ['read', 'bash', 'plan_mode_question'],
        });
        expect(info.enabled).toBe(false);
    });

    it('marks ready when latest plan and awaiting action', () => {
        const info = readPlanModeInfoFromContext({
            jsonlEntries: [
                {
                    type: 'custom',
                    customType: 'plan-mode-state',
                    data: { enabled: true, awaitingAction: true, latestPlan: '# Plan\n\n1. Step' },
                },
            ],
            activeToolNames: ['read', 'bash', 'plan_mode_question'],
        });
        expect(info.enabled).toBe(true);
        expect(info.hasPlan).toBe(true);
        expect(info.statusLabel).toBe('ready');
    });

    it('ignores <proposed_plan> in assistant text unless plan mode is on', () => {
        const messages = [
            { role: 'assistant', content: [{ type: 'text', text: 'The parser matches `<proposed_plan>…</proposed_plan>` tags.' }] },
        ];
        const off = readPlanModeInfoFromContext({ messages });
        expect(off.hasPlan).toBe(false);
        expect(off.planMarkdown).toBe('');

        const on = readPlanModeInfoFromContext({
            messages,
            jsonlEntries: [{ type: 'custom', customType: 'plan-mode-state', data: { enabled: true } }],
        });
        expect(on.hasPlan).toBe(true);
    });
});
