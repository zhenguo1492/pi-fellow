import { escapeHtml } from '../shared/html';
import type { SessionTreeNodeData, SessionTreePayload } from '../shared/protocol';
import { vscode } from './vscodeApi';

let panelOpen = false;
let filterMode: 'chat-only' | 'user-only' | 'all' | 'labeled-only' = 'chat-only';
let searchQuery = '';
let treePayload: SessionTreePayload | null = null;
let panelEl: HTMLElement | null = null;
let backdropEl: HTMLElement | null = null;

let selectedIndex = 0;
let actionMenuOpen = false;
let actionMenuIndex = 0; // 0: No summary, 1: Summarize, 2: Summarize with custom prompt
let customPromptMode = false;
let statusMessage = '';
let statusTimeout: any = null;

function showStatus(msg: string, durationMs = 2500): void {
    statusMessage = msg;
    if (statusTimeout) {
        clearTimeout(statusTimeout);
    }
    renderStatusFooter();
    statusTimeout = setTimeout(() => {
        statusMessage = '';
        renderStatusFooter();
    }, durationMs);
}

function ensureBackdrop(): HTMLElement {
    if (backdropEl?.isConnected) {
        return backdropEl;
    }
    backdropEl = document.createElement('div');
    backdropEl.id = 'tree-panel-backdrop';
    backdropEl.className = 'session-panel-backdrop tree-panel-backdrop';
    backdropEl.hidden = true;
    backdropEl.addEventListener('click', () => {
        if (actionMenuOpen) {
            actionMenuOpen = false;
            customPromptMode = false;
            renderContent();
        } else {
            closeTreePanel();
        }
    });
    document.body.appendChild(backdropEl);
    return backdropEl;
}

export function setTreePanelOpen(open: boolean): void {
    panelOpen = open;
    syncPanelChrome();
    if (open) {
        ensurePanel();
        actionMenuOpen = false;
        customPromptMode = false;
        renderContent();
        focusListOrSearch();
    }
}

export function applyTreePayload(payload: SessionTreePayload): void {
    treePayload = payload;
    if (panelOpen) {
        // Maintain selection near current leaf
        const nodes = getFilteredNodes();
        const leafIdx = nodes.findIndex((n) => n.isCurrentLeaf);
        if (leafIdx >= 0) {
            selectedIndex = leafIdx;
        } else if (selectedIndex >= nodes.length) {
            selectedIndex = Math.max(0, nodes.length - 1);
        }
        renderContent();
    }
}

export function closeTreePanel(): void {
    panelOpen = false;
    actionMenuOpen = false;
    customPromptMode = false;
    syncPanelChrome();
    vscode.postMessage({ type: 'closeSessionTree' });
}

function syncPanelChrome(): void {
    document.documentElement.classList.toggle('tree-panel-open', panelOpen);
    if (panelEl) {
        panelEl.hidden = !panelOpen;
    }
    if (backdropEl) {
        backdropEl.hidden = !panelOpen;
    }
}

function focusListOrSearch(): void {
    const listEl = panelEl?.querySelector<HTMLElement>('#tree-panel-content');
    listEl?.focus();
}

