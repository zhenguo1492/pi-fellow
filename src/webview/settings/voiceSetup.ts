/**
 * The Voice tab: three cards (Built-in, Cloud service, My own server) that map onto the existing voice
 * settings, the details each needs, and an explicit Save with an unsaved-changes indicator. Fields are
 * drafts (kept across re-renders) until Save; Test and Dry run try them unsaved.
 */
import { escapeHtml } from '../../shared/html';
import type { SettingsClientMessage, SettingsData, SettingsServerMessage, VoiceSettings } from '../../shared/protocol';
import { CLOUD_PROVIDERS, VOICE_PRESETS, presetForUrl } from '../../shared/voicePresets';
import type { TtsConfig } from '../../voiceAgent/tts';
import { openSttDryRun, openTtsDryRun } from '../voiceDryRun';
import { vscode } from './api';
import { buildNumberInput, buildSection, buildSelect, buildTextInput, el, showToast } from './dom';
import { settingsState, type VoiceSetup } from './state';
import { buildTabPanel } from './tabs';
import {
    bindVoiceSkills,
    buildDraftSection,
    buildSentenceActionsRow,
    buildHiddenField,
    buildServiceUrlRow,
    buildTtsModelRow,
    buildVoiceSkillsRow,
    buildSpeakersRow,
    isVoiceDirty,
    readSttForm,
    readTtsForm,
    renderTtsModelPicker,
    renderVoiceSkills,
    renderVoiceStatus,
    voiceFormKey,
    voiceServiceOf,
    type VoiceService,
} from './voice';

const SERVICES: readonly VoiceService[] = ['stt', 'tts'];
const ENGINE_FIELD: Record<VoiceService, string> = { stt: 'voice.sttEngine', tts: 'voiceAgent.tts.engine' };
const URL_FIELD: Record<VoiceService, string> = { stt: 'voice.sttUrl', tts: 'voiceAgent.tts.url' };
const MODEL_FIELD: Record<VoiceService, string> = { stt: 'voice.sttModel', tts: 'voiceAgent.tts.model' };
/** The fields "My own server" brings back (remembered, else saved) when the cloud had them. */
const SERVER_FIELDS: Record<VoiceService, Array<[key: string, blank: string]>> = {
    stt: [['voice.sttUrl', ''], ['voice.sttModel', '']],
    tts: [['voiceAgent.tts.url', ''], ['voiceAgent.tts.model', ''], ['voiceAgent.tts.voice', ''], ['voiceAgent.tts.languageField', 'none']],
};

/** Which card the settings match: both built-in; a cloud provider's services (built-in voice where it has none); else your server(s). */
export function deriveVoiceSetup(stt: VoiceSettings, tts: TtsConfig): { setup: VoiceSetup; provider?: string } {
    if (stt.sttEngine === 'builtin' && tts.engine === 'builtin') {
        return { setup: 'builtin' };
    }
    const provider = stt.sttEngine === 'custom' ? presetForUrl('stt', stt.sttUrl)?.id : undefined;
    if (provider) {
        // The provider's voice, or the built-in one (a provider without a voice, or one saved that way).
        if (tts.engine === 'builtin' || presetForUrl('tts', tts.url)?.id === provider) {
            return { setup: 'cloud', provider };
        }
    }
    return { setup: 'own' };
}

function currentSetup(): VoiceSetup {
    return settingsState.voiceSetup ?? deriveVoiceSetup(readSttForm(), readTtsForm()).setup;
}

function cloudProvider(): string {
    return settingsState.voiceCloudProvider ?? deriveVoiceSetup(readSttForm(), readTtsForm()).provider ?? CLOUD_PROVIDERS[0].id;
}

/** Sets a field as a draft, as if typed. */
function setDraft(key: string, value: string): void {
    const field = document.getElementById(`setting-${key}`);
    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
        field.value = value;
        settingsState.voiceDrafts.set(field.id, value);
    }
}

function savedValue(key: string): string | undefined {
    const data = settingsState.currentSettings;
    return data ? savedVoiceValue(data, key)?.toString() : undefined;
}

