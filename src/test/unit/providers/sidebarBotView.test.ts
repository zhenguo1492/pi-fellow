import { describe, expect, it, vi } from 'vitest';
import type { SidebarHost } from '../../../providers/sidebarHost';
import { SidebarBotView } from '../../../providers/sidebarBotView';
import type { SidebarTabs } from '../../../providers/sidebarTabs';
import type { TabState } from '../../../providers/sidebarTabState';
import type { VoiceInput } from '../../../voice/voiceInput';

vi.mock('vscode', () => ({ commands: { executeCommand: async () => undefined } }));

function setup(tuiMode: boolean) {
    const tab = { id: 'tab-1', tuiMode, botView: false, isStreaming: false, session: { messages: [] } } as unknown as TabState;
    const host = {
        tabs: new Map([[tab.id, tab]]),
        activeTabId: tab.id,
        activeTab: tab,
        sendStateSync: vi.fn(),
    } as unknown as SidebarHost;
    const view = { visible: true, show: vi.fn() };
    const tabs = { switchTab: vi.fn() };
    const botView = new SidebarBotView(host, () => view as never, {} as VoiceInput, tabs as unknown as SidebarTabs, {
        fire: vi.fn(),
    } as never);
    return {
        tab,
        host,
        tabs,
        botView,
        toggle: () => botView.handlers().toggleBotView!({ type: 'toggleBotView' } as never, tab),
        showTui: (tabId: string) => botView.handlers().showTui!({ type: 'showTui', tabId } as never, tab),
    };
}

describe('SidebarBotView in a tab showing its TUI', () => {
    it('toggles between the terminal and the Bot view, which then counts as shown', async () => {
        const { tab, host, botView, toggle } = setup(true);
        await toggle();
        expect(tab.botView).toBe(true);
        expect(botView.showsBotView()).toBe(true);
        expect(botView.isBotViewVisible()).toBe(true);
        expect(host.sendStateSync).toHaveBeenCalled();

        await toggle();
        expect(tab.botView).toBe(false);
        expect(botView.showsBotView()).toBe(false);
    });

    it('opens the Bot view when asked, but not on its own for a TUI tab, whose work the RPC session cannot see', async () => {
        const automatic = setup(true);
        await automatic.botView.showBotView(true, { onlyIfWorkerUnused: true });
        expect(automatic.tab.botView).toBe(false);

        const chat = setup(false);
        await chat.botView.showBotView(true, { onlyIfWorkerUnused: true });
        expect(chat.tab.botView).toBe(true);

        const asked = setup(true);
        await asked.botView.showBotView(true);
        expect(asked.tab.botView).toBe(true);
    });

    it("shows the terminal for a dialog card's button, from the Bot view or another tab, and leaves a chat tab alone", async () => {
        const { tab, host, tabs, toggle, showTui } = setup(true);
        await toggle();
        await showTui('tab-1');
        expect(tab.botView).toBe(false);
        expect(host.sendStateSync).toHaveBeenCalledTimes(2);

        const other = { id: 'tab-2', tuiMode: true, botView: true } as unknown as TabState;
        host.tabs.set(other.id, other);
        await showTui('tab-2');
        expect(other.botView).toBe(false);
        expect(tabs.switchTab).toHaveBeenCalledExactlyOnceWith('tab-2');

        const chat = setup(false);
        chat.tab.botView = true;
        await chat.showTui('tab-1');
        expect(chat.tab.botView).toBe(true);
    });
});

describe('SidebarBotView in a chat tab', () => {
    it('toggles between the conversation and the Bot view on each click of the avatar button', async () => {
        const { tab, host, botView, toggle } = setup(false);
        await toggle();
        expect(tab.botView).toBe(true);
        expect(botView.showsBotView()).toBe(true);
        expect(host.sendStateSync).toHaveBeenCalledTimes(1);

        await toggle();
        expect(tab.botView).toBe(false);
        expect(botView.showsBotView()).toBe(false);
        expect(host.sendStateSync).toHaveBeenCalledTimes(2);
    });

    it('switches to a tab that is not active and shows its Bot view', async () => {
        const { host, tabs, botView } = setup(false);
        const other = { id: 'tab-2', tuiMode: false, botView: false } as unknown as TabState;
        host.tabs.set(other.id, other);
        await botView.handlers().toggleBotView!({ type: 'toggleBotView', tabId: 'tab-2' } as never, other);
        expect(other.botView).toBe(true);
        expect(tabs.switchTab).toHaveBeenCalledExactlyOnceWith('tab-2');
        expect(host.sendStateSync).not.toHaveBeenCalled();
    });
});
