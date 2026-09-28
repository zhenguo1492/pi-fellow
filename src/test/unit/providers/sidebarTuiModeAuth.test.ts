import { describe, expect, it, vi } from 'vitest';
import type { TuiProcessOptions } from '../../../pi/tuiTerminal';
import type { SidebarHost } from '../../../providers/sidebarHost';
import type { TabState } from '../../../providers/sidebarTabState';
import { SidebarTuiMode } from '../../../providers/sidebarTuiMode';

const typed = vi.hoisted(() => [] as string[]);

vi.mock('vscode', () => ({
    commands: { executeCommand: async () => undefined },
    workspace: { workspaceFolders: undefined },
}));
vi.mock('../../../pi/sessionActivity', () => ({
    SessionActivityWatcher: class {
        dispose(): void {}
    },
}));
vi.mock('../../../pi/tuiTerminal', () => ({
    TuiProcess: {
        start: async (options: TuiProcessOptions) => ({
            cwd: options.cwd,
            backend: options.backend,
            sessionFile: options.sessionFile,
            exited: false,
            write: () => undefined,
            resize: () => undefined,
            typeWhenReady: async (text: string) => {
                typed.push(text);
            },
            snapshot: async () => '',
            dispose: async () => undefined,
        }),
    },
}));
vi.mock('../../../providers/sidebarTabs', () => ({ updateTabName: () => false }));
vi.mock('../../../providers/sidebarTabState', () => ({ resetTabUiState: () => undefined, tabReady: async () => undefined }));

function setup() {
    const session = {
        backend: 'pi',
        session: { cwd: '/work', sessionFile: '/s/a.jsonl' },
        reloadPiAgentResources: vi.fn(async () => undefined),
        reloadSessionFromDisk: vi.fn(async () => undefined),
    };
    const tab = { id: 'tab-1', name: 'Tab', tuiMode: false, isStreaming: false, botView: false, session } as unknown as TabState;
    const host = {
        tabs: new Map([[tab.id, tab]]),
        activeTabId: tab.id,
        activeTab: tab,
        post: vi.fn(),
        sendStateSync: vi.fn(),
        outputChannel: { appendLine: vi.fn() },
    } as unknown as SidebarHost;
    const mode = new SidebarTuiMode(host);
    return { mode, handlers: mode.handlers(), tab, session };
}

describe('SidebarTuiMode /login hand-off', () => {
    it('types the command into the TUI and restarts the RPC process on return, so it sees the new credentials', async () => {
        typed.length = 0;
        const { mode, handlers, tab, session } = setup();
        await mode.promptAuth('login');
        expect(mode.authPrompt).toBe('login');

        await handlers.runTuiAuth!({ type: 'runTuiAuth' } as never, tab);
        expect(tab.tuiMode).toBe(true);
        expect(mode.authPrompt).toBeUndefined();
        await mode.start(tab.id, 80, 24);
        expect(typed).toEqual(['/login\r']);

        await handlers.toggleTuiMode!({ type: 'toggleTuiMode' } as never, tab);
        expect(tab.tuiMode).toBe(false);
        expect(session.reloadPiAgentResources).toHaveBeenCalledOnce();
        expect(session.reloadSessionFromDisk).not.toHaveBeenCalled();
    });

    it('only re-reads the session file when leaving a TUI that ran no auth command', async () => {
        const { mode, handlers, tab, session } = setup();
        await handlers.toggleTuiMode!({ type: 'toggleTuiMode' } as never, tab);
        await mode.start(tab.id, 80, 24);
        await handlers.toggleTuiMode!({ type: 'toggleTuiMode' } as never, tab);
        expect(session.reloadSessionFromDisk).toHaveBeenCalledOnce();
        expect(session.reloadPiAgentResources).not.toHaveBeenCalled();
    });
});
