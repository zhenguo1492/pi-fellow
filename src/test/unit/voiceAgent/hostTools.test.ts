import { describe, it, expect } from 'vitest';
import { HostToolRouter, type EditorHands, type ToolTurn } from '../../../voiceAgent/hostTools';
import { findViewers, type ExtensionManifest } from '../../../voiceAgent/viewers';
import type {
    WorkerAnswer,
    WorkerController,
    WorkerRequest,
    WorkerSendOptions,
    WorkerStatus,
} from '../../../voiceAgent/workerController';

class FakeWorker implements WorkerController {
    phase: WorkerStatus['phase'] = 'idle';
    requests: WorkerRequest[] = [];
    sends: Array<{ tabId: string; text: string; options: WorkerSendOptions }> = [];
    answers: Array<{ requestId: string; answer: WorkerAnswer }> = [];

    activeTask() {
        return { tabId: 'tab-1', name: 'Task', backend: 'omp' as const };
    }
    onActiveTaskChanged() {
        return { dispose() {} };
    }
    onTabEvent() {
        return { dispose() {} };
    }
    onRequestsChanged() {
        return { dispose() {} };
    }
    async send(tabId: string, text: string, options: WorkerSendOptions) {
        this.sends.push({ tabId, text, options });
        return this.phase === 'idle' ? ('started' as const) : options.when === 'now' ? ('steered' as const) : ('queued' as const);
    }
    async abort() {}
    status(): WorkerStatus {
        return { phase: this.phase, queued: 0 };
    }
    pendingRequests() {
        return this.requests;
    }
    answer(_tabId: string, requestId: string, answer: WorkerAnswer) {
        this.answers.push({ requestId, answer });
        return true;
    }
    recentTurns() {
        return [];
    }
    async nameTask() {
        return false;
    }
}

/** A draw.io-like installed extension: one custom editor and one preview command offered for its files. */
const DIAGRAMS: ExtensionManifest = {
    id: 'someone.diagrams',
    builtin: false,
    packageJSON: {
        contributes: {
            customEditors: [{ viewType: 'diagrams.editor', displayName: 'Diagram', selector: [{ filenamePattern: '*.drawio' }], priority: 'default' }],
            commands: [{ command: 'diagrams.preview', title: 'Preview Diagram' }],
            menus: { 'editor/title': [{ command: 'diagrams.preview', when: 'resourceExtname == .drawio' }] },
        },
    },
};

/** VS Code's built-in Markdown extension, trimmed to its side preview. */
const MARKDOWN: ExtensionManifest = {
    id: 'vscode.markdown-language-features',
    builtin: true,
    packageJSON: {
        contributes: {
            commands: [{ command: 'markdown.showPreviewToSide', title: 'Open Preview to the Side', category: 'Markdown' }],
            menus: { 'editor/title': [{ command: 'markdown.showPreviewToSide', when: 'resourceExtname == .md' }] },
        },
    },
};

function setup(confirm = true) {
    const worker = new FakeWorker();
    const edits: string[] = [];
    const commands: string[] = [];
    const opened: string[] = [];
    /** The discoverPreviewCommands setting, read on every list_viewers as PairHands does. */
    const settings = { thirdPartyCommands: false };
    const hands: EditorHands = {
        openFile: async (target) => `opened ${target.path}`,
        listViewers: async (path) => ({ path, languageId: undefined, ...findViewers([DIAGRAMS, MARKDOWN], path, undefined, settings) }),
        openWith: async (path, viewer, toSide) => {
            opened.push(`${viewer.kind} ${viewer.id} ${path}${toSide ? ' side' : ''}`);
            return `opened ${path}`;
        },
        editFile: async (edit) => {
            edits.push(edit.path);
            return `edited ${edit.path}`;
        },
        createFile: async (path) => {
            edits.push(`create ${path}`);
            return `created ${path}`;
        },
        createFolder: async (path) => {
            edits.push(`mkdir ${path}`);
            return `created ${path}`;
        },
        renamePath: async (from, to) => {
            edits.push(`rename ${from} ${to}`);
            return 'renamed';
        },
        describeDeletion: async (path) => `the file ${path}`,
        deletePath: async (path) => {
            edits.push(`delete ${path}`);
            return `deleted ${path}`;
        },
        saveFiles: async () => 'saved',
        closeEditor: async () => 'closed',
        runInTerminal: async (command) => {
            commands.push(command);
            return 'Exit code 0.';
        },
        readOutput: async (source) => `output of ${source ?? 'all'}`,
        startDebugging: async (configuration) => {
            commands.push(`debug ${configuration}`);
            return 'Paused.';
        },
        controlDebugging: async (action) => {
            commands.push(`debug ${action}`);
            return 'Paused.';
        },
        setBreakpoint: async (breakpoint) => {
            commands.push(`break ${breakpoint.path}:${breakpoint.line}`);
            return 'Breakpoint.';
        },
        inspectDebugging: async () => 'Paused.',
    };
    const router = new HostToolRouter(
        worker,
        () => undefined,
        () => confirm,
        (_tabId, question) => ({ id: 'r1', question, startedAt: 0, status: 'running' as const }),
        hands,
    );
    // A new router starts in pair mode; most tests here direct the worker, which is omp mode's job.
    router.setMode('omp');
    const turn = (seq: number, userAt = seq * 1000, tabId = 'tab-1'): ToolTurn => ({ tabId, seq, userAt });
    return { worker, router, turn, edits, commands, opened, settings };
}

