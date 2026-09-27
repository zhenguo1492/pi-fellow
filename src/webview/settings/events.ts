import type { AgentBackend, SettingsClientMessage } from '../../shared/protocol';
import { openSttDryRun, openTtsDryRun } from '../voiceDryRun';
import { vscode } from './api';
import { showToast } from './dom';
import { bindMcpServerCards } from './mcp';
import { render } from './render';
import { settingsState } from './state';
import { readSttForm, readTtsForm, renderVoiceStatus, voiceServiceOf } from './voice';

export function bindEvents(): void {
    document.querySelectorAll('.backend-segment-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const b = (e.currentTarget as HTMLElement).dataset.backend as AgentBackend;
            if (b && b !== settingsState.currentSettings?.backend) {
                vscode.postMessage({ type: 'setBackend', backend: b });
            }
        });
    });

    document.querySelectorAll('.setting-select[data-key]').forEach((select) => {
        // Voice sections save only through their Test button.
        if (select.closest('[data-draft]')) return;
        select.addEventListener('change', () => {
            const key = (select as HTMLSelectElement).dataset.key!;
            vscode.postMessage({ type: 'updateSetting', key, value: (select as HTMLSelectElement).value });
        });
    });

    // Save text inputs on 'change' (blur / Enter) to prevent re-rendering and flickering while typing
    document.querySelectorAll('.setting-input[data-key]').forEach((input) => {
        if (input.closest('[data-draft]')) return;
        input.addEventListener('change', () => {
            const field = input as HTMLInputElement;
            const key = field.dataset.key!;
            let value: string | string[] | number = field.value;
            if (key === 'allowedTools') {
                value = field.value.split(',').map((s) => s.trim()).filter(Boolean);
            } else if (field.type === 'number') {
                if (Number.isNaN(field.valueAsNumber)) {
                    return;
                }
                value = Math.min(Number(field.max), Math.max(Number(field.min), field.valueAsNumber));
            }
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    // Voice sections: edits stay drafts (kept across re-renders) until the section's Test saves them.
    document.querySelectorAll<HTMLElement>('[data-draft] [data-key]').forEach((field) => {
        const service = voiceServiceOf(field.closest<HTMLElement>('[data-draft]')?.dataset.draft);
        if (!service || !(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
        const keep = () => {
            settingsState.voiceDrafts.set(field.id, field.value);
            renderVoiceStatus(service);
        };
        field.addEventListener('input', keep);
        field.addEventListener('change', keep);
    });

    document.querySelectorAll<HTMLButtonElement>('[data-voice-test]').forEach((btn) => {
        // Keep focus (and the caret) in the field being edited: Ctrl+Z right after a Test still undoes it.
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
            const service = voiceServiceOf(btn.dataset.voiceTest);
            if (!service || settingsState.voiceTesting[service]) return;
            settingsState.voiceTesting[service] = true;
            renderVoiceStatus(service);
            vscode.postMessage(service === 'stt' ? { type: 'testStt', settings: readSttForm() } : { type: 'testTts', settings: readTtsForm() });
        });
    });

    document.querySelectorAll<HTMLButtonElement>('[data-voice-dry-run]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const post = (message: SettingsClientMessage) => vscode.postMessage(message);
            if (btn.dataset.voiceDryRun === 'stt') {
                openSttDryRun(readSttForm(), post);
            } else {
                openTtsDryRun(readTtsForm(), post);
            }
        });
    });

    document.querySelectorAll('input[type="checkbox"][data-key]').forEach((cb) => {
        cb.addEventListener('change', () => {
            vscode.postMessage({
                type: 'updateSetting',
                key: (cb as HTMLInputElement).dataset.key!,
                value: (cb as HTMLInputElement).checked,
            });
        });
    });

    document.querySelectorAll('.setting-range').forEach((range) => {
        range.addEventListener('input', () => {
            const key = (range as HTMLInputElement).dataset.key!;
            const value = parseInt((range as HTMLInputElement).value, 10);
            const label = document.getElementById(`range-val-${key}`);
            if (label) label.textContent = `${value}%`;
        });
        range.addEventListener('change', () => {
            vscode.postMessage({
                type: 'updateSetting',
                key: (range as HTMLInputElement).dataset.key!,
                value: parseInt((range as HTMLInputElement).value, 10),
            });
        });
    });

    document.getElementById('btn-save-pi-defaults')?.addEventListener('click', () => {
        const provider = (document.getElementById('pi-default-provider') as HTMLSelectElement)?.value;
        const model = (document.getElementById('pi-default-model') as HTMLSelectElement)?.value;
        const thinkingLevel = (document.getElementById('pi-thinking') as HTMLSelectElement)?.value;
        vscode.postMessage({
            type: 'updatePiDefaults',
            provider: provider || undefined,
            model: model || undefined,
            thinkingLevel,
        });
    });

    document.getElementById('pi-thinking')?.addEventListener('change', (e) => {
        const thinkingLevel = (e.target as HTMLSelectElement).value;
        vscode.postMessage({ type: 'updatePiDefaults', thinkingLevel });
    });

    document.querySelectorAll('[data-pi-mode]').forEach((sel) => {
        sel.addEventListener('change', () => {
            const kind = (sel as HTMLSelectElement).dataset.piMode!;
            const mode = (sel as HTMLSelectElement).value as 'all' | 'one-at-a-time';
            if (kind === 'steering') {
                vscode.postMessage({ type: 'setPiSteeringMode', mode });
            } else {
                vscode.postMessage({ type: 'setPiFollowUpMode', mode });
            }
        });
    });

    document.getElementById('pi-enable-skill-cmds')?.addEventListener('change', (e) => {
        vscode.postMessage({
            type: 'setPiEnableSkillCommands',
            enabled: (e.target as HTMLInputElement).checked,
        });
    });

    document.querySelectorAll('[data-add-btn]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const kind = (btn as HTMLButtonElement).dataset.addBtn!;
            const input = document.querySelector(`input[data-add-kind="${kind}"]`) as HTMLInputElement;
            const value = input?.value?.trim();
            if (!value) {
                showToast('Enter a value first', 'error');
                return;
            }
            postAdd(kind, value);
            input.value = '';
        });
    });

    document.querySelectorAll('[data-remove-kind]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const kind = (btn as HTMLButtonElement).dataset.removeKind!;
            const index = parseInt((btn as HTMLButtonElement).dataset.removeIndex!, 10);
            postRemove(kind, index);
        });
    });

    document.querySelectorAll('[data-open-file]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const file = (btn as HTMLButtonElement).dataset.openFile as 'settings' | 'auth' | 'mcp';
            vscode.postMessage({ type: 'openPiAgentFile', file });
        });
    });

    document.getElementById('btn-reload-pi-session')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'reloadPiSession' });
    });

    document.getElementById('btn-rebuild-native')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'rebuildNativeModules' });
    });

    document.getElementById('btn-pi-login')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'runPiLogin' });
    });

    document.getElementById('btn-pi-logout')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'runPiLogout' });
    });

    document.getElementById('btn-browse-pi-catalog')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'browsePiCatalog' });
    });

    document.getElementById('btn-open-pi-packages-site')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'openExternalUrl', url: 'https://pi.dev/packages' });
    });

    document.getElementById('btn-test-all-mcp')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'testAllMcpServers' });
    });
    bindMcpServerCards();
    bindApiKeyHandlers();
}

