import { escapeHtml } from '../../shared/html';
import type { ToolCallPendingInfo } from '../../shared/protocol';
import { vscode } from '../vscodeApi';
import { el, tryParseJSON } from './helpers';
import { iconsBaseUri } from './icons';
import { state } from './state';
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
    return `<img class="tool-icon-img" src="${iconsBaseUri()}/${file}" alt="${escapeHtml(name)}">`;
}

/** Voice-agent changes waiting for Approve/Reject live above the input, so the chat and the Bot view both show them. */
export function renderToolApprovalCard(pending: ToolCallPendingInfo): void {
    if (!state.pendingToolApprovals.some((p) => p.toolCallId === pending.toolCallId)) {
        state.pendingToolApprovals = [...state.pendingToolApprovals, pending];
    }
    const container = document.getElementById('tool-approval-host');
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
            <span class="tool-name">${escapeHtml(label)}</span>
            <span class="tool-status pending">awaiting approval</span>
        </div>
        <div class="approval-args">${escapeHtml(formatToolArgs(parsedArgs))}</div>
        <div class="approval-actions">
            <button class="approval-btn approve" data-toolcallid="${escapeHtml(pending.toolCallId)}">Approve</button>
            <button class="approval-btn reject" data-toolcallid="${escapeHtml(pending.toolCallId)}">Reject</button>
        </div>
    `;

    container.appendChild(card);
    bindApprovalButtons();
}

export function removeToolApprovalCard(toolCallId: string): void {
    state.pendingToolApprovals = state.pendingToolApprovals.filter((p) => p.toolCallId !== toolCallId);
    document.getElementById(`approval-${toolCallId}`)?.remove();
}

/** The cards match the tab's pending approvals after a state sync or a rebuilt composer. */
export function syncToolApprovalCards(): void {
    const container = document.getElementById('tool-approval-host');
    if (!container) return;
    const wanted = new Set(state.pendingToolApprovals.map((p) => `approval-${p.toolCallId}`));
    for (const card of [...container.children]) {
        if (!wanted.has(card.id)) card.remove();
    }
    for (const pending of state.pendingToolApprovals) {
        renderToolApprovalCard(pending);
    }
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
