import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_CHANGE, ScreenReader, drawsScreen, screenSnapshot, screenText, watchScreenText } from '../../../pi/terminalScreen';

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';

let term: Terminal;
let sent: string[];

/** The emulator parses writes in later ticks: runs them, and any wait of the reader, on the fake clock. */
async function run<T>(work: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(5000);
    return work;
}

function write(data: string): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    term.write(data, resolve);
    return run(promise);
}

beforeEach(() => {
    vi.useFakeTimers();
    term = new Terminal({ cols: 12, rows: 4, scrollback: 100, allowProposedApi: true });
    sent = [];
});

afterEach(() => {
    term.dispose();
    vi.useRealTimers();
});

describe('screenText', () => {
    it('drops trailing spaces and the blank rows at the bottom, and joins a row wrapped onto the next', async () => {
        await write('hi   \r\n\r\nabcdefghijklmnop');
        expect(screenText(term)).toBe('hi\n\nabcdefghijklmnop');
    });

    it('is the visible rows only once earlier lines scrolled into the scrollback', async () => {
        await write('1\r\n2\r\n3\r\n4\r\n5\r\n6');
        expect(screenText(term)).toBe('3\n4\n5\n6');
    });
});

describe('screenSnapshot', () => {
    it('keeps what is drawn on a background color in place, blanking the rest, line for line with the text', async () => {
        await write(' \x1b[48;5;24m a \x1b[0m  \x1b[38;5;9m b \x1b[0m\r\nnext\r\n\x1b[44m 界x\x1b[0my');
        const { text, highlight } = screenSnapshot(term);
        expect(text).toBe('  a    b\nnext\n 界xy');
        expect(highlight).toBe('  a\n\n 界x');
        expect(highlight.split('\n').map((line) => line.length)).toEqual([3, 0, 3]);
    });

    it('has as many lines as the text when blank rows at the bottom are dropped', async () => {
        await write('one\r\n\x1b[41m  \x1b[0m');
        expect(screenSnapshot(term)).toEqual({ text: 'one', highlight: '' });
    });
});

describe('drawsScreen', () => {
    it('tells a program that draws a screen from one that prints lines', () => {
        for (const drawing of ['\x1b[?1049h', '\x1b[H', '\x1b[12;40H', '\x1b[2J', '\x1b[3A', '\x1b[5d']) {
            expect(drawsScreen(`text${drawing}more`)).toBe(true);
        }
        for (const printing of ['plain\r\nlines\n', '\x1b[1;32mok\x1b[0m', 'progress 40%\rprogress 80%', '\x1b[2K\rline', '\x1b[?25l\x1b[?25h']) {
            expect(drawsScreen(printing)).toBe(false);
        }
    });
});

/** What omp redraws while its approval dialog waits: the same words, their colors shifted along (from a PTY capture). */
const shimmer = (i: number) =>
    `\x1b[?25l\x1b[?2026h\x1b[1;1H\x1b[0m\x1b[K\x1b[38;2;107;114;128mRun${'ning'.slice(0, i % 4)}\x1b[39;1;38;2;0;180;255m${'ning'.slice(i % 4)}\x1b[22;39m\x1b[?2026l`;

describe('watchScreenText', () => {
    it('fires when the text on the screen changes, not when a redraw only restyles it', async () => {
        let changes = 0;
        const watch = watchScreenText(term, () => changes++);
        await write(shimmer(0));
        expect(changes).toBe(1);
        for (let i = 1; i < 8; i++) {
            await write(shimmer(i));
        }
        expect(changes).toBe(1);
        await write('\x1b[2;1H⠋ 3s');
        await write('\x1b[2;1H⠙ 3s');
        expect(changes).toBe(3);
        watch.dispose();
        await write('\x1b[2;1H⠹ 4s');
        expect(changes).toBe(3);
    });
});

