/**
 * The settings page's Save bar, at the bottom of every tab. Every setting on the page is a draft
 * until Save: the bar says whether anything is unsaved, and its Discard and Save act on all of it
 * (each tab's edits, `edits.ts`, and both voice services' forms, `voiceSetup.ts`). On the Voice tab's
 * Speech-to-text and Text-to-speech sub-tabs it also holds their Try, left of Discard. A dot marks
 * each tab and Voice sub-tab with unsaved changes.
 */
import { vscode } from './api';
import { el } from './dom';
import { settingsState } from './state';

export function buildSaveBar(): HTMLElement {
    const bar = el('div', 'settings-save-bar');
    bar.innerHTML = `
        <span class="settings-save-state" id="settings-save-state" role="status"></span>
        <button type="button" class="setting-btn secondary" data-voice-dry-run="stt" data-save-bar-subtab="stt"
            title="Tries the settings as shown, saved or not: one sentence from your microphone.">Try speech-to-text…</button>
        <button type="button" class="setting-btn secondary" data-voice-dry-run="tts" data-save-bar-subtab="tts"
            title="Tries the settings as shown, saved or not: a sentence you type, read aloud.">Try the voice…</button>
        <button type="button" class="setting-btn secondary" data-settings-discard>Discard</button>
        <button type="button" class="setting-btn primary" data-settings-save>Save</button>`;
    return bar;
}

/** An unsaved-changes dot for a tab button; `renderSaveBar` shows it. */
export function buildUnsavedDot(): HTMLElement {
    const dot = el('span', 'unsaved-dot');
    dot.hidden = true;
    dot.title = 'Unsaved changes';
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', 'unsaved changes');
    return dot;
}

/** Once per full render: what Save and Discard do. */
export function bindSaveBar(actions: { save: () => void; discard: () => void }): void {
    document.querySelector('[data-settings-save]')?.addEventListener('click', actions.save);
    document.querySelector('[data-settings-discard]')?.addEventListener('click', actions.discard);
}

/** The bar's state and buttons, the shown sub-tab's Try, and the dots; tells the host when the page turns (un)saved. */
export function renderSaveBar(): void {
    const tabs = new Set<string>();
    const subtabs = new Set<string>();
    for (const { tab, subtab } of settingsState.edits.values()) {
        tabs.add(tab);
        if (subtab) {
            subtabs.add(subtab);
        }
    }
    for (const service of ['stt', 'tts'] as const) {
        if (settingsState.voiceUnsaved[service]) {
            tabs.add('voice');
            subtabs.add(service);
        }
    }
    const dirty = tabs.size > 0;
    const saving = settingsState.voiceSaving || settingsState.editsSaving;
    const state = document.getElementById('settings-save-state');
    if (state) {
        state.dataset.state = saving ? 'saving' : dirty ? 'dirty' : 'ok';
        state.textContent = saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved';
    }
    document.querySelectorAll<HTMLButtonElement>('[data-settings-save], [data-settings-discard]').forEach((button) => {
        button.disabled = !dirty || saving;
    });
    document.querySelectorAll<HTMLElement>('[data-save-bar-subtab]').forEach((button) => {
        button.hidden = settingsState.activeTab !== 'voice' || button.dataset.saveBarSubtab !== settingsState.voiceSubtab;
    });
    markUnsaved('[data-tab]', 'tab', tabs);
    markUnsaved('[data-voice-subtab]', 'voiceSubtab', subtabs);
    if (dirty !== settingsState.dirty) {
        settingsState.dirty = dirty;
        vscode.postMessage({ type: 'settingsDirty', dirty });
    }
}

function markUnsaved(selector: string, key: 'tab' | 'voiceSubtab', unsaved: ReadonlySet<string>): void {
    document.querySelectorAll<HTMLButtonElement>(`button${selector}`).forEach((btn) => {
        const on = unsaved.has(btn.dataset[key] ?? '');
        const dot = btn.querySelector<HTMLElement>('.unsaved-dot');
        if (dot) {
            dot.hidden = !on;
        }
        btn.classList.toggle('unsaved', on);
    });
}
