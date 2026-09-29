/**
 * Settings → Voice, "Only my voice": record a voiceprint, test it, and how it is used. Unlike the
 * speech services above, these save at once (the toggles and the select by the page's generic
 * `[data-key]` handlers, the threshold here); the voiceprint itself is recorded by the host.
 */
import { escapeHtml } from '../../shared/html';
import type { SettingsClientMessage, SettingsData } from '../../shared/protocol';
import type { VoiceprintStatus } from '../../shared/voiceprint';
import { openVoiceprintDialog } from '../voiceprintDialog';
import { vscode } from './api';
import { buildSection, buildSelect, el } from './dom';
import { settingsState } from './state';

function toggle(key: string, label: string, checked: boolean): string {
    return `
        <div class="setting-toggle-row">
            <label class="toggle-label" for="setting-${key}">
                <span class="toggle-switch">
                    <input type="checkbox" id="setting-${key}" data-key="${key}" ${checked ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </span>
                <span>${escapeHtml(label)}</span>
            </label>
        </div>`;
}

export function buildVoiceprintSection(data: SettingsData): HTMLElement {
    const vp = data.voiceprint;
    const intro = el('div', 'setting-row');
    intro.innerHTML = `
        <p class="setting-description">Record your voiceprint and voice input (the chat mic and voice mode) takes only your voice: people talking nearby are neither typed nor answered, and cannot interrupt the voice agent. It runs on this computer (the built-in voice engine, a 28 MB model) whatever speech-to-text you use; the voiceprint is kept in VS Code's extension storage, not in settings.json.</p>
        <p class="voice-status" id="voiceprint-status" role="status"></p>
        <div class="voice-actions-buttons">
            <button type="button" class="setting-btn primary" data-voiceprint-enroll>Record my voiceprint…</button>
            <button type="button" class="setting-btn secondary" data-voiceprint-test>Test…</button>
            <button type="button" class="setting-btn danger" data-voiceprint-delete>Delete</button>
        </div>`;
    const enabled = el('div', 'setting-row');
    enabled.innerHTML = `
        ${toggle('voice.voiceprint.enabled', 'Only take my voice', vp.enabled)}
        <p class="setting-description">Off, or without a voiceprint, every voice is heard as before.</p>`;
    const threshold = el('div', 'setting-row');
    threshold.innerHTML = `
        <div class="setting-label-row">
            <label for="voiceprint-threshold">Match threshold</label>
            <span class="range-value" id="voiceprint-threshold-value">${vp.threshold.toFixed(2)}</span>
        </div>
        <input type="range" id="voiceprint-threshold" class="voiceprint-threshold" min="0.2" max="0.9" step="0.05" value="${vp.threshold}">
        <p class="setting-description">How much an utterance must sound like you (similarity 0–1). Raise it if other voices get through, lower it if yours is dropped; Test shows the similarity of what you say.</p>`;
    const denoise = el('div', 'setting-row');
    denoise.innerHTML = `
        ${toggle('voice.denoise', 'Reduce background noise', vp.denoise)}
        <p class="setting-description">Takes the noise out of each utterance before speech-to-text and the voiceprint check (GTCRN, 0.5 MB, on the built-in engine). Adds a little delay. Record your voiceprint again after changing this.</p>`;
    return buildSection(
        'Only my voice',
        [
            intro,
            enabled,
            threshold,
            buildSelect('voice.voiceprint.shortSpeech', 'Short utterances (under 1 s)', vp.shortSpeech, [
                { value: 'stricter', label: 'Check them more strictly (threshold + 0.1)' },
                { value: 'accept', label: 'Take them unchecked' },
            ], 'A second of speech carries little voice. Stricter keeps short shouts from others out, but drops more of your own short words.'),
            denoise,
        ],
        'voiceprint',
    );
}

function statusLine(vp: VoiceprintStatus): [state: string, text: string] {
    if (vp.warning) {
        return ['error', vp.warning];
    }
    if (!vp.enrolled) {
        return ['dirty', 'No voiceprint yet: every voice is heard. Record yours to take only your voice.'];
    }
    if (vp.enrolled.stale) {
        return ['dirty', 'Your voiceprint was made with an older voice model and is not used: record it again.'];
    }
    const made = `${vp.enrolled.samples} recordings, ${new Date(vp.enrolled.at).toLocaleDateString()}`;
    return vp.enabled
        ? ['ok', `On: voice input takes only your voice (voiceprint of ${made}).`]
        : ['testing', `Off: your voiceprint is saved (${made}); turn "Only take my voice" on to use it.`];
}

/** Follows the settings and the saved voiceprint without rebuilding the section. */
export function renderVoiceprint(): void {
    const vp = settingsState.currentSettings?.voiceprint;
    const status = document.getElementById('voiceprint-status');
    if (!vp || !status) {
        return;
    }
    const [state, text] = statusLine(vp);
    status.dataset.state = state;
    status.textContent = text;
    const usable = vp.enrolled !== undefined && !vp.enrolled.stale;
    const enroll = document.querySelector<HTMLButtonElement>('[data-voiceprint-enroll]');
    if (enroll) {
        enroll.textContent = vp.enrolled ? 'Record it again…' : 'Record my voiceprint…';
    }
    document.querySelectorAll<HTMLButtonElement>('[data-voiceprint-test], [data-voiceprint-delete]').forEach((btn) => {
        btn.hidden = btn.dataset.voiceprintDelete === undefined ? !usable : !vp.enrolled;
    });
    const enabled = document.getElementById('setting-voice.voiceprint.enabled');
    if (enabled instanceof HTMLInputElement) {
        enabled.checked = vp.enabled;
    }
    const denoise = document.getElementById('setting-voice.denoise');
    if (denoise instanceof HTMLInputElement) {
        denoise.checked = vp.denoise;
    }
    const shortSpeech = document.getElementById('setting-voice.voiceprint.shortSpeech');
    if (shortSpeech instanceof HTMLSelectElement) {
        shortSpeech.value = vp.shortSpeech;
    }
    const threshold = document.getElementById('voiceprint-threshold');
    // Not while it is being dragged: the saved value lags behind.
    if (threshold instanceof HTMLInputElement && document.activeElement !== threshold) {
        threshold.value = String(vp.threshold);
        document.getElementById('voiceprint-threshold-value')!.textContent = vp.threshold.toFixed(2);
    }
}

/** Once per full render. */
export function bindVoiceprint(): void {
    const post = (message: SettingsClientMessage) => vscode.postMessage(message);
    document.querySelector('[data-voiceprint-enroll]')?.addEventListener('click', () => openVoiceprintDialog('enroll', post));
    document.querySelector('[data-voiceprint-test]')?.addEventListener('click', () => openVoiceprintDialog('test', post));
    document.querySelector('[data-voiceprint-delete]')?.addEventListener('click', () => post({ type: 'deleteVoiceprint' }));
    const threshold = document.getElementById('voiceprint-threshold');
    if (threshold instanceof HTMLInputElement) {
        threshold.addEventListener('input', () => {
            document.getElementById('voiceprint-threshold-value')!.textContent = Number(threshold.value).toFixed(2);
        });
        threshold.addEventListener('change', () => {
            post({ type: 'updateSetting', key: 'voice.voiceprint.threshold', value: Number(threshold.value) });
        });
    }
    renderVoiceprint();
}
