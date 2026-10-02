// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsData } from '../../../../shared/protocol';
import { applySavedSettings } from '../../../../webview/settings/edits';
import { render } from '../../../../webview/settings/render';
import { settingsState } from '../../../../webview/settings/state';
import { scrollToSettingsSection, switchSettingsTab } from '../../../../webview/settings/tabs';
import { readSttForm, readTtsForm } from '../../../../webview/settings/voice';
import { applyBuiltinVoiceStatus, applyVoiceSaved, applyVoiceTestResult } from '../../../../webview/settings/voiceSetup';

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
    backend: 'pi',
    availableBackends: ['pi'],
    extensionVersion: '1.0.0',
    syncWithPiCli: false,
    piAgentDir: '~/.pi/agent',
    authMethod: 'none',
    defaultPermissionLevel: 'ask',
    allowedTools: [],
    contextUsageWarningThreshold: 80,
    voiceMessageButtons: false,
    voiceTranslateTo: 'zh',
    voice: { sttEngine: 'custom', sttUrl: 'http://127.0.0.1:8010/v1', sttModel: 'local-whisper', language: 'en', vadConfidence: 0.5, vadStopSecs: 0.8 },
    tts: { engine: 'custom', languageField: 'perSentence', url: 'http://127.0.0.1:8881/v1', model: 'm', voice: 'v', speed: 1 },
    voiceReadiness: { stt: { ok: true }, tts: { ok: true } },
    voiceApiKeys: { openai: false, groq: false },
    voiceSkills: [],
    voiceModel: '',
    voiceModels: [],
    voiceExtraPrompt: '',
    voiceDefaultPrompt: 'You are the voice agent.',
    voiceSpeakers: { user: { name: 'User', avatar: '' }, bot: { name: 'Bot', avatar: '' } },
    voiceprint: { enabled: false, threshold: 0.5, shortSpeech: 'stricter', denoise: false },
} as unknown as SettingsData;

/** The settings page as the host's settings render it, on the Voice tab. */
function showTab(changes: (d: SettingsData) => void = () => {}): void {
    document.body.innerHTML = '<div id="settings-app"></div>';
    // jsdom has no scrolling; the page keeps its scroll position across renders.
    window.scrollTo = () => {};
    posted.length = 0;
    Object.assign(settingsState, {
        voiceSetup: {},
        voiceCloudProvider: {},
        voiceSaving: false,
        voiceSaveResult: undefined,
        editsSaving: false,
        builtinVoice: {},
        activeTab: 'voice',
        voiceSubtab: 'stt',
    });
    settingsState.edits.clear();
    settingsState.voiceDrafts.clear();
    delete settingsState.voiceTestResults.stt;
    const saved = structuredClone(data);
    changes(saved);
    applySavedSettings(saved);
    render();
}

type Service = 'stt' | 'tts';
const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();
const pick = (service: Service, setup: string) => click(`[data-voice-service="${service}"][data-voice-setup-card="${setup}"]`);
const selectedCard = (service: Service) =>
    document.querySelector<HTMLElement>(`.voice-setup-card.selected[data-voice-service="${service}"]`)?.dataset.voiceSetupCard;
const shownPanels = (service: Service) =>
    [...document.querySelectorAll<HTMLElement>(`[data-voice-setup-panel][data-voice-service="${service}"]`)].filter((p) => !p.hidden).map((p) => p.dataset.voiceSetupPanel);
const saveState = () => document.getElementById('settings-save-state')!.textContent;
const text = (id: string) => document.getElementById(id)!.textContent ?? '';
const field = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as unknown as T;
function setValue(id: string, value: string, event = 'input'): void {
    const input = field<HTMLInputElement | HTMLSelectElement>(id);
    input.value = value;
    input.dispatchEvent(new Event(event));
}

