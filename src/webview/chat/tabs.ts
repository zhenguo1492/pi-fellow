import type { TabInfo } from '../../shared/protocol';
import { ICON_ROBOT } from '../avatar';
import { setWorkerBusy } from '../voiceBar';
import { vscode } from '../vscodeApi';
import { el } from './helpers';
import { iconsBaseUri } from './icons';
import { state } from './state';

const TAB_MIN_VISIBLE_WIDTH = 112;
let visibleTabCapacity = Number.POSITIVE_INFINITY;
let tabLayoutObserver: ResizeObserver | undefined;
let tabLayoutFrame = 0;
let tabOverflowDismissBound = false;

/**
 * Tabs shown in the strip when only `capacity` fit: all of them if they fit, otherwise a window
 * around the active tab (clamped to the ends of the list).
 */
export function tabsForVisibleCapacity(tabs: TabInfo[], activeTabId: string, capacity: number): TabInfo[] {
    if (tabs.length <= capacity) {
        return tabs;
    }

    const visibleCount = Math.max(1, Math.floor(capacity));
    const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
    const beforeActive = Math.floor((visibleCount - 1) / 2);
    const start = Math.max(0, Math.min(activeIndex - beforeActive, tabs.length - visibleCount));
    return tabs.slice(start, start + visibleCount);
}

function setTabOverflowOpen(open: boolean): void {
    const menu = document.getElementById('tab-overflow-menu');
    const button = document.getElementById('btn-tab-overflow');
    if (!menu || !button) return;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.classList.toggle('active', open);
}

/** The dropdown listing every tab; always shown, the strip may not fit them all. */
function updateTabOverflowMenu(): void {
    const menu = document.getElementById('tab-overflow-menu');
    if (!menu) return;

    menu.innerHTML = '';
    for (const tab of state.tabs) {
        const row = el('div', `tab-overflow-row${tab.isActive ? ' active' : ''}`);
        const item = el('button', 'tab-overflow-item');
        item.type = 'button';
        item.dataset.tabId = tab.id;
        item.setAttribute('role', 'menuitem');
        item.title = tab.name;

        const status = el('span', 'tab-overflow-item-status');
        status.innerHTML = tabIconHtml(tab);
        const label = el('span', 'tab-overflow-item-label');
        label.textContent = tab.name;
        const marker = el('span', 'tab-overflow-item-marker');
        marker.textContent = tab.isActive ? '✓' : '';
        item.append(status, label, marker);

        const closeBtn = el('button', 'tab-overflow-close');
        closeBtn.type = 'button';
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Close tab';
        closeBtn.setAttribute('aria-label', `Close ${tab.name}`);
        closeBtn.dataset.tabId = tab.id;

        row.append(item, closeBtn);
        menu.appendChild(row);
    }
}

function recalculateTabCapacity(): void {
    const header = document.querySelector('.header') as HTMLElement | null;
    const modeSwitch = document.getElementById('mode-switch');
    const headerActions = document.querySelector('.header-right') as HTMLElement | null;
    if (!header || !modeSwitch || !headerActions) return;

    // The strip's room left after the mode switch, the actions, and the always-shown dropdown button.
    const fixedWidth = modeSwitch.offsetWidth + headerActions.offsetWidth + 24 + 34;
    const available = Math.max(0, header.clientWidth - fixedWidth);
    const nextCapacity = Math.max(1, Math.floor(available / TAB_MIN_VISIBLE_WIDTH));
    if (nextCapacity === visibleTabCapacity) return;
    visibleTabCapacity = nextCapacity;
    updateTabs();
}

function scheduleTabCapacityUpdate(): void {
    cancelAnimationFrame(tabLayoutFrame);
    tabLayoutFrame = requestAnimationFrame(recalculateTabCapacity);
}

export function initTabLayoutObserver(): void {
    tabLayoutObserver?.disconnect();
    tabLayoutObserver = new ResizeObserver(scheduleTabCapacityUpdate);
    const header = document.querySelector('.header');
    const modeSwitch = document.getElementById('mode-switch');
    if (header) tabLayoutObserver.observe(header);
    if (modeSwitch) tabLayoutObserver.observe(modeSwitch);
    scheduleTabCapacityUpdate();
}

/**
 * What a tab shows: its conversation, its CLI's TUI, or the Bot view. The Bot view goes over either;
 * a TUI under it keeps running, its terminal hidden.
 */
export function tabView(tab: Pick<TabInfo, 'botView' | 'tuiMode'> | undefined): 'chat' | 'terminal' | 'bot' {
    return tab?.botView ? 'bot' : tab?.tuiMode ? 'terminal' : 'chat';
}

