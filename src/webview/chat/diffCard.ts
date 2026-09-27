import type { FileChangeInfo } from '../../shared/protocol';
import { vscode } from '../vscodeApi';
import { el, escHtml, formatTimestamp } from './helpers';
import { state } from './state';

// ── Inline diff card ──

export function buildDiffCard(change: FileChangeInfo, msg?: any): HTMLElement {
    const wrapper = el('div', 'tool-card-wrapper');

    const card = el('div', 'diff-card');
    card.id = `diff-${change.toolCallId}`;

    const fileName = change.filePath.split('/').pop() ?? change.filePath;
    const dirPath = change.filePath.split('/').slice(0, -1).join('/');

    let statsHtml = '';
    if (change.addedLines > 0 || change.removedLines > 0) {
        statsHtml = `<span class="diff-stats">`;
        if (change.addedLines > 0) statsHtml += `<span class="diff-stat-add">+${change.addedLines}</span>`;
        if (change.removedLines > 0) statsHtml += `<span class="diff-stat-del">-${change.removedLines}</span>`;
        statsHtml += `</span>`;
    }

    card.innerHTML = `
        <div class="diff-file-header" data-filepath="${escHtml(change.filePath)}" data-toolcallid="${escHtml(change.toolCallId)}">
            <span class="diff-file-icon">${change.isNew ? '&#10010;' : '&#9998;'}</span>
            <span class="diff-file-name">${escHtml(fileName)}</span>
            ${dirPath ? `<span class="diff-file-dir">${escHtml(dirPath)}</span>` : ''}
            ${statsHtml}
            ${change.isNew ? '<span class="diff-new-badge">NEW</span>' : ''}
        </div>
    `;

    if (change.diff) {
        const diffView = el('div', 'diff-view');
        diffView.innerHTML = renderDiffLines(change.diff);
        card.appendChild(diffView);
    }

    wrapper.appendChild(card);

    const ts = msg?.timestamp;
    if (ts) {
        const footer = el('div', 'tool-footer');
        footer.textContent = formatTimestamp(ts);
        wrapper.appendChild(footer);
    }

    return wrapper;
}

/** Unified diff → one classified, escaped `<div>` per line; `---`/`+++` file headers are dropped. */
export function renderDiffLines(diff: string): string {
    const lines = diff.split('\n');
    const htmlLines: string[] = [];

    for (const line of lines) {
        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            continue;
        }
        if (line.startsWith('@@')) {
            htmlLines.push(`<div class="diff-line diff-line-hunk">${escHtml(line)}</div>`);
        } else if (line.startsWith('+')) {
            htmlLines.push(`<div class="diff-line diff-line-add">${escHtml(line)}</div>`);
        } else if (line.startsWith('-')) {
            htmlLines.push(`<div class="diff-line diff-line-del">${escHtml(line)}</div>`);
        } else {
            htmlLines.push(`<div class="diff-line diff-line-ctx">${escHtml(line)}</div>`);
        }
    }

    return htmlLines.join('');
}

export function bindDiffButtons(): void {
    document.querySelectorAll('.diff-file-header:not([data-bound])').forEach((header) => {
        header.setAttribute('data-bound', '1');
        header.addEventListener('click', () => {
            const filePath = (header as HTMLElement).dataset.filepath;
            const toolCallId = (header as HTMLElement).dataset.toolcallid;
            if (filePath && toolCallId) {
                vscode.postMessage({ type: 'openDiff', filePath, toolCallId });
            }
        });
    });
}

export function findFileChangeForToolResult(msg: any): FileChangeInfo | undefined {
    const id = msg.toolCallId ?? msg.tool_call_id;
    if (id) {
        const match = state.fileChanges.find(c => c.toolCallId === id);
        if (match) return match;
    }
    return undefined;
}
