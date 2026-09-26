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
