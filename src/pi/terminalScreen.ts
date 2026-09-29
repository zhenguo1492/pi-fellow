import type { IDisposable, Terminal } from '@xterm/headless';

/**
 * What the voice agent sees of a terminal program (a chat tab's TUI, a program left running in a Pi
 * terminal): the screen of an in-memory emulator fed with the program's output, as text.
 */

/** What a terminal gets for PageUp and PageDown (terminal_send's `pageup` / `pagedown`). */
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';

/** read() when the screen is what the previous read returned. */
export const NO_CHANGE = 'No change on the screen since you last read it.';

export interface ScreenTiming {
    /** Output quiet this long after keys were sent: the program has redrawn. */
    quietMs: number;
    /** Longest wait for a program that does not react to the keys. */
    maxWaitMs: number;
}

/** What a screen's users get: reading, typing, a tail for notifications, and peeking and pressing for dialog cards. */
export type TerminalScreen = Pick<ScreenReader, 'read' | 'type' | 'tail' | 'peek' | 'press'>;

const DEFAULT_TIMING: ScreenTiming = { quietMs: 150, maxWaitMs: 1500 };
const POLL_MS = 25;

/**
 * Rows [from, to) of the active buffer as lines: a row soft-wrapped onto the next is joined with it,
 * trailing spaces are dropped.
 */
function bufferLines(term: Terminal, from: number, to: number): string[] {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let y = from; y < to; y++) {
        const row = buffer.getLine(y);
        const text = row?.translateToString(false) ?? '';
        if (row?.isWrapped && lines.length > 0) {
            lines[lines.length - 1] += text;
        } else {
            lines.push(text);
        }
    }
    return lines.map((line) => line.trimEnd());
}

function dropBlankTail(lines: string[]): string[] {
    let end = lines.length;
    while (end > 0 && lines[end - 1] === '') {
        end--;
    }
    return lines.slice(0, end);
}

/** The visible screen as text: trailing spaces and the blank rows at the bottom dropped. */
export function screenText(term: Terminal): string {
    const { baseY } = term.buffer.active;
    return dropBlankTail(bufferLines(term, baseY, baseY + term.rows)).join('\n');
}

/**
 * The visible screen as `text`, and `highlight`: the same lines, character for character, keeping only
 * what is drawn on a background color and blanking the rest. It shows what a TUI marks with a background
 * alone, such as the active tab of omp's ask panel (`  color    fruit    Submit` → `  color`).
 */
export interface ScreenSnapshot {
    text: string;
    highlight: string;
}

export function screenSnapshot(term: Terminal): ScreenSnapshot {
    const buffer = term.buffer.active;
    const cell = buffer.getNullCell();
    const text: string[] = [];
    const highlight: string[] = [];
    for (let y = buffer.baseY; y < buffer.baseY + term.rows; y++) {
        const row = buffer.getLine(y);
        let rowText = '';
        let rowHighlight = '';
        for (let x = 0; row && x < term.cols; x++) {
            row.getCell(x, cell);
            // The second half of a wide character: translateToString adds nothing for it either.
            if (cell.getWidth() === 0) continue;
            const chars = cell.getChars() || ' ';
            rowText += chars;
            rowHighlight += cell.isBgDefault() ? ' '.repeat(chars.length) : chars;
        }
        if (row?.isWrapped && text.length > 0) {
            text[text.length - 1] += rowText;
            highlight[highlight.length - 1] += rowHighlight;
        } else {
            text.push(rowText);
            highlight.push(rowHighlight);
        }
    }
    const lines = dropBlankTail(text.map((line) => line.trimEnd()));
    return { text: lines.join('\n'), highlight: highlight.slice(0, lines.length).map((line) => line.trimEnd()).join('\n') };
}

/**
 * Calls `onChange` each time parsed output changes the screen's text. Redraws that only restyle it do
 * not count: omp animates the colors of its status line while it waits on an approval dialog, a steady
 * stream of output with nothing new to read, while a working TUI's spinner and timer change the text.
 */
export function watchScreenText(term: Terminal, onChange: () => void): IDisposable {
    let last = screenText(term);
    return term.onWriteParsed(() => {
        const text = screenText(term);
        if (text !== last) {
            last = text;
            onChange();
        }
    });
}

/**
 * Whether a stretch of raw output draws a screen rather than printing lines: it switches to the
 * alternate screen, or moves the cursor up or to a row. `\r` rewrites (progress bars) and erasing a
 * line do not count: line-by-line cleanup reads those fine.
 */
