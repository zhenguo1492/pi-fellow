import { describe, it, expect } from 'vitest';
import { SilenceGate, buildTurnMessage, tuiQuestionLine, type TurnInput, USER_TURN_REMINDER } from '../../../voiceAgent/voicePrompt';

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

describe('turn message: a tab showing the CLI TUI', () => {
    it('marks the worker as a TUI, so the model reads its screen and types its answers', () => {
        const input: TurnInput = { trigger: { kind: 'user', text: '好了吗', source: 'stt' }, status: { phase: 'idle', queued: 0 }, updates: [], requests: [], proposals: [], research: [] };
        expect(buildTurnMessage({ ...input, status: { phase: 'working', queued: 0, tui: true } })).toContain('<worker status="working" tui="true"/>');
        expect(buildTurnMessage(input)).toContain('<worker status="idle"/>');
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

describe('turn message: the line that closes a user turn', () => {
    const base: TurnInput = {
        trigger: { kind: 'user', text: '这个方法是干嘛的', source: 'stt' },
        status: { phase: 'idle', queued: 0 },
        updates: [],
        requests: [],
        proposals: [],
        research: [],
    };

    it('ends every user turn with the language and length reminder, after the attachments', () => {
        expect(buildTurnMessage(base).endsWith(`<user source="stt">这个方法是干嘛的</user>\n${USER_TURN_REMINDER}`)).toBe(true);
        const withFiles = buildTurnMessage({ ...base, trigger: { ...base.trigger, kind: 'user', text: 'look', source: 'text', files: '<file path="a.md">hi</file>\n' } });
        expect(withFiles.endsWith(`</user>\n<attached>\n<file path="a.md">hi</file>\n</attached>\n${USER_TURN_REMINDER}`)).toBe(true);
    });

    it('leaves the turns nobody started to their own closing lines', () => {
        const opening = buildTurnMessage({ ...base, trigger: { kind: 'opening', reason: 'connect' } });
        const update = buildTurnMessage({ ...base, trigger: { kind: 'proactive', observation: 'done', detail: 'The worker finished.' } });
        expect([opening, update].some((message) => message.includes(USER_TURN_REMINDER))).toBe(false);
        expect(opening.endsWith('Nobody has spoken yet; speak first, in one short sentence.')).toBe(true);
    });
});

describe('tuiQuestionLine', () => {
    it('says what the TUI asks and the choices, so the voice agent need not read them off the screen', () => {
        expect(tuiQuestionLine({ method: 'select', title: 'Allow tool: bash', message: 'Reason: prompt\nCommand: rm -rf out', options: ['Approve', 'Deny'] })).toBe(
            'It asks for a choice: "Allow tool: bash" (Reason: prompt; Command: rm -rf out), options: Approve | Deny. The chat shows it as a card too.\n',
        );
        expect(tuiQuestionLine({ method: 'confirm', title: 'Delete the build folder?' })).toBe(
            'It asks for a yes or no: "Delete the build folder?". The chat shows it as a card too.\n',
        );
        expect(tuiQuestionLine({ method: 'input', title: 'Branch name' })).toBe('It asks for a line of text: "Branch name". The chat shows it as a card too.\n');
        expect(tuiQuestionLine(undefined)).toBe('');
    });
});

describe('turn message: boards', () => {
    const base: TurnInput = {
        trigger: { kind: 'user', text: 'why here?', source: 'text' },
        status: { phase: 'idle', queued: 0 },
        updates: [],
        requests: [],
        proposals: [],
        research: [],
    };

    it("shows the user's mark, saved edits and the board list", () => {
        const message = buildTurnMessage({
            ...base,
            board: { board: 'b1', title: 'Login "flow"', latest: true, mark: { block: 'c1', kind: 'code', startLine: 3, endLine: 5, text: 'refresh()' } },
            boardEdits: [{ board: 'b1', title: 'Login', summary: 'changed p2; added c3', outline: 'h1 heading "Login"\np2 paragraph "x"' }],
            boards: [
                { id: 'b1', title: 'Login', open: true, current: true },
                { id: 'b2', title: 'Cache', open: false, current: false },
            ],
        });
        expect(message).toContain(`<board board="b1" title="Login 'flow'" block="c1" kind="code" lines="3-5" latest="true">refresh()</board>`);
        expect(message).toContain('<board-edited board="b1" title="Login" changes="changed p2; added c3">\nh1 heading "Login"\np2 paragraph "x"\n</board-edited>');
        expect(message).toContain('<boards>\nb1 "Login" open current\nb2 "Cache"\n</boards>');
        const node = buildTurnMessage({ ...base, board: { board: 'b1', title: 'Login', latest: false, mark: { block: 'd1', kind: 'diagram', node: 'Token' } } });
        expect(node).toContain('<board board="b1" title="Login" block="d1" kind="diagram" node="Token"></board>');
        const arrow = buildTurnMessage({ ...base, board: { board: 'b1', title: 'Login', latest: false, mark: { block: 'd2', kind: 'diagram', message: 'show_me 写"内容"', step: 2 } } });
        expect(arrow).toContain(`<board board="b1" title="Login" block="d2" kind="diagram" step="2" message="show_me 写'内容'"></board>`);
        const element = buildTurnMessage({
            ...base,
            board: {
                board: 'b1',
                title: 'Stack',
                latest: true,
                mark: {
                    block: 'w1',
                    kind: 'web',
                    element: { selector: '#app > button.primary:nth-of-type(2)', tag: 'button', classes: ['primary', 'big'], text: 'Push "1"', html: '<button class="primary big">Push "1"</button>' },
                },
            },
        });
        expect(element).toContain(
            `<board board="b1" title="Stack" block="w1" kind="web" selector="#app > button.primary:nth-of-type(2)" tag="button" class="primary big" text="Push '1'" latest="true"><button class="primary big">Push "1"</button></board>`,
        );
    });

    it('says nothing about boards without any', () => {
        expect(buildTurnMessage({ ...base, boardEdits: [], boards: [] })).not.toContain('<board');
    });
});
