import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The shell execution end listener PairHands subscribes, so a test can end a command. */
const shell = vi.hoisted(() => ({
    endListeners: [] as ((e: { execution: unknown; exitCode: number | undefined }) => void)[],
}));

vi.mock('node:timers/promises', () => ({
    // Goes through the global setTimeout, which the fake timers control.
    setTimeout: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(value), ms);
            options?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
            });
        }),
}));

vi.mock('vscode', () => ({
    ThemeIcon: class {
        constructor(readonly id: string) {}
    },
    window: {
        onDidCloseTerminal: () => ({ dispose() {} }),
        onDidEndTerminalShellExecution: (listener: (e: { execution: unknown; exitCode: number | undefined }) => void) => {
            shell.endListeners.push(listener);
            return { dispose: () => shell.endListeners.splice(shell.endListeners.indexOf(listener), 1) };
        },
        createTerminal: () => terminal.current,
    },
}));

import { PairHands } from '../../../voiceAgent/pairHands';

/** One command's output stream: the test pushes chunks and ends it. */
class FakeExecution {
    private readonly _chunks: string[] = [];
    private _ended = false;
    private _wake: (() => void) | undefined;

    push(data: string): void {
        this._chunks.push(data);
        this._wake?.();
    }

    end(exitCode: number): void {
        this._ended = true;
        this._wake?.();
        for (const listener of [...shell.endListeners]) {
            listener({ execution: this, exitCode });
        }
    }

    async *read(): AsyncIterable<string> {
        for (;;) {
            if (this._chunks.length > 0) {
                yield this._chunks.shift()!;
                continue;
            }
            if (this._ended) {
                return;
            }
            await new Promise<void>((resolve) => (this._wake = resolve));
        }
    }
}

const terminal: { current: unknown } = { current: undefined };
let execution: FakeExecution;
let sent: { text: string; enter: boolean }[];

function hands(): PairHands {
    return new PairHands('/work', { onDidChangeFollowing: () => ({ dispose() {} }) } as never, {} as never, {} as never);
}

/** Lets the output reader and the polling loop see what just happened. */
async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
    vi.useFakeTimers();
    shell.endListeners.length = 0;
    execution = new FakeExecution();
    sent = [];
    terminal.current = {
        name: 'Pi',
        exitStatus: undefined,
        show() {},
        sendText(text: string, enter = true) {
            sent.push({ text, enter });
        },
        shellIntegration: { executeCommand: () => execution },
    };
});

afterEach(() => {
    vi.useRealTimers();
});

describe('PairHands.runInTerminal', () => {
    it('returns the exit code and output once the command ends', async () => {
        const result = hands().runInTerminal('npm test', 30_000);
        execution.push('212 passed\n');
        await advance(1000);
        execution.end(0);
        await advance(1000);
        const text = await result;
        expect(text).toMatch(/^Exit code 0\./);
        expect(text).toContain('212 passed');
    });

    it('returns early when the output has been quiet for 5 seconds, and leaves the command running', async () => {
        const pi = hands();
        let settled = false;
        const result = pi.runInTerminal('npx skills add x', 120_000).then((text) => {
            settled = true;
            return text;
        });
        execution.push('Which agents do you want to install to?\n');
        await advance(4000);
        expect(settled).toBe(false);
        await advance(1500);
        const text = await result;
        expect(text).toMatch(/quiet for 5s, so it may be waiting for input/);
        expect(text).toContain('Which agents do you want to install to?');
        // Still running: terminal_send can drive it.
        expect(await pi.readTerminal(undefined, 0)).toMatch(/still running/);
    });

    it('keeps waiting while output keeps coming, until the timeout', async () => {
        let settled = false;
        const result = hands()
            .runInTerminal('npm run build', 12_000)
            .then((text) => {
                settled = true;
                return text;
            });
        for (let i = 0; i < 11; i++) {
            execution.push(`step ${i}\n`);
            await advance(1000);
        }
        expect(settled).toBe(false);
        await advance(1500);
        const text = await result;
        expect(text).toMatch(/^Still running after 12s/);
        expect(text).toContain('step 10');
    });
});

describe('PairHands.sendToTerminal', () => {
    it('sends the text it is given, key sequences included, as is', async () => {
        const pi = hands();
        const started = pi.runInTerminal('npx skills add x', 60_000);
        execution.push('Installation scope\n');
        await advance(6000);
        await started;
        const typed = pi.sendToTerminal({ text: '\x1b[B', enter: false, waitMs: 2000 });
        execution.push('● Global\n');
        await advance(2500);
        expect(await typed).toContain('● Global');
        expect(sent).toEqual([{ text: '\x1b[B', enter: false }]);
    });
});

describe('PairHands: a program that draws a screen', () => {
    /** omp's TUI, roughly: the alternate screen, cleared, text placed by cursor position. */
    const TUI = '\x1b[?1049h\x1b[H\x1b[2J\x1b[1;1Homp v18\x1b[3;1H\x1b[1m> \x1b[0mfix the parser\x1b[5;1HAllow edit? \x1b[7mApprove\x1b[0m Deny';

    async function started(): Promise<{ pi: PairHands; text: string }> {
        const pi = hands();
        const result = pi.runInTerminal('omp', 120_000);
        execution.push(TUI);
        await advance(6000);
        return { pi, text: await result };
    }

    it('returns its screen as text, not the stream of cursor moves', async () => {
        const { text } = await started();
        expect(text).toContain('Its screen:\nomp v18\n\n> fix the parser\n\nAllow edit? Approve Deny');
        expect(text).not.toContain('\x1b');
    });

    it('terminal_read says when the screen has not changed, and shows it again once it has', async () => {
        const { pi } = await started();
        const unchanged = pi.readTerminal(undefined, 0);
        await advance(100);
        expect(await unchanged).toBe('"Pi" is still running. Its screen:\nNo change on the screen since you last read it.');
        execution.push('\x1b[5;1H\x1b[2KApproved.');
        const changed = pi.readTerminal(undefined, 0);
        await advance(100);
        expect(await changed).toContain('> fix the parser\n\nApproved.');
    });

    it('terminal_send returns the screen the program redrew', async () => {
        const { pi } = await started();
        const typed = pi.sendToTerminal({ text: '\r', enter: false, waitMs: 2000 });
        execution.push('\x1b[5;1H\x1b[2KApproved.');
        await advance(2500);
        expect(await typed).toContain('Its screen:\nomp v18\n\n> fix the parser\n\nApproved.');
    });

    it('reads further up a full-screen program by paging it up and back down', async () => {
        const { pi } = await started();
        const read = pi.readTerminal(undefined, 2);
        await advance(5000);
        expect(await read).toContain('pressed PageUp 2 times');
        expect(sent).toEqual([{ text: '\x1b[5~\x1b[5~', enter: false }, { text: '\x1b[6~\x1b[6~', enter: false }]);
    });
});
