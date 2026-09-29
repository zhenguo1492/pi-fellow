import type { BuiltinVoiceStatus, McpSettingsSnapshot, SettingsData, SkillInfo, VoiceCheckResult } from '../../shared/protocol';
import { vscode } from './api';
import type { SettingsTabId } from './tabs';
import type { VoiceService } from './voice';
import type { VoiceSubtab } from './voiceTabs';

/** The Voice tab's three ways to set voice up; they only map onto the existing settings. */
export type VoiceSetup = 'builtin' | 'cloud' | 'own';

interface SettingsState {
    currentSettings: SettingsData | null;
    /** Voice tab fields typed but not saved yet, by element id: they survive re-renders until saved or discarded. */
    readonly voiceDrafts: Map<string, string>;
    /** A section's Test is checking; its button waits. */
    readonly voiceTesting: Record<VoiceService, boolean>;
    /** A section's last Test, and the form (JSON) it tested: shown while the form is still that. */
    readonly voiceTestResults: Partial<Record<VoiceService, VoiceCheckResult & { form: string }>>;
    /** The card picked on the Voice tab; undefined: the one the settings (as drafted) match. */
    voiceSetup: VoiceSetup | undefined;
    /** The cloud provider picked; undefined: the one the URL points at, else the first. */
    voiceCloudProvider: string | undefined;
    /** Saving (and with Save & test, checking). */
    voiceSaving: boolean;
    /** The last Save & test, shown on the Cloud card until something changes. */
    voiceSaveResult: { ok: boolean; message: string } | undefined;
    /** The Voice tab has unsaved changes (the host is told, to warn when the panel closes). */
    voiceDirty: boolean;
    /** The built-in engine's models; undefined until the host answers. */
    builtinVoice: { status?: BuiltinVoiceStatus; busy: boolean; error?: string } | undefined;
    /** The models the custom TTS server listed at its last Test, offered by the Model field. */
    ttsServerModels: string[];
    /** The chat tab's CLI's skills; undefined until they arrive. */
    loadedSkills: SkillInfo[] | undefined;
    /** The voice agent extra prompt as typed while it is edited; undefined: shown as Markdown (View). */
    voiceExtraPromptDraft: string | undefined;
    /** "View default prompt" is expanded; kept across re-renders. */
    voiceDefaultPromptOpen: boolean;
    mcpSnapshot: McpSettingsSnapshot | null;
    activeTab: SettingsTabId;
    /** The Voice tab's sub-tab shown; kept in the webview state. */
    voiceSubtab: VoiceSubtab;
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

function restoredVoiceSubtab(): VoiceSubtab {
    const saved: unknown = vscode.getState()?.voiceSubtab;
    return saved === 'listening' || saved === 'agent' ? saved : 'engine';
}

/** All mutable state of the settings page. */
export const settingsState: SettingsState = {
    currentSettings: null,
    voiceDrafts: new Map<string, string>(),
    voiceTesting: { stt: false, tts: false },
    voiceTestResults: {},
    voiceSetup: undefined,
    voiceCloudProvider: undefined,
    voiceSaving: false,
    voiceSaveResult: undefined,
    voiceDirty: false,
    builtinVoice: undefined,
    ttsServerModels: [],
    loadedSkills: undefined,
    voiceExtraPromptDraft: undefined,
    voiceDefaultPromptOpen: false,
    mcpSnapshot: null,
    activeTab: restoredTab(),
    voiceSubtab: restoredVoiceSubtab(),
    toastTimeout: undefined,
};
