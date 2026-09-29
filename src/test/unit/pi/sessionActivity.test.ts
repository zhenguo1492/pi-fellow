import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionActivityWatcher, sessionEntryBusy } from '../../../pi/sessionActivity';

/** fs.watchFile's listener per file: the tests poll by hand instead of waiting on stat polling. */
const polls = vi.hoisted(() => new Map<string, () => void>());

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        watchFile: (file: string, _options: unknown, listener: () => void) => polls.set(file, listener),
        unwatchFile: (file: string) => polls.delete(file),
    };
});

const user = { type: 'message', message: { role: 'user', content: 'go' } };
const toolUse = { type: 'message', message: { role: 'assistant', stopReason: 'toolUse' } };
const toolResult = { type: 'message', message: { role: 'toolResult' } };
const stop = { type: 'message', message: { role: 'assistant', stopReason: 'stop' } };
const lines = (...entries: unknown[]) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');

describe('sessionEntryBusy', () => {
    it('reads a run as on after a prompt, a tool call or a tool result, and off after any other assistant stop', () => {
        expect(sessionEntryBusy(user)).toBe(true);
        expect(sessionEntryBusy(toolUse)).toBe(true);
        expect(sessionEntryBusy(toolResult)).toBe(true);
        for (const stopReason of ['stop', 'aborted', 'error', 'length', undefined]) {
            expect(sessionEntryBusy({ type: 'message', message: { role: 'assistant', stopReason } })).toBe(false);
        }
    });

    it('has no opinion on entries that say nothing about a run', () => {
        const silent = [
            null,
            'text',
            42,
            { type: 'model_change', provider: 'x' },
            { type: 'custom', message: { role: 'user' } },
            { type: 'message' },
            { type: 'message', message: null },
            { type: 'message', message: { role: 'bashExecution' } },
            { type: 'message', message: { role: 'system' } },
        ];
        for (const entry of silent) {
            expect(sessionEntryBusy(entry)).toBeUndefined();
        }
    });
});

describe('SessionActivityWatcher', () => {
    let dir: string;
    let file: string;
    let changes: boolean[];
    let watcher: SessionActivityWatcher | undefined;

    const append = (text: string | Buffer) => fs.appendFileSync(file, text);
    const poll = () => polls.get(file)?.();
    const start = () => {
        watcher = new SessionActivityWatcher(file, (busy) => changes.push(busy));
        return watcher;
    };
    /** Polls until the reported changes are `expected`. */
    const expectChanges = (expected: boolean[]) =>
        vi.waitFor(() => {
            poll();
            expect(changes).toEqual(expected);
        });

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-activity-'));
        file = path.join(dir, 'session.jsonl');
        changes = [];
    });

    afterEach(() => {
        watcher?.dispose();
        watcher = undefined;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('starts idle at the end of what is already written, then follows each appended run', async () => {
        fs.writeFileSync(file, lines({ type: 'session' }, user, toolUse));
        start();
        append(lines(toolResult));
        await expectChanges([true]);
        append(lines(toolUse, toolResult));
        poll();
        append(lines(stop));
        await expectChanges([true, false]);
        append(lines(user));
        await expectChanges([true, false, true]);
    });

    it('goes by the last entry of what arrived in one read', async () => {
        fs.writeFileSync(file, '');
        start();
        // A whole run between two polls: it was never seen running.
        append(lines(user, toolUse, toolResult, stop));
        poll();
        append(lines(stop, user));
        await expectChanges([true]);
    });

    it('waits for the rest of a line written in pieces, even one split inside a character', async () => {
        fs.writeFileSync(file, '');
        start();
        const entry = Buffer.from(JSON.stringify({ type: 'message', message: { role: 'user', content: '改一下' } }));
        const split = entry.indexOf(Buffer.from('改')) + 1;
        append(entry.subarray(0, split));
        poll();
        append(entry.subarray(split));
        poll();
        append('\n');
        await expectChanges([true]);
    });

    it('skips a line that is not JSON and lets the next entry decide', async () => {
        fs.writeFileSync(file, '');
        start();
        append(`not json\n${lines(user)}{"type": "message", "message": {"role": "assistant", "stopReason": "stop"\n`);
        await expectChanges([true]);
    });

    it('reads a session file created after it started from its first entry', async () => {
        start();
        append(lines({ type: 'session' }, user));
        await expectChanges([true]);
    });

    it('rescans a file rewritten shorter and takes its state from its last entry', async () => {
        fs.writeFileSync(file, lines(user, toolUse, toolResult, toolUse, toolResult));
        start();
        append(lines(toolUse));
        await expectChanges([true]);
        fs.writeFileSync(file, lines(user, stop));
        await expectChanges([true, false]);
    });

    it('stops following on dispose', () => {
        fs.writeFileSync(file, '');
        start().dispose();
        expect(polls.has(file)).toBe(false);
    });
});