export function drawsScreen(output: string): boolean {
    return /\x1b\[(?:\?(?:1049|1047|47)h|\d*(?:;\d*)?[Hf]|\d*[AJ]|\d+d)/.test(output);
}

/**
 * Reads one emulator's screen for the voice agent. Remembers what it last returned, so asking again
 * about an unchanged screen says so instead of repeating it.
 */
export class ScreenReader {
    private _lastRead: string | undefined;
    /** When output last changed the screen's text: the program has redrawn with something new. */
    private _lastOutputAt = 0;
    private readonly _subscription: IDisposable;

    constructor(
        private readonly _term: Terminal,
        /** Types into the program (keys go to the process, not the emulator). */
        private readonly _sendKeys: (keys: string) => void,
        private readonly _timing: ScreenTiming = DEFAULT_TIMING,
    ) {
        this._subscription = watchScreenText(_term, () => {
            this._lastOutputAt = Date.now();
        });
    }

    /**
     * `pagesBack` 0: the screen, or NO_CHANGE when it is what the last such read returned. More: that
     * many screens above it, from the emulator's scrollback, which does not move the user's view. A
     * full-screen program (alternate screen) leaves no scrollback: it gets PageUp that many times,
     * is read, then gets PageDown as often to go back.
     */
    async read(pagesBack = 0): Promise<string> {
        await this._parsed();
        if (pagesBack <= 0) {
            const text = screenText(this._term);
            if (text === this._lastRead) {
                return NO_CHANGE;
            }
            this._lastRead = text;
            return text || '(the screen is blank)';
        }
        const buffer = this._term.buffer.active;
        if (buffer.type === 'normal') {
            const from = Math.max(0, buffer.baseY - pagesBack * this._term.rows);
            const above = dropBlankTail(bufferLines(this._term, from, buffer.baseY));
            if (above.length === 0) {
                return 'Nothing above the screen: the terminal has kept no earlier lines.';
            }
            const start = from === 0 ? ', from the first one the terminal kept' : '';
            return `The ${above.length} lines above the screen${start}:\n${above.join('\n')}`;
        }
        this._sendKeys(PAGE_UP.repeat(pagesBack));
        await this._settle();
        const text = screenText(this._term);
        this._sendKeys(PAGE_DOWN.repeat(pagesBack));
        await this._settle();
        return (
            `A full-screen program, which keeps no scrollback: pressed PageUp ${pagesBack} times, read the screen, ` +
            `and pressed PageDown as often to go back. It showed:\n${text || '(a blank screen)'}`
        );
    }

    /** Types `keys`, waits for the program to redraw, and reads the screen (as read() does). */
    async type(keys: string): Promise<string> {
        this._sendKeys(keys);
        await this._settle();
        return this.read();
    }

    /**
     * The screen's last `count` lines once output has been quiet for a moment, for a notification; not a
     * read, so the next read still shows the whole screen.
     */
    async tail(count: number): Promise<string> {
        await this._settle(0);
        return screenText(this._term).split('\n').slice(-count).join('\n');
    }

    /** The whole screen now, with its highlight; not a read (no "no change" bookkeeping). For the TUI's dialog cards. */
    async peek(): Promise<ScreenSnapshot> {
        await this._parsed();
        return screenSnapshot(this._term);
    }

    /** Types `keys`, waits for the program to redraw, and returns the screen as peek() does. */
    async press(keys: string): Promise<ScreenSnapshot> {
        this._sendKeys(keys);
        await this._settle();
        return this.peek();
    }

    dispose(): void {
        this._subscription.dispose();
    }

    /** Resolves once everything written so far is parsed: the emulator parses writes in later ticks. */
    private _parsed(): Promise<void> {
        const { promise, resolve } = Promise.withResolvers<void>();
        this._term.write('', resolve);
        return promise;
    }

    /** Output since `since` has been quiet for `quietMs`, or `maxWaitMs` passed without any. */
    private async _settle(since = Date.now()): Promise<void> {
        const start = Date.now();
        const { quietMs, maxWaitMs } = this._timing;
        while (Date.now() - start < maxWaitMs) {
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, POLL_MS);
            await promise;
            if (this._lastOutputAt >= since && Date.now() - this._lastOutputAt >= quietMs) {
                break;
            }
        }
        await this._parsed();
    }
}
