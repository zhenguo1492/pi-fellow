import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TuiProcessOptions } from '../../../pi/tuiTerminal';
import type { SidebarHost } from '../../../providers/sidebarHost';
import type { TabState } from '../../../providers/sidebarTabState';
import { SidebarTuiMode } from '../../../providers/sidebarTuiMode';
import { TUI_RUN_END, TUI_RUN_START, type WorkerEvent } from '../../../voiceAgent/workerController';

/** The running TUI's side: its output, what the session file says, and its screen's last lines. */
const cli = vi.hoisted(() => ({
    options: undefined as TuiProcessOptions | undefined,
    fileBusy: undefined as ((busy: boolean) => void) | undefined,
    exited: false,
    written: [] as string[],
    tail: 'Allow bash: rm -rf out? Approve / Deny',
    /** The whole screen, as the dialog cards read it: no dialog by default. */
    screen: '',
}));

vi.mock('vscode', () => ({
    commands: { executeCommand: async () => undefined },
    workspace: { workspaceFolders: undefined },
}));
vi.mock('../../../pi/sessionActivity', () => ({
    SessionActivityWatcher: class {
        constructor(_file: string, onBusy: (busy: boolean) => void) {
            cli.fileBusy = onBusy;
        }
        dispose(): void {}
    },
}));
vi.mock('../../../pi/tuiTerminal', () => ({
    TuiProcess: {
        start: async (options: TuiProcessOptions) => {
            cli.options = options;
            return {
                cwd: options.cwd,
                backend: options.backend,
                sessionFile: options.sessionFile,
                get exited() {
                    return cli.exited;
                },
                write: (data: string) => cli.written.push(data),
                resize: () => undefined,
                typeWhenReady: async () => undefined,
                snapshot: async () => '',
                title: '',
                screen: () => ({ read: async () => '', type: async () => '', tail: async () => cli.tail, peek: async () => ({ text: cli.screen }), press: async () => ({ text: cli.screen }) }),
                dispose: async () => undefined,
            };
        },
    },
}));
vi.mock('../../../providers/sidebarTabs', () => ({ updateTabName: () => false }));
vi.mock('../../../providers/sidebarTabState', () => ({ resetTabUiState: () => undefined, tabReady: async () => undefined }));

async function setup() {
    cli.exited = false;
    cli.written = [];
    cli.screen = '';
    const session = { backend: 'omp', session: { cwd: '/work', sessionFile: '/s/a.jsonl' } };
    const tab = { id: 'tab-1', name: 'Tab', tuiMode: true, tuiBusy: false, tuiPromptFromVoice: true, session } as unknown as TabState;
    const host = {
        tabs: new Map([[tab.id, tab]]),
        activeTabId: tab.id,
        activeTab: tab,
        post: vi.fn(),
        sendStateSync: vi.fn(),
        outputChannel: { appendLine: vi.fn() },
    } as unknown as SidebarHost;
    const events: WorkerEvent[] = [];
    const mode = new SidebarTuiMode(host, (_tabId, event) => events.push(event));
    await mode.start(tab.id, 80, 24);
    /** The session file says a run is on and the TUI redraws its spinner. */
    const runStarts = () => {
        cli.fileBusy!(true);
        cli.options!.onData('⠋ Working');
        cli.options!.onScreenChange();
    };
    return { mode, tab, host, events, runStarts };
}

describe('SidebarTuiMode: what the voice agent hears of a TUI', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports a run starting, and its stop with the last lines of the screen', async () => {
        const { tab, events, runStarts } = await setup();
        runStarts();
        expect(events).toEqual([{ type: TUI_RUN_START }]);
        expect(tab.tuiBusy).toBe(true);

        cli.fileBusy!(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(events).toEqual([{ type: TUI_RUN_START }, { type: TUI_RUN_END, screen: cli.tail }]);
        expect(tab.tuiBusy).toBe(false);
    });

    it('reports a run that went quiet without the file saying it ended (waiting on an approval)', async () => {
        const { events, runStarts } = await setup();
        runStarts();
        await vi.advanceTimersByTimeAsync(3000);
        expect(events).toEqual([{ type: TUI_RUN_START }, { type: TUI_RUN_END, screen: cli.tail }]);
    });

    it('says nothing of a stop when the TUI exited with the run on: it did not stop by itself', async () => {
        const { events, runStarts } = await setup();
        runStarts();
        cli.exited = true;
        cli.options!.onExit(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(events).toEqual([{ type: TUI_RUN_START }]);
    });

    it("hands the next run to the user once they press Enter in the TUI themselves, and passes their keys on", async () => {
        const { mode, tab } = await setup();
        const { tuiInput } = mode.handlers();
        await tuiInput!({ type: 'tuiInput', tabId: tab.id, data: 'ab' } as never, tab);
        expect(tab.tuiPromptFromVoice).toBe(true);
        await tuiInput!({ type: 'tuiInput', tabId: tab.id, data: '\r' } as never, tab);
        expect(tab.tuiPromptFromVoice).toBe(false);
        expect(cli.written).toEqual(['ab', '\r']);
    });

    it('shows a card for the dialog the TUI waits on, and gives its question to the voice agent with the stop', async () => {
        const { host, events, runStarts } = await setup();
        cli.screen = fs.readFileSync(path.resolve('src/test/unit/pi/fixtures/tuiDialogs/omp-approval.txt'), 'utf8');
        runStarts();
        await vi.advanceTimersByTimeAsync(3000);
        const question = { method: 'select', title: 'Allow tool: bash', message: 'Command: echo approval-probe', options: ['Approve', 'Deny'] };
        expect(host.post).toHaveBeenCalledWith({ type: 'extensionUiRequest', request: { id: 'tui-tab-1-1', ...question } });
        expect(events).toEqual([{ type: TUI_RUN_START }, { type: TUI_RUN_END, screen: cli.tail, question }]);
    });
});
