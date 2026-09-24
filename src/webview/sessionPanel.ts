import type { SessionListPayload } from '../shared/protocol';
import { vscode } from './vscodeApi';

let panelOpen = false;
let query = '';
let loadDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let panelEl: HTMLElement | null = null;
let backdropEl: HTMLElement | null = null;
let confirmingDeletePath: string | null = null;
let renamingPath: string | null = null;

function shortenCwd(cwd: string): string {
    return cwd.length > 48 ? `…${cwd.slice(-46)}` : cwd;
}

function syncPanelChrome(): void {
    document.documentElement.classList.toggle('session-panel-open', panelOpen);
    if (panelEl) {
        panelEl.hidden = !panelOpen;
    }
    if (backdropEl) {
        backdropEl.hidden = !panelOpen;
    }
}

function ensureBackdrop(): HTMLElement {
    if (backdropEl?.isConnected) {
        return backdropEl;
    }
    backdropEl = document.createElement('div');
    backdropEl.id = 'session-panel-backdrop';
    backdropEl.className = 'session-panel-backdrop';
    backdropEl.hidden = true;
    backdropEl.addEventListener('click', () => {
        vscode.postMessage({ type: 'closeSessionPanel' });
    });
    document.body.appendChild(backdropEl);
    return backdropEl;
}

function cancelPendingActions(): void {
    confirmingDeletePath = null;
    renamingPath = null;
}

function wirePanel(panel: HTMLElement): void {
    panel.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    panel.addEventListener('mousedown', (e) => {
        e.stopPropagation();
    });

    panel.querySelector('.session-panel-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelPendingActions();
        vscode.postMessage({ type: 'closeSessionPanel' });
    });

    const search = panel.querySelector('#session-panel-search') as HTMLInputElement | null;
    search?.addEventListener('input', () => {
        query = search.value;
        scheduleLoad();
    });

    const listEl = panel.querySelector('#session-panel-list');
    listEl?.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = e.target as HTMLElement;

        const confirmBtn = target.closest('[data-action="confirm-delete"]') as HTMLElement | null;
        if (confirmBtn) {
            const sessionPath = confirmBtn.dataset.sessionPath;
            if (sessionPath) {
                confirmingDeletePath = null;
                vscode.postMessage({ type: 'deleteSession', sessionPath });
            }
            return;
        }

        const cancelBtn = target.closest('[data-action="cancel-delete"]');
        if (cancelBtn) {
            confirmingDeletePath = null;
            const lastData = listEl.dataset.lastPayload;
            if (lastData) {
                try {
                    renderList(JSON.parse(lastData) as SessionListPayload);
                } catch {
                    /* ignore */
                }
            }
            return;
        }

        const deleteBtn = target.closest('[data-action="delete"]') as HTMLElement | null;
        if (deleteBtn) {
            if (deleteBtn.hasAttribute('disabled')) {
                return;
            }
            const sessionPath = deleteBtn.dataset.sessionPath;
            if (sessionPath) {
                confirmingDeletePath = sessionPath;
                renamingPath = null;
                const lastData = listEl.dataset.lastPayload;
                if (lastData) {
                    try {
                        renderList(JSON.parse(lastData) as SessionListPayload);
                    } catch {
                        /* ignore */
                    }
                }
            }
            return;
        }

        const renameBtn = target.closest('[data-action="rename"]') as HTMLElement | null;
        if (renameBtn) {
            const sessionPath = renameBtn.dataset.sessionPath;
            if (sessionPath) {
                renamingPath = sessionPath;
                confirmingDeletePath = null;
                const lastData = listEl.dataset.lastPayload;
                if (lastData) {
                    try {
                        renderList(JSON.parse(lastData) as SessionListPayload);
                    } catch {
                        /* ignore */
                    }
                }
            }
            return;
        }

        const saveRenameBtn = target.closest('[data-action="save-rename"]') as HTMLElement | null;
        if (saveRenameBtn) {
            const sessionPath = saveRenameBtn.dataset.sessionPath;
            const row = saveRenameBtn.closest('.session-panel-item');
            const input = row?.querySelector('.session-panel-rename-input') as HTMLInputElement | null;
            if (sessionPath && input) {
                renamingPath = null;
                vscode.postMessage({ type: 'renameSession', sessionPath, name: input.value });
            }
            return;
        }

        const cancelRenameBtn = target.closest('[data-action="cancel-rename"]');
        if (cancelRenameBtn) {
            renamingPath = null;
            const lastData = listEl.dataset.lastPayload;
            if (lastData) {
                try {
                    renderList(JSON.parse(lastData) as SessionListPayload);
                } catch {
                    /* ignore */
                }
            }
            return;
        }

        const row = target.closest('.session-panel-item') as HTMLElement | null;
        if (!row || target.closest('.session-panel-actions') || target.closest('.session-panel-rename')) {
            return;
        }
        const sessionPath = row.dataset.sessionPath;
        if (!sessionPath) {
            return;
        }
        vscode.postMessage({ type: 'resumeSession', sessionPath });
    });

    listEl?.addEventListener('keydown', (e) => {
        const input = (e.target as HTMLElement).closest('.session-panel-rename-input');
        if (!input) {
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const row = input.closest('.session-panel-item');
            const sessionPath = row?.dataset.sessionPath;
            if (sessionPath) {
                renamingPath = null;
                vscode.postMessage({
                    type: 'renameSession',
                    sessionPath,
                    name: (input as HTMLInputElement).value,
                });
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            renamingPath = null;
            const list = panel.querySelector('#session-panel-list');
            const lastData = list?.getAttribute('data-last-payload');
            if (lastData) {
                try {
                    renderList(JSON.parse(lastData) as SessionListPayload);
                } catch {
                    /* ignore */
                }
            }
        }
    });
}

