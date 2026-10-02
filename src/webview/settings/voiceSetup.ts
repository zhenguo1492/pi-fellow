/**
 * The Voice tab, in sub-tabs (`voiceTabs.ts`). Speech-to-text and Text-to-speech each pick their own
 * engine on three cards (Built-in, Cloud service, My own server) that map onto that service's settings
 * and show the details it needs, then the service's own options: language, listening and the
 * voiceprint; speaking speed. Voice agent: names, skills, sentence actions, instructions.
 * Their fields are drafts until the page's Save (`saveBar.ts`), with a dot on the sub-tab that holds
 * them; they are kept across re-renders, and Test and Try use them unsaved.
 */
import { escapeHtml } from '../../shared/html';
import type { SettingsClientMessage, SettingsData, SettingsServerMessage } from '../../shared/protocol';
import { CLOUD_PROVIDERS, VOICE_PRESETS, presetForUrl, type CloudProvider } from '../../shared/voicePresets';
import { openSttDryRun, openTtsDryRun } from '../voiceDryRun';
import { vscode } from './api';
import { buildNumberInput, buildSection, buildSelect, buildTextInput, el, showToast } from './dom';
import { pruneEdits } from './edits';
import { renderSaveBar } from './saveBar';
import { settingsState, type VoiceSetup } from './state';
import { buildTabPanel } from './tabs';
import { bindVoiceprint, buildVoiceprintSection, renderVoiceprint } from './voiceprint';
import { bindVoicePrompt, buildVoicePromptSection } from './voicePrompt';
import { buildVoiceSubtabs } from './voiceTabs';
import {
    bindVoiceSkills,
    buildDraftSection,
    buildSentenceActionsRow,
    buildHiddenField,
    buildServiceUrlRow,
    buildTtsModelRow,
    buildVoiceModelRow,
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
const SERVICE_NAME: Record<VoiceService, string> = { stt: 'Speech-to-text', tts: 'Text-to-speech' };

function otherService(service: VoiceService): VoiceService {
    return service === 'stt' ? 'tts' : 'stt';
}

/** The cloud providers that offer `service`. */
function cloudProviders(service: VoiceService): readonly CloudProvider[] {
    return CLOUD_PROVIDERS.filter((provider) => VOICE_PRESETS[service].some((preset) => preset.id === provider.id));
}

/** Which card a service's settings (as drafted) match: built-in; a cloud provider's address; else your server. */
function deriveVoiceSetup(service: VoiceService): { setup: VoiceSetup; provider?: string } {
    const form = service === 'stt' ? readSttForm() : readTtsForm();
    const [engine, url] = 'sttEngine' in form ? [form.sttEngine, form.sttUrl] : [form.engine, form.url];
    if (engine === 'builtin') {
        return { setup: 'builtin' };
    }
    const provider = presetForUrl(service, url)?.id;
    return provider ? { setup: 'cloud', provider } : { setup: 'own' };
}

function currentSetup(service: VoiceService): VoiceSetup {
    return settingsState.voiceSetup[service] ?? deriveVoiceSetup(service).setup;
}

function cloudProvider(service: VoiceService): string {
    return settingsState.voiceCloudProvider[service] ?? deriveVoiceSetup(service).provider ?? cloudProviders(service)[0].id;
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

/** Points `service` at `providerId`'s preset. */
function applyCloudProvider(service: VoiceService, providerId: string): void {
    settingsState.voiceCloudProvider[service] = providerId;
    const preset = VOICE_PRESETS[service].find((p) => p.id === providerId);
    if (!preset) {
        return;
    }
    setDraft(ENGINE_FIELD[service], 'custom');
    for (const [key, value] of Object.entries(preset.fields)) {
        setDraft(key, value);
    }
}

/** A card click on one service's sub-tab: fills the fields the card stands for, as drafts; Save keeps them. */
function chooseVoiceSetup(service: VoiceService, setup: VoiceSetup): void {
    settingsState.voiceSetup[service] = setup;
    settingsState.voiceSaveResult = undefined;
    if (setup === 'builtin') {
        setDraft(ENGINE_FIELD[service], 'builtin');
    } else if (setup === 'cloud') {
        applyCloudProvider(service, cloudProvider(service));
        if (!keyField(service)?.value.trim()) {
            shareTypedKey(otherService(service));
        }
    } else {
        // Coming from the cloud (or with no address yet): your server as saved, else as remembered from
        // before a Cloud or Built-in save replaced it, else empty fields to fill.
        const url = service === 'stt' ? readSttForm().sttUrl : readTtsForm().url;
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
    renderVoiceTab();
}

/** On your own server, a URL is used; one left empty means the built-in engine. */
function followUrl(service: VoiceService): void {
    const url = document.getElementById(`setting-${URL_FIELD[service]}`);
    setDraft(ENGINE_FIELD[service], url instanceof HTMLInputElement && url.value.trim() ? 'custom' : 'builtin');
}

function keyField(service: VoiceService): HTMLInputElement | undefined {
    const field = document.getElementById(`voice-cloud-key-${service}`);
    return field instanceof HTMLInputElement ? field : undefined;
}

function setKeyField(field: HTMLInputElement, value: string): void {
    field.value = value;
    if (value) {
        settingsState.voiceDrafts.set(field.id, value);
    } else {
        settingsState.voiceDrafts.delete(field.id);
    }
}

/**
 * One key per provider: a key pasted on `from`'s Cloud card shows on the other service's too when
 * both use the same provider.
 */
function shareTypedKey(from: VoiceService): void {
    const to = otherService(from);
    const source = keyField(from);
    const target = keyField(to);
    if (source && target && currentSetup(from) === 'cloud' && currentSetup(to) === 'cloud' && cloudProvider(from) === cloudProvider(to)) {
        setKeyField(target, source.value);
    }
}

/** The API key pasted on a service's Cloud card, for its provider; your own server takes none. */
function typedApiKey(service: VoiceService): string | undefined {
    if (currentSetup(service) !== 'cloud') {
        return undefined;
    }
    return keyField(service)?.value.trim() || undefined;
}

/** Saves both services and the typed keys when either is unsaved; with a service on its Cloud card, also checks the custom services. */
export function saveVoice(): void {
    if (settingsState.voiceSaving || !(settingsState.voiceUnsaved.stt || settingsState.voiceUnsaved.tts)) {
        return;
    }
    const apiKeys: Record<string, string> = {};
    for (const service of SERVICES) {
        const key = typedApiKey(service);
        if (key) {
            apiKeys[cloudProvider(service)] = key;
        }
    }
    settingsState.voiceSaving = true;
    settingsState.voiceSaveResult = undefined;
    const test = SERVICES.some((service) => currentSetup(service) === 'cloud');
    vscode.postMessage({ type: 'saveVoice', stt: readSttForm(), tts: readTtsForm(), apiKeys, test });
    renderVoiceTab();
}

function clearTypedKeys(): void {
    document.querySelectorAll<HTMLInputElement>('[data-voice-cloud-key]').forEach((field) => setKeyField(field, ''));
}

/** Back to the saved settings: drafts, typed keys and the picked cards go. */
export function discardVoiceChanges(): void {
    settingsState.voiceDrafts.clear();
    for (const service of SERVICES) {
        delete settingsState.voiceSetup[service];
        delete settingsState.voiceCloudProvider[service];
    }
    settingsState.voiceSaveResult = undefined;
    clearTypedKeys();
    syncVoiceFields();
}

/** The host saved (answer to `saveVoice`): the form is the settings now; with a test, its result shows on the Cloud cards. */
export function applyVoiceSaved(msg: Extract<SettingsServerMessage, { type: 'voiceSaved' }>): void {
    settingsState.voiceSaving = false;
    if (msg.saved) {
        const saved = settingsState.savedSettings;
        if (saved) {
            saved.voice = readSttForm();
            saved.tts = readTtsForm();
            pruneEdits();
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
    settingsState.builtinVoice[msg.service] = { status: msg.status, busy: msg.busy, error: msg.error };
    renderVoiceTab();
}

// ── Rendering ──

function renderBuiltinPanel(service: VoiceService, visible: boolean): void {
    const status = document.getElementById(`voice-builtin-status-${service}`);
    const download = document.querySelector<HTMLButtonElement>(`[data-voice-builtin-download="${service}"]`);
    if (!status || !download) {
        return;
    }
    if (visible && settingsState.builtinVoice[service] === undefined) {
        settingsState.builtinVoice[service] = { busy: false };
        vscode.postMessage({ type: 'getBuiltinVoiceStatus', service });
    }
    const { status: models, busy, error } = settingsState.builtinVoice[service] ?? { busy: false };
    const size = models?.bytes === undefined ? undefined : `${Math.max(1, Math.round(models.bytes / 1e6))} MB`;
    const [state, text] = busy
        ? ['testing', 'Downloading the engine and its models, then starting it… (progress shows in the notification)']
        : error
          ? ['error', error]
          : !models
            ? ['testing', 'Checking the download…']
            : models.downloaded
              ? ['ok', `Ready. Engine and models downloaded${size ? ` (${size})` : ''}.`]
              : ['dirty', `Not downloaded yet${size ? `: ${size},` : ';'} fetched once the first time it is used. Download now to be ready.`];
    status.dataset.state = state;
    status.textContent = text;
    download.hidden = busy || models?.downloaded !== false;
}

function renderCloudPanel(service: VoiceService): void {
    const providers = cloudProviders(service);
    const providerId = cloudProvider(service);
    const provider = providers.find((p) => p.id === providerId) ?? providers[0];
    const select = document.getElementById(`voice-cloud-provider-${service}`);
    if (select instanceof HTMLSelectElement) {
        select.value = provider.id;
    }
    const keyButton = document.querySelector<HTMLButtonElement>(`[data-voice-key-page="${service}"]`);
    if (keyButton) {
        keyButton.textContent = `Get ${provider.label} API key`;
    }
    const preset = VOICE_PRESETS[service].find((p) => p.id === provider.id);
    if (service === 'tts') {
        renderCloudVoice(preset?.voices ?? []);
    }
    const note = document.getElementById(`voice-cloud-note-${service}`);
    if (note) {
        const does = service === 'stt' ? 'turns your speech into text' : 'gives voice mode its voice';
        note.textContent = `${provider.label} ${does}.${preset?.note ? ` ${preset.note}` : ''}`;
    }
    const keySaved = settingsState.currentSettings?.voiceApiKeys[provider.id] === true;
    const field = keyField(service);
    const typed = field !== undefined && field.value.trim() !== '';
    if (field) {
        field.placeholder = keySaved ? `Paste a new ${provider.label} key to replace the saved one` : `Paste your ${provider.label} API key`;
    }
    const keyState = document.getElementById(`voice-cloud-key-state-${service}`);
    if (keyState) {
        keyState.dataset.state = keySaved ? 'ok' : typed ? 'dirty' : '';
        keyState.textContent = keySaved
            ? typed ? `✓ ${provider.label} key saved. The one pasted replaces it when you save.` : `✓ ${provider.label} key saved.`
            : typed ? `${provider.label} key not saved yet: Save keeps it.` : `No ${provider.label} key saved yet.`;
    }
    const remove = document.querySelector<HTMLButtonElement>(`[data-voice-key-remove="${service}"]`);
    if (remove) {
        remove.hidden = !keySaved;
        remove.textContent = `Remove ${provider.label} key`;
    }
    const status = document.getElementById(`voice-cloud-status-${service}`);
    if (!status) {
        return;
    }
    const result = settingsState.voiceSaveResult;
    const [state, text] = settingsState.voiceSaving
        ? ['testing', 'Saving and testing…']
        : result
          ? [result.ok ? 'ok' : 'error', result.message]
          : !keySaved && !typed
            ? ['error', `${provider.label} needs an API key: click "Get ${provider.label} API key", create one, paste it here, then Save.`]
            : ['', ''];
    status.dataset.state = state;
    status.textContent = text;
}

/** The Text-to-speech Cloud card's Voice picker: the provider's voices, and the one set now if it is none of them. */
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

/** Which services' forms (or pasted keys) differ from what is saved, for the page's Save bar. */
function renderVoiceUnsaved(): void {
    for (const service of SERVICES) {
        settingsState.voiceUnsaved[service] = isVoiceDirty(service) || typedApiKey(service) !== undefined;
    }
    renderSaveBar();
}

/** Everything on the Voice tab that follows the form: cards, panels, section status lines, the save bar. */
export function renderVoiceTab(): void {
    for (const service of SERVICES) {
        const setup = currentSetup(service);
        document.querySelectorAll<HTMLElement>(`[data-voice-setup-card][data-voice-service="${service}"]`).forEach((card) => {
            const selected = card.dataset.voiceSetupCard === setup;
            card.classList.toggle('selected', selected);
            card.setAttribute('aria-checked', String(selected));
        });
        document.querySelectorAll<HTMLElement>(`[data-voice-setup-panel][data-voice-service="${service}"]`).forEach((panel) => {
            panel.hidden = panel.dataset.voiceSetupPanel !== setup;
        });
        renderBuiltinPanel(service, setup === 'builtin');
        renderCloudPanel(service);
        renderVoiceStatus(service);
    }
    renderVoiceprint();
    renderVoiceUnsaved();
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

function buildServiceHelp(service: VoiceService): HTMLElement {
    const help = el('details', 'voice-help');
    help.id = `voice-help-${service}`;
    const [summary, intro, builtin, own] = service === 'stt'
        ? [
            'How to set up speech-to-text',
            '<b>Speech-to-text</b> writes what you say: the chat mic, and voice mode. Pick where it runs, then Save. The voice that speaks back is set up on Text-to-speech.',
            'Runs on this computer (Moonshine), English only; the engine and its model download once, the first time it is used.',
            'any OpenAI-compatible speech-to-text server you run (for example speaches). Full control, including models and languages.',
        ]
        : [
            'How to set up text-to-speech',
            '<b>Text-to-speech</b> gives voice mode its voice. Pick where it runs, then Save. What you say is written by Speech-to-text, set up on its own tab.',
            'Runs on this computer (Piper), an English voice; the engine and its model download once, the first time it is used.',
            'any OpenAI-compatible text-to-speech server you run (for example Kokoro-FastAPI). Full control, including models, voices and languages.',
        ];
    const providers = cloudProviders(service).map((p) => p.label).join(' or ');
    help.innerHTML = `
        <summary>${summary}</summary>
        <p>${intro}</p>
        <ul>
            <li><b>Built-in</b>: nothing to set up. ${builtin}</li>
            <li><b>Cloud service</b>: ${providers}. Best quality and many languages; needs an account and an API key (paid by use). Click "Get API key", paste the key, then Save: it also tests.</li>
            <li><b>My own server</b>: ${own}</li>
        </ul>
        <p>Changes wait until you press <b>Save</b>; Discard goes back to what is saved.</p>`;
    return help;
}

function buildSetupCards(service: VoiceService): HTMLElement {
    const cards = el('div', 'voice-setup-cards');
    cards.setAttribute('role', 'radiogroup');
    cards.setAttribute('aria-label', `How ${SERVICE_NAME[service].toLowerCase()} is set up`);
    const card = (setup: VoiceSetup, title: string, sub: string) => `
        <button type="button" class="voice-setup-card" role="radio" aria-checked="false" data-voice-service="${service}" data-voice-setup-card="${setup}">
            <span class="voice-setup-title">${escapeHtml(title)}</span>
            <span class="voice-setup-sub">${escapeHtml(sub)}</span>
        </button>`;
    cards.innerHTML = [
        card('builtin', 'Built-in', 'No setup · English'),
        card('cloud', 'Cloud service', `${cloudProviders(service).map((p) => p.label).join(' or ')} · API key`),
        card('own', 'My own server', 'OpenAI-compatible, you run it'),
    ].join('');
    return cards;
}

function buildBuiltinPanel(service: VoiceService): HTMLElement {
    const panel = el('div', 'voice-setup-panel');
    panel.dataset.voiceSetupPanel = 'builtin';
    panel.dataset.voiceService = service;
    const description = service === 'stt'
        ? 'Speech-to-text (Moonshine) runs on this computer, in the background; what you say is not sent anywhere. English only.'
        : 'The voice (Piper) runs on this computer, in the background; what voice mode says is not sent anywhere. English only.';
    panel.innerHTML = `
        <p class="setting-description">${description}</p>
        <p class="voice-status" id="voice-builtin-status-${service}" role="status"></p>
        <button type="button" class="setting-btn secondary" data-voice-builtin-download="${service}" hidden>Download now</button>`;
    return panel;
}

function buildCloudPanel(service: VoiceService): HTMLElement {
    const panel = el('div', 'voice-setup-panel');
    panel.dataset.voiceSetupPanel = 'cloud';
    panel.dataset.voiceService = service;
    const voiceRow = service === 'tts'
        ? `<div class="setting-row" id="voice-cloud-voice-row">
            <div class="setting-label-row"><label for="voice-cloud-voice">Voice</label></div>
            <select id="voice-cloud-voice" class="setting-select"></select>
            <p class="setting-description">How voice mode sounds. "Try the voice…" below reads a sentence aloud with the voice picked (and the key pasted, if any).</p>
        </div>`
        : '';
    panel.innerHTML = `
        <div class="setting-row">
            <div class="setting-label-row"><label for="voice-cloud-provider-${service}">Provider</label></div>
            <select id="voice-cloud-provider-${service}" class="setting-select" data-voice-cloud-provider="${service}">
                ${cloudProviders(service).map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('')}
            </select>
            <p class="setting-description" id="voice-cloud-note-${service}"></p>
        </div>
        ${voiceRow}
        <div class="setting-row">
            <div class="setting-label-row"><label for="voice-cloud-key-${service}">API key</label></div>
            <div class="setting-input-wrapper">
                <input type="password" id="voice-cloud-key-${service}" class="setting-input" autocomplete="off" spellcheck="false" data-voice-cloud-key="${service}">
                <button type="button" class="setting-btn secondary" data-voice-key-page="${service}">Get API key</button>
            </div>
            <div class="voice-key-state-row">
                <p class="voice-status" id="voice-cloud-key-state-${service}" role="status"></p>
                <button type="button" class="setting-btn secondary small" data-voice-key-remove="${service}" hidden>Remove key</button>
            </div>
            <p class="setting-description">Each provider has its own key, kept in VS Code's secret storage (not in settings.json) and sent only to that provider. Speech-to-text and text-to-speech on the same provider share it.</p>
        </div>
        <p class="voice-status" id="voice-cloud-status-${service}" role="status"></p>`;
    return panel;
}

function buildServerHelp(service: VoiceService): HTMLElement {
    const help = el('details', 'voice-help');
    help.innerHTML = service === 'stt'
        ? `
        <summary>How to run a local speech-to-text server</summary>
        <p>Speech-to-text with <a href="https://speaches.ai/installation/">speaches</a> (faster-whisper), in Docker:</p>
        <pre><code>docker run --rm --detach --publish 8000:8000 --name speaches \\
  --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \\
  ghcr.io/speaches-ai/speaches:latest-cpu
SPEACHES_BASE_URL=http://localhost:8000 uvx speaches-cli model download Systran/faster-distil-whisper-small.en</code></pre>
        <p>Then enter URL <code>http://localhost:8000/v1</code> and model <code>Systran/faster-distil-whisper-small.en</code>.</p>`
        : `
        <summary>How to run a local text-to-speech server</summary>
        <p>A voice with <a href="https://github.com/remsky/Kokoro-FastAPI">Kokoro-FastAPI</a>, in Docker:</p>
        <pre><code>docker run --detach --publish 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest</code></pre>
        <p>Then enter URL <code>http://localhost:8880/v1</code>, model <code>kokoro</code>, voice <code>af_bella</code>; for Chinese, language field "lang_code: z".</p>`;
    return help;
}

function buildOwnServerPanel(service: VoiceService, data: SettingsData): HTMLElement {
    const panel = el('div', 'voice-setup-panel voice-own-panel');
    panel.dataset.voiceSetupPanel = 'own';
    panel.dataset.voiceService = service;
    const section = service === 'stt'
        ? buildDraftSection('stt', 'Speech-to-text server', [
            buildHiddenField('voice.sttEngine', data.voice.sttEngine),
            buildServiceUrlRow('stt', 'voice.sttUrl', 'URL', data.voice.sttUrl, 'http://localhost:8000/v1',
                'OpenAI-compatible base URL, usually ending in /v1. Empty: speech-to-text uses the built-in engine.'),
            buildTextInput('voice.sttModel', 'Model', data.voice.sttModel,
                'Leave it empty and press Test: the model the server offers is filled in.',
                'filled in by Test'),
        ])
        : buildDraftSection('tts', 'Text-to-speech server', [
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
        ]);
    panel.append(buildServerHelp(service), section);
    return panel;
}

/** A service's engine: the help, the cards with the Built-in and Cloud details, then your own server's fields. */
function buildEngine(service: VoiceService, data: SettingsData): HTMLElement[] {
    return [
        buildServiceHelp(service),
        buildSection(`${SERVICE_NAME[service]} engine`, [buildSetupCards(service), buildBuiltinPanel(service), buildCloudPanel(service)], service),
        buildOwnServerPanel(service, data),
    ];
}

/** What every speech-to-text engine shares: language and listening (Try is on the Save bar). */
function buildListeningSection(data: SettingsData): HTMLElement {
    const fields = el('div');
    fields.dataset.draft = 'stt';
    fields.append(
        buildTextInput('voice.language', 'Language', data.voice.language,
            'ISO-639-1 hint such as zh or en. Empty lets the service detect it per utterance (Built-in is English only).',
            'auto-detect'),
        buildNumberInput('voice.vadConfidence', 'Speech detection threshold', data.voice.vadConfidence, 0.1, 0.95, 0.05,
            'Lower it (e.g. 0.35) if quiet speech is missed; raise it if background noise gets transcribed.'),
        buildNumberInput('voice.vadStopSecs', 'Pause that ends a sentence (s)', data.voice.vadStopSecs, 0.2, 3, 0.1,
            'Each sentence is transcribed as soon as this much silence follows it.'),
    );
    return buildSection('Listening', [fields], 'voice-listening');
}

/** What every text-to-speech engine shares: speaking speed (Try is on the Save bar). */
function buildSpeakingSection(data: SettingsData): HTMLElement {
    const fields = el('div');
    fields.dataset.draft = 'tts';
    fields.append(buildNumberInput('voiceAgent.tts.speed', 'Speaking speed', data.tts.speed, 0.5, 2, 0.1, 'Voice mode speaking speed (0.5–2).'));
    return buildSection('Speaking', [fields], 'voice-speaking');
}

export function buildVoiceTab(data: SettingsData): HTMLElement {
    return buildTabPanel('voice', buildVoiceSubtabs({
        stt: [...buildEngine('stt', data), buildListeningSection(data), buildVoiceprintSection(data)],
        tts: [...buildEngine('tts', data), buildSpeakingSection(data)],
        agent: [
            buildSection(
                'Voice agent',
                [
                    buildSpeakersRow(data.voiceSpeakers),
                    buildVoiceModelRow(data.voiceModel, data.voiceModels),
                    buildVoiceSkillsRow(),
                ],
                'voice-agent',
            ),
            buildVoicePromptSection(data.voiceExtraPrompt),
            buildSection('Sentences', [buildSentenceActionsRow(data.voiceMessageButtons, data.voiceTranslateTo)], 'voice-sentences'),
        ],
    }));
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
                // The URL field is on My own server: the card stays there, even emptied (the built-in engine then).
                settingsState.voiceSetup[service] = 'own';
                followUrl(service);
            }
            renderVoiceTab();
        };
        field.addEventListener('input', keep);
        field.addEventListener('change', keep);
    });

    document.querySelectorAll<HTMLInputElement>('[data-voice-cloud-key]').forEach((field) => {
        const service = voiceServiceOf(field.dataset.voiceCloudKey);
        if (!service) return;
        field.addEventListener('input', () => {
            setKeyField(field, field.value);
            shareTypedKey(service);
            settingsState.voiceSaveResult = undefined;
            renderVoiceTab();
        });
    });
    document.querySelectorAll<HTMLButtonElement>('[data-voice-setup-card]').forEach((card) => {
        const service = voiceServiceOf(card.dataset.voiceService);
        if (!service) return;
        card.addEventListener('click', () => chooseVoiceSetup(service, card.dataset.voiceSetupCard as VoiceSetup));
    });
    document.querySelectorAll<HTMLSelectElement>('[data-voice-cloud-provider]').forEach((select) => {
        const service = voiceServiceOf(select.dataset.voiceCloudProvider);
        if (!service) return;
        select.addEventListener('change', () => {
            settingsState.voiceSaveResult = undefined;
            applyCloudProvider(service, select.value);
            // A pasted key belongs to the provider it was pasted for: the new one's, if pasted on the other service.
            const field = keyField(service);
            if (field) {
                setKeyField(field, '');
                shareTypedKey(otherService(service));
            }
            renderVoiceTab();
        });
    });
    document.querySelectorAll<HTMLButtonElement>('[data-voice-key-page]').forEach((button) => {
        const service = voiceServiceOf(button.dataset.voiceKeyPage);
        if (!service) return;
        button.addEventListener('click', () => post({ type: 'openVoiceKeyPage', provider: cloudProvider(service) }));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-voice-key-remove]').forEach((button) => {
        const service = voiceServiceOf(button.dataset.voiceKeyRemove);
        if (!service) return;
        button.addEventListener('click', () => post({ type: 'removeVoiceApiKey', provider: cloudProvider(service) }));
    });
    const cloudVoice = document.getElementById('voice-cloud-voice');
    cloudVoice?.addEventListener('change', () => {
        if (cloudVoice instanceof HTMLSelectElement) {
            // The voice setting itself (the own-server Voice field), as a draft until Save.
            setDraft('voiceAgent.tts.voice', cloudVoice.value);
            settingsState.voiceSaveResult = undefined;
            renderVoiceTab();
        }
    });
    document.querySelectorAll<HTMLButtonElement>('[data-voice-builtin-download]').forEach((button) => {
        const service = voiceServiceOf(button.dataset.voiceBuiltinDownload);
        if (!service) return;
        button.addEventListener('click', () => {
            settingsState.builtinVoice[service] = { ...settingsState.builtinVoice[service], busy: true, error: undefined };
            post({ type: 'prepareBuiltinVoice', service });
            renderVoiceTab();
        });
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
    bindVoicePrompt();
    bindVoiceprint();
}