describe('HostToolRouter: tell_worker / confirm_task', () => {
    it('holds a new task for an idle worker until a later user turn confirms it', async () => {
        const { worker, router, turn } = setup();
        const told = await router.execute('tell_worker', { message: 'bump version', when: 'now' }, turn(1));
        expect(told.isError).toBe(false);
        expect(worker.sends).toEqual([]);
        const [proposal] = router.proposals('tab-1');

        const sameTurn = await router.execute('confirm_task', { proposalId: proposal.id }, turn(1));
        expect(sameTurn.isError).toBe(true);
        expect(worker.sends).toEqual([]);

        const confirmed = await router.execute('confirm_task', { proposalId: proposal.id }, turn(2));
        expect(confirmed).toEqual({ text: expect.stringContaining('new task'), isError: false });
        expect(worker.sends).toEqual([{ tabId: 'tab-1', text: 'bump version', options: { when: 'after', includeEditorContext: false } }]);

        const again = await router.execute('confirm_task', { proposalId: proposal.id }, turn(3));
        expect(again).toEqual({ text: expect.stringContaining('Already sent'), isError: false });
        expect(worker.sends).toHaveLength(1);
        // Confirmed aloud: the model saw its own tool result, so there is nothing to tell it.
        expect(router.takeSettled('tab-1')).toEqual([]);
    });

    it('a newer proposal replaces the older one', async () => {
        const { router, turn } = setup();
        await router.execute('tell_worker', { message: 'plan A', when: 'now' }, turn(1));
        const [a] = router.proposals('tab-1');
        await router.execute('tell_worker', { message: 'plan B', when: 'now' }, turn(2));
        expect(router.proposals('tab-1').map((p) => p.message)).toEqual(['plan B']);
        expect((await router.execute('confirm_task', { proposalId: a.id }, turn(3))).isError).toBe(true);
    });

    it('a proposal cannot be confirmed from another task', async () => {
        const { worker, router, turn } = setup();
        await router.execute('tell_worker', { message: 'plan', when: 'now' }, turn(1));
        const [proposal] = router.proposals('tab-1');
        expect((await router.execute('confirm_task', { proposalId: proposal.id }, turn(2, 2000, 'tab-2'))).isError).toBe(true);
        expect(worker.sends).toEqual([]);
    });

    it('sends straight away while the worker is busy, keeping `when`', async () => {
        const { worker, router, turn } = setup();
        worker.phase = 'working';
        const steered = await router.execute('tell_worker', { message: 'use B instead', when: 'now' }, turn(1));
        const queued = await router.execute('tell_worker', { message: 'then add tests', when: 'after' }, turn(1));
        expect([steered.text, queued.text]).toEqual([
            expect.stringContaining('correction'),
            expect.stringContaining('Queued'),
        ]);
        expect(worker.sends.map((s) => s.options.when)).toEqual(['now', 'after']);
        expect(router.proposals('tab-1')).toEqual([]);
    });

    it('sends a read-only task to an idle worker without asking, telling it not to change files', async () => {
        const { worker, router, turn } = setup();
        const result = await router.execute('tell_worker', { message: 'run the tests', when: 'now', readOnly: true }, turn(1));
        expect(result.text).toContain('new task');
        expect(router.proposals('tab-1')).toEqual([]);
        expect(worker.sends).toHaveLength(1);
        expect(worker.sends[0].text).toMatch(/^run the tests\n\n.*do not edit, create or delete/);
    });

    it('sends straight away when confirmation is turned off', async () => {
        const { worker, router, turn } = setup(false);
        await router.execute('tell_worker', { message: 'bump version', when: 'now' }, turn(1));
        expect(worker.sends).toHaveLength(1);
    });

    it('a proposal confirmed with the panel button is told to the model once, and confirm_task does not send it again', async () => {
        const { worker, router, turn } = setup();
        await router.execute('tell_worker', { message: 'bump version', when: 'now' }, turn(1));
        const [proposal] = router.proposals('tab-1');

        expect(await router.confirmProposal(proposal.id)).toContain('new task');
        expect(router.proposals('tab-1')).toEqual([]);
        expect(router.takeSettled('tab-1')).toEqual([
            expect.objectContaining({ id: proposal.id, message: 'bump version', outcome: 'confirmed', by: 'button', result: expect.stringContaining('new task') }),
        ]);
        expect(router.takeSettled('tab-1')).toEqual([]);

        // The user also says yes aloud: the model is told it already went out, not that something failed.
        const late = await router.execute('confirm_task', { proposalId: proposal.id }, turn(2));
        expect(late.isError).toBe(false);
        expect(late.text).toMatch(/Already sent.*button/);
        expect(worker.sends).toHaveLength(1);
    });

    it('confirm_task while the button is still sending the proposal does not send it twice', async () => {
        const { worker, router, turn } = setup();
        await router.execute('tell_worker', { message: 'bump version', when: 'now' }, turn(1));
        const [proposal] = router.proposals('tab-1');
        const sending = router.confirmProposal(proposal.id);
        const late = await router.execute('confirm_task', { proposalId: proposal.id }, turn(2));
        await sending;
        expect(late.isError).toBe(false);
        expect(worker.sends).toHaveLength(1);
    });

    it('a proposal cancelled with the panel button is told to the model and cannot be confirmed', async () => {
        const { worker, router, turn } = setup();
        await router.execute('tell_worker', { message: 'bump version', when: 'now' }, turn(1));
        const [proposal] = router.proposals('tab-1');

        router.cancelProposal(proposal.id);
        expect(router.proposals('tab-1')).toEqual([]);
        expect(router.takeSettled('tab-1')).toEqual([expect.objectContaining({ id: proposal.id, outcome: 'cancelled', by: 'button' })]);

        const late = await router.execute('confirm_task', { proposalId: proposal.id }, turn(2));
        expect(late).toEqual({ text: expect.stringContaining('cancelled'), isError: true });
        expect(worker.sends).toEqual([]);
    });

    it('a proposal the button failed to send is reported as not sent', async () => {
        const { worker, router, turn } = setup();
        await router.execute('tell_worker', { message: 'bump version', when: 'now' }, turn(1));
        const [proposal] = router.proposals('tab-1');
        worker.send = async () => {
            throw new Error('no chat tab');
        };

        await expect(router.confirmProposal(proposal.id)).rejects.toThrow('no chat tab');
        expect(router.takeSettled('tab-1')).toEqual([expect.objectContaining({ outcome: 'failed', result: expect.stringContaining('no chat tab') })]);
        const late = await router.execute('confirm_task', { proposalId: proposal.id }, turn(2));
        expect(late).toEqual({ text: expect.stringMatching(/^Not sent: .*no chat tab/), isError: true });
    });
});