function ensurePanel(): HTMLElement {
    if (panelEl?.isConnected) {
        return panelEl;
    }

    panelEl = null;
    const panel = document.createElement('div');
    panel.id = 'session-panel';
    panel.className = 'session-panel';
    panel.hidden = !panelOpen;
    panel.innerHTML = `
        <div class="session-panel-header">
            <div class="session-panel-title-wrap">
                <span class="session-panel-title">Resume session</span>
                <span class="session-panel-backend-badge" id="session-panel-backend-badge" hidden></span>
            </div>
            <button type="button" class="session-panel-close icon-btn" title="Close" aria-label="Close">×</button>
        </div>
        <div class="session-panel-subtitle" id="session-panel-cwd"></div>
        <input type="search" class="session-panel-search" id="session-panel-search" placeholder="Search sessions…" autocomplete="off" />
        <div class="session-panel-status" id="session-panel-status"></div>
        <div class="session-panel-list" id="session-panel-list" role="listbox"></div>
    `;
    document.body.appendChild(panel);
    panelEl = panel;
    wirePanel(panel);
    return panel;
}

function requestLoad(): void {
    if (loadDebounceTimer) {
        clearTimeout(loadDebounceTimer);
        loadDebounceTimer = undefined;
    }
    vscode.postMessage({ type: 'loadSessionList', query });
}

/** Debounce search typing. */
function scheduleLoad(delayMs = 200): void {
    if (loadDebounceTimer) {
        clearTimeout(loadDebounceTimer);
    }
    loadDebounceTimer = setTimeout(() => {
        loadDebounceTimer = undefined;
        requestLoad();
    }, delayMs);
}

function createActionButton(
    className: string,
    title: string,
    label: string,
    action: string,
    sessionPath: string,
    disabled = false,
): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.textContent = label;
    btn.dataset.action = action;
    btn.dataset.sessionPath = sessionPath;
    if (disabled) {
        btn.setAttribute('disabled', '');
    }
    return btn;
}