/** The tab icon's tooltip: what clicking it shows. */
export function tabIconTitle(tab: Pick<TabInfo, 'botView' | 'tuiMode'>): string {
    if (!tab.botView) {
        return 'Show the Bot view (voice agent conversation)';
    }
    return tab.tuiMode ? 'Show the terminal (TUI); it kept running' : 'Show the conversation';
}

function tabIconHtml(tab: TabInfo): string {
    if (tab.botView) {
        return `<span class="tab-icon-robot">${ICON_ROBOT}</span>`;
    }
    if (tab.isStreaming) {
        return `<span class="tab-chat-icon${tab.tuiMode ? ' tab-chat-icon--terminal' : ''}" aria-hidden="true"></span>`;
    }
    if (tab.hasNotification) {
        return `<img class="tab-icon-img" src="${iconsBaseUri()}/notification.svg" alt="notification">`;
    }
    const icon = tab.tuiMode ? 'terminal' : 'chat';
    return `<img class="tab-icon-img" src="${iconsBaseUri()}/${icon}.svg" alt="${icon}">`;
}

export function updateTabs(): void {
    const tabStrip = document.querySelector('.tab-strip');
    if (!tabStrip) return;
    tabStrip.innerHTML = '';

    const visibleTabs = tabsForVisibleCapacity(state.tabs, state.activeTabId, visibleTabCapacity);
    for (const tab of visibleTabs) {
        const tabEl = el('div', `tab${tab.isActive ? ' tab-active' : ''}${tab.isStreaming ? ' tab-streaming' : ''}`);
        tabEl.dataset.tabId = tab.id;

        // The icon toggles what the tab shows: its conversation or TUI, or the Bot view (robot).
        const icon = el('button', 'tab-icon');
        icon.type = 'button';
        icon.dataset.tabId = tab.id;
        icon.title = tabIconTitle(tab);
        icon.setAttribute('aria-pressed', String(tab.botView));
        icon.innerHTML = tabIconHtml(tab);

        const name = el('span', 'tab-name');
        const displayName = tab.name.length > 20
            ? tab.name.substring(0, 18) + '...'
            : tab.name;
        name.textContent = displayName;
        name.title = tab.name;

        tabEl.appendChild(icon);
        tabEl.appendChild(name);

        // The last tab closes too: the chat then shows its empty state.
        const closeBtn = el('button', 'tab-close');
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Close tab';
        closeBtn.dataset.tabId = tab.id;
        tabEl.appendChild(closeBtn);

        tabStrip.appendChild(tabEl);
    }

    setWorkerBusy(state.tabs.some((tab) => tab.id === state.activeTabId && tab.isStreaming));
    updateTabOverflowMenu();
    bindTabEvents();
    scheduleTabCapacityUpdate();
}

/** Tab overflow button and menu; the document-level dismiss listeners are bound once per webview. */
export function bindTabOverflow(): void {
    const tabOverflowBtn = document.getElementById('btn-tab-overflow');
    const tabOverflowMenu = document.getElementById('tab-overflow-menu');

    tabOverflowBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = tabOverflowBtn.getAttribute('aria-expanded') === 'true';
        setTabOverflowOpen(!isOpen);
    });
    tabOverflowMenu?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        // Closing keeps the menu open so several tabs can be closed in a row.
        const closeBtn = target.closest('.tab-overflow-close') as HTMLElement | null;
        if (closeBtn?.dataset.tabId) {
            vscode.postMessage({ type: 'closeTab', tabId: closeBtn.dataset.tabId });
            return;
        }
        const item = target.closest('.tab-overflow-item') as HTMLElement | null;
        const tabId = item?.dataset.tabId;
        if (!tabId) return;
        setTabOverflowOpen(false);
        if (tabId !== state.activeTabId) {
            vscode.postMessage({ type: 'switchTab', tabId });
        }
    });
    if (!tabOverflowDismissBound) {
        tabOverflowDismissBound = true;
        document.addEventListener('click', (e) => {
            if (!(e.target as HTMLElement).closest('#tab-overflow')) {
                setTabOverflowOpen(false);
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') setTabOverflowOpen(false);
        });
    }
}

function bindTabEvents(): void {
    document.querySelectorAll('.tab').forEach((tabEl) => {
        tabEl.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.tab-close, .tab-icon')) return;
            const tabId = (tabEl as HTMLElement).dataset.tabId;
            if (tabId && tabId !== state.activeTabId) {
                vscode.postMessage({ type: 'switchTab', tabId });
            }
        });
    });

    document.querySelectorAll('.tab-icon').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabId = (btn as HTMLElement).dataset.tabId;
            if (tabId) {
                vscode.postMessage({ type: 'toggleBotView', tabId });
            }
        });
    });

    document.querySelectorAll('.tab-close').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabId = (btn as HTMLElement).dataset.tabId;
            if (tabId) {
                vscode.postMessage({ type: 'closeTab', tabId });
            }
        });
    });
}