describe('HostToolRouter: answer_worker', () => {
    const approval: WorkerRequest = { id: 'r1', method: 'select', title: 'Allow tool: bash', options: ['Approve', 'Deny'], receivedAt: 1500 };

    it('refuses to answer a request the user had not seen when they spoke', async () => {
        const { worker, router, turn } = setup();
        worker.requests = [approval];
        const result = await router.execute('answer_worker', { requestId: 'r1', value: 'Approve' }, turn(1, 1000));
        expect(result.isError).toBe(true);
        expect(worker.answers).toEqual([]);
    });

    it('maps the answer to the request kind', async () => {
        const { worker, router, turn } = setup();
        worker.requests = [approval, { id: 'r2', method: 'confirm', title: 'Overwrite?', receivedAt: 1500 }];
        await router.execute('answer_worker', { requestId: 'r1', value: 'Approve' }, turn(2));
        await router.execute('answer_worker', { requestId: 'r2', confirmed: false }, turn(2));
        await router.execute('answer_worker', { requestId: 'r1', cancel: true }, turn(2));
        expect(worker.answers).toEqual([
            { requestId: 'r1', answer: { value: 'Approve' } },
            { requestId: 'r2', answer: { confirmed: false } },
            { requestId: 'r1', answer: { cancelled: true } },
        ]);
        const missing = await router.execute('answer_worker', { requestId: 'r2', value: 'yes' }, turn(2));
        expect(missing.isError).toBe(true);
    });
});

