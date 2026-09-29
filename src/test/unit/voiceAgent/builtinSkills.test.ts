import * as fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_VOICE_SKILLS } from '../../../shared/builtinVoiceSkills';
import type { SkillInfo } from '../../../shared/protocol';
import { builtinVoiceSkills, resolveVoiceSkills } from '../../../voiceAgent/builtinSkills';

const builtins = builtinVoiceSkills('/ext');

function installed(...names: string[]): SkillInfo[] {
    return names.map((name) => ({ name, description: '', filePath: `/skills/${name}/SKILL.md`, source: 'skill', disableModelInvocation: false }));
}

describe('builtinVoiceSkills', () => {
    it('points at the SKILL.md files shipped in media/, each named as listed, invocable by the model and licensed', () => {
        const shipped = builtinVoiceSkills(process.cwd());
        expect(shipped.map((skill) => skill.name)).toEqual(BUILTIN_VOICE_SKILLS);
        for (const skill of shipped) {
            const text = fs.readFileSync(skill.filePath!, 'utf8');
            const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
            expect(frontmatter).toContain(`name: ${skill.name}\n`);
            expect(frontmatter).toMatch(/^description: \S/m);
            expect(frontmatter).not.toMatch(/disable-model-invocation|^hide:/m);
            expect(fs.existsSync(`${skill.pluginDir}/skills/${skill.name}/LICENSE`)).toBe(true);
        }
    });
});

describe('resolveVoiceSkills', () => {
    it('loads the built-ins alone when nothing else is chosen, without asking for the installed skills', async () => {
        const list = vi.fn(async () => installed('tdd'));
        expect(await resolveVoiceSkills(builtins, [], list, () => {})).toEqual(builtins);
        expect(await resolveVoiceSkills(builtins, ['show-me'], list, () => {})).toEqual(builtins);
        expect(list).not.toHaveBeenCalled();
    });

    it('adds the chosen installed skills after the built-ins, once each, the built-in copy winning a shared name', async () => {
        const log = vi.fn();
        const skills = await resolveVoiceSkills(builtins, ['tdd', 'grilling', 'tdd'], async () => installed('grilling', 'tdd'), log);
        expect(skills).toEqual([...builtins, { name: 'tdd', filePath: '/skills/tdd/SKILL.md' }]);
        expect(log).not.toHaveBeenCalled();
    });

    it('logs and leaves out chosen skills that are not installed', async () => {
        const log = vi.fn();
        const skills = await resolveVoiceSkills(builtins, ['tdd', 'gone'], async () => installed('tdd'), log);
        expect(skills.map((skill) => skill.name)).toEqual([...BUILTIN_VOICE_SKILLS, 'tdd']);
        expect(log).toHaveBeenCalledWith('Voice skills not installed, not loaded: gone.');
    });

    it('passes the chosen names without files when the installed list cannot be read', async () => {
        const skills = await resolveVoiceSkills(builtins, ['tdd'], async () => undefined, () => {});
        expect(skills).toEqual([...builtins, { name: 'tdd' }]);
    });
});
