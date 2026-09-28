import type { AgentBackend } from '../../shared/protocol';
import { vscode } from './api';
import { modelOptionsHtml } from './auth';
import { showToast } from './dom';
import { bindMcpServerCards } from './mcp';
import { settingsState } from './state';
import { bindVoiceSetup } from './voiceSetup';

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

    // Voice tab: drafts until its Save (see voiceSetup.ts).
    bindVoiceSetup();

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

    // Save writes both fields as shown ('' is auto); a model picked under (auto) brings its provider.
    document.getElementById('btn-save-pi-defaults')?.addEventListener('click', () => {
        const model = (document.getElementById('pi-default-model') as HTMLSelectElement).value;
        const provider = (document.getElementById('pi-default-provider') as HTMLSelectElement).value
            || (settingsState.currentSettings?.piConfig?.availableModels.find((m) => m.id === model)?.provider ?? '');
        vscode.postMessage({
            type: 'updatePiDefaults',
            provider,
            model,
            thinkingLevel: (document.getElementById('pi-thinking') as HTMLSelectElement).value,
        });
    });

    // The model list follows the provider, so Save can never pair a model with another provider.
    document.getElementById('pi-default-provider')?.addEventListener('change', (e) => {
        const models = settingsState.currentSettings?.piConfig?.availableModels ?? [];
        const modelSelect = document.getElementById('pi-default-model') as HTMLSelectElement;
        modelSelect.innerHTML = modelOptionsHtml(models, (e.target as HTMLSelectElement).value, modelSelect.value);
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

    document.querySelectorAll('[data-reload-session]').forEach((btn) => {
        btn.addEventListener('click', () => vscode.postMessage({ type: 'reloadPiSession' }));
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