/** Points both services at `providerId`'s presets; its missing services use the built-in engine. */
export function applyCloudProvider(providerId: string): void {
    settingsState.voiceCloudProvider = providerId;
    for (const service of SERVICES) {
        const preset = VOICE_PRESETS[service].find((p) => p.id === providerId);
        setDraft(ENGINE_FIELD[service], preset ? 'custom' : 'builtin');
        for (const [key, value] of Object.entries(preset?.fields ?? {})) {
            setDraft(key, value);
        }
    }
}

/** A card click: fills the fields the card stands for, as drafts; Save keeps them. */
export function chooseVoiceSetup(setup: VoiceSetup): void {
    settingsState.voiceSetup = setup;
    settingsState.voiceSaveResult = undefined;
    if (setup === 'builtin') {
        SERVICES.forEach((service) => setDraft(ENGINE_FIELD[service], 'builtin'));
    } else if (setup === 'cloud') {
        applyCloudProvider(cloudProvider());
    } else {
        const stt = readSttForm();
        const tts = readTtsForm();
        for (const service of SERVICES) {
            // Coming from the cloud (or with no address yet): your server as saved, else as remembered from
            // before a Cloud or Built-in save replaced it, else empty fields to fill.
            const url = service === 'stt' ? stt.sttUrl : tts.url;
            if (!url || presetForUrl(service, url)) {
                const savedUrl = savedValue(SERVER_FIELDS[service][0][0]) ?? '';
                const fromSaved = savedUrl !== '' && !presetForUrl(service, savedUrl);
                const remembered = settingsState.currentSettings?.voiceOwnServers?.[service];
                for (const [key, blank] of SERVER_FIELDS[service]) {
                    setDraft(key, (fromSaved ? savedValue(key) : remembered?.[key]) ?? blank);
                }
            }
            followUrl(service);
        }
    }
    renderVoiceTab();
}

/** On your own server, a part with a URL uses it; one left empty uses the built-in engine. */
function followUrl(service: VoiceService): void {
    const url = document.getElementById(`setting-${URL_FIELD[service]}`);
    setDraft(ENGINE_FIELD[service], url instanceof HTMLInputElement && url.value.trim() ? 'custom' : 'builtin');
}

/** The API key pasted on the Cloud card, for the provider's services; your own server takes none. */
export function typedApiKey(service: VoiceService): string | undefined {
    if (currentSetup() !== 'cloud') {
        return undefined;
    }
    const field = document.getElementById('voice-cloud-key');
    const engine = service === 'stt' ? readSttForm().sttEngine : readTtsForm().engine;
    return field instanceof HTMLInputElement && field.value.trim() && engine === 'custom' ? field.value.trim() : undefined;
}

/** Saves both sections and the typed keys; `test` also checks the custom services. */
export function saveVoice(test: boolean): void {
    if (settingsState.voiceSaving) {
        return;
    }
    // The key pasted on the Cloud card is the picked provider's (one key per provider).
    const typed = SERVICES.map(typedApiKey).find((key) => key !== undefined);
    const apiKeys: Record<string, string> = typed ? { [cloudProvider()]: typed } : {};
    settingsState.voiceSaving = true;
    settingsState.voiceSaveResult = undefined;
    vscode.postMessage({ type: 'saveVoice', stt: readSttForm(), tts: readTtsForm(), apiKeys, test });
    renderVoiceTab();
}

function clearTypedKeys(): void {
    document.querySelectorAll<HTMLInputElement>('#voice-cloud-key').forEach((field) => {
        field.value = '';
        settingsState.voiceDrafts.delete(field.id);
    });
}

/** Back to the saved settings: drafts, typed keys and the picked card go. */
export function discardVoiceChanges(): void {
    settingsState.voiceDrafts.clear();
    settingsState.voiceSetup = undefined;
    settingsState.voiceCloudProvider = undefined;
    settingsState.voiceSaveResult = undefined;
    clearTypedKeys();
    syncVoiceFields();
}

