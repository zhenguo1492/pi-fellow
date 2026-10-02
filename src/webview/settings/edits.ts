/**
 * The settings page's unsaved edits, outside the voice services' forms (those are `voiceSetup.ts`
 * drafts). A changed control puts its edit here by id; the page shows `currentSettings`, the saved
 * settings with the edits applied, so re-renders keep them. An edit back at the saved value goes,
 * and so does one the host's settings now hold (after Save, or a change made elsewhere). Save sends
 * them all, Discard drops them.
 */
import type { McpSettingsSnapshot, PermissionLevel, SettingEdit, SettingsData } from '../../shared/protocol';
import type { VoiceSpeakerId } from '../../shared/voiceSpeakers';
import { vscode } from './api';
import { renderSaveBar } from './saveBar';
import { settingsState } from './state';
import type { SettingsTabId } from './tabs';
import { voiceSubtabOf } from './voiceTabs';

type SettingField = { get: (data: SettingsData) => unknown; set: (data: SettingsData, value: unknown) => void };

function speakerField(id: VoiceSpeakerId, field: 'name' | 'avatar'): SettingField {
    return {
        get: (data) => data.voiceSpeakers[id][field],
        set: (data, value) => {
            const speaker = data.voiceSpeakers[id];
            speaker[field] = String(value);
            if (field === 'avatar') {
                // A preset shows as its tile; an uploaded picture as it was read when picked.
                const picked = settingsState.pickedAvatars[id];
                const upload = picked?.value === value ? picked : undefined;
                speaker.resolved = upload?.resolved;
                speaker.error = upload?.error;
            }
        },
    };
}

/** The `setting` edits the page makes: where each `oh-my-pi-chater.<key>` shows in `SettingsData`. */
const SETTING_FIELDS: Record<string, SettingField> = {
    defaultPermissionLevel: { get: (d) => d.defaultPermissionLevel, set: (d, v) => { d.defaultPermissionLevel = v as PermissionLevel; } },
    allowedTools: { get: (d) => d.allowedTools, set: (d, v) => { d.allowedTools = v as string[]; } },
    contextUsageWarningThreshold: { get: (d) => d.contextUsageWarningThreshold, set: (d, v) => { d.contextUsageWarningThreshold = Number(v); } },
    'voiceAgent.model': { get: (d) => d.voiceModel, set: (d, v) => { d.voiceModel = String(v); } },
    'voiceAgent.skills': { get: (d) => d.voiceSkills, set: (d, v) => { d.voiceSkills = v as string[]; } },
    'voiceAgent.extraPrompt': { get: (d) => d.voiceExtraPrompt, set: (d, v) => { d.voiceExtraPrompt = String(v); } },
    'voiceAgent.messageButtons': { get: (d) => d.voiceMessageButtons, set: (d, v) => { d.voiceMessageButtons = v === true; } },
    'voiceAgent.translateTo': { get: (d) => d.voiceTranslateTo, set: (d, v) => { d.voiceTranslateTo = String(v); } },
    'voiceAgent.userName': speakerField('user', 'name'),
    'voiceAgent.botName': speakerField('bot', 'name'),
    'voiceAgent.userAvatar': speakerField('user', 'avatar'),
    'voiceAgent.botAvatar': speakerField('bot', 'avatar'),
    'voice.voiceprint.enabled': { get: (d) => d.voiceprint.enabled, set: (d, v) => { d.voiceprint.enabled = v === true; } },
    'voice.voiceprint.threshold': { get: (d) => d.voiceprint.threshold, set: (d, v) => { d.voiceprint.threshold = Number(v); } },
    'voice.voiceprint.shortSpeech': {
        get: (d) => d.voiceprint.shortSpeech,
        set: (d, v) => { d.voiceprint.shortSpeech = v as SettingsData['voiceprint']['shortSpeech']; },
    },
    'voice.denoise': { get: (d) => d.voiceprint.denoise, set: (d, v) => { d.voiceprint.denoise = v === true; } },
};

/** The thinking level the page shows when none is set: each CLI's own default. */
export function shownThinkingLevel(data: SettingsData): string {
    return data.piDefaultThinkingLevel ?? (data.backend === 'omp' ? 'high' : 'off');
}

/** The provider a default model is saved with: the one picked, or under (auto) the model's own. */
function modelProvider(data: SettingsData, provider: string, model: string): string {
    return provider || (data.piConfig?.availableModels.find((m) => m.id === model)?.provider ?? '');
}

function applyEdit(data: SettingsData, edit: SettingEdit): void {
    const cfg = data.piConfig;
    switch (edit.kind) {
        case 'setting':
            SETTING_FIELDS[edit.key]?.set(data, edit.value);
            return;
        case 'piDefaults':
            if (edit.provider !== undefined) {
                data.piDefaultProvider = edit.provider || undefined;
            }
            if (edit.model !== undefined) {
                data.piDefaultModel = edit.model || undefined;
            }
            if (edit.thinkingLevel !== undefined) {
                data.piDefaultThinkingLevel = edit.thinkingLevel;
            }
            return;
        case 'steeringMode':
            if (cfg) cfg.steeringMode = edit.mode;
            return;
        case 'followUpMode':
            if (cfg) cfg.followUpMode = edit.mode;
            return;
        case 'skillCommands':
            if (cfg) cfg.enableSkillCommands = edit.enabled;
            return;
        case 'extensionPaths':
            if (cfg) cfg.extensionPaths = edit.paths;
            return;
        case 'skillPaths':
            if (cfg) cfg.skillPaths = edit.paths;
            return;
        case 'mcpServer': {
            const server = data.mcpSnapshot?.servers.find((s) => s.name === edit.serverName);
            if (server) server.enabled = edit.enabled;
            return;
        }
    }
}

