import { escapeHtml } from '../../shared/html';
import type { SettingsData, VoiceSettings } from '../../shared/protocol';
import type { TtsConfig } from '../../voiceAgent/tts';
import { buildNumberInput, buildSection, buildSelect, buildTextInput, el } from './dom';
import { settingsState } from './state';
import { buildTabPanel } from './tabs';

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
    renderVoiceStatus('stt');
    renderVoiceStatus('tts');
}

export type VoiceService = 'stt' | 'tts';

export function voiceServiceOf(value: string | undefined): VoiceService | undefined {
    return value === 'stt' || value === 'tts' ? value : undefined;
}

function fieldText(key: string): string {
    const field = document.getElementById(`setting-${key}`);
    return field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value.trim() : '';
}

/** A number field's value clamped to its range; `fallback` while it does not parse. */
function fieldNumber(key: string, fallback: number): number {
    const field = document.getElementById(`setting-${key}`);
    if (!(field instanceof HTMLInputElement) || Number.isNaN(field.valueAsNumber)) {
        return fallback;
    }
    return Math.min(Number(field.max), Math.max(Number(field.min), field.valueAsNumber));
}

/** The STT section as typed. */
export function readSttForm(): VoiceSettings {
    const saved = settingsState.currentSettings?.voice;
    return {
        sttUrl: fieldText('voice.sttUrl'),
        sttModel: fieldText('voice.sttModel'),
        language: fieldText('voice.language'),
        vadConfidence: fieldNumber('voice.vadConfidence', saved?.vadConfidence ?? 0.5),
        vadStopSecs: fieldNumber('voice.vadStopSecs', saved?.vadStopSecs ?? 0.8),
    };
}

/** The TTS section as typed. */
export function readTtsForm(): TtsConfig {
    const provider = fieldText('voiceAgent.tts.provider');
    return {
        provider: provider === 'chatterbox' || provider === 'kokoro' ? provider : 'openai',
        url: fieldText('voiceAgent.tts.url'),
        model: fieldText('voiceAgent.tts.model'),
        voice: fieldText('voiceAgent.tts.voice'),
        speed: fieldNumber('voiceAgent.tts.speed', settingsState.currentSettings?.tts.speed ?? 1),
    };
}

/** The section's form no longer matches what is saved (and in use). */
function isVoiceDirty(service: VoiceService): boolean {
    if (!settingsState.currentSettings) {
        return false;
    }
    const [form, saved]: [object, object] = service === 'stt'
        ? [readSttForm(), settingsState.currentSettings.voice]
        : [readTtsForm(), settingsState.currentSettings.tts];
    const savedValues: Record<string, unknown> = Object.fromEntries(Object.entries(saved));
    return Object.entries(form).some(([key, value]) => savedValues[key] !== value);
}

/** Test button (text, or a green check / red cross), status line of one section, from its check, draft and test state. */
export function renderVoiceStatus(service: VoiceService): void {
    const check = settingsState.currentSettings?.voiceReadiness[service];
    const testing = settingsState.voiceTesting[service] || (check?.checking === true && !isVoiceDirty(service));
    const dirty = !testing && isVoiceDirty(service);
    const ok = !testing && !dirty && check?.ok === true;
    const failed = !testing && !dirty && check !== undefined && !check.ok;
    const button = document.querySelector<HTMLButtonElement>(`[data-voice-test="${service}"]`);
    if (button) {
        button.dataset.state = testing ? 'testing' : ok ? 'ok' : failed ? 'failed' : '';
        button.disabled = settingsState.voiceTesting[service];
        const title = testing
            ? 'Testing the connection…'
            : ok
              ? 'Connected. Click to test again.'
              : failed
                ? `${check?.reason ?? 'Not connected.'}\nClick to test again.`
                : 'Save this section and test the connection.';
        button.title = title;
        button.setAttribute('aria-label', title);
    }
    const status = document.getElementById(`voice-status-${service}`);
    if (!status) {
        return;
    }
    const [state, text] = testing
        ? ['testing', 'Saving and checking…']
        : dirty
          ? ['dirty', 'Unsaved changes. Test saves them; until then the previous settings stay in use.']
          : ok
            ? ['ok', 'Connected.']
            : [check?.checking ? 'testing' : 'error', check?.reason ?? 'Not checked yet.'];
    status.dataset.state = state;
    status.textContent = text;
}

/** Puts typed-but-unsaved values back after a re-render. */
export function restoreVoiceDrafts(): void {
    for (const [id, value] of settingsState.voiceDrafts) {
        const field = document.getElementById(id);
        if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
            field.value = value;
        }
    }
    renderVoiceStatus('stt');
    renderVoiceStatus('tts');
}

function buildVoiceGuideCard(): HTMLElement {
    const note = el('p', 'voice-guide-note');
    note.textContent = 'Speech-to-text powers the chat mic (dictation) and voice mode; text-to-speech gives voice mode its voice. Edits here are drafts: the Test button next to each URL saves its section, even when the check fails, and then shows a green check or a red cross. Until then the previous settings stay in use. Dry run tries the values as typed without saving them.';
    return note;
}

