import type { SettingsData, SettingsServerMessage } from '../../shared/protocol';
import { applySttDryRun, applyTtsDryRunResult } from '../voiceDryRun';
import { applyVoiceprintRun } from '../voiceprintDialog';
import { vscode } from './api';
import { showToast } from './dom';
import { applySavedSettings, applySettingsSaved, pruneEdits } from './edits';
import { render, renderMcpSection } from './render';
import { renderSkillsSection } from './skills';
import { settingsState } from './state';
import { scrollToSettingsSection } from './tabs';
import { applyAvatarPicked, renderVoiceSkills } from './voice';
import { applyBuiltinVoiceStatus, applyVoiceSaved, applyVoiceTestResult, renderVoiceTab, syncVoiceFields } from './voiceSetup';

/** Handles every message the extension host sends to the settings page. */
export function registerMessageListener(): void {
    window.addEventListener('message', (event) => {
        const msg = event.data as SettingsServerMessage;
        switch (msg.type) {
            case 'settings': {
                const previous = settingsState.savedSettings;
                applySavedSettings(msg.data);
                if (previous && withoutVoice(previous) === withoutVoice(msg.data)) {
                    // Only the voice settings changed (e.g. a Save): update in place, so the
                    // fields keep their undo history (Ctrl+Z back to the previous URL).
                    syncVoiceFields();
                } else if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
                    // Keep the field being typed in when settings arrive during editing.
                    renderVoiceTab();
                } else {
                    render();
                }
                break;
            }
            case 'mcpSnapshot':
                settingsState.mcpSnapshot = msg.snapshot;
                pruneEdits();
                renderMcpSection();
                break;
            case 'skills':
                settingsState.loadedSkills = msg.skills;
                renderSkillsSection();
                renderVoiceSkills();
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
                applyVoiceTestResult(msg);
                break;
            case 'voiceSaved':
                applyVoiceSaved(msg);
                break;
            case 'settingsSaved':
                applySettingsSaved();
                showToast(msg.message, msg.ok ? 'info' : 'error');
                break;
            case 'avatarPicked':
                applyAvatarPicked(msg);
                render();
                break;
            case 'builtinVoiceStatus':
                applyBuiltinVoiceStatus(msg);
                break;
            case 'sttDryRun':
                applySttDryRun(msg.run, msg.event);
                break;
            case 'ttsDryRunResult':
                applyTtsDryRunResult(msg);
                break;
            case 'voiceprintRun':
                applyVoiceprintRun(msg.run, msg.event);
                break;
        }
    });
}

/** The settings minus the Voice tab's, to tell a voice-only change from one that needs a full render. */
function withoutVoice(data: SettingsData): string {
    return JSON.stringify({ ...data, voice: undefined, tts: undefined, voiceReadiness: undefined, voiceApiKeys: undefined, voiceOwnServers: undefined, voiceSkills: undefined, voiceprint: undefined });
}
