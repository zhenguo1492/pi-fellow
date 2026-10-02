import { escapeHtml } from '../shared/html';
import type { ModelInfo } from '../shared/protocol';
import type { VoiceEngines } from '../shared/voiceViewProtocol';
import { vscode } from './vscodeApi';

/**
 * Composer model picker: chip under the textarea opens a list of the starred models
 * (`oh-my-pi-chater.favoriteModels`) above the composer. Starring happens in the full model
 * QuickPick (status bar / `/model`), not here.
 *
 * The chip picks the model of what the composer talks to: the chat tab's worker, or in the Bot view
 * the voice agent (`voiceAgent.model`; left empty, it takes the chat tab's model, which Settings →
 * Voice sets back). The two are separate state: a pick for one never changes the other.
 */

export type PickerTarget = 'worker' | 'voice';

/** A row of the list; `key` is `provider/id`. */
interface PickerRow {
    key: string;
    name: string;
    provider: string;
    model?: ModelInfo;
}

let models: ModelInfo[] = [];
let favorites: string[] = [];
let target: PickerTarget = 'worker';
/** The chat tab's model. */
let workerModel: ModelInfo | undefined;
/** The voice agent's: `setting` as chosen (empty: the chat tab's), `model` what it runs or will start on. */
let voiceModel: VoiceEngines['llm'] | undefined;
let rows: PickerRow[] = [];
let highlight = 0;
let dismissBound = false;

function modelKey(m: { provider: string; id: string }): string {
    return `${m.provider}/${m.id}`;
}

/** A model's display name: its catalog name, else the id part of `provider/id`. */
function modelName(key: string): string {
    const known = models.find((m) => modelKey(m) === key);
    return known ? known.name || known.id : key.slice(key.indexOf('/') + 1);
}

function isCurrent(row: PickerRow): boolean {
    if (target === 'voice') {
        return row.key === (voiceModel?.setting ?? '');
    }
    return !!workerModel && row.key === modelKey(workerModel);
}

function isModelPickerOpen(): boolean {
    const picker = document.getElementById('model-picker');
    return !!picker && !picker.hidden;
}

function refresh(): void {
    updateModelChip();
    if (isModelPickerOpen()) {
        renderList();
    }
}

export function setPickerModels(next: ModelInfo[], nextFavorites: string[]): void {
    models = next;
    favorites = nextFavorites;
    refresh();
}

/** The chat tab's model (stateSync, `models`). */
export function setPickerCurrentModel(model: ModelInfo | undefined): void {
    workerModel = model;
    refresh();
}

/** The voice agent's model, from each Bot view state. */
export function setVoicePickerModel(llm: VoiceEngines['llm']): void {
    if (voiceModel?.setting === llm.setting && voiceModel.model === llm.model) {
        return;
    }
    voiceModel = { ...llm };
    refresh();
}

/** What the composer talks to: the worker, or in the Bot view the voice agent. */
export function setPickerTarget(next: PickerTarget): void {
    if (next === target) {
        return;
    }
    closeModelPicker(false);
    target = next;
    updateModelChip();
}

/** Wire the chip and list; call after every composer skeleton rebuild. */
export function bindModelPicker(): void {
    const chip = document.getElementById('btn-model');
    const list = document.getElementById('model-list');
    if (!chip || !list) {
        return;
    }

    chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isModelPickerOpen()) {
            closeModelPicker(true);
        } else {
            openModelPicker();
        }
    });

    list.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'ArrowDown':
            case 'ArrowUp':
                e.preventDefault();
                if (rows.length > 0) {
                    highlight = (highlight + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
                    renderList();
                }
                break;
            case 'Enter': {
                e.preventDefault();
                const row = rows[highlight];
                if (row) {
                    selectRow(row);
                }
                break;
            }
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                closeModelPicker(true);
                break;
        }
    });

    list.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest('.model-item') as HTMLElement | null;
        const row = item ? rows[Number(item.dataset.index)] : undefined;
        if (row) {
            selectRow(row);
        }
    });

    if (!dismissBound) {
        dismissBound = true;
        document.addEventListener('click', (e) => {
            if (!(e.target as HTMLElement).closest('#model-picker, #btn-model')) {
                closeModelPicker(false);
            }
        });
    }

    updateModelChip();
}

function openModelPicker(): void {
    const picker = document.getElementById('model-picker');
    const list = document.getElementById('model-list');
    if (!picker || !list) {
        return;
    }
    // Cached on the host; picks up stars added in the QuickPick since the last push.
    vscode.postMessage({ type: 'getModels' });
    list.setAttribute('aria-label', target === 'voice' ? 'Voice agent model' : 'Favorite models');
    highlight = 0;
    renderList();
    highlight = Math.max(rows.findIndex(isCurrent), 0);
    renderList();
    picker.hidden = false;
    document.getElementById('btn-model')?.setAttribute('aria-expanded', 'true');
    list.focus();
}

