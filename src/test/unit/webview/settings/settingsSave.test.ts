// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingEdit, SettingsData } from '../../../../shared/protocol';
import { applySavedSettings, applySettingsSaved } from '../../../../webview/settings/edits';
import { render } from '../../../../webview/settings/render';
import { settingsState } from '../../../../webview/settings/state';
import { switchSettingsTab } from '../../../../webview/settings/tabs';

const posted = vi.hoisted((): Array<{ type: string } & Record<string, unknown>> => []);
vi.mock('../../../../webview/settings/api', () => ({
    vscode: { postMessage: (message: { type: string }) => posted.push(message), getState: () => undefined, setState: () => {} },
}));

const data = {
    backend: 'pi',
    availableBackends: ['pi', 'omp'],
    extensionVersion: '1.0.0',
    syncWithPiCli: true,
    piAgentDir: '~/.pi/agent',
    authMethod: 'none',
    defaultPermissionLevel: 'ask',
    allowedTools: [],
    contextUsageWarningThreshold: 80,
    piDefaultModel: 'm1',
    piConfig: {
        agentDir: '~/.pi/agent',
        packages: [],
        extensionPaths: ['/ext/a.ts'],
        skillPaths: [],
        enableSkillCommands: true,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        authProviders: [],
        mcpFileExists: false,
        commands: [],
        availableModels: [
            { id: 'm1', name: 'M1', provider: 'acme' },
            { id: 'm2', name: 'M2', provider: 'acme' },
        ],
    },
    voice: { sttEngine: 'builtin', sttUrl: '', sttModel: '', language: '', vadConfidence: 0.5, vadStopSecs: 0.8 },
    tts: { engine: 'builtin', languageField: 'none', url: '', model: '', voice: '', speed: 1 },
    voiceReadiness: { stt: { ok: true }, tts: { ok: true } },
    voiceApiKeys: { openai: false, groq: false },
    voiceSkills: [],
    voiceModel: '',
    voiceModels: [],
    voiceMessageButtons: false,
    voiceTranslateTo: 'zh',
    voiceExtraPrompt: '',
    voiceDefaultPrompt: 'You are the voice agent.',
    voiceSpeakers: { user: { name: 'User', avatar: '' }, bot: { name: 'Bot', avatar: '' } },
    voiceprint: { enabled: false, threshold: 0.5, shortSpeech: 'stricter', denoise: false },
} as unknown as SettingsData;

function showPage(tab: 'general' | 'auth' | 'packages', saved: SettingsData = structuredClone(data)): void {
    document.body.innerHTML = '<div id="settings-app"></div>';
    window.scrollTo = () => {};
    posted.length = 0;
    settingsState.edits.clear();
    settingsState.voiceDrafts.clear();
    Object.assign(settingsState, { activeTab: tab, editsSaving: false, voiceSaving: false, voiceSetup: {}, voiceCloudProvider: {} });
    applySavedSettings(saved);
    render();
}

const saveState = () => document.getElementById('settings-save-state')!.textContent;
const tabDot = (tab: string) => !document.querySelector<HTMLElement>(`button[data-tab="${tab}"] .unsaved-dot`)!.hidden;
const field = <T extends HTMLInputElement | HTMLSelectElement>(id: string) => document.getElementById(id) as T;
function change(id: string, value: string, event = 'change'): void {
    const control = field(id);
    control.value = value;
    control.dispatchEvent(new Event(event));
}
const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();
const saved = () => posted.filter((m) => m.type === 'saveSettings').map((m) => m.edits as SettingEdit[]);