/** The host saved (answer to `saveVoice`): the form is the settings now; with a test, its result shows on the Cloud card. */
export function applyVoiceSaved(msg: Extract<SettingsServerMessage, { type: 'voiceSaved' }>): void {
    settingsState.voiceSaving = false;
    if (msg.saved) {
        if (settingsState.currentSettings) {
            settingsState.currentSettings.voice = readSttForm();
            settingsState.currentSettings.tts = readTtsForm();
        }
        settingsState.voiceDrafts.clear();
        clearTypedKeys();
    }
    const tested = Object.keys(msg.tests).length > 0;
    settingsState.voiceSaveResult = tested || !msg.ok ? { ok: msg.ok, message: msg.message } : undefined;
    showToast(msg.message, msg.ok ? 'info' : 'error');
    renderVoiceTab();
}

/** The form a pending Test checks, by service: its result is about that form. */
const pendingTests: Partial<Record<VoiceService, string>> = {};

/**
 * A section's Test answered. A model the server offers in place of an empty or unknown one is filled
 * in (a draft, as if typed) while the section still shows what was tested.
 */
export function applyVoiceTestResult(msg: Extract<SettingsServerMessage, { type: 'voiceTestResult' }>): void {
    settingsState.voiceTesting[msg.service] = false;
    const tested = pendingTests[msg.service] ?? voiceFormKey(msg.service);
    if (msg.detectedModel && tested === voiceFormKey(msg.service)) {
        setDraft(MODEL_FIELD[msg.service], msg.detectedModel);
    }
    settingsState.voiceTestResults[msg.service] = { ok: msg.ok, message: msg.message, form: msg.detectedModel ? voiceFormKey(msg.service) : tested };
    if (msg.service === 'tts') {
        settingsState.ttsServerModels = msg.models ?? [];
        renderTtsModelPicker();
    }
    renderVoiceTab();
}

export function applyBuiltinVoiceStatus(msg: Extract<SettingsServerMessage, { type: 'builtinVoiceStatus' }>): void {
    settingsState.builtinVoice = { status: msg.status, busy: msg.busy, error: msg.error };
    renderVoiceTab();
}

// ── Rendering ──

