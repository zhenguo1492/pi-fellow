import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalScreen } from '../../../pi/terminalScreen';
import type { TuiProcessOptions } from '../../../pi/tuiTerminal';
import { DIALOG_CHECK_MS, TabTuis, tuiPromptKeys, type TabTui, type TuiLaunch, type TuiMessage } from '../../../providers/sidebarTui';

/** Stands in for a PTY-backed TuiProcess: `emit`/`exit` play the CLI's side. */
class FakeTui implements TabTui {
    exited = false;
    title = '';
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
    screen(): TerminalScreen {
        const text = async () => 'screen';
        const snapshot = async () => ({ text: 'screen', highlight: '' });
        return { read: text, type: text, tail: text, peek: snapshot, press: snapshot };
    }
    /** Like TuiProcess: killing the PTY reports its exit. */
    async dispose(): Promise<void> {
        this.disposed = true;
        if (!this.exited) this.exit(143);
    }
    emit(data: string): void {
        this._options.onData(data);
    }
    /** Output that changed the screen's text (the real TUI's headless mirror decides that). */
    draw(): void {
        this._options.onScreenChange();
    }
    setTitle(title: string): void {
        this.title = title;
        this._options.onTitleChange();
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
    /** Tabs whose screen the dialog cards were asked to look at again, in order. */
    const checks: string[] = [];
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
        screenChanged: (tabId) => checks.push(tabId),
    });
    return { tuis, procs, posted, log, wanted, fileBusy, busy, checks };
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
            screenChanged: () => undefined,
        });

        await tuis.start('tab-1', launch());

        expect(log).toHaveBeenCalledWith('TUI start failed: omp not found');
        expect(posted).toEqual([
            { type: 'tuiData', tabId: 'tab-1', data: '\r\n\x1b[31mTUI start failed: omp not found\x1b[0m\r\n' },
        ]);
    });

    it('reports a run while the file says so and the TUI draws; an interrupt with no file entry ends when it goes still', async () => {
        const { tuis, procs, fileBusy, busy } = setup();
        await tuis.start('tab-1', launch());
        const file = fileBusy.get('/s/a.jsonl')!;

        procs[0].draw();
        file(true);
        expect(busy).toEqual([['tab-1', true]]);

        // Spinner keeps it working past the quiet limit.
        for (let i = 0; i < 10; i++) {
            vi.advanceTimersByTime(1000);
            procs[0].draw();
        }
        expect(busy).toEqual([['tab-1', true]]);

        // Esc: the TUI stops drawing but the file never records the end.
        vi.advanceTimersByTime(3000);
        expect(busy).toEqual([['tab-1', true], ['tab-1', false]]);

        // Drawing again while the file still shows the run: working again; the file's end ends it.
        procs[0].draw();
        file(false);
        expect(busy).toEqual([['tab-1', true], ['tab-1', false], ['tab-1', true], ['tab-1', false]]);
    });

    it('ends the run while the TUI waits on an approval dialog, though it keeps restyling the screen', async () => {
        const { tuis, procs, fileBusy, busy } = setup();
        await tuis.start('tab-1', launch());
        procs[0].draw();
        // The model called a tool: the file says the run is on until its result is written.
        fileBusy.get('/s/a.jsonl')!(true);
        expect(busy).toEqual([['tab-1', true]]);

        // "Allow tool: bash": omp animates the colors of its status line, bytes but no new text.
        for (let i = 0; i < 40; i++) {
            vi.advanceTimersByTime(100);
            procs[0].emit('\x1b[20;1H\x1b[38;2;107;114;128mRunning\x1b[39m');
        }
        expect(busy).toEqual([['tab-1', true], ['tab-1', false]]);

        // Approved: the tool runs and the spinner turns again.
        procs[0].draw();
        expect(busy).toEqual([['tab-1', true], ['tab-1', false], ['tab-1', true]]);
    });

    it('ends the run and stops following the file when the TUI stops', async () => {
        const { tuis, procs, fileBusy, busy } = setup();
        await tuis.start('tab-1', launch());
        procs[0].draw();
        fileBusy.get('/s/a.jsonl')!(true);

        await tuis.stop('tab-1');
        expect(busy).toEqual([['tab-1', true], ['tab-1', false]]);
        expect(fileBusy.size).toBe(0);
    });
});

describe('TabTuis: when the dialog cards look at the screen again', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('once after a burst of drawing, never before its last change', async () => {
        const { tuis, procs, checks } = setup();
        await tuis.start('tab-1', launch());
        procs[0].draw();
        vi.advanceTimersByTime(DIALOG_CHECK_MS - 100);
        procs[0].draw();
        expect(checks).toEqual([]);
        vi.advanceTimersByTime(100);
        expect(checks).toEqual(['tab-1']);
        vi.advanceTimersByTime(DIALOG_CHECK_MS * 4);
        expect(checks).toEqual(['tab-1']);
    });

    it('at most every DIALOG_CHECK_MS while the TUI keeps drawing, so a closed dialog is seen while it works again', async () => {
        const { tuis, procs, checks } = setup();
        await tuis.start('tab-1', launch());
        for (let i = 0; i < 20; i++) {
            procs[0].draw();
            vi.advanceTimersByTime(100);
        }
        expect(checks).toEqual(['tab-1', 'tab-1', 'tab-1', 'tab-1']);
    });

    it("when the TUI sets its title (omp's attention state), and at once when it stops or exits", async () => {
        const { tuis, procs, checks } = setup();
        await tuis.start('tab-1', launch());
        await tuis.start('tab-2', launch({ sessionFile: '/s/b.jsonl' }));
        procs[0].setTitle('π ! probe');
        vi.advanceTimersByTime(DIALOG_CHECK_MS);
        expect(checks).toEqual(['tab-1']);

        procs[0].draw();
        await tuis.stop('tab-1');
        procs[1].exit(1);
        expect(checks).toEqual(['tab-1', 'tab-1', 'tab-2']);
        // The check the drawing had scheduled was replaced by the one at the stop.
        vi.advanceTimersByTime(DIALOG_CHECK_MS);
        expect(checks).toEqual(['tab-1', 'tab-1', 'tab-2']);
    });
});

describe('tuiPromptKeys', () => {
    const PASTE = '\x1b[200~fix it\nthen test\x1b[201~';

    it('pastes the prompt, newlines kept inside the paste, and submits it with Enter', () => {
        for (const backend of ['omp', 'pi'] as const) {
            expect(tuiPromptKeys('fix it\nthen test', backend, false, false)).toBe(`${PASTE}\r`);
        }
    });

    it("queues a follow-up with each CLI's key: Ctrl+Q in omp, Alt+Enter in pi, Ctrl+Q in pi on Windows", () => {
        expect(tuiPromptKeys('fix it\nthen test', 'omp', true, false)).toBe(`${PASTE}\x11`);
        expect(tuiPromptKeys('fix it\nthen test', 'pi', true, false)).toBe(`${PASTE}\x1b\r`);
        expect(tuiPromptKeys('fix it\nthen test', 'pi', true, true)).toBe(`${PASTE}\x11`);
    });

    it('drops paste markers inside the text, so it cannot end the paste early and type the rest as keys', () => {
        expect(tuiPromptKeys('a\x1b[201~\rb\x1b[200~', 'omp', false, false)).toBe('\x1b[200~a\rb\x1b[201~\r');
    });
});
