import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ActiveVoiceWindow } from '../../../voiceAgent/activeWindow';

/** Each instance stands for one VS Code window; they share the directory as windows share globalStorage. */
const windows: ActiveVoiceWindow[] = [];
let dir: string;
let clock = 1_000_000;

function open(id: string): ActiveVoiceWindow {
    const w = new ActiveVoiceWindow(dir, id);
    windows.push(w);
    return w;
}

/** Focus order comes from Date.now(); each step is one tick later. */
function later(): void {
    vi.setSystemTime(++clock);
}

/**
 * Waits for other windows' writes, which arrive through real fs.watch events: the condition is
 * polled between event-loop turns (only Date is faked), with a deadline so a bug fails, not hangs.
 */
async function until(condition: () => boolean): Promise<void> {
    const deadline = performance.now() + 2000;
    while (!condition()) {
        if (performance.now() > deadline) {
            throw new Error('condition not reached');
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setImmediate(resolve);
        await promise;
    }
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-windows-'));
});

afterEach(() => {
    for (const w of windows.splice(0)) {
        w.dispose();
    }
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('ActiveVoiceWindow', () => {
    it('gives the voice to the window in voice mode focused last', async () => {
        const a = open('a');
        const b = open('b');
        a.join();
        later();
        b.join();
        await until(() => !a.active && b.active);
        later();
        a.focused();
        await until(() => a.active && !b.active);
    });

    it('ignores focus on a window without voice mode', () => {
        const a = open('a');
        const plain = open('plain');
        a.join();
        later();
        plain.focused();
        expect([a.active, plain.active]).toEqual([true, false]);
        expect(fs.readdirSync(dir)).toEqual(['a.json']);
    });

    it('falls back to the previously focused voice window when the live one leaves', async () => {
        const a = open('a');
        const b = open('b');
        const changes: boolean[] = [];
        a.onDidChange((active) => changes.push(active));
        a.join();
        later();
        b.join();
        await until(() => !a.active);
        b.leave();
        await until(() => a.active);
        expect(changes).toEqual([true, false, true]);
    });

    it('does not let a crashed window keep the voice', async () => {
        const a = open('a');
        a.join();
        // A window focused after `a` whose process is gone.
        const crashed = path.join(dir, 'crashed.json');
        fs.writeFileSync(crashed, JSON.stringify({ pid: 999_999_999, focusedAt: clock + 1000 }));
        await until(() => !fs.existsSync(crashed));
        expect(a.active).toBe(true);
    });
});
