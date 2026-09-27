import { describe, it, expect, vi } from 'vitest';
import type { TabInfo } from '../../../../shared/protocol';

vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: vi.fn() } }));

import { tabsForVisibleCapacity } from '../../../../webview/chat/tabs';

function makeTabs(count: number): TabInfo[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `t${i}`,
        name: `Tab ${i}`,
        isActive: false,
        isStreaming: false,
        hasNotification: false,
        botView: false,
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