describe('Voice tab: an engine per service', () => {
    beforeEach(() => showTab());

    it("selects each service's card from its own saved settings", () => {
        expect([selectedCard('stt'), shownPanels('stt'), selectedCard('tts'), shownPanels('tts')]).toEqual(['own', ['own'], 'own', ['own']]);

        // Groq speech-to-text with the built-in voice: each service shows its own choice.
        showTab((d) => {
            d.voice.sttUrl = 'https://api.groq.com/openai/v1';
            d.tts.engine = 'builtin';
        });
        expect([selectedCard('stt'), field<HTMLSelectElement>('voice-cloud-provider-stt').value, selectedCard('tts')]).toEqual(['cloud', 'groq', 'builtin']);
        // Only the built-in service's download is asked about.
        expect(posted).toContainEqual({ type: 'getBuiltinVoiceStatus', service: 'tts' });
        expect(posted).not.toContainEqual({ type: 'getBuiltinVoiceStatus', service: 'stt' });
    });

    it("a card fills only its service's settings as unsaved drafts, and Discard goes back", () => {
        pick('stt', 'cloud');
        expect([selectedCard('stt'), shownPanels('stt'), selectedCard('tts')]).toEqual(['cloud', ['cloud'], 'own']);
        expect(readSttForm()).toMatchObject({ sttEngine: 'custom', sttUrl: 'https://api.openai.com/v1', sttModel: 'gpt-4o-mini-transcribe', language: 'en' });
        expect(readTtsForm()).toEqual(data.tts);
        expect(saveState()).toBe('Unsaved changes');
        expect(posted).toContainEqual({ type: 'settingsDirty', dirty: true });
        expect(text('voice-cloud-status-stt')).toContain('OpenAI needs an API key');

        setValue('voice-cloud-provider-stt', 'groq', 'change');
        expect(readSttForm().sttUrl).toBe('https://api.groq.com/openai/v1');
        expect(readTtsForm()).toEqual(data.tts);

        pick('tts', 'cloud');
        expect(readTtsForm()).toMatchObject({ engine: 'custom', url: 'https://api.openai.com/v1', voice: 'marin', languageField: 'none' });
        expect(readSttForm().sttUrl).toBe('https://api.groq.com/openai/v1');

        // Back to your own server: its saved addresses, not the cloud's.
        pick('stt', 'own');
        expect(readSttForm()).toMatchObject({ sttEngine: 'custom', sttUrl: 'http://127.0.0.1:8010/v1', sttModel: 'local-whisper' });
        expect(readTtsForm().url).toBe('https://api.openai.com/v1');

        pick('tts', 'builtin');
        expect([readSttForm().sttEngine, readTtsForm().engine, shownPanels('tts')]).toEqual(['custom', 'builtin', ['builtin']]);

        click('[data-settings-discard]');
        expect([selectedCard('stt'), selectedCard('tts'), saveState(), settingsState.voiceDrafts.size]).toEqual(['own', 'own', 'All changes saved', 0]);
        expect(posted.at(-1)).toEqual({ type: 'settingsDirty', dirty: false });
    });

    it('brings your own server back after a cloud setup was saved over it', () => {
        showTab((d) => {
            Object.assign(d.voice, { sttUrl: 'https://api.openai.com/v1', sttModel: 'gpt-4o-mini-transcribe' });
            Object.assign(d.tts, { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy', languageField: 'none' });
            d.voiceOwnServers = {
                stt: { 'voice.sttUrl': 'http://127.0.0.1:8010/v1', 'voice.sttModel': 'local-whisper' },
                tts: { 'voiceAgent.tts.url': 'http://127.0.0.1:8881/v1', 'voiceAgent.tts.model': 'm', 'voiceAgent.tts.voice': 'Justin.mp3', 'voiceAgent.tts.languageField': 'perSentence' },
            };
        });
        expect([selectedCard('stt'), selectedCard('tts')]).toEqual(['cloud', 'cloud']);
        pick('tts', 'own');
        expect(readTtsForm()).toMatchObject({ engine: 'custom', url: 'http://127.0.0.1:8881/v1', model: 'm', voice: 'Justin.mp3', languageField: 'perSentence' });
        expect(readSttForm().sttUrl).toBe('https://api.openai.com/v1');
        pick('stt', 'own');
        expect(readSttForm()).toMatchObject({ sttEngine: 'custom', sttUrl: 'http://127.0.0.1:8010/v1', sttModel: 'local-whisper' });
    });

    it("picks the cloud voice from the provider's voices, and keeps one set before", () => {
        pick('tts', 'cloud');
        const voice = field<HTMLSelectElement>('voice-cloud-voice');
        const row = document.getElementById('voice-cloud-voice-row')!;
        expect([row.hidden, voice.value, voice.options.length]).toEqual([false, 'marin', 13]);

        voice.value = 'coral';
        voice.dispatchEvent(new Event('change'));
        expect([readTtsForm().voice, saveState()]).toEqual(['coral', 'Unsaved changes']);

        // Groq's own voices replace OpenAI's.
        setValue('voice-cloud-provider-tts', 'groq', 'change');
        expect([row.hidden, voice.value, [...voice.options].map((o) => o.value)]).toEqual([false, 'troy', ['troy', 'austin', 'daniel', 'autumn', 'diana', 'hannah']]);
        expect(text('voice-cloud-note-tts')).toContain('Groq speaks English only');

        // A voice saved before that is not in the list stays pickable.
        showTab((d) => {
            Object.assign(d.tts, { url: 'https://api.openai.com/v1', voice: 'my-voice' });
        });
        expect([voice.isConnected, field<HTMLSelectElement>('voice-cloud-voice').value]).toEqual([false, 'my-voice']);
    });

    it('Save on a Cloud card sends both forms with the pasted keys and tests; the answer clears the drafts and shows the plain result', () => {
        pick('stt', 'cloud');
        setValue('voice-cloud-provider-stt', 'groq', 'change');
        setValue('voice-cloud-key-stt', 'gsk-test');
        pick('tts', 'cloud');
        setValue('voice-cloud-key-tts', 'sk-test');
        click('[data-settings-save]');
        expect(posted.at(-1)).toMatchObject({
            type: 'saveVoice',
            test: true,
            apiKeys: { groq: 'gsk-test', openai: 'sk-test' },
            stt: { sttUrl: 'https://api.groq.com/openai/v1' },
            tts: { url: 'https://api.openai.com/v1' },
        });
        expect([saveState(), text('voice-cloud-status-stt'), text('voice-cloud-status-tts')]).toEqual(['Saving…', 'Saving and testing…', 'Saving and testing…']);

        const message = "Saved, but speech-to-text isn't working: The speech-to-text service rejected the API key.";
        applyVoiceSaved({ type: 'voiceSaved', saved: true, ok: false, message, tests: { stt: { ok: false, message: 'rejected' } } });
        expect(text('voice-cloud-status-stt')).toBe(message);
        expect(document.getElementById('voice-cloud-status-stt')!.dataset.state).toBe('error');
        expect([saveState(), field('voice-cloud-key-stt').value, field('voice-cloud-key-tts').value]).toEqual(['All changes saved', '', '']);
    });

    it('one key per provider: a key pasted on one service shows on the other when both use that provider', () => {
        pick('stt', 'cloud');
        pick('tts', 'cloud');
        setValue('voice-cloud-key-stt', 'sk-shared');
        expect([field('voice-cloud-key-tts').value, text('voice-cloud-key-state-tts')]).toEqual(['sk-shared', 'OpenAI key not saved yet: Save keeps it.']);

        // Another provider: its own key, not OpenAI's.
        setValue('voice-cloud-provider-tts', 'groq', 'change');
        expect([field('voice-cloud-key-tts').value, field('voice-cloud-key-stt').value]).toEqual(['', 'sk-shared']);
        // Back to OpenAI: the key pasted for it on Speech-to-text again.
        setValue('voice-cloud-provider-tts', 'openai', 'change');
        expect(field('voice-cloud-key-tts').value).toBe('sk-shared');
        click('[data-settings-save]');
        expect(posted.at(-1)).toMatchObject({ type: 'saveVoice', apiKeys: { openai: 'sk-shared' } });
    });

    it("shows whether the picked provider's own key is saved, and a pasted key does not follow a provider change", () => {
        showTab((d) => {
            d.voiceApiKeys = { openai: false, groq: true };
        });
        pick('stt', 'cloud');
        const remove = document.querySelector<HTMLButtonElement>('[data-voice-key-remove="stt"]')!;
        expect([text('voice-cloud-key-state-stt'), remove.hidden]).toEqual(['No OpenAI key saved yet.', true]);

        setValue('voice-cloud-key-stt', 'sk-openai');
        expect(text('voice-cloud-key-state-stt')).toBe('OpenAI key not saved yet: Save keeps it.');

        setValue('voice-cloud-provider-stt', 'groq', 'change');
        expect([field('voice-cloud-key-stt').value, text('voice-cloud-key-state-stt'), remove.hidden, remove.textContent]).toEqual(['', '✓ Groq key saved.', false, 'Remove Groq key']);

        click('[data-voice-key-remove="stt"]');
        expect(posted.at(-1)).toEqual({ type: 'removeVoiceApiKey', provider: 'groq' });
        click('[data-settings-save]');
        expect(posted.at(-1)).toMatchObject({ type: 'saveVoice', apiKeys: {} });
    });

    it("the built-in status and download are each service's own", () => {
        pick('stt', 'builtin');
        expect(posted).toContainEqual({ type: 'getBuiltinVoiceStatus', service: 'stt' });
        applyBuiltinVoiceStatus({ type: 'builtinVoiceStatus', service: 'stt', status: { downloaded: false, bytes: 120e6, running: false }, busy: false });
        expect(text('voice-builtin-status-stt')).toBe('Not downloaded yet: 120 MB, fetched once the first time it is used. Download now to be ready.');

        click('[data-voice-builtin-download="stt"]');
        expect(posted.at(-1)).toEqual({ type: 'prepareBuiltinVoice', service: 'stt' });
        expect(text('voice-builtin-status-stt')).toContain('Downloading');

        pick('tts', 'builtin');
        applyBuiltinVoiceStatus({ type: 'builtinVoiceStatus', service: 'tts', status: { downloaded: true, bytes: 80e6, running: true }, busy: false });
        expect([text('voice-builtin-status-tts'), text('voice-builtin-status-stt')]).toEqual(['Ready. Engine and models downloaded (80 MB).', expect.stringContaining('Downloading')]);
    });

    it('a section Test only tests: nothing is saved and its result shows while the values are the same', () => {
        setValue('setting-voice.sttUrl', 'http://127.0.0.1:8019/v1');
        click('[data-voice-test="stt"]');
        expect(posted.map((m) => m.type)).not.toContain('saveVoice');
        expect(posted.at(-1)).toMatchObject({ type: 'testStt', settings: { sttUrl: 'http://127.0.0.1:8019/v1' } });

        applyVoiceTestResult({ type: 'voiceTestResult', service: 'stt', ok: false, message: "The speech-to-text service isn't running at 127.0.0.1:8019.", check: { ok: true } });
        expect(text('voice-status-stt')).toBe("The speech-to-text service isn't running at 127.0.0.1:8019. (not saved yet)");
        expect(saveState()).toBe('Unsaved changes');

        setValue('setting-voice.sttUrl', 'http://127.0.0.1:8010/v1');
        expect(text('voice-status-stt')).toBe('Connected.');
    });

    it('your own server needs only addresses: no engine or key fields, and an empty URL means Built-in for that service', () => {
        const own = document.querySelectorAll('[data-voice-setup-panel="own"]');
        expect([...own].flatMap((panel) => [...panel.querySelectorAll('select[id$="Engine"], select[id$=".engine"], input[type="password"]')])).toHaveLength(0);

        setValue('setting-voiceAgent.tts.url', '');
        expect([readSttForm().sttEngine, readTtsForm().engine, selectedCard('tts')]).toEqual(['custom', 'builtin', 'own']);
        // Testing it would download the built-in models: asks for the URL instead.
        posted.length = 0;
        click('[data-voice-test="tts"]');
        expect(posted).toEqual([]);
        expect(text('voice-status-tts')).toContain('Enter the URL of your server first');

        setValue('setting-voiceAgent.tts.url', 'http://127.0.0.1:8880/v1');
        expect(readTtsForm().engine).toBe('custom');
    });

    it('fills in the model the server offered at Test, as an unsaved change', () => {
        const model = field('setting-voice.sttModel');
        setValue('setting-voice.sttModel', '');
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
        setValue('setting-voice.sttModel', 'mine');
        applyVoiceTestResult({ type: 'voiceTestResult', service: 'stt', ok: true, message: 'Connected.', check: { ok: true }, models: ['x'], detectedModel: 'x' });
        expect(model.value).toBe('mine');
    });

    it('a voice change marks the Voice tab too, and the bar keeps it on every tab, without the Voice Try', () => {
        pick('stt', 'builtin');
        switchSettingsTab('general', false);
        const voiceDot = document.querySelector<HTMLElement>('button[data-tab="voice"] .unsaved-dot')!;
        const shownTries = [...document.querySelectorAll<HTMLElement>('[data-save-bar-subtab]')].filter((b) => !b.hidden);
        expect([voiceDot.hidden, saveState(), shownTries]).toEqual([false, 'Unsaved changes', []]);
    });
});

describe('Voice sub-tabs', () => {
    beforeEach(() => showTab());

    const tab = (id: string) => document.getElementById(`voice-subtab-${id}`)!;
    const shownSubpanels = () => [...document.querySelectorAll<HTMLElement>('[data-voice-subpanel]')].filter((p) => !p.hidden).map((p) => p.dataset.voiceSubpanel);
    const tries = () => [...document.querySelectorAll<HTMLElement>('[data-save-bar-subtab]')].filter((b) => !b.hidden).map((b) => b.textContent);
    const dots = () => ['stt', 'tts', 'agent'].filter((id) => !tab(id).querySelector<HTMLElement>('.unsaved-dot')!.hidden);
    const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

    it("shows one panel at a time; arrows, Home and End move the selection and focus; the Save bar holds the sub-tab's Try", () => {
        expect([shownSubpanels(), tries()]).toEqual([['stt'], ['Try speech-to-text…']]);
        tab('stt').focus();
        press('ArrowRight');
        expect([shownSubpanels(), tries(), document.activeElement?.id]).toEqual([['tts'], ['Try the voice…'], 'voice-subtab-tts']);
        expect([tab('tts').getAttribute('aria-selected'), tab('tts').tabIndex, tab('stt').tabIndex]).toEqual(['true', 0, -1]);
        press('ArrowRight');
        expect([shownSubpanels(), tries()]).toEqual([['agent'], []]);
        press('ArrowRight');
        expect(shownSubpanels()).toEqual(['stt']);
        press('ArrowLeft');
        expect([shownSubpanels(), document.activeElement?.id]).toEqual([['agent'], 'voice-subtab-agent']);
        press('Home');
        expect(shownSubpanels()).toEqual(['stt']);
        press('End');
        expect(shownSubpanels()).toEqual(['agent']);
    });

    it('keeps the chosen sub-tab across a rebuild, and hidden panels keep working', () => {
        tab('agent').click();
        expect(webviewState.current?.voiceSubtab).toBe('agent');
        render();
        expect([shownSubpanels(), tab('agent').getAttribute('aria-selected')]).toEqual([['agent'], 'true']);

        // The setup cards are hidden but bound: a click still drafts, and the dot says so.
        pick('tts', 'builtin');
        expect([saveState(), dots()]).toEqual(['Unsaved changes', ['tts']]);
    });

    it("puts the unsaved dot on the sub-tab of the service whose settings or key differ", () => {
        setValue('setting-voiceAgent.tts.speed', '1.5');
        expect([saveState(), dots()]).toEqual(['Unsaved changes', ['tts']]);

        setValue('setting-voice.language', 'zh');
        expect(dots()).toEqual(['stt', 'tts']);

        setValue('setting-voiceAgent.tts.speed', '1');
        expect(dots()).toEqual(['stt']);
        setValue('setting-voice.language', 'en');
        expect([dots(), saveState()]).toEqual([[], 'All changes saved']);

        // A pasted key alone is a change of its service.
        showTab((d) => Object.assign(d.tts, { url: 'https://api.openai.com/v1' }));
        setValue('voice-cloud-key-tts', 'sk-new');
        expect([dots(), saveState()]).toEqual([['tts'], 'Unsaved changes']);
        click('[data-settings-discard]');
        expect([dots(), field('voice-cloud-key-tts').value]).toEqual([[], '']);
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
        expect(opens('voiceprint')).toBe('stt');
        expect(opens('voice-agent')).toBe('agent');
        expect(opens('tts')).toBe('tts');
        expect(opens('voice-listening')).toBe('stt');
        expect(opens('voice-speaking')).toBe('tts');
        expect(opens('stt-server')).toBe('stt');
        expect(document.getElementById('section-stt-server')!.classList.contains('section-highlight')).toBe(true);

        // A server section of a setup not shown: its service's engine choice instead.
        pick('tts', 'builtin');
        expect(opens('tts-server')).toBe('tts');
        expect(document.getElementById('section-tts')!.classList.contains('section-highlight')).toBe(true);
    });
});
