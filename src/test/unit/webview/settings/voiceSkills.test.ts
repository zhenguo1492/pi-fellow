// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsData, SkillInfo } from '../../../../shared/protocol';
import { settingsState } from '../../../../webview/settings/state';
import { bindVoiceSkills, renderVoiceSkills } from '../../../../webview/settings/voice';
import { buildVoiceTab } from '../../../../webview/settings/voiceSetup';

const posted = vi.hoisted((): unknown[] => []);
vi.mock('../../../../webview/settings/api', () => ({
    vscode: { postMessage: (message: unknown) => posted.push(message), getState: () => undefined, setState: () => {} },
}));

const skill = (name: string): SkillInfo => ({ name, description: `${name} description`, filePath: `/skills/${name}/SKILL.md`, source: 'skill', disableModelInvocation: false });

const data = {
    voice: { sttEngine: 'custom', sttUrl: '', sttModel: '', language: '', vadConfidence: 0.5, vadStopSecs: 0.8 },
    tts: { engine: 'custom', languageField: 'none', url: '', model: '', voice: '', speed: 1 },
    voiceReadiness: { stt: { ok: true }, tts: { ok: true } },
    voiceApiKeys: { openai: false, groq: false },
    voiceSkills: ['grill-with-docs'],
    voiceSpeakers: { user: { name: 'User', avatar: '' }, bot: { name: 'Bot', avatar: '' } },
} as unknown as SettingsData;

/** The Voice tab with the skills dropdown open and the filter focused, as clicking it leaves it. */
function openDropdown() {
    document.body.innerHTML = '';
    settingsState.currentSettings = structuredClone(data);
    settingsState.loadedSkills = [skill('grill-with-docs'), skill('grill-me'), skill('grilling')];
    document.body.append(buildVoiceTab(settingsState.currentSettings), Object.assign(document.createElement('button'), { id: 'outside' }));
    bindVoiceSkills();
    renderVoiceSkills();
    const picker = document.querySelector<HTMLDetailsElement>('.voice-skills-picker')!;
    picker.open = true;
    const filter = document.querySelector<HTMLInputElement>('.voice-skills-filter')!;
    filter.focus();
    const name = (skillName: string) => document.querySelector(`[data-voice-skill="${skillName}"] + .voice-skill-text .voice-skill-name`)!;
    return { picker, filter, name, outside: document.getElementById('outside')! };
}

describe('voice agent skills dropdown', () => {
    beforeEach(() => {
        posted.length = 0;
    });

    // Closing the <details> from a focusout that a mousedown inside it caused hangs Chromium's renderer
    // (the whole VS Code window when the webview shares its process). Focus leaving to nowhere is what a
    // mousedown on the skill's name or description does, so it must not close the dropdown.
    it('stays open when focus leaves to nowhere, as a click on a skill name makes it', () => {
        const { picker, filter } = openDropdown();
        filter.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
        expect(picker.open).toBe(true);
    });

    it('keeps focus in the dropdown when a skill name is pressed, and the click still ticks the skill', () => {
        const { picker, name } = openDropdown();
        const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        name('grill-me').dispatchEvent(press);
        expect(press.defaultPrevented).toBe(true);
        (name('grill-me') as HTMLElement).click();
        expect(posted).toEqual([{ type: 'updateSetting', key: 'voiceAgent.skills', value: ['grill-with-docs', 'grill-me'] }]);
        expect(picker.open).toBe(true);
    });

    it('closes on a press outside it, on focus moving to something outside, and on Escape', () => {
        let { picker, outside, filter } = openDropdown();
        outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        expect(picker.open).toBe(false);

        ({ picker, outside, filter } = openDropdown());
        filter.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
        expect(picker.open).toBe(false);

        ({ picker, filter } = openDropdown());
        filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(picker.open).toBe(false);
    });

    it('a press inside it, or a re-render that binds again, does not close it', () => {
        openDropdown();
        // A full render rebuilds the page and binds again: the old page's listeners must not act on the new one.
        const { picker, name } = openDropdown();
        name('grilling').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        expect(picker.open).toBe(true);
    });
});
