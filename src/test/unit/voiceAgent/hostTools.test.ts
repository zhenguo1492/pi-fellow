import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { WorkerEditLocks } from '../../../pi/workerEdits';
import { HostToolRouter, terminalKeys, type EditorHands, type ToolTurn } from '../../../voiceAgent/hostTools';
import { findViewers, type ExtensionManifest } from '../../../voiceAgent/viewers';
import type {
    WorkerAnswer,
    WorkerController,
    WorkerRequest,
    WorkerSendOptions,
    WorkerStatus,
} from '../../../voiceAgent/workerController';
import type { PermissionLevel } from '../../../shared/protocol';

/** The workspace the voice agent's relative paths are in. */
const ROOT = path.resolve('/ws');

class FakeWorker implements WorkerController {
    phase: WorkerStatus['phase'] = 'idle';
    requests: WorkerRequest[] = [];
    sends: Array<{ tabId: string; text: string; options: WorkerSendOptions }> = [];
    answers: Array<{ requestId: string; answer: WorkerAnswer }> = [];
    /** Existing tests predate permission levels: Auto keeps their pair-mode tools running at once. */
    level: PermissionLevel = 'auto';
    /** Approvals asked for (Manual, or commands and deletions in Edit automatically), answered by `approve`. */
    approvals: Array<{ tabId: string; toolName: string; args: Record<string, unknown> }> = [];
    approve: () => Promise<boolean> = async () => true;
    /** The tab shows the CLI's TUI: its screen, what was typed into it, and the reads asked for. */
    tui = false;
    screen = 'omp TUI';
    typed: string[] = [];
    screenReads: number[] = [];
    aborts = 0;
    /** What the permission gate reported the running task changes (absolute paths). */
    readonly gate = new WorkerEditLocks();