function bindApiKeyHandlers(): void {
    const saveKeyBtn = document.getElementById('btn-save-key');
    saveKeyBtn?.addEventListener('click', () => {
        const input = document.getElementById('api-key-input') as HTMLInputElement;
        const key = input?.value?.trim();
        const provider = settingsState.currentSettings?.apiProvider || '';
        if (!provider) {
            showToast('Select a provider first', 'error');
            return;
        }
        if (!key) {
            showToast('Enter an API key', 'error');
            return;
        }
        vscode.postMessage({ type: 'setApiKey', provider, key });
    });

    document.getElementById('btn-change-key')?.addEventListener('click', () => {
        if (settingsState.currentSettings) {
            settingsState.currentSettings.apiKeySet = false;
            render(settingsState.currentSettings);
        }
    });

    document.getElementById('btn-clear-key')?.addEventListener('click', () => {
        const provider = settingsState.currentSettings?.apiProvider || '';
        if (provider) {
            vscode.postMessage({ type: 'clearApiKey', provider });
        }
    });
}

function postAdd(kind: string, value: string): void {
    switch (kind) {
        case 'packages':
            vscode.postMessage({ type: 'addPiPackage', source: value });
            break;
        case 'extensions':
            vscode.postMessage({ type: 'addPiExtensionPath', path: value });
            break;
        case 'skillpaths':
            vscode.postMessage({ type: 'addPiSkillPath', path: value });
            break;
    }
}

function postRemove(kind: string, index: number): void {
    showToast('Removing…', 'info');
    switch (kind) {
        case 'packages':
            vscode.postMessage({ type: 'removePiPackage', index });
            break;
        case 'extensions':
            vscode.postMessage({ type: 'removePiExtensionPath', index });
            break;
        case 'skillpaths':
            vscode.postMessage({ type: 'removePiSkillPath', index });
            break;
    }
}
