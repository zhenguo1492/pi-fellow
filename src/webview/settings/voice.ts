import { escapeHtml } from '../../shared/html';
import type { SettingsData, VoiceSettings } from '../../shared/protocol';
import { TRANSLATION_LANGUAGES, translationLanguage } from '../../shared/translationLanguages';
import { AVATAR_PRESETS, AVATAR_PRESET_PREFIX, avatarPresetSrc } from '../../shared/avatarPresets';
import { DEFAULT_SPEAKER_NAMES, type VoiceSpeakerId } from '../../shared/voiceSpeakers';
import { TTS_LANGUAGE_FIELDS, type TtsConfig } from '../../voiceAgent/tts';
import { DEFAULT_AVATAR, avatarMarkup } from '../avatar';
import { vscode } from './api';
import { buildSection, buildTextInput, el } from './dom';
import { settingsState } from './state';

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
        sttEngine: fieldText('voice.sttEngine') === 'custom' ? 'custom' : 'builtin',
        sttUrl: fieldText('voice.sttUrl'),
        sttModel: fieldText('voice.sttModel'),
        language: fieldText('voice.language'),
        vadConfidence: fieldNumber('voice.vadConfidence', saved?.vadConfidence ?? 0.5),
        vadStopSecs: fieldNumber('voice.vadStopSecs', saved?.vadStopSecs ?? 0.8),
    };
}

/** The TTS section as typed. */
export function readTtsForm(): TtsConfig {
    const languageField = fieldText('voiceAgent.tts.languageField');
    return {
        engine: fieldText('voiceAgent.tts.engine') === 'custom' ? 'custom' : 'builtin',
        languageField: TTS_LANGUAGE_FIELDS.find((field) => field === languageField) ?? 'none',
        url: fieldText('voiceAgent.tts.url'),
        model: fieldText('voiceAgent.tts.model'),
        voice: fieldText('voiceAgent.tts.voice'),
        speed: fieldNumber('voiceAgent.tts.speed', settingsState.currentSettings?.tts.speed ?? 1),
    };
}

