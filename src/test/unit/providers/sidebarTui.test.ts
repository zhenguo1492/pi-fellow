import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TuiProcessOptions } from '../../../pi/tuiTerminal';
import { TabTuis, type TabTui, type TuiLaunch, type TuiMessage } from '../../../providers/sidebarTui';

/** Stands in for a PTY-backed TuiProcess: `emit`/`exit` play the CLI's side. */
class FakeTui implements TabTui {
    exited = false;
    readonly resized: [number, number][] = [];
    readonly typed: string[] = [];
    disposed = false;

    constructor(private readonly _options: TuiProcessOptions) {}

    get cwd(): string {
        return this._options.cwd;
    }
    get backend() {
        return this._options.backend ?? 'pi';
    }
    get sessionFile(): string | undefined {
        return this._options.sessionFile;
    }
    write(): void {}
    resize(cols: number, rows: number): void {
        this.resized.push([cols, rows]);
    }
    async typeWhenReady(text: string): Promise<void> {
        this.typed.push(text);
    }
    async snapshot(): Promise<string> {
        return `screen of ${this.sessionFile}`;
    }
    /** Like TuiProcess: killing the PTY reports its exit. */
    async dispose(): Promise<void> {
        this.disposed = true;
        if (!this.exited) this.exit(143);
    }
    emit(data: string): void {
        this._options.onData(data);
    }
    exit(code: number): void {
        this.exited = true;
        this._options.onExit(code);
    }
}

function launch(overrides: Partial<TuiLaunch> = {}): TuiLaunch {
    return { cwd: '/work', sessionFile: '/s/a.jsonl', backend: 'omp', cols: 80, rows: 24, replace: false, ...overrides };
}

function setup() {
    const procs: FakeTui[] = [];
    const posted: TuiMessage[] = [];
    const log = vi.fn();
    const wanted = new Set(['tab-1', 'tab-2']);
    /** Plays the session file: what it says about the run of the TUI launched on each file. */
    const fileBusy = new Map<string, (busy: boolean) => void>();
    const busy: [string, boolean][] = [];
    const tuis = new TabTuis({
        start: async (options) => {
            const proc = new FakeTui(options);
            procs.push(proc);
            return proc;
        },
        post: (message) => posted.push(message),
        log,
        wanted: (tabId) => wanted.has(tabId),
        watchSession: (sessionFile, onBusy) => {
            fileBusy.set(sessionFile, onBusy);
            return { dispose: () => fileBusy.delete(sessionFile) };
        },
        busyChanged: (tabId, value) => busy.push([tabId, value]),
    });
    return { tuis, procs, posted, log, wanted, fileBusy, busy };
}

