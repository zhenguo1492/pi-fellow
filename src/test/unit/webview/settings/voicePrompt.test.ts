// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsData } from '../../../../shared/protocol';
import { settingsState } from '../../../../webview/settings/state';
import { bindVoicePrompt } from '../../../../webview/settings/voicePrompt';
import { buildVoiceTab } from '../../../../webview/settings/voiceSetup';

const posted = vi.hoisted((): unknown[] => []);
vi.mock('../../../../webview/settings/api', () => ({
    vscode: { postMessage: (message: unknown) => posted.push(message), getState: () => undefined, setState: () => {} },
}));

const data = {
    voice: { sttEngine: 'custom', sttUrl: '', sttModel: '', language: '', vadConfidence: 0.5, vadStopSecs: 0.8 },
    tts: { engine: 'custom', languageField: 'none', url: '', model: '', voice: '', speed: 1 },
    voiceReadiness: { stt: { ok: true }, tts: { ok: true } },
    voiceApiKeys: { openai: false, groq: false },
    voiceSkills: [],
    voiceExtraPrompt: '',
    voiceDefaultPrompt: 'The editor arrives in <editor> on every message.\n\n```ts\nconst a = 1 < 2;\n```',
    voiceSpeakers: { user: { name: 'User', avatar: '' }, bot: { name: 'Bot', avatar: '' } },
    voiceprint: { enabled: false, threshold: 0.5, shortSpeech: 'stricter', denoise: false },
} as unknown as SettingsData;

/** A full page render, as a settings message from the host makes. */
function render(extraPrompt: string) {
    document.body.innerHTML = '';
    settingsState.currentSettings = { ...structuredClone(data), voiceExtraPrompt: extraPrompt };
    document.body.append(buildVoiceTab(settingsState.currentSettings), Object.assign(document.createElement('button'), { id: 'outside' }));
    bindVoicePrompt();
}

const toggle = () => document.querySelector<HTMLButtonElement>('[data-voice-extra-prompt-toggle]')!;
const textarea = () => document.querySelector<HTMLTextAreaElement>('#voice-extra-prompt-input');
const view = () => document.querySelector<HTMLElement>('.voice-extra-prompt .voice-prompt-markdown');

describe('voice agent extra prompt', () => {
    beforeEach(() => {
        posted.length = 0;
        settingsState.voiceExtraPromptDraft = undefined;
        settingsState.voiceDefaultPromptOpen = false;
    });

    it('shows a hint when empty, and saves what is typed once, on leaving the field', () => {
        render('');
        expect(document.querySelector('.voice-extra-prompt-empty')?.textContent).toContain('No extra instructions');
        toggle().click();
        const input = textarea()!;
        expect([input.value, document.activeElement]).toEqual(['', input]);
        input.value = 'Call me **Captain**.';
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('blur'));
        toggle().click();

        expect(posted).toEqual([{ type: 'updateSetting', key: 'voiceAgent.extraPrompt', value: 'Call me **Captain**.' }]);
        expect(textarea()).toBeNull();
        expect(view()?.innerHTML).toContain('<strong>Captain</strong>');
    });

    it('keeps the text being edited across a page render, and saves it on View', () => {
        render('Be brief.');
        toggle().click();
        textarea()!.value = 'Be brief. <b>Really</b>.';
        textarea()!.dispatchEvent(new Event('input'));
        render('Be brief.');
        expect(textarea()?.value).toBe('Be brief. <b>Really</b>.');

        toggle().click();
        expect(posted).toEqual([{ type: 'updateSetting', key: 'voiceAgent.extraPrompt', value: 'Be brief. <b>Really</b>.' }]);
        // Written for the model: tags show as text.
        expect(view()?.querySelector('b')).toBeNull();
        expect(view()?.textContent).toContain('<b>Really</b>');
    });
});

describe('voice agent default prompt', () => {
    it('is collapsed, and shows the prompt as Markdown with its tags as text once opened, open across renders', () => {
        render('');
        const details = () => document.querySelector<HTMLDetailsElement>('.voice-default-prompt-details')!;
        const content = () => details().querySelector('.voice-prompt-markdown')!;
        expect([details().open, content().innerHTML]).toEqual([false, '']);

        details().open = true;
        details().dispatchEvent(new Event('toggle'));
        expect(content().textContent).toContain('The editor arrives in <editor> on every message.');
        expect(content().querySelector('.code-block-code')?.textContent).toBe('const a = 1 < 2;');

        render('');
        expect([details().open, content().textContent]).toEqual([true, expect.stringContaining('<editor>')]);
    });
});
