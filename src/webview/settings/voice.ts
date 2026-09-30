import { escapeHtml } from '../../shared/html';
import type { SettingsData, VoiceSettings } from '../../shared/protocol';
import { TRANSLATION_LANGUAGES, translationLanguage } from '../../shared/translationLanguages';
import { AVATAR_PRESETS, AVATAR_PRESET_PREFIX, ICON_PRESETS, avatarPresetSrc } from '../../shared/avatarPresets';
import { DEFAULT_SPEAKER_NAMES, type VoiceSpeakerId } from '../../shared/voiceSpeakers';
import { BUILTIN_VOICE_SKILLS } from '../../shared/builtinVoiceSkills';
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
        <p class="setting-description">In the Bot view and the chat (prompts, replies, Thought blocks, card text), hold Alt to highlight the sentence under the pointer: Alt+click reads it aloud with the text-to-speech above, Alt+right-click shows its translation in a floating panel (the text is sent to Google Translate). Hold Shift too (Alt+Shift) for the whole paragraph. Selecting text with the mouse shows Read aloud and Translate buttons for the selection. While text is read aloud, click it to pause or resume, double-click a word to read on from there, click elsewhere or press Escape to stop. Off by default.</p>
        <div class="voice-translate-to">
            <div class="setting-label-row">
                <label for="setting-voiceAgent.translateTo">Translate into</label>
            </div>
            <select id="setting-voiceAgent.translateTo" class="setting-select" data-key="voiceAgent.translateTo">${options}</select>
        </div>
    `;
    return row;
}

/** Arrow into a tray: the Upload tile of the avatar picker. */
const ICON_UPLOAD =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 10.5V2.5M5 5.5l3-3 3 3"/><path d="M2.5 10v2.25c0 .7.55 1.25 1.25 1.25h8.5c.7 0 1.25-.55 1.25-1.25V10"/></svg>';

/** Closes the open avatar picker on a press outside it or Escape; replaced by each build of the row. */
let avatarMenuListeners: AbortController | undefined;

/**
 * The names and avatars in the Bot view, you and the voice agent: the avatar, as the Bot view shows
 * it, beside the name. Clicking the avatar opens a picker under it: the two default icons, the
 * pixel-art presets, and Upload (a picture of your own). Saved at once: the name by the page's
 * generic `[data-key]` handler, an avatar on click.
 */
export function buildSpeakersRow(speakers: SettingsData['voiceSpeakers']): HTMLElement {
    const row = el('div', 'setting-row voice-speakers');
    const who: Record<VoiceSpeakerId, string> = { user: 'You', bot: 'Voice agent' };
    // Each tile's setting value: the speaker's own default icon is the empty setting.
    const choices = (id: VoiceSpeakerId) => [
        ...ICON_PRESETS.map((p) => ({ value: p.icon === id ? '' : AVATAR_PRESET_PREFIX + p.id, label: p.label, html: DEFAULT_AVATAR[p.icon] })),
        ...AVATAR_PRESETS.map((p) => ({ value: AVATAR_PRESET_PREFIX + p.id, label: p.label, html: `<img src="${avatarPresetSrc(p.id)}" alt="">` })),
    ];
    row.innerHTML = `
        <div class="setting-label-row"><label>Names and avatars</label></div>
        ${(['user', 'bot'] as const)
            .map((id) => {
                const { name, avatar, error } = speakers[id];
                const own = AVATAR_PRESET_PREFIX + ICON_PRESETS.find((p) => p.icon === id)!.id;
                const current = avatar.trim() === own ? '' : avatar.trim();
                const tiles = choices(id);
                // Anything else set (a picture, or text from settings.json) counts as uploaded.
                const uploaded = !tiles.some((c) => c.value === current);
                return `
        <div class="voice-speaker voice-speaker--${id}" data-speaker="${id}">
            <label class="voice-speaker-who" for="setting-voiceAgent.${id}Name">${who[id]}</label>
            <div class="voice-speaker-line">
                <button type="button" class="voice-speaker-avatar" aria-haspopup="true" aria-expanded="false" title="Change the avatar" aria-label="${who[id]}: change the avatar">${DEFAULT_AVATAR[id]}</button>
                <input type="text" id="setting-voiceAgent.${id}Name" class="setting-input voice-speaker-name" data-key="voiceAgent.${id}Name" value="${escapeHtml(name)}" placeholder="${DEFAULT_SPEAKER_NAMES[id]}" maxlength="40">
                <div class="voice-avatar-menu" role="group" aria-label="${who[id]}: avatars" hidden>
                    ${tiles
                        .map(
                            (c) =>
                                `<button type="button" class="voice-avatar-preset" data-avatar-value="${escapeHtml(c.value)}" title="${escapeHtml(c.label)}" aria-label="${escapeHtml(c.label)}" aria-pressed="${c.value === current}">${c.html}</button>`,
                        )
                        .join('')}
                    <button type="button" class="voice-avatar-preset voice-avatar-upload" data-pick-avatar="${id}" title="Upload a picture (PNG, JPEG, GIF, WebP or SVG, under 2 MB)" aria-label="Upload a picture" aria-pressed="${uploaded}">${ICON_UPLOAD}</button>
                </div>
            </div>
            ${error ? `<p class="setting-description voice-speaker-error">${escapeHtml(error)}</p>` : ''}
        </div>`;
            })
            .join('')}
        <p class="setting-description">Shown on each turn in the Bot view; an empty name goes back to User or Bot. Click an avatar to change it: pick one, or upload a picture. The voice agent is told both names and answers to its own.</p>
    `;

    const menus = [...row.querySelectorAll<HTMLElement>('.voice-speaker')].map((speaker) => ({
        speaker,
        id: speaker.dataset.speaker === 'bot' ? ('bot' as const) : ('user' as const),
        toggle: speaker.querySelector<HTMLButtonElement>('.voice-speaker-avatar')!,
        menu: speaker.querySelector<HTMLElement>('.voice-avatar-menu')!,
    }));
    const close = () => {
        for (const { toggle, menu } of menus) {
            menu.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
        }
    };
    for (const { speaker, id, toggle, menu } of menus) {
        void avatarMarkup(speakers[id].resolved, DEFAULT_AVATAR[id]).then((html) => {
            toggle.innerHTML = html;
        });
        toggle.addEventListener('click', () => {
            const open = menu.hidden;
            close();
            menu.hidden = !open;
            toggle.setAttribute('aria-expanded', String(open));
            if (open) {
                menu.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
            }
        });
        const tiles = speaker.querySelectorAll<HTMLButtonElement>('.voice-avatar-preset');
        tiles.forEach((tile) => {
            tile.addEventListener('click', () => {
                close();
                toggle.focus();
                if (tile.dataset.pickAvatar) {
                    vscode.postMessage({ type: 'pickAvatar', speaker: id });
                    return;
                }
                tiles.forEach((t) => t.setAttribute('aria-pressed', String(t === tile)));
                toggle.innerHTML = tile.innerHTML;
                vscode.postMessage({ type: 'updateSetting', key: `voiceAgent.${id}Avatar`, value: tile.dataset.avatarValue ?? '' });
            });
        });
    }
    avatarMenuListeners?.abort();
    avatarMenuListeners = new AbortController();
    const { signal } = avatarMenuListeners;
    document.addEventListener(
        'pointerdown',
        (e) => {
            if (!menus.some(({ toggle, menu }) => toggle.contains(e.target as Node) || menu.contains(e.target as Node))) {
                close();
            }
        },
        { signal },
    );
    document.addEventListener(
        'keydown',
        (e) => {
            const open = menus.find(({ menu }) => !menu.hidden);
            if (e.key === 'Escape' && open) {
                close();
                open.toggle.focus();
            }
        },
        { signal },
    );
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
        <p class="setting-description">The built-in skills (${BUILTIN_VOICE_SKILLS.join(', ')}) are always loaded. Beyond them, only the skills chosen here are, for skills written for the voice agent rather than for the coding worker; none by default. omp loads them by name, pi by their SKILL.md files. The list is the current chat tab's. Takes effect after Voice Agent — Stop, when it starts again.</p>
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
    // A chosen name that is also built in is loaded once, as the built-in: shown with the built-ins.
    const extra = chosen.filter((name) => !BUILTIN_VOICE_SKILLS.includes(name));
    row.querySelector('.voice-skills-summary')!.textContent =
        extra.length === 0 ? 'No other skills' : extra.length === 1 ? extra[0] : `${extra.length} skills: ${extra.join(', ')}`;

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
        const builtin = BUILTIN_VOICE_SKILLS.includes(box.dataset.voiceSkill ?? '');
        box.checked = builtin || chosen.includes(box.dataset.voiceSkill ?? '');
        box.disabled = builtin;
        box.title = builtin ? 'Built in: always loaded' : '';
    });

    const builtinChips = BUILTIN_VOICE_SKILLS.map((name) => `<span class="voice-skill-chip builtin" title="Built in: always loaded">
            <span>${escapeHtml(name)}</span>
        </span>`);
    const chosenChips = extra.map((name) => {
        // Chosen before, but not installed for this tab's CLI: the voice agent does not load it.
        const missing = installed !== undefined && !installed.some((skill) => skill.name === name);
        const title = missing ? 'Not installed for the current chat tab: not loaded' : name;
        return `<span class="voice-skill-chip${missing ? ' missing' : ''}" title="${escapeHtml(title)}">
            <span>${escapeHtml(name)}</span>
            <button type="button" class="voice-skill-remove" data-voice-skill-remove="${escapeHtml(name)}" aria-label="Remove ${escapeHtml(name)}">×</button>
        </span>`;
    });
    row.querySelector('.voice-skills-chips')!.innerHTML = [...builtinChips, ...chosenChips].join('');
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