describe('ScreenReader', () => {
    const reader = (onKeys: (keys: string) => void = () => {}) =>
        new ScreenReader(term, (keys) => {
            sent.push(keys);
            onKeys(keys);
        }, { quietMs: 100, maxWaitMs: 1000 });

    it('reads the screen, then says there is no change until it changes', async () => {
        const screen = reader();
        await write('ready');
        expect(await run(screen.read())).toBe('ready');
        expect(await run(screen.read())).toBe(NO_CHANGE);
        await write('\r\nworking');
        expect(await run(screen.read())).toBe('ready\nworking');
    });

    it('does not count a notification tail as a read', async () => {
        const screen = reader();
        await write('a\r\nb\r\nc');
        expect(await run(screen.tail(2))).toBe('b\nc');
        expect(await run(screen.read())).toBe('a\nb\nc');
    });

    it('scrolls back through the scrollback without sending the program anything', async () => {
        const screen = reader();
        await write(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\r\n'));
        expect(await run(screen.read(1))).toBe('The 4 lines above the screen:\nline 3\nline 4\nline 5\nline 6');
        expect(await run(screen.read(5))).toBe('The 6 lines above the screen, from the first one the terminal kept:\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6');
        expect(sent).toEqual([]);
        expect(await run(screen.read())).toBe('line 7\nline 8\nline 9\nline 10');
    });

    it('says so when nothing is above the screen', async () => {
        const screen = reader();
        await write('only this');
        expect(await run(screen.read(2))).toBe('Nothing above the screen: the terminal has kept no earlier lines.');
    });

    it('pages a full-screen program up, reads it, and pages it back down', async () => {
        const pages = ['\x1b[H\x1b[2Jpage 2 of 2', '\x1b[H\x1b[2Jpage 1 of 2'];
        let page = 0;
        const screen = reader((keys) => {
            page = keys === PAGE_UP.repeat(1) ? 1 : 0;
            term.write(pages[page]);
        });
        await write(`\x1b[?1049h${pages[0]}`);
        const read = await run(screen.read(1));
        expect(read).toContain('pressed PageUp 1 times');
        expect(read.endsWith('It showed:\npage 1 of 2')).toBe(true);
        expect(sent).toEqual([PAGE_UP, PAGE_DOWN]);
        expect(await run(screen.read())).toBe('page 2 of 2');
    });

    it('types keys and returns the screen the program redrew', async () => {
        const screen = reader((keys) => term.write(keys === '\r' ? '\r\nApproved' : ''));
        await write('Allow? (y/n)');
        expect(await run(screen.read())).toBe('Allow? (y/n)');
        expect(await run(screen.type('\r'))).toBe('Allow? (y/n)\nApproved');
        expect(sent).toEqual(['\r']);
    });

    it('still reads after waiting out a program that does not react to the keys', async () => {
        const screen = reader();
        await write('frozen');
        expect(await run(screen.type('x'))).toBe('frozen');
    });

    it('reads a program that answered the keys as soon as its text settles, though it keeps restyling', async () => {
        const screen = reader((keys) => {
            if (keys === '\r') term.write('\x1b[2;1HApproved');
        });
        await write(shimmer(0));
        // On the fake clock: the restyling goes on the whole time.
        let i = 0;
        const restyle = setInterval(() => term.write(shimmer(++i)), 30);
        let result: string | undefined;
        void screen.type('\r').then((text) => (result = text));
        await vi.advanceTimersByTimeAsync(400);
        clearInterval(restyle);
        expect(result).toBe('Running\nApproved');
    });

    it('peeks and presses without counting as a read, so the next read still shows the whole screen', async () => {
        const screen = reader((keys) => term.write(keys === '\x1b[B' ? '\x1b[2;1H> two' : ''));
        await write('> one\r\n  two');
        expect(await run(screen.read())).toBe('> one\n  two');
        expect((await run(screen.peek())).text).toBe('> one\n  two');
        expect((await run(screen.press('\x1b[B'))).text).toBe('> one\n> two');
        expect(sent).toEqual(['\x1b[B']);
        expect(await run(screen.read())).toBe('> one\n> two');
    });
});
