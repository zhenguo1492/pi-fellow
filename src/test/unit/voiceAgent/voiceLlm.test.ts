import { describe, expect, it, vi } from 'vitest';
import { voiceLlmArgs } from '../../../voiceAgent/voiceLlm';

// Hoisted above the import: the CLI lookup and RPC bridge read VS Code; only the command line is under test.
vi.mock('../../../pi/piCliPaths', () => ({}));
vi.mock('../../../pi/piRpcBridge', () => ({}));

const base = {
    sessionDir: '/tmp/voice',
    systemPrompt: 'You are the voice agent.',
    thinking: 'off',
    tools: [{ name: 'tell_worker', label: 'Tell worker', description: '', parameters: {} }],
};
const chosen = [
    { name: 'voice-notes', filePath: '/skills/voice-notes/SKILL.md' },
    { name: 'standup', filePath: '/skills/standup/SKILL.md' },
];

/** The value of each `name value` or `name=value` in `args`. */
function flag(args: string[], name: string): string[] {
    return args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []));
}

describe('voiceLlmArgs: skills', () => {
    it('loads no skills on either backend when none are chosen', () => {
        for (const backend of ['omp', 'pi'] as const) {
            const args = voiceLlmArgs(backend, { ...base, skills: [] });
            expect(args).toContain('--no-skills');
            expect([flag(args, '--skills'), flag(args, '--skill')]).toEqual([[], []]);
        }
    });

    it('omp: filters discovery to the chosen names instead of turning skills off', () => {
        const args = voiceLlmArgs('omp', { ...base, skills: chosen });
        expect(args).not.toContain('--no-skills');
        expect(flag(args, '--skills')).toEqual(['voice-notes,standup']);
        expect(flag(args, '--skill')).toEqual([]);
    });

    it('pi: keeps discovery off and loads each chosen file, skipping one whose file is unknown', () => {
        const args = voiceLlmArgs('pi', { ...base, skills: [...chosen, { name: 'elsewhere' }] });
        expect(args).toContain('--no-skills');
        expect(flag(args, '--skill')).toEqual(['/skills/voice-notes/SKILL.md', '/skills/standup/SKILL.md']);
        expect(flag(args, '--skills')).toEqual([]);
    });

    it('omp: adds the built-ins\' plugin folder once, and filters discovery to built-ins and chosen alike', () => {
        const builtins = [
            { name: 'show-me', filePath: '/ext/media/voiceAgent/skills/show-me/SKILL.md', pluginDir: '/ext/media/voiceAgent' },
            { name: 'grilling', filePath: '/ext/media/voiceAgent/skills/grilling/SKILL.md', pluginDir: '/ext/media/voiceAgent' },
        ];
        const omp = voiceLlmArgs('omp', { ...base, skills: [...builtins, ...chosen] });
        expect(omp).not.toContain('--no-skills');
        expect(flag(omp, '--plugin-dir')).toEqual(['/ext/media/voiceAgent']);
        expect(flag(omp, '--skills')).toEqual(['show-me,grilling,voice-notes,standup']);

        const pi = voiceLlmArgs('pi', { ...base, skills: [...builtins, ...chosen] });
        expect(flag(pi, '--plugin-dir')).toEqual([]);
        expect(flag(pi, '--skill')).toEqual([...builtins, ...chosen].map((skill) => skill.filePath));
    });

    it('keeps the rest of the command line whatever the skills', () => {
        for (const backend of ['omp', 'pi'] as const) {
            const withSkills = voiceLlmArgs(backend, { ...base, model: 'anthropic/claude', skills: chosen });
            const withoutSkills = voiceLlmArgs(backend, { ...base, model: 'anthropic/claude', skills: [] });
            const rest = (args: string[]) => args.filter((arg, i) => !/^--(no-)?skills?(=|$)/.test(arg) && args[i - 1] !== '--skill');
            expect(rest(withSkills)).toEqual(rest(withoutSkills));
            expect(flag(withSkills, '--model')).toEqual(['anthropic/claude']);
            expect(flag(withSkills, '--system-prompt')).toEqual([base.systemPrompt]);
        }
    });
});