describe('HostToolRouter: proactive turns', () => {
    it('only looks: nobody asked, so nothing reaches the worker', async () => {
        const { worker, router } = setup(false);
        worker.phase = 'awaiting';
        worker.requests = [{ id: 'r1', method: 'select', options: ['Approve', 'Deny'], receivedAt: 500 }];
        const proactive = { tabId: 'tab-1', seq: 1, userAt: 1000, proactive: true };
        const results = await Promise.all([
            router.execute('tell_worker', { message: 'run the tests', when: 'now', readOnly: true }, proactive),
            router.execute('answer_worker', { requestId: 'r1', value: 'Approve' }, proactive),
            router.execute('stop_worker', {}, proactive),
        ]);
        expect(results.map((r) => r.isError)).toEqual([true, true, true]);
        expect(worker.sends).toEqual([]);
        expect(worker.answers).toEqual([]);
        expect((await router.execute('worker_status', {}, proactive)).isError).toBe(false);
    });
});

describe('HostToolRouter: omp and pair modes', () => {
    const edit = { path: 'a.ts', oldText: 'x', newText: 'y' };

    it('starts in pair mode: edits at once, and switches to omp and back on its own for a heavy job', async () => {
        const worker = new FakeWorker();
        const edited: string[] = [];
        const hands = {
            editFile: async (e: { path: string }) => {
                edited.push(e.path);
                return 'edited';
            },
        } as unknown as EditorHands;
        const router = new HostToolRouter(worker, () => undefined, () => false, () => ({ id: 'r1', question: '', startedAt: 0, status: 'running' as const }), hands);
        const turn = { tabId: 'tab-1', seq: 1, userAt: 1000 };
        expect(router.mode).toBe('pair');
        expect((await router.execute('edit_file', edit, turn)).isError).toBe(false);
        expect(edited).toEqual(['a.ts']);
        await router.execute('set_mode', { mode: 'omp', auto: true }, turn);
        expect((await router.execute('tell_worker', { message: 'refactor the parser', when: 'now' }, turn)).isError).toBe(false);
        expect(worker.sends.map((s) => s.text)).toEqual(['refactor the parser']);
        await router.execute('set_mode', { mode: 'pair' }, turn);
        expect(router.mode).toBe('pair');
    });

    it('enters pair mode only when a later user turn confirms, and leaves it at once', async () => {
        const { router, turn } = setup();
        expect(router.mode).toBe('omp');
        expect((await router.execute('set_mode', { mode: 'pair' }, turn(1))).text).toMatch(/Not switched yet/);
        expect((await router.execute('set_mode', { mode: 'pair' }, turn(1))).text).toMatch(/Not switched yet/);
        expect(router.mode).toBe('omp');
        await router.execute('set_mode', { mode: 'pair' }, turn(2));
        expect(router.mode).toBe('pair');
        await router.execute('set_mode', { mode: 'omp' }, turn(3));
        expect(router.mode).toBe('omp');
        // The old request does not carry over: pair needs asking and confirming again.
        expect((await router.execute('set_mode', { mode: 'pair' }, turn(4))).text).toMatch(/Not switched yet/);
    });

    it('switches pair -> omp on its own for a heavy job, and back to pair without confirmation', async () => {
        const { router, turn } = setup();
        router.setMode('pair');
        const auto = await router.execute('set_mode', { mode: 'omp', auto: true }, turn(1));
        expect([auto.isError, router.mode]).toEqual([false, 'omp']);
        // A redundant omp call keeps the auto switch.
        await router.execute('set_mode', { mode: 'omp' }, turn(2));
        await router.execute('set_mode', { mode: 'pair' }, turn(2));
        expect(router.mode).toBe('pair');
        // Only once: the next time omp was the user's idea, pair needs confirming again.
        await router.execute('set_mode', { mode: 'omp' }, turn(3));
        expect((await router.execute('set_mode', { mode: 'pair' }, turn(4))).text).toMatch(/Not switched yet/);
        expect(router.mode).toBe('omp');
    });

    it('needs confirmation for pair after the user switched to omp, even following an auto switch', async () => {
        const { router, turn } = setup();
        router.setMode('pair');
        router.setMode('omp');
        expect((await router.execute('set_mode', { mode: 'pair' }, turn(1))).text).toMatch(/Not switched yet/);
        router.setMode('pair');
        await router.execute('set_mode', { mode: 'omp', auto: true }, turn(2));
        router.setMode('omp');
        expect((await router.execute('set_mode', { mode: 'pair' }, turn(3))).text).toMatch(/Not switched yet/);
        // auto means nothing outside pair mode: there is no switch from pair to remember.
        await router.execute('set_mode', { mode: 'omp', auto: true }, turn(4));
        expect((await router.execute('set_mode', { mode: 'pair' }, turn(4))).text).toMatch(/Not switched yet/);
        expect(router.mode).toBe('omp');
    });

    it('in omp mode refuses to change files, run commands or debug itself, but reads output', async () => {
        const { router, turn, edits, commands } = setup();
        expect((await router.execute('edit_file', edit, turn(1))).isError).toBe(true);
        expect((await router.execute('create_file', { path: 'b.ts', content: 'x' }, turn(1))).isError).toBe(true);
        expect((await router.execute('delete_file', { path: 'a.ts' }, turn(1))).isError).toBe(true);
        expect((await router.execute('run_in_terminal', { command: 'ls' }, turn(1))).isError).toBe(true);
        expect((await router.execute('debug_start', {}, turn(1))).isError).toBe(true);
        expect((await router.execute('set_breakpoint', { path: 'a.ts', line: 3 }, turn(1))).isError).toBe(true);
        expect((await router.execute('read_output', { source: 'Tasks' }, turn(1))).isError).toBe(false);
        expect([edits, commands]).toEqual([[], []]);
    });

    it('in pair mode works itself and does not direct the worker', async () => {
        const { worker, router, turn, edits, commands } = setup(false);
        router.setMode('pair');
        worker.requests = [{ id: 'r1', method: 'select', options: ['Approve', 'Deny'], receivedAt: 500 }];
        const refused = await Promise.all([
            router.execute('tell_worker', { message: 'run the tests', when: 'now' }, turn(1)),
            router.execute('answer_worker', { requestId: 'r1', value: 'Approve' }, turn(1)),
            router.execute('stop_worker', {}, turn(1)),
        ]);
        expect(refused.map((r) => r.isError)).toEqual([true, true, true]);
        expect([worker.sends, worker.answers]).toEqual([[], []]);
        expect((await router.execute('edit_file', edit, turn(1))).isError).toBe(false);
        expect((await router.execute('run_in_terminal', { command: 'npm test' }, turn(1))).isError).toBe(false);
        expect([edits, commands]).toEqual([['a.ts'], ['npm test']]);
    });

    it('does not edit while the worker is still writing, nor on its own in a proactive turn', async () => {
        const { worker, router, turn, edits, commands } = setup();
        router.setMode('pair');
        worker.phase = 'working';
        expect((await router.execute('edit_file', edit, turn(1))).isError).toBe(true);
        expect((await router.execute('delete_file', { path: 'a.ts' }, turn(1))).isError).toBe(true);
        worker.phase = 'idle';
        const proactive = { tabId: 'tab-1', seq: 1, userAt: 1000, proactive: true };
        expect((await router.execute('edit_file', edit, proactive)).isError).toBe(true);
        expect((await router.execute('run_in_terminal', { command: 'ls' }, proactive)).isError).toBe(true);
        expect((await router.execute('set_mode', { mode: 'omp' }, proactive)).isError).toBe(true);
        expect([edits, commands, router.mode]).toEqual([[], [], 'pair']);
    });
});

