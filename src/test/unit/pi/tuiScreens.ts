import * as fs from 'node:fs';
import * as path from 'node:path';
import { Terminal } from '@xterm/headless';
import { screenSnapshot, type ScreenSnapshot } from '../../../pi/terminalScreen';

/**
 * Screens captured from omp 18.2.11 and pi 0.87.1 in a 100x30 PTY (src/test/unit/pi/fixtures/tuiDialogs).
 * `.txt`: the screen's text (screenText). `.ans`: the screen serialized with its colors (SerializeAddon),
 * for what only colors show, such as the ask panel's active tab.
 */
const DIR = path.resolve('src/test/unit/pi/fixtures/tuiDialogs');

export function screenTextOf(name: string): string {
    return fs.readFileSync(path.join(DIR, `${name}.txt`), 'utf8');
}

/** A text fixture as a screen without its colors. */
export function textScreen(name: string): { text: string } {
    return { text: screenTextOf(name) };
}

/** A colored fixture replayed into a terminal the size it was captured at, read as the dialog cards read it. */
export async function coloredScreen(name: string): Promise<ScreenSnapshot> {
    const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
    const { promise, resolve } = Promise.withResolvers<void>();
    term.write(fs.readFileSync(path.join(DIR, `${name}.ans`), 'utf8'), resolve);
    await promise;
    const snapshot = screenSnapshot(term);
    term.dispose();
    return snapshot;
}