/**
 * A URL field with the section's "Test" button: it saves the section and checks it, then carries a
 * green check (connected) or a red cross (not; the tooltip says why). Edited again, the mark goes.
 */
function buildServiceUrlRow(service: VoiceService, key: string, label: string, value: string, placeholder: string, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escapeHtml(label)}</label>
        </div>
        <div class="setting-input-wrapper">
            <input type="text" id="setting-${key}" class="setting-input" data-key="${key}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">
            <button type="button" class="setting-btn secondary voice-test-btn" data-voice-test="${service}">
                <span>Test</span>
                <svg class="voice-test-ok" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M13.5 4.5l-7 7L3 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <svg class="voice-test-failed" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
                </svg>
            </button>
        </div>
        <p class="setting-description">${escapeHtml(description)}</p>
    `;
    return row;
}

/** Dry run (tries the typed values unsaved) and the section's status line. */
function buildVoiceActions(service: VoiceService): HTMLElement {
    const row = el('div', 'setting-row voice-actions');
    row.innerHTML = `
        <div class="voice-actions-buttons">
            <button type="button" class="setting-btn secondary" data-voice-dry-run="${service}">Dry run…</button>
        </div>
        <p class="voice-status" id="voice-status-${service}" role="status"></p>
        <p class="setting-description">${service === 'stt'
            ? 'Dry run records one sentence from your microphone and shows what the service transcribed.'
            : 'Dry run synthesizes a sentence you type and gives you the audio to play.'}</p>
    `;
    return row;
}

/** A section whose fields are drafts until its Test button saves them. */
function buildDraftSection(service: VoiceService, title: string, children: HTMLElement[]): HTMLElement {
    const section = buildSection(title, [...children, buildVoiceActions(service)], service);
    section.dataset.draft = service;
    return section;
}

export function buildVoiceTab(data: SettingsData): HTMLElement {
    return buildTabPanel('voice', [
        buildVoiceGuideCard(),
        buildDraftSection('stt', 'Speech-to-Text (STT)', [
            buildServiceUrlRow('stt', 'voice.sttUrl', 'Speech-to-text URL', data.voice.sttUrl, 'http://127.0.0.1:8010/v1',
                'OpenAI-compatible API base URL; /audio/transcriptions is appended. Checked with GET /models: the chat mic works only when it answers.'),
            buildTextInput('voice.sttModel', 'Model', data.voice.sttModel,
                'Transcription model id. Empty uses the first model listed at /models.',
                'first model at /models'),
            buildTextInput('voice.language', 'Language', data.voice.language,
                'ISO-639-1 hint such as zh or en. Empty lets the model detect it per utterance.',
                'auto-detect'),
            buildNumberInput('voice.vadConfidence', 'VAD threshold', data.voice.vadConfidence, 0.1, 0.95, 0.05,
                'Silero VAD speech probability (0.1–0.95). Lower it (e.g. 0.35) if quiet speech is missed; raise it if background noise gets transcribed.'),
            buildNumberInput('voice.vadStopSecs', 'Pause to end an utterance (s)', data.voice.vadStopSecs, 0.2, 3, 0.1,
                'Each utterance is transcribed as soon as this much silence follows it, so text appears while you keep talking.'),
        ]),
        buildDraftSection('tts', 'Text-to-Speech (TTS)', [
            buildSelect('voiceAgent.tts.provider', 'Provider', data.tts.provider, [
                { value: 'openai', label: 'OpenAI-compatible' },
                { value: 'chatterbox', label: 'chatterbox-tts' },
                { value: 'kokoro', label: 'Kokoro-FastAPI' },
            ], 'Decides how the language is sent: chatterbox gets zh/en per sentence, Kokoro gets Chinese runs as lang_code z, OpenAI-compatible gets none.'),
            buildServiceUrlRow('tts', 'voiceAgent.tts.url', 'Text-to-speech URL', data.tts.url, 'http://127.0.0.1:8881/v1',
                'OpenAI-compatible base URL; /audio/speech is appended. Checked with GET /models, which must list the model below. Voice mode needs it.'),
            buildTextInput('voiceAgent.tts.model', 'Model', data.tts.model,
                'Empty uses the provider default: chatterbox-multilingual, kokoro, or tts-1.',
                'provider default'),
            buildTextInput('voiceAgent.tts.voice', 'Voice', data.tts.voice,
                'Empty uses the provider default: default (chatterbox), af_sarah (Kokoro), or alloy.',
                'provider default'),
            buildNumberInput('voiceAgent.tts.speed', 'Speed', data.tts.speed, 0.5, 2, 0.1,
                'Speaking speed (0.5–2). Takes effect when voice mode starts.'),
        ]),
    ]);
}
