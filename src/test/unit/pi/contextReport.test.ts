import { describe, expect, it } from 'vitest';
import { parseContextReport } from '../../../pi/contextReport';

/** omp 18.2 `/context` over RPC (`command_output`), bars coloured. */
const REPORT = [
    'Context window: 1000000 tokens (29% used)',
    '  System prompt    [\u001b[38;2;156;163;176m░\u001b[39m\u001b[38;2;107;114;128m░░░░░░░░░░░░░░░░░░░░░░░\u001b[39m] 1%  7363 tokens',
    '  System tools     [░░░░░░░░░░░░░░░░░░░░░░░░] 2%  19871 tokens',
    '  System context   [░░░░░░░░░░░░░░░░░░░░░░░░] 0%  324 tokens',
    '  Skills           [░░░░░░░░░░░░░░░░░░░░░░░░] 1%  7051 tokens',
    '  Messages         [██████░░░░░░░░░░░░░░░░░░] 25%  253000 tokens',
    '  Auto-compact buf [████░░░░░░░░░░░░░░░░░░░░] 15%  150000 tokens',
    '  Free             [█████████████░░░░░░░░░░░] 56%  562391 tokens',
    'Snapcompact (estimated wire savings):',
    '  System prompt: stays text (no net savings)',
].join('\n');

describe('parseContextReport', () => {
    it('splits the window into categories, buffer, free space and notes', () => {
        const info = parseContextReport(REPORT);
        expect(info.contextWindow).toBe(1_000_000);
        expect(info.categories.map((c) => [c.id, c.tokens])).toEqual([
            ['systemPrompt', 7363],
            ['systemTools', 19871],
            ['systemContext', 324],
            ['skills', 7051],
            ['messages', 253000],
        ]);
        expect(info.usedTokens).toBe(7363 + 19871 + 324 + 7051 + 253000);
        expect(info.autoCompactBufferTokens).toBe(150000);
        expect(info.freeTokens).toBe(562391);
        // A snapcompact line looks like a category row but has no bar: it stays a note.
        expect(info.notes).toEqual(['Snapcompact (estimated wire savings):', '  System prompt: stays text (no net savings)']);
    });

    it('surfaces the report as the error when it has no breakdown', () => {
        expect(() => parseContextReport('Context usage is unavailable: no model is selected for this session.')).toThrow(
            'no model is selected',
        );
    });
});
