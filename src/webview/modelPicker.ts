import { escapeHtml } from '../shared/html';
import type { ModelInfo } from '../shared/protocol';
import { vscode } from './vscodeApi';

/**
 * Composer model picker: chip under the textarea opens a list of the starred models
 * (`oh-my-pi-chater.favoriteModels`) above the composer. Starring happens in the full model
 * QuickPick (status bar / `/model`), not here.
 */

let models: ModelInfo[] = [];
let favorites: string[] = [];
let current: ModelInfo | undefined;
/** Favorite models that are currently available, in starring order. */
let rows: ModelInfo[] = [];
let highlight = 0;
let dismissBound = false;

function modelKey(m: { provider: string; id: string }): string {
    return `${m.provider}/${m.id}`;
}

function isCurrent(m: ModelInfo): boolean {
    return !!current && current.provider === m.provider && current.id === m.id;
}

function isModelPickerOpen(): boolean {
    const picker = document.getElementById('model-picker');
    return !!picker && !picker.hidden;
}

export function setPickerModels(next: ModelInfo[], nextFavorites: string[]): void {
    models = next;
    favorites = nextFavorites;
    if (isModelPickerOpen()) {
        renderList();
    }
}

export function setPickerCurrentModel(model: ModelInfo | undefined): void {
    current = model;
    updateModelChip();
    if (isModelPickerOpen()) {
        renderList();
    }
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
                const model = rows[highlight];
                if (model) {
                    selectModel(model);
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
        const row = (e.target as HTMLElement).closest('.model-item') as HTMLElement | null;
        const model = row ? rows[Number(row.dataset.index)] : undefined;
        if (model) {
            selectModel(model);
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

function selectModel(model: ModelInfo): void {
    if (!isCurrent(model)) {
        vscode.postMessage({ type: 'setModel', provider: model.provider, modelId: model.id });
        // Optimistic; the stateSync that follows set_model carries the authoritative model.
        current = model;
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
    label.textContent = current ? current.name || current.id : 'Select model';
    chip.title = current ? `Model: ${modelKey(current)} — switch to a favorite` : 'Switch to a favorite model';
}

function renderList(): void {
    const list = document.getElementById('model-list');
    if (!list) {
        return;
    }
    const byKey = new Map(models.map((m) => [modelKey(m), m]));
    // Favorites for providers that are no longer signed in stay hidden.
    rows = favorites.map((k) => byKey.get(k)).filter((m): m is ModelInfo => !!m);
    highlight = Math.min(highlight, Math.max(rows.length - 1, 0));

    if (rows.length === 0) {
        list.innerHTML =
            '<div class="model-picker-hint">No favorite models yet. Star models in the model picker (status bar model button or <code>/model</code>).</div>';
        return;
    }
    list.innerHTML = rows
        .map((m, index) => {
            const active = isCurrent(m);
            const classes = ['model-item', active ? 'active' : '', index === highlight ? 'highlighted' : '']
                .filter(Boolean)
                .join(' ');
            return `
                <div class="${classes}" data-index="${index}" role="option" aria-selected="${active}">
                    <span class="model-item-check" aria-hidden="true">${active ? '✓' : ''}</span>
                    <span class="model-item-name" title="${escapeHtml(modelKey(m))}">${escapeHtml(m.name || m.id)}</span>
                    <span class="model-item-provider">${escapeHtml(m.provider)}</span>
                </div>`;
        })
        .join('');
    list.querySelector('.model-item.highlighted')?.scrollIntoView({ block: 'nearest' });
}