function megabytes(bytes: number | undefined): string {
    return bytes === undefined ? 'about 350 MB' : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function renderBuiltinPanel(visible: boolean): void {
    const status = document.getElementById('voice-builtin-status');
    const download = document.querySelector<HTMLButtonElement>('[data-voice-builtin-download]');
    if (!status || !download) {
        return;
    }
    if (visible && settingsState.builtinVoice === undefined) {
        settingsState.builtinVoice = { busy: false };
        vscode.postMessage({ type: 'getBuiltinVoiceStatus' });
    }
    const { status: models, busy, error } = settingsState.builtinVoice ?? { busy: false };
    const [state, text] = busy
        ? ['testing', 'Downloading the models and starting the engine… (progress shows in the notification)']
        : error
          ? ['error', error]
          : !models
            ? ['testing', 'Checking the models…']
            : models.downloaded
              ? ['ok', `Ready. Models downloaded (${megabytes(models.bytes)}).`]
              : ['dirty', `Not downloaded yet: ${megabytes(models.bytes)}, fetched once the first time you use voice. Download now to be ready.`];
    status.dataset.state = state;
    status.textContent = text;
    download.hidden = busy || models?.downloaded !== false;
}

function renderCloudPanel(): void {
    const providerId = cloudProvider();
    const provider = CLOUD_PROVIDERS.find((p) => p.id === providerId) ?? CLOUD_PROVIDERS[0];
    const select = document.getElementById('voice-cloud-provider');
    if (select instanceof HTMLSelectElement) {
        select.value = provider.id;
    }
    const keyButton = document.querySelector<HTMLButtonElement>('[data-voice-key-page]');
    if (keyButton) {
        keyButton.textContent = `Get ${provider.label} API key`;
    }
    const ttsPreset = VOICE_PRESETS.tts.find((p) => p.id === provider.id);
    const hasTts = ttsPreset !== undefined;
    renderCloudVoice(ttsPreset?.voices ?? []);
    const note = document.getElementById('voice-cloud-note');
    if (note) {
        note.textContent = hasTts
            ? `${provider.label} does both: it turns your speech into text and gives voice mode its voice.`
            : `${provider.label} turns your speech into text; voice mode speaks with the built-in English voice (it has no voice here).`;
    }
    const keySaved = settingsState.currentSettings?.voiceApiKeys[provider.id] === true;
    const keyField = document.getElementById('voice-cloud-key');
    const typed = keyField instanceof HTMLInputElement && keyField.value.trim() !== '';
    if (keyField instanceof HTMLInputElement) {
        keyField.placeholder = keySaved ? `Paste a new ${provider.label} key to replace the saved one` : `Paste your ${provider.label} API key`;
    }
    const keyState = document.getElementById('voice-cloud-key-state');
    if (keyState) {
        keyState.dataset.state = keySaved ? 'ok' : typed ? 'dirty' : '';
        keyState.textContent = keySaved
            ? typed ? `✓ ${provider.label} key saved. The one pasted replaces it when you save.` : `✓ ${provider.label} key saved.`
            : typed ? `${provider.label} key not saved yet: Save & test keeps it.` : `No ${provider.label} key saved yet.`;
    }
    const remove = document.querySelector<HTMLButtonElement>('[data-voice-key-remove]');
    if (remove) {
        remove.hidden = !keySaved;
        remove.textContent = `Remove ${provider.label} key`;
    }
    const status = document.getElementById('voice-cloud-status');
    if (!status) {
        return;
    }
    const result = settingsState.voiceSaveResult;
    const [state, text] = settingsState.voiceSaving
        ? ['testing', 'Saving and testing…']
        : result
          ? [result.ok ? 'ok' : 'error', result.message]
          : !keySaved && !typed
            ? ['error', `${provider.label} needs an API key: click "Get ${provider.label} API key", create one, paste it here, then Save & test.`]
            : ['', ''];
    status.dataset.state = state;
    status.textContent = text;
}

/** The Cloud card's Voice picker: the provider's voices, and the one set now if it is none of them. */
function renderCloudVoice(voices: readonly string[]): void {
    const row = document.getElementById('voice-cloud-voice-row');
    const select = document.getElementById('voice-cloud-voice');
    if (!row || !(select instanceof HTMLSelectElement)) {
        return;
    }
    row.hidden = voices.length === 0;
    const current = readTtsForm().voice;
    const options = current && !voices.includes(current) ? [...voices, current] : voices;
    const listed = options.join('\n');
    if (select.dataset.listed !== listed) {
        select.dataset.listed = listed;
        select.innerHTML = options.map((v, i) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}${i === 0 ? ' (default)' : ''}</option>`).join('');
    }
    select.value = current || (voices[0] ?? '');
}

function renderSaveBar(): void {
    const dirty = isVoiceDirty('stt') || isVoiceDirty('tts') || SERVICES.some((service) => typedApiKey(service) !== undefined);
    const state = document.getElementById('voice-save-state');
    if (state) {
        state.dataset.state = settingsState.voiceSaving ? 'testing' : dirty ? 'dirty' : 'ok';
        state.textContent = settingsState.voiceSaving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved';
    }
    document.querySelectorAll<HTMLButtonElement>('[data-voice-save], [data-voice-discard]').forEach((button) => {
        button.disabled = !dirty || settingsState.voiceSaving;
    });
    const saveTest = document.querySelector<HTMLButtonElement>('[data-voice-save-test]');
    if (saveTest) {
        saveTest.disabled = settingsState.voiceSaving;
    }
    if (dirty !== settingsState.voiceDirty) {
        settingsState.voiceDirty = dirty;
        vscode.postMessage({ type: 'voiceDirty', dirty });
    }
}

/** Everything on the Voice tab that follows the form: cards, panels, section status lines, the save bar. */
export function renderVoiceTab(): void {
    const setup = currentSetup();
    document.querySelectorAll<HTMLElement>('[data-voice-setup-card]').forEach((card) => {
        const selected = card.dataset.voiceSetupCard === setup;
        card.classList.toggle('selected', selected);
        card.setAttribute('aria-checked', String(selected));
    });
    document.querySelectorAll<HTMLElement>('[data-voice-setup-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.voiceSetupPanel !== setup;
    });
    renderBuiltinPanel(setup === 'builtin');
    renderCloudPanel();
    SERVICES.forEach(renderVoiceStatus);
    renderSaveBar();
}

// ── Saved settings in the fields ──

/** The saved value behind a Voice field (`voice.sttUrl`, `voiceAgent.tts.speed`, …). */
function savedVoiceValue(data: SettingsData, key: string): string | number | undefined {
    const [section, name] = key.startsWith('voiceAgent.tts.')
        ? [data.tts, key.slice('voiceAgent.tts.'.length)]
        : key.startsWith('voice.')
          ? [data.voice, key.slice('voice.'.length)]
          : [undefined, ''];
    const value: unknown = section ? Object.entries(section).find(([k]) => k === name)?.[1] : undefined;
    return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

/**
 * Shows newly saved voice settings without rebuilding the fields: a field with an unsaved draft keeps
 * it, and one that already shows the saved value is not touched (writing `.value` would clear its undo).
 */
export function syncVoiceFields(): void {
    const data = settingsState.currentSettings;
    if (!data) {
        return;
    }
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-draft] [data-key]').forEach((field) => {
        const saved = savedVoiceValue(data, field.dataset.key ?? '');
        if (saved === undefined || settingsState.voiceDrafts.has(field.id)) {
            return;
        }
        const shown = typeof saved === 'number' ? Number(field.value) === saved : field.value.trim() === saved;
        if (!shown) {
            field.value = String(saved);
        }
    });
    renderVoiceSkills();
    renderVoiceTab();
}

/** Puts typed-but-unsaved values back after a re-render. */
export function restoreVoiceDrafts(): void {
    for (const [id, value] of settingsState.voiceDrafts) {
        const field = document.getElementById(id);
        if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
            field.value = value;
        }
    }
    renderVoiceTab();
}

// ── Building ──

function buildVoiceHelp(): HTMLElement {
    const help = el('details', 'voice-help');
    help.id = 'voice-help';
    help.innerHTML = `
        <summary>How to set up voice</summary>
        <p>Voice is two parts: <b>speech-to-text</b> writes what you say (the chat mic, and voice mode), and <b>text-to-speech</b> gives voice mode its voice. Pick one way below, then Save.</p>
        <ul>
            <li><b>Built-in</b>: nothing to set up. Runs on this computer, English only; about 350 MB of models download once, the first time you use voice.</li>
            <li><b>Cloud service</b>: OpenAI or Groq. Best quality and many languages; needs an account and an API key (paid by use). Click "Get API key", paste the key, then "Save & test".</li>
            <li><b>My own server</b>: any OpenAI-compatible speech server you run (for example speaches for speech-to-text, Kokoro-FastAPI for the voice). Full control, including models, voices and languages.</li>
        </ul>
        <p>Changes wait until you press <b>Save</b>; Discard goes back to what is saved.</p>`;
    return help;
}

function buildSetupCards(): HTMLElement {
    const cards = el('div', 'voice-setup-cards');
    cards.setAttribute('role', 'radiogroup');
    cards.setAttribute('aria-label', 'How voice is set up');
    const card = (setup: VoiceSetup, title: string, sub: string) => `
        <button type="button" class="voice-setup-card" role="radio" aria-checked="false" data-voice-setup-card="${setup}">
            <span class="voice-setup-title">${escapeHtml(title)}</span>
            <span class="voice-setup-sub">${escapeHtml(sub)}</span>
        </button>`;
    cards.innerHTML = [
        card('builtin', 'Built-in', 'No setup · English'),
        card('cloud', 'Cloud service', 'OpenAI or Groq · API key'),
        card('own', 'My own server', 'OpenAI-compatible, you run it'),
    ].join('');
    return cards;
}

function buildBuiltinPanel(): HTMLElement {
    const panel = el('div', 'voice-setup-panel');
    panel.dataset.voiceSetupPanel = 'builtin';
    panel.innerHTML = `
        <p class="setting-description">Speech-to-text (Moonshine) and the voice (Piper) run on this computer, in the background; what you say is not sent anywhere. English only.</p>
        <p class="voice-status" id="voice-builtin-status" role="status"></p>
        <button type="button" class="setting-btn secondary" data-voice-builtin-download hidden>Download now</button>`;
    return panel;
}

function buildCloudPanel(): HTMLElement {
    const panel = el('div', 'voice-setup-panel');
    panel.dataset.voiceSetupPanel = 'cloud';
    panel.innerHTML = `
        <div class="setting-row">
            <div class="setting-label-row"><label for="voice-cloud-provider">Provider</label></div>
            <select id="voice-cloud-provider" class="setting-select">
                ${CLOUD_PROVIDERS.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('')}
            </select>
            <p class="setting-description" id="voice-cloud-note"></p>
        </div>
        <div class="setting-row" id="voice-cloud-voice-row">
            <div class="setting-label-row"><label for="voice-cloud-voice">Voice</label></div>
            <div class="setting-input-wrapper">
                <select id="voice-cloud-voice" class="setting-select"></select>
                <button type="button" class="setting-btn secondary" data-voice-dry-run="tts">Try…</button>
            </div>
            <p class="setting-description">How voice mode sounds. Try reads a sentence aloud with the voice picked (and the key pasted, if any).</p>
        </div>
        <div class="setting-row">
            <div class="setting-label-row"><label for="voice-cloud-key">API key</label></div>
            <div class="setting-input-wrapper">
                <input type="password" id="voice-cloud-key" class="setting-input" autocomplete="off" spellcheck="false">
                <button type="button" class="setting-btn secondary" data-voice-key-page>Get API key</button>
            </div>
            <div class="voice-key-state-row">
                <p class="voice-status" id="voice-cloud-key-state" role="status"></p>
                <button type="button" class="setting-btn secondary small" data-voice-key-remove hidden>Remove key</button>
            </div>
            <p class="setting-description">Each provider has its own key, kept in VS Code's secret storage (not in settings.json) and sent only to that provider.</p>
        </div>
        <div class="voice-actions-buttons">
            <button type="button" class="setting-btn primary" data-voice-save-test>Save &amp; test</button>
        </div>
        <p class="voice-status" id="voice-cloud-status" role="status"></p>`;
    return panel;
}

function buildServerHelp(): HTMLElement {
    const help = el('details', 'voice-help');
    help.innerHTML = `
        <summary>How to run a local speech server</summary>
        <p>Speech-to-text with <a href="https://speaches.ai/installation/">speaches</a> (faster-whisper), in Docker:</p>
        <pre><code>docker run --rm --detach --publish 8000:8000 --name speaches \\
  --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \\
  ghcr.io/speaches-ai/speaches:latest-cpu
SPEACHES_BASE_URL=http://localhost:8000 uvx speaches-cli model download Systran/faster-distil-whisper-small.en</code></pre>
        <p>Then enter URL <code>http://localhost:8000/v1</code> and model <code>Systran/faster-distil-whisper-small.en</code>.</p>
        <p>A voice with <a href="https://github.com/remsky/Kokoro-FastAPI">Kokoro-FastAPI</a>:</p>
        <pre><code>docker run --detach --publish 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest</code></pre>
        <p>Then enter URL <code>http://localhost:8880/v1</code>, model <code>kokoro</code>, voice <code>af_bella</code>; for Chinese, language field "lang_code: z".</p>
        <p>Only have one of them? Leave the other URL empty: that part uses the built-in engine.</p>`;
    return help;
}

function buildOwnServerPanel(data: SettingsData): HTMLElement {
    const panel = el('div', 'voice-setup-panel voice-own-panel');
    panel.dataset.voiceSetupPanel = 'own';
    panel.append(
        buildServerHelp(),
        buildDraftSection('stt', 'Speech-to-text server', [
            buildHiddenField('voice.sttEngine', data.voice.sttEngine),
            buildServiceUrlRow('stt', 'voice.sttUrl', 'URL', data.voice.sttUrl, 'http://localhost:8000/v1',
                'OpenAI-compatible base URL, usually ending in /v1. Empty: speech-to-text uses the built-in engine.'),
            buildTextInput('voice.sttModel', 'Model', data.voice.sttModel,
                'Leave it empty and press Test: the model the server offers is filled in.',
                'filled in by Test'),
        ]),
        buildDraftSection('tts', 'Text-to-speech server', [
            buildHiddenField('voiceAgent.tts.engine', data.tts.engine),
            buildServiceUrlRow('tts', 'voiceAgent.tts.url', 'URL', data.tts.url, 'http://localhost:8880/v1',
                'OpenAI-compatible base URL, usually ending in /v1. Empty: voice mode speaks with the built-in voice.'),
            buildTtsModelRow(data.tts.model),
            buildTextInput('voiceAgent.tts.voice', 'Voice', data.tts.voice, 'Empty sends no voice and the server picks.', 'server default'),
            buildSelect('voiceAgent.tts.languageField', 'Language field', data.tts.languageField, [
                { value: 'none', label: 'None' },
                { value: 'perSentence', label: 'language: zh / en per sentence' },
                { value: 'chineseLangCode', label: 'lang_code: z for Chinese runs' },
            ], 'How the server is told the language. None sends nothing; per sentence sends zh for sentences with Chinese, else en (e.g. chatterbox-tts); lang_code z speaks each Chinese run as its own request (e.g. Kokoro-FastAPI).'),
        ]),
    );
    return panel;
}

/** What every setup shares: language and listening, speaking speed, and trying it out. */
function buildListeningSection(data: SettingsData): HTMLElement {
    const stt = el('div');
    stt.dataset.draft = 'stt';
    stt.append(
        buildTextInput('voice.language', 'Language', data.voice.language,
            'ISO-639-1 hint such as zh or en. Empty lets the service detect it per utterance (Built-in is English only).',
            'auto-detect'),
        buildNumberInput('voice.vadConfidence', 'Speech detection threshold', data.voice.vadConfidence, 0.1, 0.95, 0.05,
            'Lower it (e.g. 0.35) if quiet speech is missed; raise it if background noise gets transcribed.'),
        buildNumberInput('voice.vadStopSecs', 'Pause that ends a sentence (s)', data.voice.vadStopSecs, 0.2, 3, 0.1,
            'Each sentence is transcribed as soon as this much silence follows it.'),
    );
    const tts = el('div');
    tts.dataset.draft = 'tts';
    tts.append(buildNumberInput('voiceAgent.tts.speed', 'Speaking speed', data.tts.speed, 0.5, 2, 0.1, 'Voice mode speaking speed (0.5–2).'));
    const tryIt = el('div', 'setting-row voice-actions');
    tryIt.innerHTML = `
        <div class="voice-actions-buttons">
            <button type="button" class="setting-btn secondary" data-voice-dry-run="stt">Try speech-to-text…</button>
            <button type="button" class="setting-btn secondary" data-voice-dry-run="tts">Try the voice…</button>
        </div>
        <p class="setting-description">Tries the settings as shown, saved or not: one sentence from your microphone, or a sentence you type read aloud.</p>`;
    return buildSection('Listening and speaking', [stt, tts, tryIt], 'voice-listening');
}

function buildSaveBar(): HTMLElement {
    const bar = el('div', 'voice-save-bar');
    bar.innerHTML = `
        <span class="voice-save-state" id="voice-save-state" role="status"></span>
        <button type="button" class="setting-btn secondary" data-voice-discard>Discard</button>
        <button type="button" class="setting-btn primary" data-voice-save>Save</button>`;
    return bar;
}

export function buildVoiceTab(data: SettingsData): HTMLElement {
    return buildTabPanel('voice', [
        buildVoiceHelp(),
        buildSection('Set up voice', [buildSetupCards(), buildBuiltinPanel(), buildCloudPanel()], 'voice'),
        buildOwnServerPanel(data),
        buildListeningSection(data),
        buildSection(
            'Voice agent',
            [buildSpeakersRow(data.voiceSpeakers), buildVoiceSkillsRow(), buildSentenceActionsRow(data.voiceMessageButtons, data.voiceTranslateTo)],
            'voice-agent',
        ),
        buildSaveBar(),
    ]);
}

// ── Events ──

/** Once per full render. */
export function bindVoiceSetup(): void {
    const post = (message: SettingsClientMessage) => vscode.postMessage(message);

    // Fields are drafts (kept across re-renders) until Save.
    document.querySelectorAll<HTMLElement>('[data-draft] [data-key]').forEach((field) => {
        const service = voiceServiceOf(field.closest<HTMLElement>('[data-draft]')?.dataset.draft);
        if (!service || !(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
        const keep = () => {
            settingsState.voiceDrafts.set(field.id, field.value);
            settingsState.voiceSaveResult = undefined;
            if (field.dataset.key === URL_FIELD[service]) {
                followUrl(service);
            }
            renderVoiceTab();
        };
        field.addEventListener('input', keep);
        field.addEventListener('change', keep);
    });
    document.getElementById('voice-cloud-key')?.addEventListener('input', (e) => {
        const field = e.currentTarget;
        if (field instanceof HTMLInputElement) {
            settingsState.voiceDrafts.set(field.id, field.value);
            settingsState.voiceSaveResult = undefined;
            renderVoiceTab();
        }
    });

    document.querySelectorAll<HTMLButtonElement>('[data-voice-setup-card]').forEach((card) => {
        card.addEventListener('click', () => chooseVoiceSetup(card.dataset.voiceSetupCard as VoiceSetup));
    });
    const provider = document.getElementById('voice-cloud-provider');
    provider?.addEventListener('change', () => {
        if (provider instanceof HTMLSelectElement) {
            settingsState.voiceSaveResult = undefined;
            // A pasted key belongs to the provider it was pasted for.
            clearTypedKeys();
            applyCloudProvider(provider.value);
            renderVoiceTab();
        }
    });
    document.querySelector('[data-voice-key-page]')?.addEventListener('click', () => post({ type: 'openVoiceKeyPage', provider: cloudProvider() }));
    document.querySelector('[data-voice-key-remove]')?.addEventListener('click', () => post({ type: 'removeVoiceApiKey', provider: cloudProvider() }));
    const cloudVoice = document.getElementById('voice-cloud-voice');
    cloudVoice?.addEventListener('change', () => {
        if (cloudVoice instanceof HTMLSelectElement) {
            // The voice setting itself (the own-server Voice field), as a draft until Save.
            setDraft('voiceAgent.tts.voice', cloudVoice.value);
            settingsState.voiceSaveResult = undefined;
            renderVoiceTab();
        }
    });
    document.querySelector('[data-voice-save-test]')?.addEventListener('click', () => saveVoice(true));
    document.querySelector('[data-voice-save]')?.addEventListener('click', () => saveVoice(false));
    document.querySelector('[data-voice-discard]')?.addEventListener('click', discardVoiceChanges);
    document.querySelector('[data-voice-builtin-download]')?.addEventListener('click', () => {
        settingsState.builtinVoice = { ...settingsState.builtinVoice, busy: true, error: undefined };
        post({ type: 'prepareBuiltinVoice' });
        renderVoiceTab();
    });

    document.querySelectorAll<HTMLButtonElement>('[data-voice-test]').forEach((btn) => {
        // Keep focus (and the caret) in the field being edited: Ctrl+Z right after a Test still undoes it.
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
            const service = voiceServiceOf(btn.dataset.voiceTest);
            if (!service || settingsState.voiceTesting[service]) return;
            // An empty URL means Built-in here: testing that would download its models.
            if (!(service === 'stt' ? readSttForm().sttUrl : readTtsForm().url)) {
                settingsState.voiceTestResults[service] = { ok: false, message: 'Enter the URL of your server first.', form: voiceFormKey(service) };
                renderVoiceTab();
                return;
            }
            settingsState.voiceTesting[service] = true;
            pendingTests[service] = voiceFormKey(service);
            renderVoiceTab();
            post(service === 'stt' ? { type: 'testStt', settings: readSttForm() } : { type: 'testTts', settings: readTtsForm() });
        });
    });
    document.querySelectorAll<HTMLButtonElement>('[data-voice-dry-run]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (btn.dataset.voiceDryRun === 'stt') {
                openSttDryRun(readSttForm(), typedApiKey('stt'), post);
            } else {
                openTtsDryRun(readTtsForm(), typedApiKey('tts'), post);
            }
        });
    });

    bindVoiceSkills();
}