function ensurePanel(): HTMLElement {
    ensureBackdrop();
    if (panelEl?.isConnected) {
        return panelEl;
    }

    panelEl = document.createElement('div');
    panelEl.id = 'tree-panel';
    panelEl.className = 'tree-panel tui-theme';
    panelEl.hidden = !panelOpen;

    panelEl.innerHTML = `
        <div class="tree-panel-header">
            <div class="tree-panel-title-wrap">
                <span class="tree-panel-icon">🌳</span>
                <span class="tree-panel-title">Session Branch Tree (/tree)</span>
            </div>
            <button class="tree-panel-close icon-btn" title="Close (Esc)">✕</button>
        </div>
        <div class="tree-panel-toolbar">
            <div class="tree-panel-search-wrap">
                <input
                    type="search"
                    id="tree-panel-search"
                    class="tree-panel-search"
                    placeholder="Search node content or label…"
                    autocomplete="off"
                    spellcheck="false"
                />
            </div>
            <div class="tree-panel-filters" role="tablist">
                <button type="button" class="tree-filter-btn" data-filter="chat-only" title="Hide system & tool output">Chat Only</button>
                <button type="button" class="tree-filter-btn" data-filter="user-only" title="User prompts only">User Only</button>
                <button type="button" class="tree-filter-btn" data-filter="all" title="Show all entries">All</button>
                <button type="button" class="tree-filter-btn" data-filter="labeled-only" title="Show labeled entries">Labeled</button>
            </div>
        </div>
        <div class="tree-panel-content" id="tree-panel-content" tabindex="0">
            <div class="tree-panel-loading">Loading session tree…</div>
        </div>
        <div class="tree-panel-overlay" id="tree-panel-overlay" hidden></div>
        <div class="tree-panel-footer" id="tree-panel-footer"></div>
    `;

    panelEl.querySelector('.tree-panel-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTreePanel();
    });

    const searchInput = panelEl.querySelector<HTMLInputElement>('#tree-panel-search');
    searchInput?.addEventListener('input', () => {
        searchQuery = searchInput.value.trim().toLowerCase();
        selectedIndex = 0;
        renderContent();
    });

    panelEl.querySelectorAll<HTMLButtonElement>('.tree-filter-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.filter as typeof filterMode;
            if (mode) {
                filterMode = mode;
                selectedIndex = 0;
                renderContent();
            }
        });
    });

    // Keyboard navigation
    document.addEventListener('keydown', handleKeyDown);

    document.body.appendChild(panelEl);
    return panelEl;
}

function handleKeyDown(e: KeyboardEvent): void {
    if (!panelOpen) return;

    const activeEl = document.activeElement;
    const isSearchInput = activeEl?.id === 'tree-panel-search';
    const isCustomInput = activeEl?.id === 'tree-custom-prompt-input';

    // 1. Custom Prompt Input Mode
    if (customPromptMode) {
        if (e.key === 'Escape') {
            e.preventDefault();
            customPromptMode = false;
            renderContent();
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitCustomSummary();
            return;
        }
        return;
    }

    // 2. Action Menu Dialog Mode (Summarize branch?)
    if (actionMenuOpen) {
        if (e.key === 'Escape' || (e.ctrlKey && e.key.toLowerCase() === 'c')) {
            e.preventDefault();
            actionMenuOpen = false;
            renderContent();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            actionMenuIndex = (actionMenuIndex + 2) % 3;
            renderContent();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            actionMenuIndex = (actionMenuIndex + 1) % 3;
            renderContent();
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            confirmActionChoice(actionMenuIndex);
            return;
        }
        return;
    }

    // 3. Tree List Navigation Mode
    if (e.key === 'Escape') {
        e.preventDefault();
        closeTreePanel();
        return;
    }

    if (isSearchInput) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') {
            e.preventDefault();
            focusListOrSearch();
        }
        return;
    }

    const visibleNodes = getFilteredNodes();
    if (visibleNodes.length === 0) return;

    if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (selectedIndex > 0) {
            selectedIndex--;
            renderContent();
            scrollSelectedIntoView();
        }
        return;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (selectedIndex < visibleNodes.length - 1) {
            selectedIndex++;
            renderContent();
            scrollSelectedIntoView();
        }
        return;
    }

    if (e.key === 'Enter') {
        e.preventDefault();
        handleNodeSelect(visibleNodes[selectedIndex]);
        return;
    }

    if (e.key === 'c' || e.key === 'C') {
        if (!isSearchInput && !isCustomInput) {
            e.preventDefault();
            copySelectedNode(visibleNodes[selectedIndex]);
            return;
        }
    }
}

function scrollSelectedIntoView(): void {
    const listEl = panelEl?.querySelector<HTMLElement>('#tree-panel-content');
    const selectedEl = listEl?.querySelector<HTMLElement>('.tree-row.selected');
    if (selectedEl && listEl) {
        const top = selectedEl.offsetTop;
        const bottom = top + selectedEl.offsetHeight;
        if (top < listEl.scrollTop) {
            listEl.scrollTop = top;
        } else if (bottom > listEl.scrollTop + listEl.clientHeight) {
            listEl.scrollTop = bottom - listEl.clientHeight;
        }
    }
}