describe('TabTuis', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces PTY output into one message per tab per flush', async () => {
        const { tuis, procs, posted } = setup();
        await tuis.start('tab-1', launch());
        await tuis.start('tab-2', launch());

        procs[0].emit('a');
        procs[1].emit('x');
        procs[0].emit('b');
        expect(posted).toEqual([]);

        vi.advanceTimersByTime(4);
        expect(posted).toEqual([
            { type: 'tuiData', tabId: 'tab-1', data: 'ab' },
            { type: 'tuiData', tabId: 'tab-2', data: 'x' },
        ]);
    });

    it('flushes pending output before reporting an exit, and repeats the exit on resync until restarted', async () => {
        const { tuis, procs, posted } = setup();
        await tuis.start('tab-1', launch());

        procs[0].emit('bye');
        procs[0].exit(1);
        expect(posted).toEqual([
            { type: 'tuiData', tabId: 'tab-1', data: 'bye' },
            { type: 'tuiExit', tabId: 'tab-1', exitCode: 1 },
        ]);
        expect(tuis.get('tab-1')).toBeUndefined();

        posted.length = 0;
        tuis.resync();
        expect(posted).toEqual([{ type: 'tuiExit', tabId: 'tab-1', exitCode: 1 }]);

        await tuis.start('tab-1', launch());
        posted.length = 0;
        tuis.resync();
        await vi.runAllTimersAsync();
        expect(posted).toEqual([{ type: 'tuiSnapshot', tabId: 'tab-1', data: 'screen of /s/a.jsonl' }]);
    });

    it('reports nothing for a TUI stopped on purpose', async () => {
        const { tuis, procs, posted } = setup();
        await tuis.start('tab-1', launch());
        await tuis.start('tab-2', launch());

        expect(await tuis.stopAll()).toEqual(['tab-1', 'tab-2']);
        expect(procs.every((p) => p.disposed)).toBe(true);
        tuis.resync();
        expect(posted).toEqual([]);
    });

    it('re-attaches a new terminal view to the running TUI: resize and a snapshot that supersedes queued output', async () => {
        const { tuis, procs, posted } = setup();
        await tuis.start('tab-1', launch());
        procs[0].emit('already mirrored');

        await tuis.start('tab-1', launch({ cols: 120, rows: 40 }));
        await vi.runAllTimersAsync();

        expect(procs).toHaveLength(1);
        expect(procs[0].resized).toEqual([[120, 40]]);
        expect(posted).toEqual([{ type: 'tuiSnapshot', tabId: 'tab-1', data: 'screen of /s/a.jsonl' }]);
    });

    it('replaces the running TUI when resuming another session', async () => {
        const { tuis, procs, posted } = setup();
        await tuis.start('tab-1', launch());

        await tuis.start('tab-1', launch({ sessionFile: '/s/b.jsonl', replace: true }));

        expect(procs).toHaveLength(2);
        expect(procs[0].disposed).toBe(true);
        expect(tuis.get('tab-1')).toBe(procs[1]);
        expect(tuis.get('tab-1')?.sessionFile).toBe('/s/b.jsonl');
        expect(posted.filter((m) => m.type === 'tuiExit')).toEqual([]);
    });

    it('ignores a second start while the first is still starting', async () => {
        const { tuis, procs } = setup();
        const first = tuis.start('tab-1', launch());
        const second = tuis.start('tab-1', launch());
        await Promise.all([first, second]);
        expect(procs).toHaveLength(1);
    });

    it('drops a TUI that finished starting after its tab closed, keeping keys queued for the next start', async () => {
        const { tuis, procs, wanted } = setup();
        tuis.typeOnStart('tab-1', '/login\r');
        wanted.delete('tab-1');

        await tuis.start('tab-1', launch());
        expect(procs[0].disposed).toBe(true);
        expect(tuis.get('tab-1')).toBeUndefined();
        expect(procs[0].typed).toEqual([]);

        wanted.add('tab-1');
        await tuis.start('tab-1', launch());
        expect(procs[1].typed).toEqual(['/login\r']);

        // Typed once: a later restart does not repeat it.
        await tuis.start('tab-1', launch({ replace: true }));
        expect(procs[2].typed).toEqual([]);
    });

    it('shows a start failure in the terminal view', async () => {
        const posted: TuiMessage[] = [];
        const log = vi.fn();
        const tuis = new TabTuis({
            start: async () => {
                throw new Error('omp not found');
            },
            post: (message) => posted.push(message),
            log,
            wanted: () => true,
            watchSession: () => ({ dispose: () => undefined }),
            busyChanged: () => undefined,
        });

        await tuis.start('tab-1', launch());

        expect(log).toHaveBeenCalledWith('TUI start failed: omp not found');
        expect(posted).toEqual([
            { type: 'tuiData', tabId: 'tab-1', data: '\r\n\x1b[31mTUI start failed: omp not found\x1b[0m\r\n' },
        ]);
    });

    it('reports a run while the file says so and the TUI redraws; an interrupt with no file entry ends when it goes quiet', async () => {
        const { tuis, procs, fileBusy, busy } = setup();
        await tuis.start('tab-1', launch());
        const file = fileBusy.get('/s/a.jsonl')!;

        procs[0].emit('spinner');
        file(true);
        expect(busy).toEqual([['tab-1', true]]);

        // Spinner keeps it working past the quiet limit.
        for (let i = 0; i < 10; i++) {
            vi.advanceTimersByTime(1000);
            procs[0].emit('spinner');
        }
        expect(busy).toEqual([['tab-1', true]]);

        // Esc: the TUI stops drawing but the file never records the end.
        vi.advanceTimersByTime(3000);
        expect(busy).toEqual([['tab-1', true], ['tab-1', false]]);

        // Drawing again while the file still shows the run: working again; the file's end ends it.
        procs[0].emit('spinner');
        file(false);
        expect(busy).toEqual([['tab-1', true], ['tab-1', false], ['tab-1', true], ['tab-1', false]]);
    });

    it('ends the run and stops following the file when the TUI stops', async () => {
        const { tuis, procs, fileBusy, busy } = setup();
        await tuis.start('tab-1', launch());
        procs[0].emit('spinner');
        fileBusy.get('/s/a.jsonl')!(true);

        await tuis.stop('tab-1');
        expect(busy).toEqual([['tab-1', true], ['tab-1', false]]);
        expect(fileBusy.size).toBe(0);
    });
});
