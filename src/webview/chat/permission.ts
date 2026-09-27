import type { PermissionLevel } from '../../shared/protocol';
import { vscode } from '../vscodeApi';
import { state } from './state';

/** Lucide icons (ISC): hand, code, scroll-text, zap. */
function icon(paths: string, size: number): string {
    return `<svg class="permission-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const ICON_PATHS: Record<PermissionLevel, string> = {
    ask: '<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    edit: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    plan: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
    auto: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
};

const CHECK_ICON = icon('<path d="M20 6 9 17l-5-5"/>', 16);

/** Names and order follow Claude's modes: from most to least supervised, with read-only Plan before Auto. */
const LEVELS: ReadonlyArray<{ level: PermissionLevel; label: string; description: string }> = [
    { level: 'ask', label: 'Manual', description: 'Asks for approval before each edit or command' },
    { level: 'edit', label: 'Edit automatically', description: 'Edits files without asking; asks before running commands or deleting and moving files' },
    { level: 'plan', label: 'Plan', description: 'Explores the code and presents a plan before editing (read-only)' },
    { level: 'auto', label: 'Auto', description: 'Edits files and runs commands without asking' },
];

let highlight = 0;
let dismissBound = false;

/** Right end of the model row under the input: what this tab's worker and voice agent may do without asking. */
export const permissionControlHtml = `
            <button id="btn-permission" class="composer-model-btn composer-permission-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
                <span class="composer-permission-icon"></span>
                <span class="composer-model-label" id="permission-chip-label"></span>
                <svg class="dropdown-chevron" width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 10.5l5-5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>`;

/** The menu opens above the input box, right-aligned under the chip's column (like the model picker on the left). */
export function createPermissionMenu(): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'permission-menu';
    menu.id = 'permission-menu';
    menu.hidden = true;
    menu.innerHTML = `
        <div class="permission-menu-title">Modes</div>
        <div id="permission-list" class="permission-list" role="listbox" aria-label="Permission level" tabindex="-1"></div>`;
    return menu;
}

function currentLevel() {
    return LEVELS.find((l) => l.level === state.permissionLevel) ?? LEVELS[0];
}

function describe(level: PermissionLevel, description: string): string {
    return level === 'plan' && state.activeBackend === 'pi' ? `${description} (pi's plan mode)` : description;
}

export function updatePermissionControl(): void {
    const chip = document.getElementById('btn-permission');
    const label = document.getElementById('permission-chip-label');
    const iconSlot = chip?.querySelector('.composer-permission-icon');
    if (!chip || !label || !iconSlot) return;
    const current = currentLevel();
    label.textContent = current.label;
    iconSlot.innerHTML = icon(ICON_PATHS[current.level], 13);
    chip.title = `${current.label}: ${describe(current.level, current.description)}`;
    if (isMenuOpen()) renderList();
}

function isMenuOpen(): boolean {
    const menu = document.getElementById('permission-menu');
    return !!menu && !menu.hidden;
}

function renderList(): void {
    const list = document.getElementById('permission-list');
    if (!list) return;
    const active = currentLevel().level;
    list.innerHTML = LEVELS.map(({ level, label, description }, index) => {
        const classes = ['permission-item', level === active ? 'active' : '', index === highlight ? 'highlighted' : ''].filter(Boolean).join(' ');
        return `
            <div class="${classes}" data-level="${level}" role="option" aria-selected="${level === active}">
                <span class="permission-item-icon">${icon(ICON_PATHS[level], 18)}</span>
                <span class="permission-item-text">
                    <span class="permission-item-label">${label}</span>
                    <span class="permission-item-desc">${describe(level, description)}</span>
                </span>
                <span class="permission-item-check">${level === active ? CHECK_ICON : ''}</span>
            </div>`;
    }).join('');
}

function openMenu(): void {
    const menu = document.getElementById('permission-menu');
    const list = document.getElementById('permission-list');
    if (!menu || !list) return;
    highlight = Math.max(LEVELS.indexOf(currentLevel()), 0);
    renderList();
    menu.hidden = false;
    document.getElementById('btn-permission')?.setAttribute('aria-expanded', 'true');
    list.focus();
}

function closeMenu(focusComposer: boolean): void {
    const menu = document.getElementById('permission-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    document.getElementById('btn-permission')?.setAttribute('aria-expanded', 'false');
    if (focusComposer) {
        (document.getElementById('input') as HTMLTextAreaElement | null)?.focus();
    }
}

function choose(level: PermissionLevel): void {
    if (level !== state.permissionLevel) {
        // Shown at once; the host's next state sync is authoritative (e.g. pi without a plan mode).
        state.permissionLevel = level;
        updatePermissionControl();
        vscode.postMessage({ type: 'setPermissionLevel', level });
    }
    closeMenu(true);
}

/** Wire the chip and menu; call after every composer skeleton rebuild. */
export function bindPermissionControl(): void {
    const chip = document.getElementById('btn-permission');
    const list = document.getElementById('permission-list');
    if (!chip || !list) return;

    chip.addEventListener('click', () => {
        if (isMenuOpen()) {
            closeMenu(true);
        } else {
            openMenu();
        }
    });

    list.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'ArrowDown':
            case 'ArrowUp':
                e.preventDefault();
                highlight = (highlight + (e.key === 'ArrowDown' ? 1 : -1) + LEVELS.length) % LEVELS.length;
                renderList();
                break;
            case 'Enter':
                e.preventDefault();
                choose(LEVELS[highlight].level);
                break;
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                closeMenu(true);
                break;
        }
    });

    list.addEventListener('click', (e) => {
        const row = (e.target as HTMLElement).closest('.permission-item') as HTMLElement | null;
        const level = LEVELS.find((l) => l.level === row?.dataset.level)?.level;
        if (level) choose(level);
    });

    if (!dismissBound) {
        dismissBound = true;
        document.addEventListener('click', (e) => {
            if (!(e.target as HTMLElement).closest('#permission-menu, #btn-permission')) {
                closeMenu(false);
            }
        });
    }

    updatePermissionControl();
}