function getFilteredNodes(): SessionTreeNodeData[] {
    const all = treePayload?.nodes || [];
    return all.filter((n) => {
        if (filterMode === 'user-only' && n.role !== 'user') {
            return false;
        }
        if (filterMode === 'chat-only') {
            if (n.role === 'tool' || n.role === 'toolResult' || n.role === 'bash' || n.role === 'bashExecution') {
                return false;
            }
        }
        if (filterMode === 'labeled-only' && !n.label) {
            return false;
        }
        if (searchQuery) {
            const matchesText = (n.textPreview || '').toLowerCase().includes(searchQuery);
            const matchesDisplay = (n.displayText || '').toLowerCase().includes(searchQuery);
            const matchesFull = (n.fullText || '').toLowerCase().includes(searchQuery);
            const matchesLabel = (n.label || '').toLowerCase().includes(searchQuery);
            const matchesRole = (n.role || '').toLowerCase().includes(searchQuery);
            return matchesText || matchesDisplay || matchesFull || matchesLabel || matchesRole;
        }
        return true;
    });
}

function handleNodeSelect(node?: SessionTreeNodeData): void {
    if (!node) return;

    if (node.isCurrentLeaf) {
        showStatus('Already at this point');
        return;
    }

    // Open Summarize branch? action selection menu matching Pi CLI TUI
    actionMenuOpen = true;
    actionMenuIndex = 0;
    customPromptMode = false;
    renderContent();
}

function confirmActionChoice(choiceIndex: number): void {
    const visibleNodes = getFilteredNodes();
    const node = visibleNodes[selectedIndex];
    if (!node) return;

    if (choiceIndex === 0) {
        // No summary
        actionMenuOpen = false;
        executeFork(node.id, false);
    } else if (choiceIndex === 1) {
        // Summarize
        actionMenuOpen = false;
        executeFork(node.id, true);
    } else if (choiceIndex === 2) {
        // Summarize with custom prompt
        customPromptMode = true;
        renderContent();
        setTimeout(() => {
            const input = panelEl?.querySelector<HTMLInputElement>('#tree-custom-prompt-input');
            input?.focus();
        }, 50);
    }
}

function submitCustomSummary(): void {
    const visibleNodes = getFilteredNodes();
    const node = visibleNodes[selectedIndex];
    if (!node) return;

    const input = panelEl?.querySelector<HTMLInputElement>('#tree-custom-prompt-input');
    const prompt = input?.value.trim() || '';

    customPromptMode = false;
    actionMenuOpen = false;
    executeFork(node.id, true, prompt);
}

function executeFork(entryId: string, summarize: boolean, customInstructions?: string): void {
    showStatus(summarize ? 'Branching session with summary…' : 'Navigating to selected branch…');
    vscode.postMessage({
        type: 'forkSessionTree',
        entryId,
        summarize,
        customInstructions,
    });
}

async function copySelectedNode(node?: SessionTreeNodeData): Promise<void> {
    if (!node) return;
    const text = node.fullText || node.textPreview || node.displayText || '';
    if (text) {
        await navigator.clipboard.writeText(text);
        showStatus('✓ Copied node text to clipboard');
    }
}