/** Fills the Model field's picker with the models the custom TTS server listed at its last Test; hidden when there are none. */
function fillTtsModelPicker(picker: HTMLSelectElement): void {
    const models = settingsState.ttsServerModels;
    picker.hidden = models.length === 0;
    picker.innerHTML = [`<option value="">Pick one of the ${models.length} model(s) the server lists…</option>`]
        .concat(models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`))
        .join('');
}

export function renderTtsModelPicker(): void {
    const picker = document.querySelector('[data-tts-model-pick]');
    if (picker instanceof HTMLSelectElement) {
        fillTtsModelPicker(picker);
    }
}

/** The TTS Model field, with a picker of the models the server listed once Test has run. */
export function buildTtsModelRow(value: string): HTMLElement {
    const row = buildTextInput('voiceAgent.tts.model', 'Model', value,
        'Leave it empty and press Test: the model the server offers is filled in. Test also lists the others to pick from.',
        'filled in by Test');
    const input = row.querySelector('input');
    const picker = document.createElement('select');
    picker.className = 'setting-select';
    picker.dataset.ttsModelPick = '';
    fillTtsModelPicker(picker);
    picker.addEventListener('change', () => {
        if (input && picker.value) {
            input.value = picker.value;
            // A draft like one typed: kept until Test saves it.
            input.dispatchEvent(new Event('input', { bubbles: true }));
            picker.value = '';
        }
    });
    input?.after(picker);
    return row;
}

/** The section's form no longer matches what is saved (and in use). */
export function isVoiceDirty(service: VoiceService): boolean {
    if (!settingsState.currentSettings) {
        return false;
    }
    const [form, saved]: [object, object] = service === 'stt'
        ? [readSttForm(), settingsState.currentSettings.voice]
        : [readTtsForm(), settingsState.currentSettings.tts];
    const savedValues: Record<string, unknown> = Object.fromEntries(Object.entries(saved));
    return Object.entries(form).some(([key, value]) => savedValues[key] !== value);
}

/** The section's form as a string, to tell whether a Test result is still about what is shown. */
export function voiceFormKey(service: VoiceService): string {
    return JSON.stringify(service === 'stt' ? readSttForm() : readTtsForm());
}

/**
 * Test button (text, or a green check / red cross) and status line of one section: the last Test of
 * the values shown, else unsaved changes, else the check of the saved settings.
 */
export function renderVoiceStatus(service: VoiceService): void {
    const check = settingsState.currentSettings?.voiceReadiness[service];
    const dirty = isVoiceDirty(service);
    const tested = settingsState.voiceTestResults[service];
    const result = tested && tested.form === voiceFormKey(service) ? tested : undefined;
    const testing = settingsState.voiceTesting[service] || (!result && !dirty && check?.checking === true);
    const ok = !testing && (result ? result.ok : !dirty && check?.ok === true);
    const failed = !testing && (result ? !result.ok : !dirty && check !== undefined && !check.ok);
    const reason = result?.message ?? check?.reason;
    const button = document.querySelector<HTMLButtonElement>(`[data-voice-test="${service}"]`);
    if (button) {
        button.dataset.state = testing ? 'testing' : ok ? 'ok' : failed ? 'failed' : '';
        button.disabled = settingsState.voiceTesting[service];
        const title = testing
            ? 'Testing the connection…'
            : ok
              ? 'Connected. Click to test again.'
              : failed
                ? `${reason ?? 'Not connected.'}\nClick to test again.`
                : 'Test the connection with the values as shown (nothing is saved).';
        button.title = title;
        button.setAttribute('aria-label', title);
    }
    const status = document.getElementById(`voice-status-${service}`);
    if (!status) {
        return;
    }
    const [state, text] = testing
        ? ['testing', 'Checking…']
        : result
          ? [result.ok ? 'ok' : 'error', `${result.message}${dirty ? ' (not saved yet)' : ''}`]
          : dirty
            ? ['dirty', 'Unsaved changes: Save keeps them; until then the previous settings stay in use.']
            : ok
              ? ['ok', 'Connected.']
              : [check?.checking ? 'testing' : 'error', reason ?? 'Not checked yet.'];
    status.dataset.state = state;
    status.textContent = text;
}

/**
 * A URL field with the section's "Test" button: it checks the values as shown, then carries a green
 * check (connected) or a red cross (not; the tooltip says why). Edited again, the mark goes.
 */
export function buildServiceUrlRow(service: VoiceService, key: string, label: string, value: string, placeholder: string, description: string): HTMLElement {
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

/** A setting the form carries but does not show (the engine of a section, set by the setup cards and the URL). */
export function buildHiddenField(key: string, value: string): HTMLElement {
    const field = document.createElement('input');
    field.type = 'hidden';
    field.id = `setting-${key}`;
    field.dataset.key = key;
    field.value = value;
    return field;
}

/** The section's status line (its Test result, unsaved changes, or the check of the saved settings). */
function buildVoiceStatusRow(service: VoiceService): HTMLElement {
    const row = el('div', 'setting-row voice-actions');
    row.innerHTML = `<p class="voice-status" id="voice-status-${service}" role="status"></p>`;
    return row;
}

/** A section whose fields are drafts until Save. */
export function buildDraftSection(service: VoiceService, title: string, children: HTMLElement[]): HTMLElement {
    const section = buildSection(title, [...children, buildVoiceStatusRow(service)], service);
    section.dataset.draft = service;
    return section;
}

/**
 * `voiceAgent.messageButtons` (the Alt gestures on sentences in the Bot view and the chat) and, while it is on,
 * `voiceAgent.translateTo`; both saved at once by the page's generic `[data-key]` handlers.
 */
export function buildSentenceActionsRow(enabled: boolean, translateTo: string): HTMLElement {
    const row = el('div', 'setting-row voice-sentence-actions');
    const target = translationLanguage(translateTo).code;
    const options = TRANSLATION_LANGUAGES.map(
        (l) => `<option value="${l.code}" ${l.code === target ? 'selected' : ''}>${escapeHtml(l.native === l.name ? l.name : `${l.native} — ${l.name}`)}</option>`,
    ).join('');
    row.innerHTML = `
        <div class="setting-toggle-row">
            <label class="toggle-label" for="setting-voiceAgent.messageButtons">
                <span class="toggle-switch">
                    <input type="checkbox" id="setting-voiceAgent.messageButtons" data-key="voiceAgent.messageButtons" ${enabled ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </span>
                <span>Read aloud and translate sentences (Alt)</span>
            </label>
        </div>
        <p class="setting-description">In the Bot view and the chat (prompts, replies, Thought blocks, card text), hold Alt to highlight the sentence under the pointer: Alt+click reads it aloud with the text-to-speech above, Alt+right-click shows its translation in a floating panel (the sentence is sent to Google Translate). Off by default.</p>
        <div class="voice-translate-to">
            <div class="setting-label-row">
                <label for="setting-voiceAgent.translateTo">Translate into</label>
            </div>
            <select id="setting-voiceAgent.translateTo" class="setting-select" data-key="voiceAgent.translateTo">${options}</select>
        </div>
    `;
    return row;
}

/**
 * The names and avatars in the Bot view, you and the voice agent: a preview of the avatar as the
 * Bot view shows it, the name, the avatar setting (an emoji, a few letters or a picture's path)
 * with "Choose picture…", and the pixel-art presets to click. Saved at once, the fields by the
 * page's generic `[data-key]` handlers.
 */
export function buildSpeakersRow(speakers: SettingsData['voiceSpeakers']): HTMLElement {
    const row = el('div', 'setting-row voice-speakers');
    const who: Record<VoiceSpeakerId, string> = { user: 'You', bot: 'Voice agent' };
    row.innerHTML = `
        <div class="setting-label-row"><label>Names and avatars</label></div>
        ${(['user', 'bot'] as const)
            .map((id) => {
                const { name, avatar, error } = speakers[id];
                return `
        <div class="voice-speaker" data-speaker="${id}">
            <div class="voice-speaker-avatar voice-speaker-avatar--${id}" aria-hidden="true">${DEFAULT_AVATAR[id]}</div>
            <div class="voice-speaker-fields">
                <span class="voice-speaker-who">${who[id]}</span>
                <input type="text" id="setting-voiceAgent.${id}Name" class="setting-input voice-speaker-name" data-key="voiceAgent.${id}Name" value="${escapeHtml(name)}" placeholder="${DEFAULT_SPEAKER_NAMES[id]}" maxlength="40" aria-label="${who[id]}: name">
                <div class="setting-input-wrapper">
                    <input type="text" id="setting-voiceAgent.${id}Avatar" class="setting-input" data-key="voiceAgent.${id}Avatar" value="${escapeHtml(avatar)}" placeholder="Emoji, letters, or a picture's path" aria-label="${who[id]}: avatar">
                    <button type="button" class="setting-btn secondary" data-pick-avatar="${id}">Choose picture…</button>
                </div>
                <div class="voice-avatar-presets voice-avatar-presets--${id}" role="group" aria-label="${who[id]}: preset avatars">
                    ${AVATAR_PRESETS.map(
                        (preset) =>
                            `<button type="button" class="voice-avatar-preset" data-avatar-preset="${preset.id}" title="${escapeHtml(preset.label)}" aria-label="${escapeHtml(preset.label)}" aria-pressed="${avatar.trim() === AVATAR_PRESET_PREFIX + preset.id}"><img src="${avatarPresetSrc(preset.id)}" alt=""></button>`,
                    ).join('')}
                </div>
                ${error ? `<p class="setting-description voice-speaker-error">${escapeHtml(error)}</p>` : ''}
            </div>
        </div>`;
            })
            .join('')}
        <p class="setting-description">Shown on each turn in the Bot view; empty fields go back to User, Bot and their icons. An avatar is one of the pixel-art presets, an emoji, up to two letters, or a picture (PNG, JPEG, GIF, WebP or SVG, under 2 MB). The voice agent is told both names and answers to its own.</p>
    `;
    for (const id of ['user', 'bot'] as const) {
        const preview = row.querySelector<HTMLElement>(`[data-speaker="${id}"] .voice-speaker-avatar`)!;
        void avatarMarkup(speakers[id].resolved, DEFAULT_AVATAR[id]).then((html) => {
            preview.innerHTML = html;
        });
    }
    row.querySelectorAll<HTMLButtonElement>('[data-pick-avatar]').forEach((button) => {
        button.addEventListener('click', () => {
            vscode.postMessage({ type: 'pickAvatar', speaker: button.dataset.pickAvatar === 'bot' ? 'bot' : 'user' });
        });
    });
    row.querySelectorAll<HTMLElement>('.voice-speaker').forEach((speaker) => {
        const id = speaker.dataset.speaker === 'bot' ? 'bot' : 'user';
        const buttons = speaker.querySelectorAll<HTMLButtonElement>('[data-avatar-preset]');
        buttons.forEach((button) => {
            button.addEventListener('click', () => {
                const value = AVATAR_PRESET_PREFIX + button.dataset.avatarPreset;
                speaker.querySelector<HTMLInputElement>(`[data-key="voiceAgent.${id}Avatar"]`)!.value = value;
                buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
                vscode.postMessage({ type: 'updateSetting', key: `voiceAgent.${id}Avatar`, value });
            });
        });
    });
    return row;
}

/**
 * The voice agent's skills: a dropdown of the chat tab's installed skills, a checkbox each, and the
 * chosen ones as removable chips under it. Saved at once; the contents follow `renderVoiceSkills`.
 */
export function buildVoiceSkillsRow(): HTMLElement {
    const row = el('div', 'setting-row voice-skills');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="voice-skills-filter">Skills</label>
        </div>
        <details class="voice-skills-picker">
            <summary class="voice-skills-summary"></summary>
            <div class="voice-skills-menu">
                <input type="text" id="voice-skills-filter" class="setting-input voice-skills-filter" placeholder="Filter skills" autocomplete="off">
                <div class="voice-skills-options" role="group" aria-label="Installed skills"></div>
            </div>
        </details>
        <div class="voice-skills-chips"></div>
        <p class="setting-description">Only these skills are loaded into the voice agent, for skills written for it rather than for the coding worker; none by default. omp loads them by name, pi by their SKILL.md files. The list is the current chat tab's. Takes effect after Voice Agent — Stop, when it starts again.</p>
    `;
    return row;
}

/** Shows the chosen skills (saved) against the installed ones, keeping the dropdown and its filter as they are. */
export function renderVoiceSkills(): void {
    const row = document.querySelector<HTMLElement>('.voice-skills');
    const chosen = settingsState.currentSettings?.voiceSkills;
    if (!row || !chosen) {
        return;
    }
    const installed = settingsState.loadedSkills;
    row.querySelector('.voice-skills-summary')!.textContent =
        chosen.length === 0 ? 'No skills' : chosen.length === 1 ? chosen[0] : `${chosen.length} skills: ${chosen.join(', ')}`;

    // Rebuilt only when the installed skills change: otherwise the checkboxes are set in place, so the
    // one just clicked keeps focus and the open dropdown stays open.
    const options = row.querySelector<HTMLElement>('.voice-skills-options')!;
    const listed = installed ? JSON.stringify(installed.map((skill) => [skill.name, skill.description])) : '';
    if (options.dataset.listed !== listed) {
        options.dataset.listed = listed;
        if (!installed) {
            options.innerHTML = '<p class="setting-description">Loading skills…</p>';
        } else if (installed.length === 0) {
            options.innerHTML = '<p class="setting-description">No skills found for the current chat tab. Add skill paths in the Skills tab.</p>';
        } else {
            options.innerHTML = installed.map((skill) => `
                <label class="voice-skill-option" data-filter="${escapeHtml(`${skill.name} ${skill.description}`.toLowerCase())}">
                    <input type="checkbox" data-voice-skill="${escapeHtml(skill.name)}">
                    <span class="voice-skill-text">
                        <span class="voice-skill-name">${escapeHtml(skill.name)}</span>
                        ${skill.description ? `<span class="voice-skill-desc">${escapeHtml(skill.description)}</span>` : ''}
                    </span>
                </label>`).join('');
            filterVoiceSkills(row);
        }
    }
    options.querySelectorAll<HTMLInputElement>('[data-voice-skill]').forEach((box) => {
        box.checked = chosen.includes(box.dataset.voiceSkill ?? '');
    });

    row.querySelector('.voice-skills-chips')!.innerHTML = chosen.map((name) => {
        // Chosen before, but not installed for this tab's CLI: the voice agent does not load it.
        const missing = installed !== undefined && !installed.some((skill) => skill.name === name);
        const title = missing ? 'Not installed for the current chat tab: not loaded' : name;
        return `<span class="voice-skill-chip${missing ? ' missing' : ''}" title="${escapeHtml(title)}">
            <span>${escapeHtml(name)}</span>
            <button type="button" class="voice-skill-remove" data-voice-skill-remove="${escapeHtml(name)}" aria-label="Remove ${escapeHtml(name)}">×</button>
        </span>`;
    }).join('');
}

function filterVoiceSkills(row: HTMLElement): void {
    const query = row.querySelector<HTMLInputElement>('.voice-skills-filter')!.value.trim().toLowerCase();
    row.querySelectorAll<HTMLElement>('.voice-skill-option').forEach((option) => {
        option.hidden = query !== '' && !(option.dataset.filter ?? '').includes(query);
    });
}

/** Saves the chosen skills and shows them before the settings come back. */
function saveVoiceSkills(skills: string[]): void {
    if (settingsState.currentSettings) {
        settingsState.currentSettings.voiceSkills = skills;
    }
    renderVoiceSkills();
    vscode.postMessage({ type: 'updateSetting', key: 'voiceAgent.skills', value: skills });
}

/** The listener on the document from the last bind: a full render builds a new page and binds again. */
let documentListeners: AbortController | undefined;

/** Once per render: later renders of the row replace only its contents, so these listeners stay. */
export function bindVoiceSkills(): void {
    documentListeners?.abort();
    documentListeners = undefined;
    const row = document.querySelector<HTMLElement>('.voice-skills');
    const picker = row?.querySelector<HTMLDetailsElement>('.voice-skills-picker');
    if (!row || !picker) {
        return;
    }
    const chosen = () => settingsState.currentSettings?.voiceSkills ?? [];
    row.addEventListener('change', (e) => {
        const box = e.target;
        if (!(box instanceof HTMLInputElement) || box.dataset.voiceSkill === undefined) {
            return;
        }
        const name = box.dataset.voiceSkill;
        const others = chosen().filter((n) => n !== name);
        saveVoiceSkills(box.checked ? [...others, name] : others);
    });
    row.addEventListener('click', (e) => {
        const remove = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-voice-skill-remove]') : null;
        if (remove) {
            saveVoiceSkills(chosen().filter((n) => n !== remove.dataset.voiceSkillRemove));
        }
    });
    row.querySelector('.voice-skills-filter')!.addEventListener('input', () => filterVoiceSkills(row));
    picker.addEventListener('toggle', () => {
        if (picker.open) {
            row.querySelector<HTMLInputElement>('.voice-skills-filter')!.focus();
        }
    });
    // Closes like a dropdown: on Escape, on a press outside it, and when Tab moves focus out of it.
    // Never on a focus change that has no destination: Chromium makes one when a mousedown on text
    // inside the open <details> blurs the filter, and closing the <details> during that mousedown hangs
    // the renderer (the whole VS Code window when the webview shares its process).
    picker.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && picker.open) {
            picker.open = false;
            picker.querySelector('summary')!.focus();
        }
    });
    picker.addEventListener('focusout', (e) => {
        if (e.relatedTarget instanceof Node && !picker.contains(e.relatedTarget)) {
            picker.open = false;
        }
    });
    // Pressing a skill's name or description, or the menu around them, keeps focus in the filter; the
    // click still ticks the skill.
    row.querySelector('.voice-skills-menu')!.addEventListener('mousedown', (e) => {
        if (!(e.target instanceof HTMLInputElement && e.target.type === 'text')) {
            e.preventDefault();
        }
    });
    documentListeners = new AbortController();
    document.addEventListener(
        'pointerdown',
        (e) => {
            if (picker.open && !(e.target instanceof Node && picker.contains(e.target))) {
                picker.open = false;
            }
        },
        { capture: true, signal: documentListeners.signal },
    );
}


