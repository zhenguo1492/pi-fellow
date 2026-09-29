// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsData } from '../../../../shared/protocol';
import { settingsState } from '../../../../webview/settings/state';
import { scrollToSettingsSection, switchSettingsTab } from '../../../../webview/settings/tabs';
import { readSttForm, readTtsForm } from '../../../../webview/settings/voice';
import { applyVoiceSaved, applyVoiceTestResult, bindVoiceSetup, buildVoiceTab, renderVoiceTab } from '../../../../webview/settings/voiceSetup';

const posted = vi.hoisted((): Array<{ type: string } & Record<string, unknown>> => []);
const webviewState = vi.hoisted((): { current: Record<string, unknown> | undefined } => ({ current: undefined }));
vi.mock('../../../../webview/settings/api', () => ({
    vscode: {
        postMessage: (message: { type: string }) => posted.push(message),
        getState: () => webviewState.current,
        setState: (state: Record<string, unknown>) => (webviewState.current = state),
    },
}));

/** Local servers for both parts, as saved. */
const data = {
    voice: { sttEngine: 'custom', sttUrl: 'http://127.0.0.1:8010/v1', sttModel: 'local-whisper', language: 'en', vadConfidence: 0.5, vadStopSecs: 0.8 },
    tts: { engine: 'custom', languageField: 'perSentence', url: 'http://127.0.0.1:8881/v1', model: 'm', voice: 'v', speed: 1 },
    voiceReadiness: { stt: { ok: true }, tts: { ok: true } },
    voiceApiKeys: { openai: false, groq: false },
    voiceSkills: [],
    voiceExtraPrompt: '',
    voiceDefaultPrompt: 'You are the voice agent.',
    voiceSpeakers: { user: { name: 'User', avatar: '' }, bot: { name: 'Bot', avatar: '' } },
    voiceprint: { enabled: false, threshold: 0.5, shortSpeech: 'stricter', denoise: false },
} as unknown as SettingsData;

function showTab(changes: (d: SettingsData) => void = () => {}): void {
    document.body.innerHTML = '';
    posted.length = 0;
    Object.assign(settingsState, {
        voiceSetup: undefined,
        voiceCloudProvider: undefined,
        voiceSaving: false,
        voiceSaveResult: undefined,
        voiceDirty: false,
        builtinVoice: undefined,
        activeTab: 'voice',
        voiceSubtab: 'engine',
    });
    settingsState.voiceDrafts.clear();
    delete settingsState.voiceTestResults.stt;
    settingsState.currentSettings = structuredClone(data);
    changes(settingsState.currentSettings);
    document.body.append(buildVoiceTab(settingsState.currentSettings));
    bindVoiceSetup();
    renderVoiceTab();
}

const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();
const selectedCard = () => document.querySelector<HTMLElement>('.voice-setup-card.selected')?.dataset.voiceSetupCard;
const shownPanels = () => [...document.querySelectorAll<HTMLElement>('[data-voice-setup-panel]')].filter((p) => !p.hidden).map((p) => p.dataset.voiceSetupPanel);
const saveState = () => document.getElementById('voice-save-state')!.textContent;
const text = (id: string) => document.getElementById(id)!.textContent ?? '';

