import type { ToolCallPendingInfo } from '../../shared/protocol';
import { vscode } from '../vscodeApi';
import { el, escHtml, tryParseJSON } from './helpers';
import { iconsBaseUri } from './icons';
import { scrollIfFollowing } from './scroll';
import { formatToolArgs, getToolLabel } from './toolFormat';

// ── Tool approval cards ──

export function getToolIcon(name: string): string {
    const iconFiles: Record<string, string> = {
        bash: 'terminal.svg',
        python: 'code.svg',
        read: 'text.svg',
        write: 'pencil.svg',
        edit: 'pencil.svg',
        glob: 'magnifying-glass.svg',
        grep: 'magnifying-glass.svg',
        list: 'folder.svg',
    };
    const file = iconFiles[name.toLowerCase()] ?? 'bolt.svg';
    return `<img class="tool-icon-img" src="${iconsBaseUri()}/${file}" alt="${escHtml(name)}">`;
}

export function renderToolApprovalCard(pending: ToolCallPendingInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    const existing = document.getElementById(`approval-${pending.toolCallId}`);
    if (existing) return;

    const card = el('div', 'tool-approval-card');
    card.id = `approval-${pending.toolCallId}`;

    const parsedArgs = typeof pending.args === 'string' ? tryParseJSON(pending.args) : pending.args;
    const label = getToolLabel(pending.toolName, parsedArgs);

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(pending.toolName)}</span>
            <span class="tool-name">${escHtml(label)}</span>
            <span class="tool-status pending">awaiting approval</span>
        </div>
        <div class="approval-args">${escHtml(formatToolArgs(parsedArgs))}</div>
        <div class="approval-actions">
            <button class="approval-btn approve" data-toolcallid="${escHtml(pending.toolCallId)}">Approve</button>
            <button class="approval-btn reject" data-toolcallid="${escHtml(pending.toolCallId)}">Reject</button>
        </div>
    `;

    container.appendChild(card);
    bindApprovalButtons();
    scrollIfFollowing();
}

export function removeToolApprovalCard(toolCallId: string): void {
    document.getElementById(`approval-${toolCallId}`)?.remove();
}

function bindApprovalButtons(): void {
    document.querySelectorAll('.approval-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const toolCallId = (btn as HTMLElement).dataset.toolcallid;
            if (!toolCallId) return;
            if (btn.classList.contains('approve')) {
                vscode.postMessage({ type: 'approveToolCall', toolCallId });
            } else {
                vscode.postMessage({ type: 'rejectToolCall', toolCallId });
            }
            removeToolApprovalCard(toolCallId);
        });
    });
}
