import type { BuiltinVoiceStatus, McpSettingsSnapshot, SettingEdit, SettingsData, SkillInfo, VoiceCheckResult } from '../../shared/protocol';
import type { VoiceAvatar, VoiceSpeakerId } from '../../shared/voiceSpeakers';
import { vscode } from './api';
import type { SettingsTabId } from './tabs';
import type { VoiceService } from './voice';
import type { VoiceSubtab } from './voiceTabs';

/** The ways to set up one voice service (speech-to-text or text-to-speech); they only map onto its settings. */
export type VoiceSetup = 'builtin' | 'cloud' | 'own';

/** The built-in engine's download for one service: its status once the host answers, and a download running. */
interface BuiltinVoiceState {
    status?: BuiltinVoiceStatus;
    busy: boolean;
    error?: string;
}

/** An unsaved edit, and the tab (and Voice sub-tab) of the control that made it: they get the unsaved dot. */
export interface PendingEdit {
    edit: SettingEdit;
    tab: SettingsTabId;
    subtab?: VoiceSubtab;
}

interface SettingsState {
    /** The settings as saved: the host's last `settings`. */
    savedSettings: SettingsData | null;
    /** The settings as the page shows them: the saved ones with `edits` applied (`edits.ts`). */
    currentSettings: SettingsData | null;
    /** Unsaved edits outside the voice services' forms, by id (`edits.ts`); Save sends them, Discard drops them. */
    readonly edits: Map<string, PendingEdit>;
    /** Save sent the edits; the host has not answered yet. */
    editsSaving: boolean;
    /** Pictures picked with Upload for an avatar, not saved yet: shown while the avatar edit is that picture. */
    readonly pickedAvatars: Partial<Record<VoiceSpeakerId, { value: string; resolved?: VoiceAvatar; error?: string }>>;
    /** Voice tab fields typed but not saved yet, by element id: they survive re-renders until saved or discarded. */
    readonly voiceDrafts: Map<string, string>;
    /** A section's Test is checking; its button waits. */
    readonly voiceTesting: Record<VoiceService, boolean>;
    /** A section's last Test, and the form (JSON) it tested: shown while the form is still that. */
    readonly voiceTestResults: Partial<Record<VoiceService, VoiceCheckResult & { form: string }>>;
    /** The card picked on each service's sub-tab; absent: the one its settings (as drafted) match. */
    readonly voiceSetup: Partial<Record<VoiceService, VoiceSetup>>;
    /** The cloud provider picked for each service; absent: the one its URL points at, else the first. */
    readonly voiceCloudProvider: Partial<Record<VoiceService, string>>;
    /** Saving (and with a service on its Cloud card, checking). */
    voiceSaving: boolean;
    /** The last Save's check, shown on the Cloud card until something changes. */
    voiceSaveResult: { ok: boolean; message: string } | undefined;
    /** Each voice service's form (or pasted key) differs from what is saved. */
    readonly voiceUnsaved: Record<VoiceService, boolean>;
    /** Anything on the page is unsaved (the host is told, to warn when the panel closes). */
    dirty: boolean;
    /** The built-in engine's models, by service; absent until asked for. */
    readonly builtinVoice: Partial<Record<VoiceService, BuiltinVoiceState>>;
    /** The models the custom TTS server listed at its last Test, offered by the Model field. */
    ttsServerModels: string[];
    /** The chat tab's CLI's skills; undefined until they arrive. */
    loadedSkills: SkillInfo[] | undefined;
    /** The voice agent extra prompt shows as a textarea (Edit) rather than as Markdown (View). */
    voiceExtraPromptEditing: boolean;
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

/** The Voice sub-tab kept in the webview state; the former Voice engine and Listening sub-tabs open Speech-to-text. */
function restoredVoiceSubtab(): VoiceSubtab {
    const saved: unknown = vscode.getState()?.voiceSubtab;
    return saved === 'tts' || saved === 'agent' ? saved : 'stt';
}

/** All mutable state of the settings page. */
export const settingsState: SettingsState = {
    savedSettings: null,
    currentSettings: null,
    edits: new Map<string, PendingEdit>(),
    editsSaving: false,
    pickedAvatars: {},
    voiceDrafts: new Map<string, string>(),
    voiceTesting: { stt: false, tts: false },
    voiceTestResults: {},
    voiceSetup: {},
    voiceCloudProvider: {},
    voiceSaving: false,
    voiceSaveResult: undefined,
    voiceUnsaved: { stt: false, tts: false },
    dirty: false,
    builtinVoice: {},
    ttsServerModels: [],
    loadedSkills: undefined,
    voiceExtraPromptEditing: false,
    voiceDefaultPromptOpen: false,
    mcpSnapshot: null,
    activeTab: restoredTab(),
    voiceSubtab: restoredVoiceSubtab(),
    toastTimeout: undefined,
};
