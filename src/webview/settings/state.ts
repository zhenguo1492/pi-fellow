import type { McpSettingsSnapshot, SettingsData, SkillInfo } from '../../shared/protocol';
import { vscode } from './api';
import type { SettingsTabId } from './tabs';
import type { VoiceService } from './voice';

interface SettingsState {
    currentSettings: SettingsData | null;
    /** Voice tab fields typed but not saved yet, by element id: they survive re-renders until Test saves them. */
    readonly voiceDrafts: Map<string, string>;
    /** A section's Test is saving and checking; its button waits. */
    readonly voiceTesting: Record<VoiceService, boolean>;
    loadedSkills: SkillInfo[];
    mcpSnapshot: McpSettingsSnapshot | null;
    activeTab: SettingsTabId;
    toastTimeout: ReturnType<typeof setTimeout> | undefined;
}

/** The tab kept in the webview state; the former STT and TTS tabs are now the Voice tab. */
function restoredTab(): SettingsTabId {
    let activeTab: SettingsTabId = (vscode.getState()?.activeTab as SettingsTabId) ?? 'general';
    if ((activeTab as string) === 'stt' || (activeTab as string) === 'tts') {
        activeTab = 'voice';
    }
    return activeTab;
}

/** All mutable state of the settings page. */
export const settingsState: SettingsState = {
    currentSettings: null,
    voiceDrafts: new Map<string, string>(),
    voiceTesting: { stt: false, tts: false },
    loadedSkills: [],
    mcpSnapshot: null,
    activeTab: restoredTab(),
    toastTimeout: undefined,
};
