import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Which VS Code window's voice mode may use the microphone and speakers. The computer has one
 * voice, so it goes to the window focused last among those with voice mode on; the others stand by
 * (design §13 R9). Focusing a window without voice mode changes nothing. When the live window turns
 * voice mode off or closes, the voice falls back to the next most recently focused one.
 *
 * Each window's extension host is its own process; they share `globalStorage`. A window in voice
 * mode keeps one file there, `<id>.json` = `{ pid, focusedAt }`, rewritten on focus and deleted when
 * voice mode ends. Every window watches the directory and recomputes. Entries whose process is gone
 * (a crashed window) are ignored and removed.
 */
export class ActiveVoiceWindow {
    private readonly _file: string;
    private _joined = false;
    private _active = false;
    private readonly _listeners = new Set<(active: boolean) => void>();
    private readonly _watcher: fs.FSWatcher;

    constructor(
        private readonly _dir: string,
        readonly id: string = randomUUID(),
        private readonly _pid: number = process.pid,
    ) {
        fs.mkdirSync(_dir, { recursive: true });
        this._file = path.join(_dir, `${id}.json`);
        this._watcher = fs.watch(_dir, () => this._refresh());
    }

    /** This window has the voice. Always false outside voice mode. */
    get active(): boolean {
        return this._active;
    }

    /** Voice mode started here; the user just asked for it, so this window takes the voice. */
    join(): void {
        this._joined = true;
        this._write();
    }

    /** This window was focused: if it is in voice mode, the voice moves here. */
    focused(): void {
        if (this._joined) {
            this._write();
        }
    }

    /** Voice mode ended here: the voice goes back to the window focused before. */
    leave(): void {
        this._joined = false;
        fs.rmSync(this._file, { force: true });
        this._refresh();
    }

    onDidChange(listener: (active: boolean) => void): { dispose(): void } {
        this._listeners.add(listener);
        return { dispose: () => this._listeners.delete(listener) };
    }

    dispose(): void {
        this._watcher.close();
        this._listeners.clear();
        if (this._joined) {
            fs.rmSync(this._file, { force: true });
        }
    }

    private _write(): void {
        // Write + rename, so a watcher never reads half a file.
        const tmp = path.join(this._dir, `.${this.id}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify({ pid: this._pid, focusedAt: Date.now() }));
        fs.renameSync(tmp, this._file);
        this._refresh();
    }

    /** The live window: newest focus among entries whose process still runs; ties go to the smaller id. */
    private _owner(): string | undefined {
        let best: { id: string; focusedAt: number } | undefined;
        for (const name of fs.readdirSync(this._dir)) {
            if (!name.endsWith('.json')) {
                continue;
            }
            const id = name.slice(0, -'.json'.length);
            let entry: { pid?: unknown; focusedAt?: unknown };
            try {
                entry = JSON.parse(fs.readFileSync(path.join(this._dir, name), 'utf8'));
            } catch {
                continue; // deleted meanwhile
            }
            if (typeof entry.pid !== 'number' || typeof entry.focusedAt !== 'number') {
                continue;
            }
            if (!alive(entry.pid)) {
                fs.rmSync(path.join(this._dir, name), { force: true });
                continue;
            }
            if (!best || entry.focusedAt > best.focusedAt || (entry.focusedAt === best.focusedAt && id < best.id)) {
                best = { id, focusedAt: entry.focusedAt };
            }
        }
        return best?.id;
    }

    private _refresh(): void {
        const active = this._joined && this._owner() === this.id;
        if (active === this._active) {
            return;
        }
        this._active = active;
        for (const listener of [...this._listeners]) {
            listener(active);
        }
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM: it exists but belongs to someone else.
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}
