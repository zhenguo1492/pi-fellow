import { escapeHtml } from '../shared/html';
import { vscode } from './vscodeApi';

export interface WorkspaceFileMatch {
    relativePath: string;
    absolutePath: string;
    basename: string;
}

let menuIndex = 0;
let menuItems: WorkspaceFileMatch[] = [];
let searchRequestId = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

export function bindFileMentionMenu(): void {
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg?.type !== 'workspaceFiles') {
            return;
        }
        if (msg.requestId !== String(searchRequestId)) {
            return;
        }
        menuItems = msg.files ?? [];
        menuIndex = 0;
        const menu = document.getElementById('at-menu');
        if (!menu) {
            return;
        }
        if (menuItems.length === 0) {
            hideAtMenu();
            return;
        }
        renderAtMenu(menu);
        menu.style.display = '';
    });
}

export function updateAtMenu(input: HTMLTextAreaElement): void {
    const menu = document.getElementById('at-menu');
    if (!menu) {
        return;
    }

    const beforeCursor = input.value.slice(0, input.selectionStart);
    const atMatch = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (!atMatch) {
        hideAtMenu();
        return;
    }

    const query = atMatch[1];
    if (query.length < 1) {
        hideAtMenu();
        return;
    }
    if (searchTimer) {
        clearTimeout(searchTimer);
    }
    searchTimer = setTimeout(() => {
        searchRequestId += 1;
        vscode.postMessage({
            type: 'searchWorkspaceFiles',
            requestId: String(searchRequestId),
            query,
        });
    }, 120);
}

export function isAtMenuVisible(): boolean {
    const menu = document.getElementById('at-menu');
    return !!menu && menu.style.display !== 'none' && menuItems.length > 0;
}

export function handleAtMenuKeydown(e: KeyboardEvent): boolean {
    if (!isAtMenuVisible()) {
        return false;
    }
    const menu = document.getElementById('at-menu');
    if (!menu) {
        return false;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        menuIndex = Math.min(menuIndex + 1, menuItems.length - 1);
        renderAtMenu(menu);
        return true;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        menuIndex = Math.max(menuIndex - 1, 0);
        renderAtMenu(menu);
        return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectAtMenuItem(menuIndex);
        return true;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        hideAtMenu();
        return true;
    }
    return false;
}

function renderAtMenu(menu: HTMLElement): void {
    menu.innerHTML = menuItems
        .map((item, i) => {
            const active = i === menuIndex ? ' at-item-active' : '';
            return `<div class="at-item${active}" data-index="${i}">
            <span class="at-item-path">${escapeHtml(item.relativePath)}</span>
        </div>`;
        })
        .join('');

    menu.querySelectorAll('.at-item').forEach((row) => {
        row.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const idx = parseInt((row as HTMLElement).dataset.index ?? '0', 10);
            selectAtMenuItem(idx);
        });
    });
}

function selectAtMenuItem(index: number): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const item = menuItems[index];
    if (!input || !item) {
        return;
    }

    const text = input.value;
    const cursorPos = input.selectionStart;
    const beforeCursor = text.slice(0, cursorPos);
    const atIndex = beforeCursor.lastIndexOf('@');
    if (atIndex >= 0) {
        const token = `@${item.relativePath} `;
        input.value = text.slice(0, atIndex) + token + text.slice(cursorPos);
        const newPos = atIndex + token.length;
        input.setSelectionRange(newPos, newPos);
    }

    vscode.postMessage({ type: 'dropFilePaths', paths: [item.absolutePath] });
    hideAtMenu();
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function hideAtMenu(): void {
    const menu = document.getElementById('at-menu');
    if (menu) {
        menu.style.display = 'none';
        menu.innerHTML = '';
    }
    menuItems = [];
    menuIndex = 0;
}
