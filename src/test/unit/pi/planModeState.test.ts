import { describe, it, expect } from 'vitest';
import { readPlanModeInfo } from '../../../pi/planModeState';

function mockSession(opts: {
    entries?: Array<{ type: string; customType?: string; data?: unknown }>;
    tools?: string[];
    messages?: unknown[];
}): any {
    return {
        messages: opts.messages ?? [],
        getActiveToolNames: () => opts.tools ?? ['read', 'bash', 'edit', 'write'],
        sessionManager: {
            getEntries: () => opts.entries ?? [],
            getBranch: () => opts.entries ?? [],
        },
    };
}

describe('readPlanModeInfo', () => {
    it('uses the latest plan-mode-state entry, not an older disabled snapshot', () => {
        const session = mockSession({
            entries: [
                { type: 'custom', customType: 'plan-mode-state', data: { enabled: false } },
                { type: 'custom', customType: 'plan-mode-state', data: { enabled: true, awaitingAction: false } },
            ],
            tools: ['read', 'bash', 'plan_mode_question'],
        });
        const info = readPlanModeInfo(session);
        expect(info.enabled).toBe(true);
        expect(info.statusLabel).toBe('planning');
    });

    it('respects persisted disabled even when plan_mode_question is still registered', () => {
        const session = mockSession({
            entries: [{ type: 'custom', customType: 'plan-mode-state', data: { enabled: false } }],
            tools: ['read', 'bash', 'plan_mode_question'],
        });
        expect(readPlanModeInfo(session).enabled).toBe(false);
    });

    it('marks ready when latest plan and awaiting action', () => {
        const session = mockSession({
            entries: [
                {
                    type: 'custom',
                    customType: 'plan-mode-state',
                    data: { enabled: true, awaitingAction: true, latestPlan: '# Plan\n\n1. Step' },
                },
            ],
            tools: ['read', 'bash', 'plan_mode_question'],
        });
        const info = readPlanModeInfo(session);
        expect(info.enabled).toBe(true);
        expect(info.hasPlan).toBe(true);
        expect(info.statusLabel).toBe('ready');
    });

    it('ignores <proposed_plan> in assistant text unless plan mode is on', () => {
        const messages = [
            { role: 'assistant', content: [{ type: 'text', text: 'The parser matches `<proposed_plan>…</proposed_plan>` tags.' }] },
        ];
        const off = readPlanModeInfo(mockSession({ messages }));
        expect(off.hasPlan).toBe(false);
        expect(off.planMarkdown).toBe('');

        const on = readPlanModeInfo(
            mockSession({
                messages,
                entries: [{ type: 'custom', customType: 'plan-mode-state', data: { enabled: true } }],
            }),
        );
        expect(on.hasPlan).toBe(true);
    });
});