function renderList(data: SessionListPayload): void {
    if (!panelOpen) {
        return;
    }
    const panel = ensurePanel();

    const badgeEl = panel.querySelector('#session-panel-backend-badge');
    if (badgeEl) {
        if (data.backend) {
            badgeEl.textContent = data.backend;
            badgeEl.removeAttribute('hidden');
        } else {
            badgeEl.setAttribute('hidden', '');
        }
    }

    const cwdEl = panel.querySelector('#session-panel-cwd');
    if (cwdEl) {
        cwdEl.textContent = data.workspaceCwd ? shortenCwd(data.workspaceCwd) : 'No workspace folder';
    }

    const statusEl = panel.querySelector('#session-panel-status');
    const listEl = panel.querySelector('#session-panel-list');
    if (!statusEl || !listEl) {
        return;
    }

    listEl.dataset.lastPayload = JSON.stringify(data);

    if (data.loading) {
        const p = data.progress;
        statusEl.textContent = p ? `Loading ${p.loaded}/${p.total}…` : 'Loading sessions…';
        statusEl.hidden = false;
        listEl.innerHTML = '';
        return;
    }

    if (data.error) {
        statusEl.textContent = data.error;
        statusEl.hidden = false;
        listEl.innerHTML = '';
        return;
    }

    if (data.items.length === 0) {
        statusEl.textContent = 'No sessions in this folder';
        statusEl.hidden = false;
        listEl.innerHTML = '';
        return;
    }

    statusEl.hidden = true;
    listEl.innerHTML = '';

    for (const item of data.items) {
        const row = document.createElement('div');
        row.className = 'session-panel-item';
        row.setAttribute('role', 'option');
        row.tabIndex = 0;
        if (item.isCurrent) {
            row.classList.add('session-panel-item--current');
        }
        if (confirmingDeletePath === item.sessionPath) {
            row.classList.add('session-panel-item--confirm-delete');
        }
        row.dataset.sessionPath = item.sessionPath;

        const main = document.createElement('div');
        main.className = 'session-panel-main';

        if (renamingPath === item.sessionPath) {
            const renameWrap = document.createElement('div');
            renameWrap.className = 'session-panel-rename';
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'session-panel-rename-input';
            input.value = item.label;
            input.placeholder = 'Session name';
            renameWrap.appendChild(input);
            main.appendChild(renameWrap);
            requestAnimationFrame(() => {
                input.focus();
                input.select();
            });
        } else {
            const label = document.createElement('span');
            label.className = 'session-panel-label';
            label.textContent =
                confirmingDeletePath === item.sessionPath ? `Delete "${item.label}"?` : item.label;
            label.title = item.label;
            main.appendChild(label);
        }

        row.appendChild(main);

        if (renamingPath !== item.sessionPath) {
            const meta = document.createElement('span');
            meta.className = 'session-panel-meta';
            meta.textContent = item.meta;
            row.appendChild(meta);
        }

        const actions = document.createElement('div');
        actions.className = 'session-panel-actions';

        if (renamingPath === item.sessionPath) {
            actions.appendChild(
                createActionButton(
                    'session-panel-action session-panel-action--save',
                    'Save name',
                    '✓',
                    'save-rename',
                    item.sessionPath,
                ),
            );
            actions.appendChild(
                createActionButton(
                    'session-panel-action',
                    'Cancel rename',
                    '×',
                    'cancel-rename',
                    item.sessionPath,
                ),
            );
        } else if (confirmingDeletePath === item.sessionPath) {
            actions.appendChild(
                createActionButton(
                    'session-panel-action session-panel-action--danger',
                    'Confirm delete',
                    '✓',
                    'confirm-delete',
                    item.sessionPath,
                ),
            );
            actions.appendChild(
                createActionButton(
                    'session-panel-action',
                    'Cancel delete',
                    '×',
                    'cancel-delete',
                    item.sessionPath,
                ),
            );
        } else {
            actions.appendChild(
                createActionButton(
                    'session-panel-action',
                    'Rename session',
                    '✎',
                    'rename',
                    item.sessionPath,
                ),
            );
            actions.appendChild(
                createActionButton(
                    'session-panel-action session-panel-action--danger',
                    item.isCurrent ? 'Cannot delete active session' : 'Delete session',
                    '⌫',
                    'delete',
                    item.sessionPath,
                    item.isCurrent,
                ),
            );
        }

        row.appendChild(actions);
        listEl.appendChild(row);
    }
}

export function setSessionPanelOpen(open: boolean): void {
    panelOpen = open;
    if (!open) {
        cancelPendingActions();
    }
    ensureBackdrop();
    ensurePanel();
    syncPanelChrome();
    if (open) {
        const search = panelEl?.querySelector('#session-panel-search') as HTMLInputElement | null;
        if (search && search.value !== query) {
            search.value = query;
        }
        search?.focus();
    }
}

/** Called after main shell render() clears #app — panel lives on body so it survives rebuilds. */
export function onAppShellRebuilt(): void {
    if (panelEl && !panelEl.isConnected) {
        panelEl = null;
    }
    if (backdropEl && !backdropEl.isConnected) {
        backdropEl = null;
    }
    if (!panelOpen) {
        syncPanelChrome();
        return;
    }
    setSessionPanelOpen(true);
    vscode.postMessage({ type: 'loadSessionList', query });
}

export function applySessionList(data: SessionListPayload): void {
    renderList(data);
}

/** Header button: toggle in-sidebar resume panel. */
export function requestSessionPanelToggle(): void {
    vscode.postMessage({ type: 'toggleSessionPanel' });
}

/** Close on Escape when the panel has focus or is open. */
document.addEventListener('keydown', (e) => {
    if (!panelOpen || e.key !== 'Escape') {
        return;
    }
    if (renamingPath || confirmingDeletePath) {
        e.preventDefault();
        cancelPendingActions();
        const listEl = panelEl?.querySelector('#session-panel-list');
        const lastData = listEl?.dataset.lastPayload;
        if (lastData) {
            try {
                renderList(JSON.parse(lastData) as SessionListPayload);
            } catch {
                /* ignore */
            }
        }
        return;
    }
    e.preventDefault();
    vscode.postMessage({ type: 'closeSessionPanel' });
});
