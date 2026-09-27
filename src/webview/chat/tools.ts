import { createToolView, toToolResult, updateToolView } from '../toolView';
import { buildDiffCard, findFileChangeForToolResult } from './diffCard';
import { el, escHtml } from './helpers';
import { scrollIfFollowing } from './scroll';
import { extractToolResultText, findToolCallArgs, toolFooterParts } from './toolFormat';

export function buildHistoryToolView(msg: any, msgIndex: number, allMessages: any[]): HTMLElement {
    const toolCallId = msg.toolCallId ?? msg.tool_call_id ?? '';
    return createToolView(toolCallId, {
        name: msg.toolName || 'tool',
        args: findToolCallArgs(allMessages, msgIndex, toolCallId),
        result: toToolResult(msg, msg.isError === true),
    });
}

function buildToolFooter(msg: any, allMessages: any[], msgIndex: number): HTMLElement | null {
    const parts = toolFooterParts(msg, allMessages, msgIndex);
    if (parts.length === 0) return null;
    const footer = el('div', 'tool-footer');
    footer.textContent = parts.join(' · ');
    return footer;
}

export function buildToolResultCard(msg: any, allMessages: any[], msgIndex: number): HTMLElement {
    const wrapper = el('div', 'tool-card-wrapper');
    wrapper.appendChild(buildHistoryToolView(msg, msgIndex, allMessages));
    const footer = buildToolFooter(msg, allMessages, msgIndex);
    if (footer) wrapper.appendChild(footer);
    return wrapper;
}

const toolsOpenByKey = new Map<string, boolean>();

export function captureToolsOpenState(): void {
    document.querySelectorAll('details.tools-block[data-tools-key]').forEach((node) => {
        const el = node as HTMLDetailsElement;
        const key = el.dataset.toolsKey;
        if (key) {
            toolsOpenByKey.set(key, el.open);
        }
    });
}

export function clearStreamingToolArtifacts(): void {
    const container = document.getElementById('streaming-message');
    if (!container) {
        return;
    }
    container
        .querySelectorAll(
            'omp-tool-view, .tool-card-wrapper, .diff-card, .tool-approval-card',
        )
        .forEach((node) => node.remove());
}

/** A tool result message and its index in `state.messages`. */
export type ToolStepItem = { msg: any; index: number };

/** Once a tool result is in the history, its live card in the streaming area is a duplicate. */
export function removeLiveToolArtifacts(toolCallId: string): void {
    const live = document.getElementById('streaming-message');
    if (!live || !toolCallId) {
        return;
    }
    live.querySelector(`#${CSS.escape(`tool-${toolCallId}`)}`)?.remove();
    const diff = live.querySelector(`#${CSS.escape(`diff-${toolCallId}`)}`);
    (diff?.closest('.tool-card-wrapper') ?? diff)?.remove();
}

/** Tools called by one reasoning step, placed right after that step's thinking/text. */
export function buildStepToolsBlock(
    items: ToolStepItem[],
    allMessages: any[],
    live: boolean,
): HTMLElement {
    const details = document.createElement('details');
    details.className = 'tools-block';
    const toolsKey = `tools:${items[0].index}`;
    details.dataset.toolsKey = toolsKey;
    details.open = toolsOpenByKey.get(toolsKey) ?? true;

    const count = items.length;
    const toolNames = [...new Set(items.map((it) => (it.msg.toolName ?? 'tool').toLowerCase()))];
    const summary = document.createElement('summary');
    summary.className = 'tools-summary';
    summary.innerHTML = `
        <span class="tools-indicator"></span>
        <span class="tools-label">${live ? 'Using' : 'Used'} ${count} tool${count !== 1 ? 's' : ''} (${escHtml(toolNames.join(', '))})</span>
        <span class="tools-chevron">&#9656;</span>
    `;

    const list = el('div', 'tools-list');
    for (const item of items) {
        const toolName = item.msg.toolName ?? '';
        const change =
            toolName === 'edit' || toolName === 'write'
                ? findFileChangeForToolResult(item.msg)
                : undefined;
        list.appendChild(
            change
                ? buildDiffCard(change, item.msg)
                : buildHistoryToolView(item.msg, item.index, allMessages),
        );
    }

    details.appendChild(summary);
    details.appendChild(list);
    details.addEventListener('toggle', () => {
        toolsOpenByKey.set(toolsKey, details.open);
    });
    return details;
}

export function renderToolStart(event: any): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    if ((event.toolName ?? '').toLowerCase() === 'todo') {
        return;
    }

    const nameLower = (event.toolName ?? '').toLowerCase();

    if ((nameLower === 'edit' || nameLower === 'write') && event.args?.path) {
        const card = el('div', 'diff-card loading');
        card.id = `tool-${event.toolCallId}`;
        const fileName = (event.args.path as string).split('/').pop() ?? event.args.path;
        card.innerHTML = `
            <div class="diff-file-header">
                <span class="diff-file-icon">&#9998;</span>
                <span class="diff-file-name">${escHtml(fileName)}</span>
                <span class="tool-status running">running</span>
            </div>
        `;
        container.appendChild(card);
        scrollIfFollowing();
        return;
    }

    const card = createToolView(event.toolCallId ?? '', {
        name: event.toolName || 'tool',
        args: event.args,
        running: true,
    });
    card.id = `tool-${event.toolCallId}`;
    container.appendChild(card);
    scrollIfFollowing();
}

export function renderToolUpdate(event: any): void {
    const card = document.getElementById(`tool-${event.toolCallId}`);
    if (!card || card.classList.contains('diff-card')) return;
    const text = extractToolResultText(event.partialResult);
    if (!text) return;
    updateToolView(card, { partial: text });
    scrollIfFollowing();
}

export function renderToolEnd(event: any): void {
    const card = document.getElementById(`tool-${event.toolCallId}`);
    if (!card) return;

    if (card.classList.contains('diff-card')) {
        const statusEl = card.querySelector('.tool-status');
        if (statusEl) {
            statusEl.textContent = event.isError ? 'error' : 'done';
            statusEl.className = `tool-status ${event.isError ? 'error' : 'done'}`;
        }
        return;
    }

    updateToolView(card, {
        running: false,
        partial: undefined,
        result: toToolResult(event.result ?? { content: [] }, event.isError === true),
    });
}