describe('Voice tab setup cards', () => {
    beforeEach(() => showTab());

    it('selects the card the saved settings match', () => {
        expect([selectedCard(), shownPanels()]).toEqual(['own', ['own']]);

        showTab((d) => {
            d.voice.sttEngine = 'builtin';
            d.tts.engine = 'builtin';
        });
        expect(selectedCard()).toBe('builtin');
        // Its status is asked for once it shows.
        expect(posted).toContainEqual({ type: 'getBuiltinVoiceStatus' });

        // Groq speech-to-text with the built-in voice (as saved before Groq had a voice here) is still the Cloud card.
        showTab((d) => {
            d.voice.sttUrl = 'https://api.groq.com/openai/v1';
            d.tts.engine = 'builtin';
        });
        expect(selectedCard()).toBe('cloud');
        expect((document.getElementById('voice-cloud-provider') as HTMLSelectElement).value).toBe('groq');
    });

    it('fills the settings a card stands for as unsaved drafts, and Discard goes back', () => {
        click('[data-voice-setup-card="cloud"]');
        expect([selectedCard(), shownPanels()]).toEqual(['cloud', ['cloud']]);
        expect(readSttForm()).toMatchObject({ sttEngine: 'custom', sttUrl: 'https://api.openai.com/v1', sttModel: 'gpt-4o-mini-transcribe', language: 'en' });
        expect(readTtsForm()).toMatchObject({ engine: 'custom', url: 'https://api.openai.com/v1', voice: 'marin', languageField: 'none' });
        expect(saveState()).toBe('Unsaved changes');
        expect(document.querySelector<HTMLButtonElement>('[data-voice-save]')!.disabled).toBe(false);
        expect(posted).toContainEqual({ type: 'voiceDirty', dirty: true });
        expect(text('voice-cloud-status')).toContain('OpenAI needs an API key');

        const provider = document.getElementById('voice-cloud-provider') as HTMLSelectElement;
        provider.value = 'groq';
        provider.dispatchEvent(new Event('change'));
        expect(readSttForm().sttUrl).toBe('https://api.groq.com/openai/v1');
        expect(readTtsForm()).toMatchObject({ engine: 'custom', url: 'https://api.groq.com/openai/v1', model: 'canopylabs/orpheus-v1-english', voice: 'troy' });

        // Back to your own server: its saved addresses, not the cloud's.
        click('[data-voice-setup-card="own"]');
        expect(readSttForm()).toMatchObject({ sttEngine: 'custom', sttUrl: 'http://127.0.0.1:8010/v1', sttModel: 'local-whisper' });
        expect(readTtsForm()).toMatchObject({ engine: 'custom', url: 'http://127.0.0.1:8881/v1', languageField: 'perSentence', voice: 'v' });

        click('[data-voice-setup-card="builtin"]');
        expect([readSttForm().sttEngine, readTtsForm().engine, shownPanels()]).toEqual(['builtin', 'builtin', ['builtin']]);

        click('[data-voice-discard]');
        expect([selectedCard(), saveState(), settingsState.voiceDrafts.size]).toEqual(['own', 'All changes saved', 0]);
        expect(posted.at(-1)).toEqual({ type: 'voiceDirty', dirty: false });
    });

    it('brings your own servers back after a cloud setup was saved over them', () => {
        showTab((d) => {
            Object.assign(d.voice, { sttUrl: 'https://api.openai.com/v1', sttModel: 'gpt-4o-mini-transcribe' });
            Object.assign(d.tts, { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy', languageField: 'none' });
            d.voiceOwnServers = {
                stt: { 'voice.sttUrl': 'http://127.0.0.1:8010/v1', 'voice.sttModel': 'local-whisper' },
                tts: { 'voiceAgent.tts.url': 'http://127.0.0.1:8881/v1', 'voiceAgent.tts.model': 'm', 'voiceAgent.tts.voice': 'Justin.mp3', 'voiceAgent.tts.languageField': 'perSentence' },
            };
        });
        expect(selectedCard()).toBe('cloud');
        click('[data-voice-setup-card="own"]');
        expect(readSttForm()).toMatchObject({ sttEngine: 'custom', sttUrl: 'http://127.0.0.1:8010/v1', sttModel: 'local-whisper' });
        expect(readTtsForm()).toMatchObject({ engine: 'custom', url: 'http://127.0.0.1:8881/v1', model: 'm', voice: 'Justin.mp3', languageField: 'perSentence' });
    });

    it("picks the cloud voice from the provider's voices, and keeps one set before", () => {
        click('[data-voice-setup-card="cloud"]');
        const voice = document.getElementById('voice-cloud-voice') as HTMLSelectElement;
        const row = document.getElementById('voice-cloud-voice-row')!;
        expect([row.hidden, voice.value, voice.options.length]).toEqual([false, 'marin', 13]);

        voice.value = 'coral';
        voice.dispatchEvent(new Event('change'));
        expect([readTtsForm().voice, saveState()]).toEqual(['coral', 'Unsaved changes']);

        // Groq's own voices replace OpenAI's.
        const provider = document.getElementById('voice-cloud-provider') as HTMLSelectElement;
        provider.value = 'groq';
        provider.dispatchEvent(new Event('change'));
        expect([row.hidden, voice.value, [...voice.options].map((o) => o.value)]).toEqual([false, 'troy', ['troy', 'austin', 'daniel', 'autumn', 'diana', 'hannah']]);

        // A voice saved before that is not in the list stays pickable.
        showTab((d) => {
            Object.assign(d.tts, { url: 'https://api.openai.com/v1', voice: 'my-voice' });
            Object.assign(d.voice, { sttUrl: 'https://api.openai.com/v1' });
        });
        expect([voice.isConnected, (document.getElementById('voice-cloud-voice') as HTMLSelectElement).value]).toEqual([false, 'my-voice']);
    });

    it('Save & test sends the form with the pasted key; the answer clears the drafts and shows the plain result', () => {
        click('[data-voice-setup-card="cloud"]');
        const key = document.getElementById('voice-cloud-key') as HTMLInputElement;
        key.value = 'sk-test';
        key.dispatchEvent(new Event('input'));
        click('[data-voice-save-test]');
        expect(posted.at(-1)).toMatchObject({
            type: 'saveVoice',
            test: true,
            apiKeys: { openai: 'sk-test' },
            stt: { sttUrl: 'https://api.openai.com/v1' },
            tts: { url: 'https://api.openai.com/v1' },
        });
        expect([saveState(), text('voice-cloud-status')]).toEqual(['Saving…', 'Saving and testing…']);

        const message = "Saved, but speech-to-text isn't working: The speech-to-text service rejected the API key.";
        applyVoiceSaved({ type: 'voiceSaved', saved: true, ok: false, message, tests: { stt: { ok: false, message: 'rejected' } } });
        expect(text('voice-cloud-status')).toBe(message);
        expect(document.getElementById('voice-cloud-status')!.dataset.state).toBe('error');
        expect([saveState(), key.value]).toEqual(['All changes saved', '']);
    });

    it("shows whether the picked provider's own key is saved, and a pasted key does not follow a provider change", () => {
        showTab((d) => {
            d.voiceApiKeys = { openai: false, groq: true };
        });
        click('[data-voice-setup-card="cloud"]');
        const remove = document.querySelector<HTMLButtonElement>('[data-voice-key-remove]')!;
        expect([text('voice-cloud-key-state'), remove.hidden]).toEqual(['No OpenAI key saved yet.', true]);

        const key = document.getElementById('voice-cloud-key') as HTMLInputElement;
        key.value = 'sk-openai';
        key.dispatchEvent(new Event('input'));
        expect(text('voice-cloud-key-state')).toBe('OpenAI key not saved yet: Save & test keeps it.');

        const provider = document.getElementById('voice-cloud-provider') as HTMLSelectElement;
        provider.value = 'groq';
        provider.dispatchEvent(new Event('change'));
        expect([key.value, text('voice-cloud-key-state'), remove.hidden, remove.textContent]).toEqual(['', '✓ Groq key saved.', false, 'Remove Groq key']);

        click('[data-voice-key-remove]');
        expect(posted.at(-1)).toEqual({ type: 'removeVoiceApiKey', provider: 'groq' });
        click('[data-voice-save]');
        expect(posted.at(-1)).toMatchObject({ type: 'saveVoice', apiKeys: {} });
    });

    it('a section Test only tests: nothing is saved and its result shows while the values are the same', () => {
        const url = document.getElementById('setting-voice.sttUrl') as HTMLInputElement;
        url.value = 'http://127.0.0.1:8019/v1';
        url.dispatchEvent(new Event('input'));
        click('[data-voice-test="stt"]');
        expect(posted.map((m) => m.type)).not.toContain('saveVoice');
        expect(posted.at(-1)).toMatchObject({ type: 'testStt', settings: { sttUrl: 'http://127.0.0.1:8019/v1' } });

        applyVoiceTestResult({ type: 'voiceTestResult', service: 'stt', ok: false, message: "The speech-to-text service isn't running at 127.0.0.1:8019.", check: { ok: true } });
        expect(text('voice-status-stt')).toBe("The speech-to-text service isn't running at 127.0.0.1:8019. (not saved yet)");
        expect(saveState()).toBe('Unsaved changes');

        url.value = 'http://127.0.0.1:8010/v1';
        url.dispatchEvent(new Event('input'));
        expect(text('voice-status-stt')).toBe('Connected.');
    });

    it('your own server needs only addresses: no engine or key fields, and an empty URL means Built-in for that part', () => {
        const own = document.querySelector('[data-voice-setup-panel="own"]')!;
        expect(own.querySelectorAll('select[id$="Engine"], select[id$=".engine"], input[type="password"]')).toHaveLength(0);

        const url = document.getElementById('setting-voiceAgent.tts.url') as HTMLInputElement;
        url.value = '';
        url.dispatchEvent(new Event('input'));
        expect([readSttForm().sttEngine, readTtsForm().engine, selectedCard()]).toEqual(['custom', 'builtin', 'own']);
        // Testing it would download the built-in models: asks for the URL instead.
        posted.length = 0;
        click('[data-voice-test="tts"]');
        expect(posted).toEqual([]);
        expect(text('voice-status-tts')).toContain('Enter the URL of your server first');

        url.value = 'http://127.0.0.1:8880/v1';
        url.dispatchEvent(new Event('input'));
        expect(readTtsForm().engine).toBe('custom');
    });

    it('fills in the model the server offered at Test, as an unsaved change', () => {
        const model = document.getElementById('setting-voice.sttModel') as HTMLInputElement;
        model.value = '';
        model.dispatchEvent(new Event('input'));
        click('[data-voice-test="stt"]');
        applyVoiceTestResult({
            type: 'voiceTestResult',
            service: 'stt',
            ok: true,
            message: 'Connected. Found model "Systran/faster-whisper-large-v3" and filled it in.',
            check: { ok: true },
            models: ['Systran/faster-whisper-large-v3'],
            detectedModel: 'Systran/faster-whisper-large-v3',
        });
        expect(model.value).toBe('Systran/faster-whisper-large-v3');
        expect(text('voice-status-stt')).toContain('Found model "Systran/faster-whisper-large-v3"');
        expect(saveState()).toBe('Unsaved changes');

        // Edited while the Test ran: what the user typed stays.
        click('[data-voice-test="stt"]');
        model.value = 'mine';
        model.dispatchEvent(new Event('input'));
        applyVoiceTestResult({ type: 'voiceTestResult', service: 'stt', ok: true, message: 'Connected.', check: { ok: true }, models: ['x'], detectedModel: 'x' });
        expect(model.value).toBe('mine');
    });

    it('warns when leaving the tab with unsaved changes', () => {
        click('[data-voice-setup-card="builtin"]');
        switchSettingsTab('general', false);
        expect(document.getElementById('toast')?.textContent).toContain('unsaved changes');
    });
});

describe('Voice sub-tabs', () => {
    beforeEach(() => showTab());

    const tab = (id: string) => document.getElementById(`voice-subtab-${id}`)!;
    const shownSubpanels = () => [...document.querySelectorAll<HTMLElement>('[data-voice-subpanel]')].filter((p) => !p.hidden).map((p) => p.dataset.voiceSubpanel);
    const saveBarShown = () => !document.querySelector<HTMLElement>('.voice-save-bar')!.hidden;
    const dots = () => ['engine', 'listening', 'agent'].filter((id) => !tab(id).querySelector<HTMLElement>('.voice-subtab-dot')!.hidden);
    const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

    it('shows one panel at a time; arrows, Home and End move the selection and focus; Save shows only where drafts live', () => {
        expect([shownSubpanels(), saveBarShown()]).toEqual([['engine'], true]);
        tab('engine').focus();
        press('ArrowRight');
        expect([shownSubpanels(), saveBarShown(), document.activeElement?.id]).toEqual([['listening'], true, 'voice-subtab-listening']);
        expect([tab('listening').getAttribute('aria-selected'), tab('listening').tabIndex, tab('engine').tabIndex]).toEqual(['true', 0, -1]);
        press('ArrowRight');
        expect([shownSubpanels(), saveBarShown()]).toEqual([['agent'], false]);
        press('ArrowRight');
        expect(shownSubpanels()).toEqual(['engine']);
        press('ArrowLeft');
        expect([shownSubpanels(), document.activeElement?.id]).toEqual([['agent'], 'voice-subtab-agent']);
        press('Home');
        expect(shownSubpanels()).toEqual(['engine']);
        press('End');
        expect(shownSubpanels()).toEqual(['agent']);
    });

    it('keeps the chosen sub-tab across a rebuild, and hidden panels keep working', () => {
        tab('agent').click();
        expect(webviewState.current?.voiceSubtab).toBe('agent');
        document.body.replaceChildren(buildVoiceTab(settingsState.currentSettings!));
        bindVoiceSetup();
        renderVoiceTab();
        expect([shownSubpanels(), tab('agent').getAttribute('aria-selected')]).toEqual([['agent'], 'true']);

        // The setup cards are hidden but bound: a click still drafts, and the dot says so.
        click('[data-voice-setup-card="builtin"]');
        expect([saveState(), dots()]).toEqual(['Unsaved changes', ['engine']]);
    });

    it('puts the unsaved dot on the sub-tab whose fields have drafts', () => {
        const speed = document.getElementById('setting-voiceAgent.tts.speed') as HTMLInputElement;
        speed.value = '1.5';
        speed.dispatchEvent(new Event('input'));
        expect([saveState(), dots()]).toEqual(['Unsaved changes', ['listening']]);

        click('[data-voice-setup-card="builtin"]');
        expect(dots()).toEqual(['engine', 'listening']);

        speed.value = '1';
        speed.dispatchEvent(new Event('input'));
        expect(dots()).toEqual(['engine']);

        click('[data-voice-discard]');
        expect(dots()).toEqual([]);
    });

    it('a deep link to a section opens the sub-tab that holds it', () => {
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
            cb(0);
            return 0;
        });
        Element.prototype.scrollIntoView = vi.fn();
        const opens = (section: string) => {
            scrollToSettingsSection(section);
            return shownSubpanels()[0];
        };
        expect(opens('voiceprint')).toBe('listening');
        expect(opens('voice-agent')).toBe('agent');
        expect(opens('voice')).toBe('engine');
        expect(opens('voice-listening')).toBe('listening');
        expect(opens('tts')).toBe('engine');
        expect(document.getElementById('section-tts')!.classList.contains('section-highlight')).toBe(true);
    });
});
