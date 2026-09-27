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

/** A horizontal dumbbell (Lucide's is diagonal), as on Claude's Effort row. */
const EFFORT_ICON = icon(
    '<rect x="2" y="9" width="3" height="6" rx="1"/><rect x="5" y="6" width="3.5" height="12" rx="1"/><path d="M8.5 12h7"/><rect x="15.5" y="6" width="3.5" height="12" rx="1"/><rect x="19" y="9" width="3" height="6" rx="1"/>',
    18,
);

/** pi's thinking levels, least to most; the Effort slider has one dot per level. */
const EFFORT_LEVELS: ReadonlyArray<{ level: string; label: string }> = [
    { level: 'off', label: 'Off' },
    { level: 'minimal', label: 'Minimal' },
    { level: 'low', label: 'Low' },
    { level: 'medium', label: 'Medium' },
    { level: 'high', label: 'High' },
    { level: 'xhigh', label: 'Extra high' },
];

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
        <div id="permission-list" class="permission-list" role="listbox" aria-label="Permission level" tabindex="-1"></div>
        <div class="permission-menu-sep" role="separator"></div>
        <div class="effort-row">
            <span class="permission-item-icon">${EFFORT_ICON}</span>
            <span class="effort-label">Effort <span class="effort-value" id="effort-value"></span></span>
            <div id="effort-track" class="effort-track" role="slider" tabindex="0" aria-label="Thinking effort" aria-valuemin="0" aria-valuemax="${EFFORT_LEVELS.length - 1}">
                ${EFFORT_LEVELS.map(({ level, label }, index) => `<span class="effort-dot" data-index="${index}" data-level="${level}" title="${label}"></span>`).join('')}
            </div>
        </div>`;
    return menu;
}

function currentLevel() {
    return LEVELS.find((l) => l.level === state.permissionLevel) ?? LEVELS[0];
}

function describe(level: PermissionLevel, description: string): string {
    return level === 'plan' && state.activeBackend === 'pi' ? `${description} (pi's plan mode)` : description;
}

function effortIndex(): number {
    return Math.max(EFFORT_LEVELS.findIndex((l) => l.level === (state.thinkingLevel || 'off')), 0);
}

/** Label and slider of the menu's Effort row; call on every state sync. */
export function updateEffortControl(): void {
    const value = document.getElementById('effort-value');
    const track = document.getElementById('effort-track');
    if (!value || !track) return;
    const index = effortIndex();
    const { label } = EFFORT_LEVELS[index];
    value.textContent = `(${label})`;
    track.setAttribute('aria-valuenow', String(index));
    track.setAttribute('aria-valuetext', label);
    track.querySelectorAll<HTMLElement>('.effort-dot').forEach((dot) => {
        dot.classList.toggle('selected', Number(dot.dataset.index) === index);
    });
}

function setEffort(index: number): void {
    const target = EFFORT_LEVELS[Math.min(Math.max(index, 0), EFFORT_LEVELS.length - 1)];
    if (target.level === (state.thinkingLevel || 'off')) return;
    // Shown at once; the host's state sync that follows is authoritative. The menu stays open.
    state.thinkingLevel = target.level;
    updateEffortControl();
    vscode.postMessage({ type: 'setThinkingLevel', level: target.level });
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

    const track = document.getElementById('effort-track');
    track?.addEventListener('click', (e) => {
        const dot = (e.target as HTMLElement).closest('.effort-dot') as HTMLElement | null;
        if (dot) setEffort(Number(dot.dataset.index));
    });
    track?.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'ArrowLeft':
            case 'ArrowRight':
                e.preventDefault();
                setEffort(effortIndex() + (e.key === 'ArrowRight' ? 1 : -1));
                break;
            case 'Home':
            case 'End':
                e.preventDefault();
                setEffort(e.key === 'Home' ? 0 : EFFORT_LEVELS.length - 1);
                break;
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                closeMenu(true);
                break;
        }
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
    updateEffortControl();
}