describe('HostToolRouter: deleting files', () => {
    it('deletes only when the same request comes again in a later user turn', async () => {
        const { router, turn, edits } = setup();
        router.setMode('pair');
        expect((await router.execute('delete_file', { path: 'a.ts' }, turn(1))).text).toMatch(/Not deleted yet.*the file a.ts/);
        expect((await router.execute('delete_file', { path: './a.ts' }, turn(1))).text).toMatch(/Not deleted yet/);
        expect(router.pendingDelete).toEqual({ path: 'a.ts', recursive: false });
        expect(edits).toEqual([]);
        expect((await router.execute('delete_file', { path: 'a.ts' }, turn(2))).text).toBe('deleted a.ts');
        expect([edits, router.pendingDelete]).toEqual([['delete a.ts'], undefined]);
    });

    it('starts over for another path, another recursive, or after a mode switch', async () => {
        const { router, turn, edits } = setup();
        router.setMode('pair');
        await router.execute('delete_file', { path: 'a.ts' }, turn(1));
        expect((await router.execute('delete_file', { path: 'b.ts' }, turn(2))).text).toMatch(/Not deleted yet/);
        expect((await router.execute('delete_file', { path: 'b.ts', recursive: true }, turn(3))).text).toMatch(/Not deleted yet/);
        router.setMode('omp');
        router.setMode('pair');
        expect((await router.execute('delete_file', { path: 'b.ts', recursive: true }, turn(4))).text).toMatch(/Not deleted yet/);
        expect(edits).toEqual([]);
    });
});