function closeModelPicker(focusComposer: boolean): void {
    const picker = document.getElementById('model-picker');
    if (!picker || picker.hidden) {
        return;
    }
    picker.hidden = true;
    document.getElementById('btn-model')?.setAttribute('aria-expanded', 'false');
    if (focusComposer) {
        (document.getElementById('input') as HTMLTextAreaElement | null)?.focus();
    }
}

function selectRow(row: PickerRow): void {
    if (!isCurrent(row)) {
        if (target === 'voice') {
            vscode.postMessage({ type: 'voiceAgent', action: { type: 'model', model: row.key } });
            // Optimistic; the Bot view state that follows the setting change carries what is in use.
            voiceModel = { thinking: voiceModel?.thinking ?? 'off', model: row.key, setting: row.key };
        } else if (row.model) {
            vscode.postMessage({ type: 'setModel', provider: row.model.provider, modelId: row.model.id });
            // Optimistic; the stateSync that follows set_model carries the authoritative model.
            workerModel = row.model;
        }
        updateModelChip();
    }
    closeModelPicker(true);
}

function updateModelChip(): void {
    const label = document.getElementById('model-chip-label');
    const chip = document.getElementById('btn-model');
    if (!label || !chip) {
        return;
    }
    chip.classList.toggle('voice-model', target === 'voice');
    if (target === 'voice') {
        const setting = voiceModel?.setting ?? '';
        const running = voiceModel?.model;
        label.textContent = setting ? modelName(setting) : running ? modelName(running) : 'Same as chat';
        chip.title = [
            setting
                ? `Voice agent model: ${setting}`
                : `Voice agent model: the chat tab's${running ? ` (${running})` : ''}, taken when the voice agent starts`,
            ...(setting && running && running !== setting ? [`Running ${running} until its current reply ends`] : []),
            'Separate from the chat\'s model. A pick applies from the voice agent\'s next reply; Settings → Voice sets it back to the chat\'s.',
        ].join('\n');
        return;
    }
    label.textContent = workerModel ? workerModel.name || workerModel.id : 'Select model';
    chip.title = workerModel ? `Model: ${modelKey(workerModel)} — switch to a favorite` : 'Switch to a favorite model';
}

function pickerRows(): PickerRow[] {
    const byKey = new Map(models.map((m) => [modelKey(m), m]));
    // Favorites for providers that are no longer signed in stay hidden.
    const starred: PickerRow[] = favorites
        .map((k) => byKey.get(k))
        .filter((m): m is ModelInfo => !!m)
        .map((m) => ({ key: modelKey(m), name: m.name || m.id, provider: m.provider, model: m }));
    if (target === 'worker') {
        return starred;
    }
    const setting = voiceModel?.setting ?? '';
    // A model set elsewhere (Settings, settings.json) shows too, so the list says what is chosen.
    const chosen: PickerRow[] = setting && !starred.some((row) => row.key === setting)
        ? [{ key: setting, name: modelName(setting), provider: setting.includes('/') ? setting.slice(0, setting.indexOf('/')) : '', model: byKey.get(setting) }]
        : [];
    return [...chosen, ...starred];
}

function renderList(): void {
    const list = document.getElementById('model-list');
    if (!list) {
        return;
    }
    list.closest('.model-picker')?.classList.toggle('voice-model-picker', target === 'voice');
    rows = pickerRows();
    highlight = Math.min(highlight, Math.max(rows.length - 1, 0));

    const hint = target === 'voice'
        ? '<div class="model-picker-hint">The voice agent\'s model, separate from the chat\'s. A pick applies from its next reply.</div>'
        : '';
    const noFavorites = !rows.some((row) => row.model && favorites.includes(row.key))
        ? '<div class="model-picker-hint">No favorite models yet. Star models in the model picker (status bar model button or <code>/model</code>).</div>'
        : '';
    if (rows.length === 0) {
        list.innerHTML = noFavorites;
        return;
    }
    list.innerHTML = hint + rows
        .map((row, index) => {
            const active = isCurrent(row);
            const classes = ['model-item', active ? 'active' : '', index === highlight ? 'highlighted' : '']
                .filter(Boolean)
                .join(' ');
            return `
                <div class="${classes}" data-index="${index}" role="option" aria-selected="${active}">
                    <span class="model-item-check" aria-hidden="true">${active ? '✓' : ''}</span>
                    <span class="model-item-name" title="${escapeHtml(row.key)}">${escapeHtml(row.name)}</span>
                    <span class="model-item-provider">${escapeHtml(row.provider)}</span>
                </div>`;
        })
        .join('') + noFavorites;
    list.querySelector('.model-item.highlighted')?.scrollIntoView({ block: 'nearest' });
}
