import { escapeHtml } from '../../shared/html';
import type { FileChangeInfo } from '../../shared/protocol';
import { vscode } from '../vscodeApi';
import { buildDiffCard, bindDiffButtons } from './diffCard';
import { el } from './helpers';
import { isTurnPrompt } from './messageContent';
import { scrollIfFollowing } from './scroll';
import { state } from './state';

// ── Changed Files section ──

export function getFileIcon(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const icons: Record<string, string> = {
        ts: '&#128312;', tsx: '&#128312;',
        js: '&#128313;', jsx: '&#128313;',
        json: '&#128312;',
        css: '&#128309;', scss: '&#128309;',
        html: '&#128992;',
        md: '&#128310;',
        py: '&#128311;',
        svg: '&#128993;',
    };
    return icons[ext] ?? '&#128196;';
}

/** Latest change per file path, ordered by each path's first appearance. */
export function uniqueFileChanges(changes: FileChangeInfo[]): FileChangeInfo[] {
    const fileMap = new Map<string, FileChangeInfo>();
    for (const c of changes) {
        fileMap.set(c.filePath, c);
    }
    return [...fileMap.values()];
}

function buildChangedFilesSection(): HTMLElement {
    const details = document.createElement('details');
    details.className = 'changed-files-section';
    details.id = 'changed-files-bar';

    const uniqueFiles = uniqueFileChanges(state.fileChanges);
    const count = uniqueFiles.length;

    const summary = document.createElement('summary');
    summary.className = 'changed-files-summary';
    const undoRedoBtn = state.rollbackPoint !== null
        ? `<button class="changed-files-link" id="btn-redo" title="Redo changes">Redo</button>`
        : `<button class="changed-files-link" id="btn-undo" title="Undo last change">Undo</button>`;
    summary.innerHTML = `
        <span class="changed-files-arrow">&#9656;</span>
        <span class="changed-files-count">${count} File${count !== 1 ? 's' : ''}</span>
        <span class="changed-files-spacer"></span>
        ${undoRedoBtn}
        <button class="changed-files-review-btn" id="btn-review-all" title="Review all changes">Review</button>
        <button class="changed-files-dismiss" id="btn-dismiss-changes" title="Dismiss (keep changes)" aria-label="Dismiss">&#10005;</button>
    `;
    details.appendChild(summary);

    const list = el('div', 'changed-files-list');
    for (const change of uniqueFiles) {
        const fileName = change.filePath.split('/').pop() ?? change.filePath;
        const item = el('div', 'changed-file-item');
        item.dataset.filepath = change.filePath;
        item.dataset.toolcallid = change.toolCallId;

        let statsHtml = '';
        if (change.addedLines > 0) statsHtml += `<span class="cf-stat-add">+${change.addedLines}</span>`;
        if (change.removedLines > 0) statsHtml += `<span class="cf-stat-del">-${change.removedLines}</span>`;

        item.innerHTML = `
            <span class="cf-icon">${getFileIcon(change.filePath)}</span>
            <span class="cf-name">${escapeHtml(fileName)}</span>
            <span class="cf-stats">${statsHtml}</span>
        `;
        list.appendChild(item);
    }
    details.appendChild(list);

    return details;
}

export function updateChangedFiles(): void {
    const container = document.querySelector('.input-container');
    if (!container) return;

    const existing = document.getElementById('changed-files-bar') as HTMLDetailsElement | null;
    const wasOpen = existing?.open ?? false;

    if (state.fileChanges.length === 0) {
        existing?.remove();
        return;
    }

    const newSection = buildChangedFilesSection();
    if (wasOpen) {
        (newSection as HTMLDetailsElement).open = true;
    }

    if (existing) {
        existing.replaceWith(newSection);
    } else {
        container.insertBefore(newSection, container.firstChild);
    }

    bindChangedFileItems();

    const undoBtn = document.getElementById('btn-undo');
    undoBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        let lastUserTurn = 0;
        for (const msg of state.messages) {
            if (isTurnPrompt(msg)) lastUserTurn++;
        }
        if (lastUserTurn < 1) return;
        vscode.postMessage({
            type: 'confirmAction',
            action: 'restoreCheckpoint',
            message: 'Undo changes from the last turn?',
            payload: { messageIndex: lastUserTurn - 1 },
        });
    });

    const redoBtn = document.getElementById('btn-redo');
    redoBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        vscode.postMessage({
            type: 'confirmAction',
            action: 'redoCheckpoint',
            message: 'Re-apply the rolled-back changes?',
        });
    });

    const reviewBtn = document.getElementById('btn-review-all');
    reviewBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const seen = new Set<string>();
        for (const change of state.fileChanges) {
            if (!seen.has(change.filePath)) {
                seen.add(change.filePath);
                vscode.postMessage({ type: 'openDiff', filePath: change.filePath, toolCallId: change.toolCallId });
            }
        }
    });

    document.getElementById('btn-dismiss-changes')?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        vscode.postMessage({ type: 'acceptFileChanges' });
    });
}

export function renderChangedFilesBar(): void {
    const existing = document.getElementById('changed-files-bar');
    if (existing) {
        const count = uniqueFileChanges(state.fileChanges).length;
        const countEl = existing.querySelector('.changed-files-count');
        if (countEl) {
            countEl.textContent = `${count} File${count !== 1 ? 's' : ''}`;
        }
    }
}

export function renderInlineFileChange(change: FileChangeInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    const existing = document.getElementById(`diff-${change.toolCallId}`);
    if (existing) return;

    const card = buildDiffCard(change);

    const loadingCard = document.getElementById(`tool-${change.toolCallId}`);
    if (loadingCard) {
        loadingCard.replaceWith(card);
    } else {
        container.appendChild(card);
    }

    bindDiffButtons();
    scrollIfFollowing();
}

function bindChangedFileItems(): void {
    document.querySelectorAll('.changed-file-item:not([data-bound])').forEach((item) => {
        item.setAttribute('data-bound', '1');
        item.addEventListener('click', () => {
            const filePath = (item as HTMLElement).dataset.filepath;
            const toolCallId = (item as HTMLElement).dataset.toolcallid;
            if (filePath && toolCallId) {
                vscode.postMessage({ type: 'openDiff', filePath, toolCallId });
            }
        });
    });
}
