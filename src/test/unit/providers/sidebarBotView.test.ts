import { describe, expect, it, vi } from 'vitest';
import type { SidebarHost } from '../../../providers/sidebarHost';
import { SidebarBotView } from '../../../providers/sidebarBotView';
import type { SidebarTabs } from '../../../providers/sidebarTabs';
import type { TabState } from '../../../providers/sidebarTabState';
import type { VoiceInput } from '../../../voice/voiceInput';

vi.mock('vscode', () => ({ commands: { executeCommand: async () => undefined } }));

/** The fields SidebarBotView reads from its host; plain, so a test can close every tab. */
interface TestHost {
    tabs: Map<string, TabState>;
    activeTabId: string;
    activeTab: TabState | undefined;
    sendStateSync: () => void;
}

function setup(tuiMode: boolean) {
    const tab = { id: 'tab-1', tuiMode, botView: false, isStreaming: false, session: { messages: [] } } as unknown as TabState;
    const host: TestHost = {
        tabs: new Map([[tab.id, tab]]),
        activeTabId: tab.id,
        activeTab: tab,
        sendStateSync: vi.fn(),
    };
    const view = { visible: true, show: vi.fn() };
    // A new tab whose worker is up once the test settles `ready` (rejected: it failed to start).
    const ready = Promise.withResolvers<void>();
    // Handled where the handler awaits it; this only keeps a rejection settled early from being reported.
    ready.promise.catch(() => {});
    const created = { id: 'tab-new', tuiMode: false, botView: false, isStreaming: false, session: { messages: [], waitUntilReady: () => ready.promise } } as unknown as TabState;
    const tabs = {
        switchTab: vi.fn(),
        createTab: vi.fn(async () => {
            host.tabs.set(created.id, created);
            host.activeTabId = created.id;
            host.activeTab = created;
            return created;
        }),
    };
    const visibility = { fire: vi.fn() };
    const startVoice = vi.fn();
    const sidebarHost = host as unknown as SidebarHost;
    const botView = new SidebarBotView(sidebarHost, () => view as never, {} as VoiceInput, tabs as unknown as SidebarTabs, visibility as never, startVoice);
    return {
        tab,
        host,
        view,
        tabs,
        visibility,
        startVoice,
        ready,
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

describe('SidebarBotView with every tab closed', () => {
    it("counts the empty state, which shows the Bot view's intro, as the Bot view on screen while the sidebar is", () => {
        const { host, view, visibility, botView } = setup(false);
        botView.syncBotViewVisibility();
        expect(botView.isBotViewVisible()).toBe(false);
        expect(visibility.fire).not.toHaveBeenCalled();

        host.tabs.clear();
        host.activeTabId = '';
        host.activeTab = undefined;
        botView.syncBotViewVisibility();
        expect(botView.isBotViewVisible()).toBe(true);
        // No tab shows the Bot view: what is typed is not routed to the voice agent.
        expect(botView.showsBotView()).toBe(false);
        expect(visibility.fire).toHaveBeenCalledTimes(1);

        view.visible = false;
        botView.syncBotViewVisibility();
        expect(botView.isBotViewVisible()).toBe(false);
        expect(visibility.fire).toHaveBeenCalledTimes(2);
    });
});

describe("SidebarBotView's Call button in the empty state", () => {
    function closeEveryTab(host: TestHost): void {
        host.tabs.clear();
        host.activeTabId = '';
        host.activeTab = undefined;
    }
    /** As `SidebarProvider._handleMessage` runs it with every tab closed: the message only. */
    function call(botView: SidebarBotView): Promise<void> {
        const handler = botView.handlers().callInNewTab!;
        // A handler that takes the tab would not run with none open.
        expect(handler.length).toBeLessThan(2);
        return (handler as (msg: { type: 'callInNewTab' }) => Promise<void>)({ type: 'callInNewTab' });
    }

    it('opens a new tab and starts voice mode only once its worker is ready', async () => {
        const { host, tabs, startVoice, ready, botView } = setup(false);
        closeEveryTab(host);
        const calling = call(botView);
        // Opened at once; the worker is not up yet.
        expect(tabs.createTab).toHaveBeenCalledOnce();
        expect(startVoice).not.toHaveBeenCalled();

        ready.resolve();
        await calling;
        expect(startVoice).toHaveBeenCalledOnce();
    });

    it('does not start voice mode in a tab the user left before it was ready, or whose worker failed', async () => {
        const left = setup(false);
        closeEveryTab(left.host);
        const calling = call(left.botView);
        expect(left.tabs.createTab).toHaveBeenCalledOnce();
        left.host.activeTabId = left.tab.id;
        left.host.activeTab = left.tab;
        left.ready.resolve();
        await calling;
        expect(left.startVoice).not.toHaveBeenCalled();

        const failed = setup(false);
        closeEveryTab(failed.host);
        failed.ready.reject(new Error('omp exited with code 1'));
        await expect(call(failed.botView)).rejects.toThrow('omp exited with code 1');
        expect(failed.startVoice).not.toHaveBeenCalled();
    });
});