function renderContent(): void {
    if (!panelEl) return;

    panelEl.querySelectorAll<HTMLButtonElement>('.tree-filter-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.filter === filterMode);
    });

    const contentEl = panelEl.querySelector<HTMLElement>('#tree-panel-content');
    const overlayEl = panelEl.querySelector<HTMLElement>('#tree-panel-overlay');
    if (!contentEl) return;

    if (!treePayload) {
        contentEl.innerHTML = '<div class="tree-panel-loading">Loading session tree…</div>';
        if (overlayEl) {
            overlayEl.hidden = true;
            overlayEl.innerHTML = '';
        }
        renderStatusFooter();
        return;
    }

    if (treePayload.error) {
        contentEl.innerHTML = `<div class="tree-panel-empty error">Error: ${escapeHtml(treePayload.error)}</div>`;
        if (overlayEl) {
            overlayEl.hidden = true;
            overlayEl.innerHTML = '';
        }
        renderStatusFooter();
        return;
    }

    const visibleNodes = getFilteredNodes();
    if (visibleNodes.length === 0) {
        contentEl.innerHTML = '<div class="tree-panel-empty">No entries match the current filter or search.</div>';
        if (overlayEl) {
            overlayEl.hidden = true;
            overlayEl.innerHTML = '';
        }
        renderStatusFooter();
        return;
    }

    if (selectedIndex >= visibleNodes.length) {
        selectedIndex = Math.max(0, visibleNodes.length - 1);
    }

    // 1. Always render the underlying tree list into contentEl
    let html = '<div class="tree-tui-list">';
    for (let i = 0; i < visibleNodes.length; i++) {
        const node = visibleNodes[i];
        const isSelected = i === selectedIndex;
        const isActivePath = !!node.isActivePath;

        const cursor = isSelected ? '› ' : '&nbsp;&nbsp;';
        const prefix = node.treePrefix ? escapeHtml(node.treePrefix) : '';
        const bullet = `<span class="tree-bullet ${isActivePath ? 'active' : ''}">• </span>`;

        let labelHtml = '';
        if (node.label) {
            labelHtml = `<span class="tree-node-label">[${escapeHtml(node.label)}] </span>`;
        }

        const formattedContent = renderFormattedContent(node);
        const leafBadge = node.isCurrentLeaf ? '<span class="tree-leaf-badge">● current leaf</span>' : '';

        html += `
            <div class="tree-row ${isSelected ? 'selected' : ''} ${isActivePath ? 'active-path' : ''}" data-index="${i}" data-id="${escapeHtml(node.id)}">
                <span class="tree-cursor">${cursor}</span>
                <span class="tree-guide">${prefix}</span>
                ${bullet}
                ${labelHtml}
                <span class="tree-body">${formattedContent}</span>
                ${leafBadge}
            </div>
        `;
    }
    html += '</div>';
    contentEl.innerHTML = html;

    // Attach row events
    contentEl.querySelectorAll<HTMLElement>('.tree-row').forEach((row) => {
        row.addEventListener('click', () => {
            if (actionMenuOpen || customPromptMode) return;
            const idx = Number(row.dataset.index);
            if (!isNaN(idx)) {
                if (selectedIndex === idx) {
                    handleNodeSelect(visibleNodes[idx]);
                } else {
                    selectedIndex = idx;
                    renderContent();
                }
            }
        });
        row.addEventListener('dblclick', () => {
            if (actionMenuOpen || customPromptMode) return;
            const idx = Number(row.dataset.index);
            if (!isNaN(idx)) {
                handleNodeSelect(visibleNodes[idx]);
            }
        });
    });

    // 2. Render Modal Overlay if action menu or custom prompt is active
    if (!overlayEl) {
        renderStatusFooter();
        return;
    }

    if (customPromptMode) {
        overlayEl.hidden = false;
        overlayEl.innerHTML = `
            <div class="tree-action-dialog custom-prompt-dialog">
                <div class="tree-action-title">Custom summarization instructions:</div>
                <div class="tree-custom-prompt-wrap">
                    <input
                        type="text"
                        id="tree-custom-prompt-input"
                        class="tree-custom-prompt-input"
                        placeholder="Enter instructions (e.g. summarize key decisions and code changes)…"
                        autocomplete="off"
                    />
                </div>
                <div class="tree-dialog-actions">
                    <button type="button" class="tree-action-btn primary" id="btn-submit-prompt">Confirm (Enter)</button>
                    <button type="button" class="tree-action-btn" id="btn-cancel-prompt">Cancel (Esc)</button>
                </div>
                <div class="tree-action-hint">
                    <span>enter confirm</span>
                    <span>escape cancel</span>
                </div>
            </div>
        `;
        overlayEl.querySelector('#btn-submit-prompt')?.addEventListener('click', submitCustomSummary);
        overlayEl.querySelector('#btn-cancel-prompt')?.addEventListener('click', () => {
            customPromptMode = false;
            renderContent();
        });
        setTimeout(() => {
            overlayEl.querySelector<HTMLInputElement>('#tree-custom-prompt-input')?.focus();
        }, 50);
    } else if (actionMenuOpen) {
        overlayEl.hidden = false;
        const options = [
            'No summary',
            'Summarize',
            'Summarize with custom prompt',
        ];

        let optionsHtml = '';
        for (let i = 0; i < options.length; i++) {
            const isSel = i === actionMenuIndex;
            optionsHtml += `
                <div class="tree-action-option ${isSel ? 'selected' : ''}" data-index="${i}">
                    <span class="action-arrow">${isSel ? '→' : '&nbsp;'}</span>
                    <span class="action-label">${escapeHtml(options[i])}</span>
                </div>
            `;
        }

        overlayEl.innerHTML = `
            <div class="tree-action-dialog">
                <div class="tree-action-title">Summarize branch?</div>
                <div class="tree-action-options">
                    ${optionsHtml}
                </div>
                <div class="tree-action-hint">
                    <span>↑↓ navigate</span>
                    <span>enter select</span>
                    <span>escape/ctrl+c cancel</span>
                </div>
            </div>
        `;

        overlayEl.querySelectorAll<HTMLElement>('.tree-action-option').forEach((opt) => {
            opt.addEventListener('mouseenter', () => {
                const idx = Number(opt.dataset.index);
                if (!isNaN(idx) && actionMenuIndex !== idx) {
                    actionMenuIndex = idx;
                    renderContent();
                }
            });
            opt.addEventListener('click', () => {
                const idx = Number(opt.dataset.index);
                if (!isNaN(idx)) {
                    confirmActionChoice(idx);
                }
            });
        });
    } else {
        overlayEl.hidden = true;
        overlayEl.innerHTML = '';
    }

    renderStatusFooter();
}

