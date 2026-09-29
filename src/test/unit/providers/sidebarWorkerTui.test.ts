import { describe, expect, it, vi } from 'vitest';
import type { SidebarAttachments } from '../../../providers/sidebarAttachments';
import type { SidebarHost } from '../../../providers/sidebarHost';
import type { SidebarPromptQueue } from '../../../providers/sidebarPromptQueue';
import type { TabState } from '../../../providers/sidebarTabState';
import type { TabTui, TabTuis } from '../../../providers/sidebarTui';
import { SidebarWorker } from '../../../providers/sidebarWorker';

const ready = vi.hoisted(() => ({ waited: [] as string[] }));

vi.mock('vscode', () => ({}));
vi.mock('../../../providers/sidebarTabs', () => ({ updateTabName: () => false }));
vi.mock('../../../providers/sidebarTabState', () => ({
    tabReady: async (tab: { id: string }) => {
        ready.waited.push(tab.id);
    },
}));
vi.mock('../../../providers/sidebarPermission', () => ({ tabPermissionLevel: () => 'auto' }));
vi.mock('../../../providers/sidebarToolApproval', () => ({ requestToolApproval: async () => true }));

function setup(options: { backend?: 'omp' | 'pi'; busy?: boolean; running?: boolean } = {}) {
    ready.waited.length = 0;
    const typed: string[] = [];
    const written: string[] = [];
    const reads: number[] = [];
    const tui = {
        backend: options.backend ?? 'omp',
        exited: options.running === false,
        typeWhenReady: async (text: string) => {
            typed.push(text);
        },
        write: (data: string) => written.push(data),
        screen: () => ({
            read: async (pagesBack = 0) => {
                reads.push(pagesBack);
                return 'the screen';
            },
            type: async (keys: string) => {
                written.push(keys);
                return 'the screen after';
            },
            tail: async () => '',
        }),
    } as unknown as TabTui;
    const rpcPending = [{ id: 'r1', method: 'confirm', receivedAt: 0 }];
    const tab = {
        id: 'tab-1',
        tuiMode: true,
        tuiBusy: options.busy ?? false,
        tuiPromptFromVoice: false,
        queuedMessages: [],
        session: { messages: [], rpcExtensionUi: { pendingRequests: () => rpcPending } },
    } as unknown as TabState;
    const host = { tabs: new Map([[tab.id, tab]]) } as unknown as SidebarHost;
    const queue = {
        uiIsStreaming: () => false,
        beginPrompt: vi.fn(),
        abortTab: vi.fn(),
    } as unknown as SidebarPromptQueue;
    const attachments = {
        editorContextAttachments: () => [{ textFragment: 'Current file: src/a.ts' }],
    } as unknown as SidebarAttachments;
    const tuis = { get: (tabId: string) => (tabId === tab.id ? tui : undefined) } as unknown as TabTuis;
    const worker = new SidebarWorker(host, queue, attachments, tuis);
    return { worker, tab, typed, written, reads, queue };
}

const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;

describe('SidebarWorker on a tab showing the CLI TUI', () => {
    it('types a new task into the idle TUI as a pasted prompt, once the tab is ready, and marks it as the voice agent\'s', async () => {
        const { worker, tab, typed, queue } = setup();
        expect(await worker.send(tab.id, '  fix the parser  ', { when: 'now' })).toBe('started');
        expect(ready.waited).toEqual([tab.id]);
        expect(typed).toEqual([`${PASTE('fix the parser')}\r`]);
        expect(tab.tuiPromptFromVoice).toBe(true);
        expect(queue.beginPrompt).not.toHaveBeenCalled();
    });

    it('steers a working TUI with Enter, or queues a follow-up with its own key', async () => {
        const omp = setup({ busy: true });
        expect(await omp.worker.send('tab-1', 'use B', { when: 'now' })).toBe('steered');
        expect(await omp.worker.send('tab-1', 'then test', { when: 'after' })).toBe('queued');
        expect(omp.typed).toEqual([`${PASTE('use B')}\r`, `${PASTE('then test')}\x11`]);
    });

    it('keeps refusing slash commands and shell shortcuts, typing nothing', async () => {
        const { worker, typed } = setup();
        await expect(worker.send('tab-1', '/new', { when: 'now' })).rejects.toThrow(/slash commands/);
        await expect(worker.send('tab-1', '!ls', { when: 'now' })).rejects.toThrow(/slash commands/);
        expect(typed).toEqual([]);
    });

    it('adds the editor context to the typed prompt when asked', async () => {
        const { worker, typed } = setup();
        await worker.send('tab-1', 'explain this', { when: 'now', includeEditorContext: true });
        expect(typed[0]).toContain('explain this');
        expect(typed[0]).toContain('src/a.ts');
    });

    it('fails, typing nothing, when the TUI is not running', async () => {
        const { worker, typed } = setup({ running: false });
        await expect(worker.send('tab-1', 'fix it', { when: 'now' })).rejects.toThrow(/not running/);
        await expect(worker.readTuiScreen('tab-1', 0)).rejects.toThrow(/not running/);
        expect(typed).toEqual([]);
    });

    it('interrupts with Escape instead of aborting the idle RPC worker', async () => {
        const { worker, written, queue } = setup({ busy: true });
        await worker.abort('tab-1');
        expect(written).toEqual(['\x1b']);
        expect(queue.abortTab).not.toHaveBeenCalled();
    });

    it("reports the TUI's run as the state, and none of the RPC worker's requests", () => {
        const { worker, tab } = setup({ busy: true });
        expect(worker.status(tab.id)).toEqual({ phase: 'working', queued: 0, fromVoice: false, tui: true });
        tab.tuiBusy = false;
        expect(worker.status(tab.id).phase).toBe('idle');
        expect(worker.pendingRequests(tab.id)).toEqual([]);
    });

    it('reads and types through the TUI screen', async () => {
        const { worker, reads, written } = setup();
        expect(await worker.readTuiScreen('tab-1', 2)).toBe('the screen');
        expect(reads).toEqual([2]);
        expect(await worker.typeIntoTui('tab-1', '\x1b[B\r')).toBe('the screen after');
        expect(written).toEqual(['\x1b[B\r']);
    });

    it('refuses the TUI screen of a chat tab', async () => {
        const { worker, tab } = setup();
        tab.tuiMode = false;
        await expect(worker.readTuiScreen(tab.id, 0)).rejects.toThrow(/not the CLI TUI/);
        await expect(worker.typeIntoTui(tab.id, 'y')).rejects.toThrow(/not the CLI TUI/);
    });
});
