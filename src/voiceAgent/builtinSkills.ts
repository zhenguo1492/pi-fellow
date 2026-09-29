import * as path from 'node:path';
import { BUILTIN_VOICE_SKILLS } from '../shared/builtinVoiceSkills';
import type { SkillInfo } from '../shared/protocol';
import type { VoiceSkill } from './voiceLlm';

/**
 * The built-in skills of the extension installed at `extensionPath`. Their folder is laid out as an
 * omp plugin (`skills/<name>/SKILL.md`), so omp loads them with `--plugin-dir`; pi takes the files.
 */
export function builtinVoiceSkills(extensionPath: string): VoiceSkill[] {
    const pluginDir = path.join(extensionPath, 'media', 'voiceAgent');
    return BUILTIN_VOICE_SKILLS.map((name) => ({ name, filePath: path.join(pluginDir, 'skills', name, 'SKILL.md'), pluginDir }));
}

/**
 * The skills the voice agent loads: the built-ins, then the chosen names (`voiceAgent.skills`) found
 * among the installed skills. A chosen name that is a built-in is not loaded twice: the built-in copy,
 * written for speech, is the one passed. `installed` is only asked when something else is chosen, and
 * gives undefined when the list could not be read: then the names go as they are, which omp still
 * finds, while pi, which needs their files, loads none of them.
 */
export async function resolveVoiceSkills(
    builtins: readonly VoiceSkill[],
    chosenNames: readonly string[],
    installed: () => Promise<readonly SkillInfo[] | undefined>,
    log: (line: string) => void,
): Promise<VoiceSkill[]> {
    const names = [...new Set(chosenNames)].filter((name) => !builtins.some((skill) => skill.name === name));
    if (names.length === 0) {
        return [...builtins];
    }
    const list = await installed();
    if (!list) {
        return [...builtins, ...names.map((name) => ({ name }))];
    }
    const chosen = list.filter((skill) => names.includes(skill.name));
    const missing = names.filter((name) => !chosen.some((skill) => skill.name === name));
    if (missing.length > 0) {
        log(`Voice skills not installed, not loaded: ${missing.join(', ')}.`);
    }
    return [...builtins, ...chosen.map((skill) => ({ name: skill.name, filePath: skill.filePath || undefined }))];
}