function renderFormattedContent(node: SessionTreeNodeData): string {
    const raw = node.displayText || node.textPreview || node.fullText || `[${node.type}]`;
    const escaped = escapeHtml(raw);

    if (node.role === 'user' || escaped.startsWith('user: ')) {
        const after = escaped.startsWith('user: ') ? escaped.slice(6) : escaped;
        return `<span class="role-user">user:</span> <span class="text-user">${after}</span>`;
    }
    if (node.role === 'assistant' || escaped.startsWith('assistant: ')) {
        const after = escaped.startsWith('assistant: ') ? escaped.slice(11) : escaped;
        return `<span class="role-assistant">assistant:</span> <span class="text-assistant">${after}</span>`;
    }
    if (node.role === 'toolResult' || node.role === 'tool') {
        return `<span class="role-tool">${escaped}</span>`;
    }
    if (node.role === 'bash' || node.role === 'bashExecution') {
        return `<span class="role-bash">${escaped}</span>`;
    }
    if (node.role === 'custom' || node.role === 'custom_message') {
        return `<span class="role-custom">${escaped}</span>`;
    }
    if (node.role === 'compaction') {
        return `<span class="role-compaction">${escaped}</span>`;
    }
    if (node.role === 'branch_summary') {
        return `<span class="role-summary">${escaped}</span>`;
    }
    return `<span class="role-dim">${escaped}</span>`;
}

function renderStatusFooter(): void {
    const footerEl = panelEl?.querySelector<HTMLElement>('#tree-panel-footer');
    if (!footerEl) return;

    const visibleNodes = getFilteredNodes();
    const countInfo = visibleNodes.length > 0 ? `(${selectedIndex + 1}/${visibleNodes.length})` : '(0/0)';

    let actionHint = '↑↓ navigate &nbsp; enter select &nbsp; c copy &nbsp; esc close';
    if (actionMenuOpen) {
        actionHint = '↑↓ navigate &nbsp; enter select &nbsp; esc cancel';
    } else if (customPromptMode) {
        actionHint = 'enter submit &nbsp; esc back';
    }

    footerEl.innerHTML = `
        <div class="tree-footer-left">
            <span class="tree-footer-count">${countInfo}</span>
            <span class="tree-footer-hint">${actionHint}</span>
        </div>
        <div class="tree-footer-right">
            ${statusMessage ? `<span class="tree-footer-status">${escapeHtml(statusMessage)}</span>` : ''}
        </div>
    `;
}