describe('HostToolRouter: list_viewers / open_with', () => {
    it('lists and opens editors in omp and in pair mode, without touching files or running commands', async () => {
        const { router, turn, edits, commands, opened } = setup();
        for (const mode of ['omp', 'pair'] as const) {
            router.setMode(mode);
            const listed = await router.execute('list_viewers', { path: 'docs/flow.drawio' }, turn(1));
            expect(listed.isError).toBe(false);
            expect(listed.text).toMatch(/- diagrams\.editor: Diagram \[someone\.diagrams, default\]/);
            expect(listed.text).toMatch(/- default: Text Editor/);
            expect((await router.execute('open_with', { path: 'docs/flow.drawio', viewer: 'diagrams.editor', toSide: true }, turn(1))).isError).toBe(false);
        }
        expect(opened).toEqual(['editor diagrams.editor docs/flow.drawio side', 'editor diagrams.editor docs/flow.drawio side']);
        expect([edits, commands]).toEqual([[], []]);
    });

    it("always lists and opens VS Code's built-in Markdown preview", async () => {
        const { router, turn, opened, settings } = setup();
        for (const on of [false, true]) {
            settings.thirdPartyCommands = on;
            expect((await router.execute('list_viewers', { path: 'README.md' }, turn(1))).text).toMatch(/- markdown\.showPreviewToSide: Markdown: Open Preview to the Side/);
            expect((await router.execute('open_with', { path: 'README.md', viewer: 'markdown.showPreviewToSide' }, turn(1))).isError).toBe(false);
        }
        expect(opened).toEqual(['command markdown.showPreviewToSide README.md', 'command markdown.showPreviewToSide README.md']);
    });

    it("with discoverPreviewCommands off, neither lists nor runs an installed extension's preview command", async () => {
        const { router, turn, opened, settings } = setup();
        expect((await router.execute('list_viewers', { path: 'docs/flow.drawio' }, turn(1))).text).not.toMatch(/diagrams\.preview/);
        const refused = await router.execute('open_with', { path: 'docs/flow.drawio', viewer: 'diagrams.preview' }, turn(1));
        expect(refused).toEqual({ text: expect.stringMatching(/not a viewer for docs\/flow\.drawio\. Use one of: diagrams\.editor, default\.$/), isError: true });
        expect(opened).toEqual([]);

        settings.thirdPartyCommands = true;
        expect((await router.execute('list_viewers', { path: 'docs/flow.drawio' }, turn(1))).text).toMatch(/- diagrams\.preview: Preview Diagram/);
        expect((await router.execute('open_with', { path: 'docs/flow.drawio', viewer: 'diagrams.preview' }, turn(1))).isError).toBe(false);
        expect(opened).toEqual(['command diagrams.preview docs/flow.drawio']);
    });

    it('opens only a viewer listed for that file: never an arbitrary command', async () => {
        const { router, turn, opened, settings } = setup();
        settings.thirdPartyCommands = true;
        const arbitrary = await router.execute('open_with', { path: 'docs/flow.drawio', viewer: 'workbench.action.terminal.new' }, turn(1));
        expect(arbitrary).toEqual({ text: expect.stringMatching(/not a viewer for docs\/flow\.drawio\. Use one of: diagrams\.editor, default, diagrams\.preview/), isError: true });
        // Nothing is offered for another kind of file but the text editor.
        expect((await router.execute('open_with', { path: 'notes.txt', viewer: 'diagrams.editor' }, turn(1))).isError).toBe(true);
        expect((await router.execute('open_with', { path: 'notes.txt', viewer: 'diagrams.preview' }, turn(1))).isError).toBe(true);
        expect((await router.execute('open_with', { path: 'notes.txt', viewer: 'markdown.showPreviewToSide' }, turn(1))).isError).toBe(true);
        expect(opened).toEqual([]);
        expect((await router.execute('open_with', { path: 'notes.txt', viewer: 'default' }, turn(1))).isError).toBe(false);
        expect(opened).toEqual(['editor default notes.txt']);
    });
});