function isSaved(edit: SettingEdit, saved: SettingsData): boolean {
    const cfg = saved.piConfig;
    switch (edit.kind) {
        case 'setting': {
            const field = SETTING_FIELDS[edit.key];
            return field !== undefined && JSON.stringify(field.get(saved)) === JSON.stringify(edit.value);
        }
        case 'piDefaults': {
            const provider = saved.piDefaultProvider ?? '';
            const model = saved.piDefaultModel ?? '';
            const sameModel = edit.model === undefined || (edit.model === model
                && (edit.provider === provider || modelProvider(saved, edit.provider ?? '', edit.model) === provider));
            return sameModel && (edit.thinkingLevel === undefined || edit.thinkingLevel === shownThinkingLevel(saved));
        }
        case 'steeringMode':
            return cfg?.steeringMode === edit.mode;
        case 'followUpMode':
            return cfg?.followUpMode === edit.mode;
        case 'skillCommands':
            return cfg?.enableSkillCommands === edit.enabled;
        case 'extensionPaths':
            return JSON.stringify(cfg?.extensionPaths ?? []) === JSON.stringify(edit.paths);
        case 'skillPaths':
            return JSON.stringify(cfg?.skillPaths ?? []) === JSON.stringify(edit.paths);
        case 'mcpServer': {
            const snapshot = settingsState.mcpSnapshot ?? saved.mcpSnapshot;
            return snapshot?.servers.find((s) => s.name === edit.serverName)?.enabled === edit.enabled;
        }
    }
}

/** `currentSettings` again: the saved settings with the edits applied. */
function refreshShown(): void {
    const saved = settingsState.savedSettings;
    if (!saved) {
        settingsState.currentSettings = null;
        return;
    }
    const shown = structuredClone(saved);
    for (const { edit } of settingsState.edits.values()) {
        applyEdit(shown, edit);
    }
    settingsState.currentSettings = shown;
}

/**
 * A control changed: keeps its edit under `id` (or drops it, back at the saved value). `from` is the
 * control, for the tab that gets the unsaved dot.
 */
export function setEdit(id: string, edit: SettingEdit, from: Element): void {
    const saved = settingsState.savedSettings;
    if (!saved) {
        return;
    }
    if (isSaved(edit, saved)) {
        settingsState.edits.delete(id);
    } else {
        const tab = (from.closest<HTMLElement>('[data-tab-panel]')?.dataset.tabPanel ?? settingsState.activeTab) as SettingsTabId;
        settingsState.edits.set(id, { edit, tab, subtab: voiceSubtabOf(from) });
    }
    refreshShown();
    renderSaveBar();
}

/** An `oh-my-pi-chater.<key>` setting changed; its edit is kept under the key. */
export function setSetting(key: string, value: unknown, from: Element): void {
    setEdit(key, { kind: 'setting', key, value }, from);
}

/** The host's settings arrived: they are the saved ones now, and edits they already hold go. */
export function applySavedSettings(data: SettingsData): void {
    settingsState.savedSettings = data;
    if (data.mcpSnapshot) {
        settingsState.mcpSnapshot = data.mcpSnapshot;
    }
    pruneEdits();
}

/** Drops the edits the saved settings (and MCP servers) now hold, and shows the rest over them. */
export function pruneEdits(): void {
    const saved = settingsState.savedSettings;
    if (saved) {
        for (const [id, { edit }] of settingsState.edits) {
            if (isSaved(edit, saved)) {
                settingsState.edits.delete(id);
            }
        }
    }
    refreshShown();
    renderSaveBar();
}

/** The MCP servers as shown: each enabled or not as edited. */
export function withMcpEdits(snapshot: McpSettingsSnapshot): McpSettingsSnapshot {
    const enabled = new Map<string, boolean>();
    for (const { edit } of settingsState.edits.values()) {
        if (edit.kind === 'mcpServer') {
            enabled.set(edit.serverName, edit.enabled);
        }
    }
    return enabled.size === 0
        ? snapshot
        : { ...snapshot, servers: snapshot.servers.map((s) => (enabled.has(s.name) ? { ...s, enabled: enabled.get(s.name)! } : s)) };
}

/** Save: sends every edit (a default model picked under (auto) with its provider); they go once the settings hold them. */
export function saveEdits(): void {
    const saved = settingsState.savedSettings;
    if (settingsState.edits.size === 0 || settingsState.editsSaving || !saved) {
        return;
    }
    const edits = [...settingsState.edits.values()].map(({ edit }) =>
        edit.kind === 'piDefaults' && edit.model !== undefined
            ? { ...edit, provider: modelProvider(saved, edit.provider ?? '', edit.model) }
            : edit,
    );
    settingsState.editsSaving = true;
    vscode.postMessage({ type: 'saveSettings', edits });
    renderSaveBar();
}

/** The host answered Save. */
export function applySettingsSaved(): void {
    settingsState.editsSaving = false;
    pruneEdits();
}

/** Discard: back to the saved settings (the caller renders the page again). */
export function discardEdits(): void {
    settingsState.edits.clear();
    settingsState.voiceExtraPromptEditing = false;
    refreshShown();
}
