import * as fs from 'node:fs';

/** How often the session file is stat-polled; `fs.watchFile` also covers a file that does not exist yet. */
const POLL_MS = 500;

/**
 * Whether the agent is still working after this session-file entry: a user prompt, a tool result or an
 * assistant step that called tools means more is coming; any other assistant stop ends the run.
 * Undefined for entries that say nothing about it (model changes, labels, `!` shell output…).
 */
export function sessionEntryBusy(entry: unknown): boolean | undefined {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { type, message } = entry as { type?: unknown; message?: { role?: unknown; stopReason?: unknown } };
    if (type !== 'message' || typeof message !== 'object' || message === null) return undefined;
    if (message.role === 'assistant') return message.stopReason === 'toolUse';
    if (message.role === 'user' || message.role === 'toolResult') return true;
    return undefined;
}

/**
 * Follows the entries a CLI TUI appends to its session file and reports when its agent starts and
 * stops working. Starts idle at the file's current end: a TUI that was just launched is not running.
 */
export class SessionActivityWatcher {
    private _offset: number;
    /** Bytes after the last newline: an entry still being written. */
    private _partial: Buffer = Buffer.alloc(0);
    private _busy = false;
    private _disposed = false;
    private _reads = Promise.resolve();
    private readonly _listener = (): void => {
        this._reads = this._reads.then(() => this._readAppended()).catch(() => undefined);
    };

    constructor(
        private readonly _file: string,
        private readonly _onChange: (busy: boolean) => void,
    ) {
        try {
            this._offset = fs.statSync(_file).size;
        } catch {
            this._offset = 0; // not written yet
        }
        fs.watchFile(_file, { interval: POLL_MS, persistent: false }, this._listener);
    }

    dispose(): void {
        this._disposed = true;
        fs.unwatchFile(this._file, this._listener);
    }

    private async _readAppended(): Promise<void> {
        if (this._disposed) return;
        let handle: fs.promises.FileHandle;
        try {
            handle = await fs.promises.open(this._file, 'r');
        } catch {
            return; // not created yet, or deleted
        }
        let chunk: Buffer;
        try {
            const { size } = await handle.stat();
            if (size < this._offset) {
                // Rewritten in place: rescan it; its last entry gives the state.
                this._offset = 0;
                this._partial = Buffer.alloc(0);
            }
            if (size === this._offset) return;
            const appended = Buffer.alloc(size - this._offset);
            const { bytesRead } = await handle.read(appended, 0, appended.length, this._offset);
            this._offset += bytesRead;
            chunk = Buffer.concat([this._partial, appended.subarray(0, bytesRead)]);
        } finally {
            await handle.close();
        }
        // Split on the newline byte, not in the decoded text: a multi-byte character may straddle two reads.
        const end = chunk.lastIndexOf(0x0a);
        this._partial = end < 0 ? chunk : chunk.subarray(end + 1);
        if (end < 0 || this._disposed) return;
        let busy: boolean | undefined;
        for (const line of chunk.toString('utf8', 0, end).split('\n')) {
            if (!line.trim()) continue;
            try {
                busy = sessionEntryBusy(JSON.parse(line)) ?? busy;
            } catch {
                // Not JSON: skip it; the next entry decides.
            }
        }
        if (busy !== undefined && busy !== this._busy) {
            this._busy = busy;
            this._onChange(busy);
        }
    }
}
