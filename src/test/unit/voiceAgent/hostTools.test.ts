import { describe, it, expect } from 'vitest';
import { HostToolRouter, type EditorHands, type ToolTurn } from '../../../voiceAgent/hostTools';
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
}

function setup(confirm = true) {
    const worker = new FakeWorker();
    const edits: string[] = [];
    const commands: string[] = [];
    const hands: EditorHands = {
        openFile: async (target) => `opened ${target.path}`,
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
    const turn = (seq: number, userAt = seq * 1000, tabId = 'tab-1'): ToolTurn => ({ tabId, seq, userAt });
    return { worker, router, turn, edits, commands };
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

        expect((await router.execute('confirm_task', { proposalId: proposal.id }, turn(3))).isError).toBe(true);
        expect(worker.sends).toHaveLength(1);
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