describe('Settings page: every setting waits for Save', () => {
    beforeEach(() => showPage('general'));

    it('keeps changes as edits across a page render, marks their tab, and Discard puts the saved values back', () => {
        change('setting-defaultPermissionLevel', 'auto');
        change('setting-allowedTools', 'bash, read', 'input');
        expect([saveState(), tabDot('general'), tabDot('auth'), saved()]).toEqual(['Unsaved changes', true, false, []]);
        expect(posted).toContainEqual({ type: 'settingsDirty', dirty: true });

        render();
        expect([field('setting-defaultPermissionLevel').value, field('setting-allowedTools').value]).toEqual(['auto', 'bash, read']);

        click('[data-settings-discard]');
        expect([field('setting-defaultPermissionLevel').value, field('setting-allowedTools').value, saveState(), tabDot('general')])
            .toEqual(['ask', '', 'All changes saved', false]);
    });

    it('a field set back to its saved value is no change', () => {
        change('setting-defaultPermissionLevel', 'plan');
        change('setting-defaultPermissionLevel', 'ask');
        expect([saveState(), settingsState.edits.size]).toEqual(['All changes saved', 0]);
    });

    it('Save sends every edit at once; the settings that come back clear the saved ones, and one not written stays unsaved', () => {
        change('setting-defaultPermissionLevel', 'edit');
        change('setting-allowedTools', 'bash', 'input');
        click('[data-settings-save]');
        expect(saved()).toEqual([[
            { kind: 'setting', key: 'defaultPermissionLevel', value: 'edit' },
            { kind: 'setting', key: 'allowedTools', value: ['bash'] },
        ]]);
        expect(saveState()).toBe('Saving…');

        // Only the permission mode was written.
        applySavedSettings({ ...structuredClone(data), defaultPermissionLevel: 'edit' });
        applySettingsSaved();
        expect([[...settingsState.edits.keys()], saveState()]).toEqual([['allowedTools'], 'Unsaved changes']);
    });

    it('does not switch the backend while anything is unsaved: the edits are for this one', () => {
        change('setting-contextUsageWarningThreshold', '60', 'input');
        click('.backend-segment-btn[data-backend="omp"]');
        expect(posted.some((m) => m.type === 'setBackend')).toBe(false);
        expect(document.getElementById('toast')?.textContent).toContain('Save or Discard');
    });
});

describe('Settings page: the agent config', () => {
    it('saves a default model picked under (auto) with its provider, and the thinking level apart', () => {
        showPage('auth');
        change('pi-default-model', 'm2');
        change('pi-thinking', 'high');
        expect(tabDot('auth')).toBe(true);
        click('[data-settings-save]');
        expect(saved()).toEqual([[
            { kind: 'piDefaults', provider: 'acme', model: 'm2' },
            { kind: 'piDefaults', thinkingLevel: 'high' },
        ]]);
        // The host writes the provider too: still the model picked, nothing left to save.
        applySavedSettings({ ...structuredClone(data), piDefaultProvider: 'acme', piDefaultModel: 'm2', piDefaultThinkingLevel: 'high' });
        expect(settingsState.edits.size).toBe(0);
    });

    it('adds and removes extension paths as one edit of the whole list; packages install at once', () => {
        showPage('packages');
        const input = document.querySelector<HTMLInputElement>('input[data-add-kind="extensions"]')!;
        input.value = ' /ext/b.ts ';
        click('[data-add-btn="extensions"]');
        click('[data-remove-kind="extensions"][data-remove-index="0"]');
        const items = () => [...document.querySelectorAll('#list-extensions .pi-list-value')].map((item) => item.textContent);
        expect([items(), tabDot('packages')]).toEqual([['/ext/b.ts'], true]);

        const pkg = document.querySelector<HTMLInputElement>('input[data-add-kind="packages"]')!;
        pkg.value = 'npm:some-package';
        click('[data-add-btn="packages"]');
        expect(posted.at(-1)).toEqual({ type: 'addPiPackage', source: 'npm:some-package' });

        switchSettingsTab('general', false);
        click('[data-settings-save]');
        expect(saved()).toEqual([[{ kind: 'extensionPaths', paths: ['/ext/b.ts'] }]]);
    });
});
