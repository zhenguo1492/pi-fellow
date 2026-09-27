import { escapeHtml } from '../../shared/html';
import { vscode } from '../vscodeApi';
import { iconsBaseUri } from './icons';
import { state } from './state';

let queuedEditingIndex = -1;

export function updateQueuedMessageBanner(): void {
    const section = document.getElementById('queued-section') as HTMLDetailsElement | null;
    if (!section) return;

    if (state.queuedMessages.length === 0) {
        section.style.display = 'none';
        section.innerHTML = '';
        queuedEditingIndex = -1;
        return;
    }

    section.style.display = '';
    section.open = true;

    const count = state.queuedMessages.length;
    section.innerHTML = `
        <summary class="queued-summary">
            <span class="queued-chevron">&#9656;</span>
            <span class="queued-count">${count} Queued</span>
        </summary>
        <div class="queued-list">
            ${state.queuedMessages.map((msg, i) => {
                if (i === queuedEditingIndex) {
                    return `<div class="queued-item queued-item-editing" data-index="${i}">
                        <span class="queued-item-icon">&#9675;</span>
                        <input class="queued-edit-input" data-index="${i}" type="text" value="${escapeHtml(msg)}">
                        <button class="queued-edit-save" data-index="${i}" title="Save">&#10003;</button>
                        <button class="queued-edit-cancel" data-index="${i}" title="Cancel">&#10005;</button>
                    </div>`;
                }
                return `<div class="queued-item" data-index="${i}">
                    <span class="queued-item-icon">&#9675;</span>
                    <span class="queued-item-text">${escapeHtml(msg)}</span>
                    <span class="queued-item-actions">
                        <button class="queued-item-btn queued-item-steer" data-index="${i}" title="Steer now" aria-label="Steer now"><svg class="queued-btn-svg" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                        <button class="queued-item-btn queued-item-edit" data-index="${i}" title="Edit"><img class="queued-btn-icon" src="${iconsBaseUri()}/pencil.svg" alt="edit"></button>
                        <button class="queued-item-btn queued-item-delete" data-index="${i}" title="Remove"><img class="queued-btn-icon" src="${iconsBaseUri()}/trash.svg" alt="remove"></button>
                    </span>
                </div>`;
            }).join('')}
        </div>
    `;

    bindQueuedItemEvents(section);
}

function bindQueuedItemEvents(section: HTMLElement): void {
    section.querySelectorAll('.queued-item-delete').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                if (queuedEditingIndex === idx) queuedEditingIndex = -1;
                else if (queuedEditingIndex > idx) queuedEditingIndex--;
                vscode.postMessage({ type: 'removeQueuedMessage', index: idx });
            }
        });
    });

    section.querySelectorAll('.queued-item-steer').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                if (queuedEditingIndex === idx) queuedEditingIndex = -1;
                else if (queuedEditingIndex > idx) queuedEditingIndex--;
                vscode.postMessage({ type: 'steerQueuedMessage', index: idx });
            }
        });
    });

    section.querySelectorAll('.queued-item-edit').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                queuedEditingIndex = idx;
                updateQueuedMessageBanner();
                const input = section.querySelector(`.queued-edit-input[data-index="${idx}"]`) as HTMLInputElement | null;
                if (input) {
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            }
        });
    });

    section.querySelectorAll('.queued-edit-save').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            const input = section.querySelector(`.queued-edit-input[data-index="${idx}"]`) as HTMLInputElement | null;
            if (idx >= 0 && input && input.value.trim()) {
                queuedEditingIndex = -1;
                vscode.postMessage({ type: 'editQueuedMessage', index: idx, text: input.value.trim() });
            }
        });
    });

    section.querySelectorAll('.queued-edit-cancel').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            queuedEditingIndex = -1;
            updateQueuedMessageBanner();
        });
    });

    section.querySelectorAll('.queued-edit-input').forEach((input) => {
        input.addEventListener('keydown', (e) => {
            const ke = e as KeyboardEvent;
            const idx = parseInt((input as HTMLElement).dataset.index ?? '-1', 10);
            if (ke.key === 'Enter') {
                ke.preventDefault();
                const val = (input as HTMLInputElement).value.trim();
                if (idx >= 0 && val) {
                    queuedEditingIndex = -1;
                    vscode.postMessage({ type: 'editQueuedMessage', index: idx, text: val });
                }
            }
            if (ke.key === 'Escape') {
                ke.preventDefault();
                queuedEditingIndex = -1;
                updateQueuedMessageBanner();
            }
        });
    });
}
