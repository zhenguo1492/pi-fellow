import { describe, it, expect, vi } from 'vitest';
import type { TabInfo } from '../../../../shared/protocol';

vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: vi.fn() } }));

import { tabIconTitle, tabView, tabsForVisibleCapacity } from '../../../../webview/chat/tabs';

function makeTabs(count: number): TabInfo[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `t${i}`,
        name: `Tab ${i}`,
        isActive: false,
        isStreaming: false,
        hasNotification: false,
        botView: false,
        tuiMode: false,
    }));
}

function ids(tabs: TabInfo[]): string[] {
    return tabs.map((t) => t.id);
}

describe('tabsForVisibleCapacity', () => {
    it('returns the same array when every tab fits', () => {
        const tabs = makeTabs(3);
        expect(tabsForVisibleCapacity(tabs, 't1', 3)).toBe(tabs);
        expect(tabsForVisibleCapacity(tabs, 't1', Number.POSITIVE_INFINITY)).toBe(tabs);
    });

    it('centers the window on the active tab with (capacity - 1) / 2 tabs before it', () => {
        const tabs = makeTabs(10);
        expect(ids(tabsForVisibleCapacity(tabs, 't5', 3))).toEqual(['t4', 't5', 't6']);
        expect(ids(tabsForVisibleCapacity(tabs, 't5', 4))).toEqual(['t4', 't5', 't6', 't7']);
    });

    it('clamps the window at the start and end of the list', () => {
        const tabs = makeTabs(10);
        expect(ids(tabsForVisibleCapacity(tabs, 't0', 3))).toEqual(['t0', 't1', 't2']);
        expect(ids(tabsForVisibleCapacity(tabs, 't9', 3))).toEqual(['t7', 't8', 't9']);
    });

    it('rounds fractional capacity down and shows at least one tab', () => {
        const tabs = makeTabs(5);
        expect(ids(tabsForVisibleCapacity(tabs, 't2', 2.9))).toEqual(['t2', 't3']);
        expect(ids(tabsForVisibleCapacity(tabs, 't3', 0))).toEqual(['t3']);
    });

    it('treats an unknown active tab as the first one', () => {
        expect(ids(tabsForVisibleCapacity(makeTabs(5), 'missing', 2))).toEqual(['t0', 't1']);
    });
});

describe('tabView and the tab icon', () => {
    it('shows the Bot view over a conversation or a TUI, else what the tab is in', () => {
        expect(tabView({ botView: false, tuiMode: false })).toBe('chat');
        expect(tabView({ botView: false, tuiMode: true })).toBe('terminal');
        expect(tabView({ botView: true, tuiMode: true })).toBe('bot');
        expect(tabView({ botView: true, tuiMode: false })).toBe('bot');
        expect(tabView(undefined)).toBe('chat');
    });

    it('says what a click brings: the Bot view, or back to the conversation or the still-running terminal', () => {
        expect(tabIconTitle({ botView: false, tuiMode: true })).toBe('Show the Bot view (voice agent conversation)');
        expect(tabIconTitle({ botView: true, tuiMode: true })).toBe('Show the terminal (TUI); it kept running');
        expect(tabIconTitle({ botView: true, tuiMode: false })).toBe('Show the conversation');
    });
});