    activeTask() {
        return { tabId: 'tab-1', name: 'Task', backend: 'omp' as const };
    }
    onActiveTaskChanged() {
        return { dispose() {} };
    }
    onSessionResumed() {
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
    async abort() {
        this.aborts++;
    }
    status(): WorkerStatus {
        return { phase: this.phase, queued: 0, ...(this.tui ? { tui: true } : {}) };
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
    permissionLevel() {
        return this.level;
    }
    requestToolApproval(tabId: string, toolName: string, args: Record<string, unknown>) {
        this.approvals.push({ tabId, toolName, args });
        return this.approve();
    }
    /** As SidebarWorker: nothing while idle or in a TUI tab; otherwise what the gate reported, workspace-relative. */
    lockedPaths(_tabId: string, paths: string[]) {
        if (this.tui || this.phase === 'idle') {
            return [];
        }
        return this.gate.overlapping(paths.map((p) => path.resolve(ROOT, p))).map((p) => path.relative(ROOT, p) || '.');
    }
    async readTuiScreen(_tabId: string, pagesBack: number) {
        this.screenReads.push(pagesBack);
        return this.screen;
    }
    async typeIntoTui(_tabId: string, keys: string) {
        this.typed.push(keys);
        return this.screen;
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
        sendToTerminal: async (input) => {
            commands.push(`type ${JSON.stringify(input)}`);
            return 'Typed a line.';
        },
        readTerminal: async (terminal, pagesBack) => `read ${terminal ?? 'latest'}${pagesBack ? ` ${pagesBack} pages back` : ''}`,
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

describe('HostToolRouter: working itself and directing the worker', () => {
    const edit = { path: 'a.ts', oldText: 'x', newText: 'y' };

    it('edits, runs commands and directs the worker in the same conversation', async () => {
        const { worker, router, turn, edits, commands } = setup(false);
        expect((await router.execute('edit_file', edit, turn(1))).isError).toBe(false);
        expect((await router.execute('run_in_terminal', { command: 'npm test' }, turn(1))).isError).toBe(false);
        expect((await router.execute('tell_worker', { message: 'refactor the parser', when: 'now' }, turn(1))).isError).toBe(false);
        expect([edits, commands, worker.sends.map((s) => s.text)]).toEqual([['a.ts'], ['npm test'], ['refactor the parser']]);
    });

    it('does not change files or run commands on its own in a proactive turn', async () => {
        const { router, edits, commands } = setup();
        const proactive = { tabId: 'tab-1', seq: 1, userAt: 1000, proactive: true };
        expect((await router.execute('edit_file', edit, proactive)).isError).toBe(true);
        expect((await router.execute('run_in_terminal', { command: 'ls' }, proactive)).isError).toBe(true);
        expect([edits, commands]).toEqual([[], []]);
    });
});

describe("HostToolRouter: the worker's file lock", () => {
    const edit = { path: 'src/a.ts', oldText: 'x', newText: 'y' };

    /** The permission gate's report: the running task is about to change these (workspace-relative here). */
    function report(worker: FakeWorker, ...paths: string[]): void {
        worker.gate.ingest(`${JSON.stringify({ paths: paths.map((p) => path.join(ROOT, p)) })}\n`);
    }

    it('refuses every change to a file the running task is changing, naming it, before asking anything', async () => {
        const { worker, router, turn, edits } = setup();
        worker.phase = 'working';
        report(worker, 'src/a.ts');
        const refused = await Promise.all([
            router.execute('edit_file', edit, turn(1)),
            router.execute('create_file', { path: 'src/a.ts', content: 'x' }, turn(1)),
            router.execute('rename_file', { from: 'src/a.ts', to: 'src/b.ts' }, turn(1)),
            router.execute('rename_file', { from: 'src/b.ts', to: './src/a.ts' }, turn(1)),
            router.execute('delete_file', { path: 'src/a.ts' }, turn(1)),
            router.execute('save_file', { path: 'src/a.ts' }, turn(1)),
            // Saving every open file could save over it too.
            router.execute('save_file', {}, turn(1)),
        ]);
        for (const result of refused) {
            expect(result).toEqual({ text: expect.stringMatching(/worker's running task is changing src\/a\.ts/), isError: true });
        }
        expect([edits, router.pendingDelete]).toEqual([[], undefined]);
    });

    it('lets the voice agent change other files while the worker works', async () => {
        const { worker, router, turn, edits } = setup();
        worker.phase = 'working';
        report(worker, 'src/a.ts');
        expect((await router.execute('edit_file', { ...edit, path: 'src/b.ts' }, turn(1))).isError).toBe(false);
        expect((await router.execute('create_file', { path: 'src/a.test.ts', content: 'x' }, turn(1))).isError).toBe(false);
        expect(edits).toEqual(['src/b.ts', 'create src/a.test.ts']);
    });

    it('locks what lies in a folder the task changes, and a folder holding a file it changes', async () => {
        const { worker, router, turn, edits } = setup();
        worker.phase = 'working';
        // ast_edit over src/gen/**, and an edit of lib/util.ts.
        report(worker, 'src/gen', 'lib/util.ts');
        expect((await router.execute('edit_file', { ...edit, path: 'src/gen/model.ts' }, turn(1))).isError).toBe(true);
        expect((await router.execute('rename_file', { from: 'lib', to: 'lib2' }, turn(1))).isError).toBe(true);
        expect((await router.execute('delete_file', { path: 'lib', recursive: true }, turn(1))).isError).toBe(true);
        // A name that only starts the same is another file.
        expect((await router.execute('edit_file', { ...edit, path: 'src/generate.ts' }, turn(1))).isError).toBe(false);
        expect(edits).toEqual(['src/generate.ts']);
    });

    it('checks again when an approval card is answered: the task may have taken the file meanwhile', async () => {
        const { worker, router, turn, edits } = setup();
        worker.level = 'ask';
        let decide: (approved: boolean) => void = () => {};
        worker.approve = () => new Promise<boolean>((resolve) => (decide = resolve));
        expect((await router.execute('edit_file', edit, turn(1))).text).toMatch(/Waiting for the user's approval/);
        worker.phase = 'working';
        report(worker, 'src/a.ts');
        const { promise, resolve } = Promise.withResolvers<void>();
        router.onApprovalSettled = resolve;
        decide(true);
        await promise;
        expect(router.takeSettledApprovals('tab-1')).toMatchObject([
            { toolName: 'edit_file', outcome: 'failed', result: expect.stringMatching(/^Not done: The worker's running task is changing src\/a\.ts/) },
        ]);
        expect(edits).toEqual([]);
    });
});

describe('HostToolRouter: terminal_send / terminal_read', () => {
    it('types into the program left running, pressing Enter and waiting 2s unless told otherwise', async () => {
        const { router, turn, commands } = setup();
        expect(await router.execute('terminal_send', { text: 'select 1;' }, turn(1))).toEqual({ text: 'Typed a line.', isError: false });
        await router.execute('terminal_send', { terminal: 'Pi (2)', text: 'q', enter: false, waitSecs: 300 }, turn(1));
        // Just Enter: accepting a prompt's default.
        await router.execute('terminal_send', { text: '' }, turn(1));
        expect(commands).toEqual([
            `type ${JSON.stringify({ text: 'select 1;', enter: true, waitMs: 2000 })}`,
            `type ${JSON.stringify({ terminal: 'Pi (2)', text: 'q', enter: false, waitMs: 30_000 })}`,
            `type ${JSON.stringify({ text: '', enter: true, waitMs: 2000 })}`,
        ]);
        expect((await router.execute('terminal_read', { terminal: 'Pi (2)' }, turn(1))).text).toBe('read Pi (2)');
        expect((await router.execute('terminal_read', {}, turn(1))).text).toBe('read latest');
    });

    it('sends nothing without text, or with nothing to type and no Enter', async () => {
        const { router, turn, commands } = setup();
        expect(await router.execute('terminal_send', {}, turn(1))).toEqual({ text: 'Missing text.', isError: true });
        expect((await router.execute('terminal_send', { text: 42 }, turn(1))).isError).toBe(true);
        expect(await router.execute('terminal_send', { text: '', enter: false }, turn(1))).toEqual({ text: expect.stringMatching(/Nothing to send/), isError: true });
        expect(commands).toEqual([]);
    });

    it('presses named keys after the text, without Enter unless asked', async () => {
        const { router, turn, commands } = setup();
        await router.execute('terminal_send', { text: '', keys: ['down', 'Down'] }, turn(1));
        await router.execute('terminal_send', { text: 'ab', keys: ['tab'], enter: true }, turn(1));
        await router.execute('terminal_send', { text: '', keys: ['esc', 'ctrl-c', 'Ctrl+D'] }, turn(1));
        expect(commands).toEqual([
            `type ${JSON.stringify({ text: '\x1b[B\x1b[B', enter: false, waitMs: 2000 })}`,
            `type ${JSON.stringify({ text: 'ab\t', enter: true, waitMs: 2000 })}`,
            `type ${JSON.stringify({ text: '\x1b\x03\x04', enter: false, waitMs: 2000 })}`,
        ]);
    });

    it('refuses unknown keys and sends nothing', async () => {
        const { router, turn, commands } = setup();
        expect(await router.execute('terminal_send', { text: '', keys: ['hyper'] }, turn(1))).toEqual({ text: expect.stringMatching(/Unknown key "hyper"/), isError: true });
        expect((await router.execute('terminal_send', { text: '', keys: 'down' }, turn(1))).isError).toBe(true);
        expect((await router.execute('terminal_send', { text: '', keys: ['ctrl-1'] }, turn(1))).isError).toBe(true);
        expect(commands).toEqual([]);
    });
});

describe('terminalKeys', () => {
    it('turns key names into what a terminal gets', () => {
        expect(terminalKeys(undefined)).toBe('');
        expect(terminalKeys(['up', 'down', 'right', 'left'])).toBe('\x1b[A\x1b[B\x1b[C\x1b[D');
        expect(terminalKeys(['space', 'enter', 'backspace', 'escape'])).toBe(' \r\x7f\x1b');
        expect(terminalKeys(['ctrl-a', 'control-z', 'CTRL + L'])).toBe('\x01\x1a\x0c');
    });

    it('does not take names from the object prototype', () => {
        expect(() => terminalKeys(['constructor'])).toThrow(/Unknown key/);
    });
});

describe('HostToolRouter: deleting files', () => {
    it('deletes only when the same request comes again in a later user turn', async () => {
        const { router, turn, edits } = setup();
        expect((await router.execute('delete_file', { path: 'a.ts' }, turn(1))).text).toMatch(/Not deleted yet.*the file a.ts/);
        expect((await router.execute('delete_file', { path: './a.ts' }, turn(1))).text).toMatch(/Not deleted yet/);
        expect(router.pendingDelete).toEqual({ path: 'a.ts', recursive: false });
        expect(edits).toEqual([]);
        expect((await router.execute('delete_file', { path: 'a.ts' }, turn(2))).text).toBe('deleted a.ts');
        expect([edits, router.pendingDelete]).toEqual([['delete a.ts'], undefined]);
    });

    it('starts over for another path or another recursive', async () => {
        const { router, turn, edits } = setup();
        await router.execute('delete_file', { path: 'a.ts' }, turn(1));
        expect((await router.execute('delete_file', { path: 'b.ts' }, turn(2))).text).toMatch(/Not deleted yet/);
        expect((await router.execute('delete_file', { path: 'b.ts', recursive: true }, turn(3))).text).toMatch(/Not deleted yet/);
        expect(edits).toEqual([]);
    });
});

describe('HostToolRouter: list_viewers / open_with', () => {
    it('lists and opens editors without touching files or running commands', async () => {
        const { router, turn, edits, commands, opened } = setup();
        const listed = await router.execute('list_viewers', { path: 'docs/flow.drawio' }, turn(1));
        expect(listed.isError).toBe(false);
        expect(listed.text).toMatch(/- diagrams\.editor: Diagram \[someone\.diagrams, default\]/);
        expect(listed.text).toMatch(/- default: Text Editor/);
        expect((await router.execute('open_with', { path: 'docs/flow.drawio', viewer: 'diagrams.editor', toSide: true }, turn(1))).isError).toBe(false);
        expect(opened).toEqual(['editor diagrams.editor docs/flow.drawio side']);
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

describe('HostToolRouter: permission levels', () => {
    const edit = { path: 'a.ts', oldText: 'x', newText: 'y' };

    it('in Plan refuses every change and command with a read-only message, but still reads and opens', async () => {
        const { worker, router, turn, edits, commands } = setup();
        worker.level = 'plan';
        const refused = await Promise.all([
            router.execute('edit_file', edit, turn(1)),
            router.execute('create_file', { path: 'b.ts', content: 'x' }, turn(1)),
            router.execute('create_folder', { path: 'dir' }, turn(1)),
            router.execute('rename_file', { from: 'a.ts', to: 'b.ts' }, turn(1)),
            router.execute('delete_file', { path: 'a.ts' }, turn(1)),
            router.execute('run_in_terminal', { command: 'rm -rf build' }, turn(1)),
        ]);
        for (const result of refused) {
            expect(result).toEqual({ text: expect.stringMatching(/read-only Plan mode/), isError: true });
        }
        // The deletion was not even asked about: nothing to confirm in a later turn.
        expect((await router.execute('delete_file', { path: 'a.ts' }, turn(2))).isError).toBe(true);
        expect([edits, commands, worker.approvals, router.pendingDelete]).toEqual([[], [], [], undefined]);
        expect((await router.execute('read_output', {}, turn(3))).isError).toBe(false);
        expect((await router.execute('open_file', { path: 'a.ts' }, turn(3))).isError).toBe(false);
    });

    /** Resolves once `count` more approval cards were answered and their outcome recorded. */
    function settled(router: HostToolRouter, count = 1): Promise<void> {
        let left = count;
        const { promise, resolve } = Promise.withResolvers<void>();
        router.onApprovalSettled = () => {
            if (--left === 0) resolve();
        };
        return promise;
    }

    it('in Manual returns at once so it can tell the user, and acts only once the card is approved', async () => {
        const { worker, router, turn, edits } = setup();
        worker.level = 'ask';
        let decide: (approved: boolean) => void = () => {};
        worker.approve = () => new Promise<boolean>((resolve) => (decide = resolve));

        const held = await router.execute('edit_file', edit, turn(1));
        expect(held).toEqual({ text: expect.stringMatching(/Waiting for the user's approval \(a1\).*Tell the user now/s), isError: false });
        expect(worker.approvals).toEqual([{ tabId: 'tab-1', toolName: 'edit_file', args: edit }]);
        expect(router.heldApprovals('tab-1')).toEqual([{ id: 'a1', tabId: 'tab-1', toolName: 'edit_file', summary: 'a.ts' }]);
        expect(edits).toEqual([]);

        const done = settled(router);
        decide(true);
        await done;
        expect([edits, router.heldApprovals('tab-1'), router.settledApprovalCount('tab-1')]).toEqual([['a.ts'], [], 1]);
        expect(router.takeSettledApprovals('tab-1')).toEqual([
            { id: 'a1', tabId: 'tab-1', toolName: 'edit_file', summary: 'a.ts', outcome: 'done', result: 'edited a.ts' },
        ]);
        // Handed out once.
        expect(router.settledApprovalCount('tab-1')).toBe(0);
    });

    it('in Manual does nothing when the card is rejected, or when the task went to Plan before it was approved', async () => {
        const { worker, router, turn, edits, commands } = setup();
        worker.level = 'ask';
        worker.approve = async () => false;
        const rejected = settled(router);
        await router.execute('run_in_terminal', { command: 'npm publish' }, turn(1));
        await rejected;
        expect(router.takeSettledApprovals('tab-1')).toMatchObject([{ toolName: 'run_in_terminal', summary: 'npm publish', outcome: 'rejected' }]);

        let decide: (approved: boolean) => void = () => {};
        worker.approve = () => new Promise<boolean>((resolve) => (decide = resolve));
        await router.execute('create_file', { path: 'b.ts', content: 'x' }, turn(2));
        worker.level = 'plan';
        const late = settled(router);
        decide(true);
        await late;
        expect(router.takeSettledApprovals('tab-1')).toMatchObject([{ toolName: 'create_file', outcome: 'failed', result: expect.stringMatching(/Plan mode/) }]);
        expect([edits, commands]).toEqual([[], []]);
    });

    it('in Manual keeps the two-turn delete confirmation and puts up the card only when it would delete', async () => {
        const { worker, router, turn, edits } = setup();
        worker.level = 'ask';
        worker.approve = async () => false;
        expect((await router.execute('delete_file', { path: 'a.ts' }, turn(1))).text).toMatch(/Not deleted yet/);
        expect(worker.approvals).toEqual([]);
        const rejected = settled(router);
        expect((await router.execute('delete_file', { path: 'a.ts' }, turn(2))).text).toMatch(/Waiting for the user's approval/);
        await rejected;
        expect([worker.approvals.map((a) => a.toolName), edits, router.pendingDelete]).toEqual([['delete_file'], [], undefined]);

        worker.approve = async () => true;
        await router.execute('delete_file', { path: 'a.ts' }, turn(3));
        const approved = settled(router);
        await router.execute('delete_file', { path: 'a.ts' }, turn(4));
        await approved;
        expect(router.takeSettledApprovals('tab-1').map((s) => [s.outcome, s.result])).toEqual([
            ['rejected', expect.any(String)],
            ['done', 'deleted a.ts'],
        ]);
        expect(edits).toEqual(['delete a.ts']);
    });

    it('in Auto acts at once without asking', async () => {
        const { worker, router, turn, edits, commands } = setup();
        worker.level = 'auto';
        await router.execute('edit_file', edit, turn(1));
        await router.execute('run_in_terminal', { command: 'ls' }, turn(1));
        expect([edits, commands, worker.approvals]).toEqual([['a.ts'], ['ls'], []]);
    });

    it('in Edit automatically changes files at once, but holds commands, deletions and moves for approval', async () => {
        const { worker, router, turn, edits, commands } = setup();
        worker.level = 'edit';
        worker.approve = async () => false;
        expect((await router.execute('edit_file', edit, turn(1))).text).toBe('edited a.ts');
        await router.execute('create_file', { path: 'b.ts', content: 'x' }, turn(1));
        expect([edits, worker.approvals]).toEqual([['a.ts', 'create b.ts'], []]);

        const answered = settled(router, 3);
        await router.execute('run_in_terminal', { command: 'npm publish' }, turn(1));
        await router.execute('rename_file', { from: 'a.ts', to: 'c.ts' }, turn(1));
        await router.execute('delete_file', { path: 'a.ts' }, turn(1));
        await router.execute('delete_file', { path: 'a.ts' }, turn(2));
        await answered;
        expect(router.takeSettledApprovals('tab-1').map((s) => [s.toolName, s.summary, s.outcome])).toEqual([
            ['run_in_terminal', 'npm publish', 'rejected'],
            ['rename_file', 'a.ts -> c.ts', 'rejected'],
            ['delete_file', 'a.ts', 'rejected'],
        ]);
        expect([edits, commands]).toEqual([['a.ts', 'create b.ts'], []]);
    });

    it('typing counts as running a command, reading does not', async () => {
        const { worker, router, turn, commands } = setup();
        worker.level = 'edit';
        worker.approve = async () => false;
        const rejected = settled(router);
        expect((await router.execute('terminal_send', { text: 'drop table users;' }, turn(1))).text).toMatch(/Waiting for the user's approval/);
        await rejected;
        expect(router.takeSettledApprovals('tab-1')).toMatchObject([{ toolName: 'terminal_send', summary: 'drop table users;', outcome: 'rejected' }]);
        expect((await router.execute('terminal_read', {}, turn(1))).text).toBe('read latest');

        worker.level = 'plan';
        expect(await router.execute('terminal_send', { text: 'select 1;' }, turn(2))).toEqual({ text: expect.stringMatching(/read-only Plan mode/), isError: true });
        expect((await router.execute('terminal_read', {}, turn(2))).isError).toBe(false);
        const proactive = { tabId: 'tab-1', seq: 2, userAt: 2000, proactive: true };
        worker.level = 'auto';
        expect((await router.execute('terminal_send', { text: 'select 1;' }, proactive)).isError).toBe(true);
        expect(commands).toEqual([]);
    });
});

describe('HostToolRouter: a tab showing the CLI TUI', () => {
    function tuiSetup() {
        const context = setup();
        context.worker.tui = true;
        return context;
    }

    it('keeps every file change out while its task runs: the TUI does not report which files it changes', async () => {
        const { worker, router, turn, edits } = tuiSetup();
        worker.phase = 'working';
        const refused = await router.execute('edit_file', { path: 'a.ts', oldText: 'x', newText: 'y' }, turn(1));
        expect(refused).toEqual({ text: expect.stringMatching(/still running a task and may be writing files/), isError: true });
        worker.phase = 'idle';
        expect((await router.execute('edit_file', { path: 'a.ts', oldText: 'x', newText: 'y' }, turn(1))).isError).toBe(false);
        expect(edits).toEqual(['a.ts']);
    });

    it('worker_status returns the state and the screen, reading as far back as asked, within bounds', async () => {
        const { worker, router, turn } = tuiSetup();
        worker.phase = 'working';
        const status = await router.execute('worker_status', {}, turn(1));
        expect(status.text).toBe("State: working. This tab shows the CLI's own TUI; its screen:\nomp TUI");
        await router.execute('worker_status', { pagesBack: 3 }, turn(1));
        await router.execute('worker_status', { pagesBack: 500 }, turn(1));
        await router.execute('worker_status', { pagesBack: -2 }, turn(1));
        expect(worker.screenReads).toEqual([0, 3, 20, 0]);
    });

    it('worker_status stays the activity report in a chat tab', async () => {
        const { worker, router, turn } = setup();
        expect((await router.execute('worker_status', {}, turn(1))).text).toMatch(/^State: idle\./);
        expect(worker.screenReads).toEqual([]);
    });

    it("answer_worker types the user's text and named keys, needs no request, and returns the screen", async () => {
        const { worker, router, turn } = tuiSetup();
        const answered = await router.execute('answer_worker', { value: 'y', keys: ['down', 'enter'] }, turn(2));
        expect(answered).toEqual({ text: 'Typed into the TUI. Its screen now:\nomp TUI', isError: false });
        expect(worker.typed).toEqual(['y\x1b[B\r']);
        expect(worker.answers).toEqual([]);
    });

    it('answer_worker refuses an empty answer and an unknown key, typing nothing', async () => {
        const { worker, router, turn } = tuiSetup();
        expect((await router.execute('answer_worker', {}, turn(2))).isError).toBe(true);
        expect((await router.execute('answer_worker', { keys: ['hyperspace'] }, turn(2))).isError).toBe(true);
        expect(worker.typed).toEqual([]);
    });

    it('answer_worker cannot answer for the user in a turn nobody started', async () => {
        const { worker, router } = tuiSetup();
        const result = await router.execute('answer_worker', { keys: ['enter'] }, { tabId: 'tab-1', seq: 1, userAt: 1000, proactive: true });
        expect(result.isError).toBe(true);
        expect(worker.typed).toEqual([]);
    });

    it('stop_worker presses the interrupt of a working TUI and says so, and leaves an idle one alone', async () => {
        const { worker, router, turn } = tuiSetup();
        expect((await router.execute('stop_worker', {}, turn(1))).text).toBe('The worker was already idle.');
        worker.phase = 'working';
        expect((await router.execute('stop_worker', {}, turn(1))).text).toContain('Pressed Escape');
        expect(worker.aborts).toBe(1);
    });

    it('tell_worker keeps the go-ahead for a new task in an idle TUI', async () => {
        const { worker, router, turn } = tuiSetup();
        await router.execute('tell_worker', { message: 'add a test', when: 'now' }, turn(1));
        expect(worker.sends).toEqual([]);
        const [proposal] = router.proposals('tab-1');
        await router.execute('confirm_task', { proposalId: proposal.id }, turn(2));
        expect(worker.sends.map((s) => s.text)).toEqual(['add a test']);
    });
});

describe('HostToolRouter: terminal_read', () => {
    it('passes how many screens back to read, within bounds', async () => {
        const { router, turn } = setup();
        expect((await router.execute('terminal_read', { pagesBack: 2 }, turn(1))).text).toBe('read latest 2 pages back');
        expect((await router.execute('terminal_read', { pagesBack: 99 }, turn(1))).text).toBe('read latest 20 pages back');
        expect((await router.execute('terminal_read', {}, turn(1))).text).toBe('read latest');
    });
});
