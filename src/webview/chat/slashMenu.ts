import { escapeHtml } from '../../shared/html';
import type { SkillInfo, SlashCommandListItem } from '../../shared/protocol';
import { vscode } from '../vscodeApi';
import { resetUserScroll, updateScrollButton } from './scroll';
import { state } from './state';

// ── Slash command menu ──

type SlashMenuEntry = SlashCommandListItem;

let slashMenuIndex = 0;
let slashMenuItems: SlashMenuEntry[] = [];

/** Menu candidates: the agent's slash commands (or built-in fallbacks) then skills, deduped by invocation. */
export function getSlashMenuCandidates(slashCommands: SlashCommandListItem[], skills: SkillInfo[]): SlashMenuEntry[] {
    const builtins = slashCommands.length > 0
        ? slashCommands
        : [
            { invocation: '/login', name: 'login', description: 'Configure auth', source: 'builtin' as const },
            { invocation: '/logout', name: 'logout', description: 'Remove credentials', source: 'builtin' as const },
            { invocation: '/model', name: 'model', description: 'Select model', source: 'builtin' as const },
            { invocation: '/new', name: 'new', description: 'New session', source: 'builtin' as const },
            { invocation: '/reload', name: 'reload', description: 'Reload extensions', source: 'builtin' as const },
        ];
    const skillItems: SlashMenuEntry[] = skills.map((s) => ({
        invocation: `/skill:${s.name}`,
        name: `skill:${s.name}`,
        description: s.description,
        source: 'skill' as const,
    }));
    const seen = new Set<string>();
    const merged: SlashMenuEntry[] = [];
    for (const item of [...builtins, ...skillItems]) {
        if (seen.has(item.invocation)) continue;
        seen.add(item.invocation);
        merged.push(item);
    }
    return merged;
}

/** Items whose invocation, name, or description contains `query` (text after the `/`), case-insensitively. */
export function filterSlashMenuItems(items: SlashMenuEntry[], query: string): SlashMenuEntry[] {
    const q = query.toLowerCase();
    return items.filter((item) => {
        const inv = item.invocation.slice(1).toLowerCase();
        const name = item.name.toLowerCase();
        return inv.includes(q) || name.includes(q) || (item.description?.toLowerCase().includes(q) ?? false);
    });
}

/** The `/…` token ending at `cursor` when it starts the text or follows whitespace; otherwise null. */
export function slashTokenBeforeCursor(text: string, cursor: number): string | null {
    const slashMatch = text.slice(0, cursor).match(/(?:^|\s)(\/\S*)$/);
    return slashMatch ? slashMatch[1] : null;
}

/** Replaces the slash token before `cursor` with `invocation` plus a space; null when there is no token. */
export function applySlashSelection(
    text: string,
    cursor: number,
    invocation: string,
): { value: string; cursor: number } | null {
    const token = slashTokenBeforeCursor(text, cursor);
    if (token === null) {
        return null;
    }
    const matchStart = text.slice(0, cursor).length - token.length;
    const replacement = `${invocation} `;
    return {
        value: text.slice(0, matchStart) + replacement + text.slice(cursor),
        cursor: matchStart + replacement.length,
    };
}

export function updateSlashMenu(input: HTMLTextAreaElement): void {
    const menu = document.getElementById('slash-menu');
    if (!menu) return;

    const token = slashTokenBeforeCursor(input.value, input.selectionStart);

    if (token === null) {
        hideSlashMenu();
        return;
    }

    slashMenuItems = filterSlashMenuItems(getSlashMenuCandidates(state.slashCommands, state.skills), token.slice(1));

    if (slashMenuItems.length === 0) {
        hideSlashMenu();
        return;
    }

    slashMenuIndex = Math.min(slashMenuIndex, slashMenuItems.length - 1);
    renderSlashMenu(menu);
    menu.style.display = '';
}

function renderSlashMenu(menu: HTMLElement): void {
    menu.innerHTML = slashMenuItems.map((item, i) => {
        const active = i === slashMenuIndex ? ' slash-item-active' : '';
        const desc = item.description
            ? `<span class="slash-item-desc">${escapeHtml(item.description)}</span>`
            : '';
        const tag = item.source !== 'builtin'
            ? `<span class="slash-item-source">${escapeHtml(item.source)}</span>`
            : '';
        return `<div class="slash-item${active}" data-index="${i}">
            <span class="slash-item-name">${escapeHtml(item.invocation)}</span>
            ${desc}
            ${tag}
        </div>`;
    }).join('');

    menu.querySelectorAll('.slash-item').forEach((item) => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const idx = parseInt((item as HTMLElement).dataset.index ?? '0', 10);
            selectSlashItem(idx);
        });
        item.addEventListener('dblclick', (e) => {
            e.preventDefault();
            const idx = parseInt((item as HTMLElement).dataset.index ?? '0', 10);
            executeSlashCommand(idx);
        });
    });
}

/** Run a slash command immediately (same as sending it in chat). */
function executeSlashCommand(index: number): void {
    const entry = slashMenuItems[index];
    if (!entry) return;
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (input) {
        input.value = '';
        input.style.height = 'auto';
    }
    hideSlashMenu();
    resetUserScroll();
    updateScrollButton();
    vscode.postMessage({ type: 'slashCommand', text: entry.invocation });
}

function selectSlashItem(index: number): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;

    const entry = slashMenuItems[index];
    if (!entry) return;

    const next = applySlashSelection(input.value, input.selectionStart, entry.invocation);

    if (next) {
        input.value = next.value;
        input.setSelectionRange(next.cursor, next.cursor);
    }

    hideSlashMenu();
    input.focus();
}

/**
 * Composer keydown while the slash menu is open: arrows move the selection, Enter/Tab insert it,
 * Escape closes. Returns true when the key was consumed.
 */
export function handleSlashMenuKeydown(e: KeyboardEvent): boolean {
    if (isSlashMenuVisible()) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            slashMenuIndex = Math.min(slashMenuIndex + 1, slashMenuItems.length - 1);
            const menu = document.getElementById('slash-menu');
            if (menu) renderSlashMenu(menu);
            return true;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            slashMenuIndex = Math.max(slashMenuIndex - 1, 0);
            const menu = document.getElementById('slash-menu');
            if (menu) renderSlashMenu(menu);
            return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            selectSlashItem(slashMenuIndex);
            return true;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            hideSlashMenu();
            return true;
        }
    }
    return false;
}

export function hideSlashMenu(): void {
    const menu = document.getElementById('slash-menu');
    if (menu) {
        menu.style.display = 'none';
        menu.innerHTML = '';
    }
    slashMenuItems = [];
    slashMenuIndex = 0;
}

export function isSlashMenuVisible(): boolean {
    const menu = document.getElementById('slash-menu');
    return !!menu && menu.style.display !== 'none' && slashMenuItems.length > 0;
}
