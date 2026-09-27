import type { SettingsData, SettingsServerMessage } from '../../shared/protocol';
import { applySttDryRun, applyTtsDryRunResult } from '../voiceDryRun';
import { vscode } from './api';
import { showToast } from './dom';
import { render, renderMcpSection } from './render';
import { renderSkillsSection } from './skills';
import { settingsState } from './state';
import { scrollToSettingsSection } from './tabs';
import { readSttForm, readTtsForm, renderVoiceStatus, syncVoiceFields } from './voice';

/** Handles every message the extension host sends to the settings page. */
export function registerMessageListener(): void {
    window.addEventListener('message', (event) => {
        const msg = event.data as SettingsServerMessage;
        switch (msg.type) {
            case 'settings': {
                const previous = settingsState.currentSettings;
                settingsState.currentSettings = msg.data;
                if (msg.data.mcpSnapshot) {
                    settingsState.mcpSnapshot = msg.data.mcpSnapshot;
                }
                if (previous && withoutVoice(previous) === withoutVoice(msg.data)) {
                    // Only the voice settings changed (e.g. a Test saved them): update in place, so the
                    // fields keep their undo history (Ctrl+Z back to the previous URL).
                    syncVoiceFields();
                } else if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
                    // Keep the current draft when settings arrive during editing.
                    renderVoiceStatus('stt');
                    renderVoiceStatus('tts');
                } else {
                    render(msg.data);
                }
                break;
            }
            case 'mcpSnapshot':
                settingsState.mcpSnapshot = msg.snapshot;
                renderMcpSection();
                break;
            case 'settingChanged':
                if (settingsState.currentSettings) {
                    (settingsState.currentSettings as any)[msg.key] = msg.value;
                    render(settingsState.currentSettings);
                }
                break;
            case 'skills':
                settingsState.loadedSkills = msg.skills;
                renderSkillsSection();
                break;
            case 'piConfigUpdated':
                vscode.postMessage({ type: 'getSettings' });
                vscode.postMessage({ type: 'getSkills' });
                break;
            case 'success':
                showToast(msg.message, 'info');
                break;
            case 'error':
                showToast(msg.message, 'error');
                break;
            case 'scrollToSection':
                scrollToSettingsSection(msg.section);
                break;
            case 'voiceTestResult':
                settingsState.voiceTesting[msg.service] = false;
                if (settingsState.currentSettings) {
                    // Saved as sent: the form's values are the settings now, whatever the check said.
                    if (msg.service === 'stt') {
                        settingsState.currentSettings.voice = readSttForm();
                    } else {
                        settingsState.currentSettings.tts = readTtsForm();
                    }
                    settingsState.currentSettings.voiceReadiness[msg.service] = msg.check;
                }
                document.querySelectorAll(`[data-draft="${msg.service}"] [data-key]`).forEach((field) => settingsState.voiceDrafts.delete(field.id));
                renderVoiceStatus(msg.service);
                showToast(msg.message, msg.ok ? 'info' : 'error');
                break;
            case 'sttDryRun':
                applySttDryRun(msg.run, msg.event);
                break;
            case 'ttsDryRunResult':
                applyTtsDryRunResult(msg);
                break;
        }
    });
}

/** The settings minus the Voice tab's, to tell a voice-only change from one that needs a full render. */
function withoutVoice(data: SettingsData): string {
    return JSON.stringify({ ...data, voice: undefined, tts: undefined, voiceReadiness: undefined });
}
