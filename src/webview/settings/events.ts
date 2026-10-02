import type { AgentBackend, SettingEdit } from '../../shared/protocol';
import { vscode } from './api';
import { modelOptionsHtml } from './auth';
import { buildListEditor, showToast } from './dom';
import { setEdit, setSetting } from './edits';
import { bindMcpServerCards } from './mcp';
import { settingsState } from './state';
import { bindVoiceSetup } from './voiceSetup';

/** The path lists edited on the page (the list editors' kinds), and their edits. */
const PATH_LISTS: Record<string, 'extensionPaths' | 'skillPaths'> = { extensions: 'extensionPaths', skillpaths: 'skillPaths' };

/**
 * Every setting is an edit until the page's Save (`edits.ts`, `saveBar.ts`); actions (log in,
 * install a package, check a server, reload the session, …) still happen at once.
 */
export function bindEvents(): void {
    document.querySelectorAll('.backend-segment-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const b = (e.currentTarget as HTMLElement).dataset.backend as AgentBackend;
            if (!b || b === settingsState.currentSettings?.backend) {
                return;
            }
            // The edits are for this backend's config: they would be saved into the other one's.
            if (settingsState.dirty) {
                showToast('Save or Discard your changes before switching the backend.', 'error');
                return;
            }
            vscode.postMessage({ type: 'setBackend', backend: b });
        });
    });

    // The `[data-key]` fields outside the voice services' forms (those are voiceSetup.ts drafts).
    document.querySelectorAll<HTMLSelectElement>('.setting-select[data-key]').forEach((select) => {
        if (select.closest('[data-draft]')) return;
        select.addEventListener('change', () => setSetting(select.dataset.key!, select.value, select));
    });
    document.querySelectorAll<HTMLInputElement>('.setting-input[data-key]').forEach((input) => {
        if (input.closest('[data-draft]')) return;
        input.addEventListener('input', () => {
            const key = input.dataset.key!;
            setSetting(key, key === 'allowedTools' ? input.value.split(',').map((s) => s.trim()).filter(Boolean) : input.value, input);
        });
    });
    document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-key]').forEach((cb) => {
        if (cb.closest('[data-draft]')) return;
        cb.addEventListener('change', () => setSetting(cb.dataset.key!, cb.checked, cb));
    });
    document.querySelectorAll<HTMLInputElement>('.setting-range[data-key]').forEach((range) => {
        range.addEventListener('input', () => {
            const key = range.dataset.key!;
            const value = parseInt(range.value, 10);
            const label = document.getElementById(`range-val-${key}`);
            if (label) label.textContent = `${value}%`;
            setSetting(key, value, range);
        });
    });

    // Voice tab: the services' drafts, Test and Try (see voiceSetup.ts).
    bindVoiceSetup();

    // The default model: the list follows the provider, so it never pairs a model with another provider.
    const provider = document.getElementById('pi-default-provider') as HTMLSelectElement | null;
    const model = document.getElementById('pi-default-model') as HTMLSelectElement | null;
    if (provider && model) {
        const editModel = () => setEdit('piModel', { kind: 'piDefaults', provider: provider.value, model: model.value }, model);
        provider.addEventListener('change', () => {
            model.innerHTML = modelOptionsHtml(settingsState.currentSettings?.piConfig?.availableModels ?? [], provider.value, model.value);
            editModel();
        });
        model.addEventListener('change', editModel);
    }

    const thinking = document.getElementById('pi-thinking') as HTMLSelectElement | null;
    thinking?.addEventListener('change', () => setEdit('piThinking', { kind: 'piDefaults', thinkingLevel: thinking.value }, thinking));

    document.querySelectorAll<HTMLSelectElement>('[data-pi-mode]').forEach((sel) => {
        sel.addEventListener('change', () => {
            const kind = sel.dataset.piMode === 'steering' ? 'steeringMode' : 'followUpMode';
            setEdit(kind, { kind, mode: sel.value as 'all' | 'one-at-a-time' }, sel);
        });
    });

    const skillCommands = document.getElementById('pi-enable-skill-cmds') as HTMLInputElement | null;
    skillCommands?.addEventListener('change', () => setEdit('skillCommands', { kind: 'skillCommands', enabled: skillCommands.checked }, skillCommands));

    document.querySelectorAll<HTMLButtonElement>('[data-add-btn]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const kind = btn.dataset.addBtn!;
            const input = document.querySelector<HTMLInputElement>(`input[data-add-kind="${kind}"]`);
            const value = input?.value.trim();
            if (!input || !value) {
                showToast('Enter a value first', 'error');
                return;
            }
            if (kind === 'packages') {
                vscode.postMessage({ type: 'addPiPackage', source: value });
            } else {
                const paths = shownPaths(kind);
                if (paths.includes(value)) {
                    showToast('Already in the list', 'error');
                    return;
                }
                editPaths(kind, [...paths, value], btn);
            }
            input.value = '';
        });
    });

    // Delegated: a path list is built again after each edit.
    document.querySelector('.settings-tab-panels')?.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('[data-remove-kind]') : null;
        if (!btn) {
            return;
        }
        const kind = btn.dataset.removeKind!;
        const index = parseInt(btn.dataset.removeIndex!, 10);
        if (kind === 'packages') {
            showToast('Uninstalling…', 'info');
            vscode.postMessage({ type: 'removePiPackage', index });
        } else {
            const list = btn.closest('.pi-list') ?? btn;
            editPaths(kind, shownPaths(kind).filter((_, i) => i !== index), list);
        }
    });

    document.querySelectorAll<HTMLButtonElement>('[data-open-file]').forEach((btn) => {
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'openPiAgentFile', file: btn.dataset.openFile as 'settings' | 'auth' | 'mcp' });
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

/** A path list as shown (with its edit). */
function shownPaths(kind: string): string[] {
    const cfg = settingsState.currentSettings?.piConfig;
    return (PATH_LISTS[kind] === 'extensionPaths' ? cfg?.extensionPaths : cfg?.skillPaths) ?? [];
}

/** A path list edited: kept as an edit, and its list built again. */
function editPaths(kind: string, paths: string[], from: Element): void {
    const edit: SettingEdit = { kind: PATH_LISTS[kind], paths };
    setEdit(edit.kind, edit, from);
    const list = document.getElementById(`list-${kind}`);
    list?.parentElement?.replaceWith(buildListEditor(kind, shownPaths(kind), list.dataset.hint ?? ''));
}
