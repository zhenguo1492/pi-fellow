import { describe, it, expect } from 'vitest';
import { SilenceGate, buildTurnMessage, type TurnInput } from '../../../voiceAgent/voicePrompt';

function stream(deltas: string[]) {
    const gate = new SilenceGate();
    const shown = deltas.map((delta) => gate.push(delta)).join('') + gate.flush();
    return { shown, silent: gate.silent };
}

describe('SilenceGate', () => {
    it('never lets a <silent/> reply through, whitespace around it included', () => {
        expect(stream([' <sil', 'ent/>', '\n'])).toEqual({ shown: '', silent: true });
    });

    it('releases a reply once it cannot be <silent/>, without losing held text', () => {
        expect(stream(['<', 'b>好', '的'])).toEqual({ shown: '<b>好的', silent: false });
        expect(stream(['<silent/>', ' 其实有事'])).toEqual({ shown: '<silent/> 其实有事', silent: false });
    });

    it('releases a reply that ended while it still looked like the start of <silent/>', () => {
        expect(stream(['<sil'])).toEqual({ shown: '<sil', silent: false });
    });
});

describe('turn message: editor', () => {
    const base: TurnInput = {
        trigger: { kind: 'user', text: '这段在干嘛', source: 'stt' },
        status: { phase: 'idle', queued: 0 },
        updates: [],
        requests: [],
        proposals: [],
        research: [],
    };

    it('shows where the user is and the selected lines by number, and says when the buffer differs from disk', () => {
        const message = buildTurnMessage({
            ...base,
            editor: {
                path: 'src/voice/stt.ts',
                language: 'typescript',
                cursorLine: 141,
                visible: { startLine: 120, endLine: 180 },
                selection: { startLine: 139, endLine: 141 },
                lines: [
                    { line: 139, text: '        const form = new FormData();' },
                    { line: 140, text: "        form.append('file', blob);" },
                ],
                omittedLines: 1,
                unsaved: true,
            },
        });
        expect(message).toContain(
            '<editor file="src/voice/stt.ts" language="typescript" cursor="141" visible="120-180" selection="139-141" unsaved="true">\n' +
                '139:         const form = new FormData();\n' +
                "140:         form.append('file', blob);\n" +
                '(1 more selected lines; read the file for them)\n' +
                '</editor>',
        );
        // The editor comes before the user's words.
        expect(message.indexOf('<editor')).toBeLessThan(message.indexOf('<user'));
    });

    it('says the editor is unchanged or closed instead of repeating it', () => {
        expect(buildTurnMessage({ ...base, editor: 'unchanged' })).toContain('<editor unchanged/>');
        expect(buildTurnMessage({ ...base, editor: 'none' })).toContain('<editor none/>');
        expect(buildTurnMessage(base)).not.toContain('<editor');
    });
});

describe('turn message: names', () => {
    const base: TurnInput = {
        trigger: { kind: 'user', text: '你叫什么', source: 'stt' },
        status: { phase: 'idle', queued: 0 },
        updates: [],
        requests: [],
        proposals: [],
        research: [],
    };

    it('tells the model the names only once one is not the default, quotes kept out of the attribute', () => {
        expect(buildTurnMessage({ ...base, names: { bot: 'Bot', user: 'User' } })).not.toContain('<names');
        const message = buildTurnMessage({ ...base, names: { bot: '小智', user: 'Zheng "Z"' } });
        expect(message).toContain(`<names you="小智" user="Zheng 'Z'"/>`);
        expect(message.indexOf('<names')).toBeLessThan(message.indexOf('<user'));
    });
});

describe('turn message: proposals settled with the panel buttons', () => {
    const base: TurnInput = {
        trigger: { kind: 'user', text: '好了吗', source: 'stt' },
        status: { phase: 'working', queued: 0 },
        updates: [],
        requests: [],
        proposals: [],
        research: [],
    };

    it('tells the model a confirmed proposal already went out, and a cancelled one was dropped, before the user speaks', () => {
        const message = buildTurnMessage({
            ...base,
            settledProposals: [
                { id: 'p1', tabId: 'tab-1', message: 'bump version', outcome: 'confirmed', by: 'button', result: 'Sent as a new task; the worker has started.' },
                { id: 'p2', tabId: 'tab-1', message: 'drop the cache', outcome: 'cancelled', by: 'button' },
            ],
        });
        expect(message).toContain('<proposal-settled id="p1" outcome="confirmed">bump version\nResult: Sent as a new task; the worker has started.</proposal-settled>');
        expect(message).toContain('<proposal-settled id="p2" outcome="cancelled">drop the cache</proposal-settled>');
        expect(message.indexOf('<proposal-settled')).toBeLessThan(message.indexOf('<user'));
    });

    it('says a confirmed proposal is still being sent when its result is not in yet', () => {
        const message = buildTurnMessage({
            ...base,
            settledProposals: [{ id: 'p1', tabId: 'tab-1', message: 'bump version', outcome: 'confirmed', by: 'button' }],
        });
        expect(message).toContain('<proposal-settled id="p1" outcome="confirmed">bump version\nResult: It is being sent now.</proposal-settled>');
    });
});

describe('turn message: approval cards', () => {
    it('shows a card still waiting and an answered one with its result, so the model reminds the user or reports it', () => {
        const message = buildTurnMessage({
            trigger: { kind: 'proactive', observation: 'approval', detail: 'The user answered your approval card.' },
            status: { phase: 'idle', queued: 0 },
            updates: [],
            requests: [],
            proposals: [],
            research: [],
            heldApprovals: [{ id: 'a2', tabId: 'tab-1', toolName: 'delete_file', summary: 'old.ts' }],
            settledApprovals: [{ id: 'a1', tabId: 'tab-1', toolName: 'run_in_terminal', summary: 'npm test', outcome: 'done', result: 'Exit code 0.' }],
        });
        expect(message).toContain('<approval-pending id="a2" tool="delete_file">old.ts</approval-pending>');
        expect(message).toContain('<approval-settled id="a1" tool="run_in_terminal" outcome="done">npm test\nResult: Exit code 0.</approval-settled>');
        expect(message).toContain('<worker-update kind="approval">');
    });
});
