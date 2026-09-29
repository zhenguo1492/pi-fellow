import { describe, it, expect } from 'vitest';
import { ToneDial } from '../../../voiceAgent/tone';
import type { TurnInput } from '../../../voiceAgent/voicePrompt';

const chat: TurnInput = {
    trigger: { kind: 'user', text: '这段在干嘛', source: 'stt' },
    status: { phase: 'idle', queued: 0 },
    updates: [],
    requests: [],
    proposals: [],
    research: [],
};
const error: TurnInput = { ...chat, trigger: { kind: 'proactive', observation: 'error', detail: 'npm test failed' } };

/** Every roll lands low: moods drift and every allowed turn invites an aside. */
const eager = () => new ToneDial(() => 0, () => new Date(2026, 8, 28, 15));

describe('ToneDial', () => {
    it('leaves the tone out with humor off', () => {
        expect(eager().next(chat, 'off')).toBeUndefined();
    });

    it('never invites asides two turns running', () => {
        const dial = eager();
        const asides = [1, 2, 3, 4].map(() => dial.next(chat, 'often')?.aside !== undefined);
        expect(asides).toEqual([true, false, true, false]);
    });

    it('never invites an aside next to something the user must answer or hear straight', () => {
        const serious: TurnInput[] = [
            { ...chat, requests: [{ id: 'ui_1', method: 'confirm', title: 'Run npm test?', receivedAt: 0 }] },
            { ...chat, pendingDelete: { path: 'src/old.ts', recursive: false } },
            { ...chat, interrupted: 'The user saw only: "I think"' },
            { ...chat, trigger: { kind: 'proactive', observation: 'needs_input', detail: 'asks which file' } },
            { ...chat, trigger: { kind: 'proactive', observation: 'stopped', detail: 'Allow rm? Approve / Deny' } },
        ];
        for (const input of serious) {
            expect(eager().next(input, 'often')?.aside).toBeUndefined();
        }
    });

    it('an error sobers the voice for two turns, and no joke comes with it', () => {
        const dial = eager();
        expect(dial.next(error, 'often')).toEqual({ mood: 'sober', time: 'afternoon' });
        expect(dial.next(chat, 'often')).toEqual({ mood: 'sober', time: 'afternoon' });
        const after = dial.next(chat, 'often');
        expect(after?.mood).not.toBe('sober');
        expect(after?.aside).toBeDefined();
    });

    it('finished work pleases it for that turn', () => {
        const done: TurnInput = { ...chat, trigger: { kind: 'proactive', observation: 'done', detail: 'tests pass' } };
        expect(eager().next(done, 'occasional')?.mood).toBe('pleased');
    });
});
