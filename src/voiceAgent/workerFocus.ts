import * as fs from 'node:fs';
import * as path from 'node:path';
import { editPaths } from '../pi/permissionPolicy';
import { changedLines, readTarget, type FocusTarget } from './piFocus';
import type { WorkerController, WorkerEvent } from './workerController';

/** Files larger than this are not compared: the write shows as the whole file. */
const MAX_COMPARE_BYTES = 2_000_000;

/**
 * What the worker of the current task reads and writes, as Pi focus: a read shows its lines; a write
 * shows its file when it starts and the changed lines once it lands (compared with the file before).
 */
export class WorkerFocusTracker {
    /** Content of each file an edit is about to change, per tool call. */
    private readonly _before = new Map<string, Array<{ path: string; content: string | undefined }>>();
    private readonly _subscription: { dispose(): void };

    constructor(
        worker: WorkerController,
        /** Relative tool paths are relative to it. */
        private readonly _root: string,
        private readonly _onFocus: (kind: 'reading' | 'writing', target: FocusTarget) => void,
    ) {
        this._subscription = worker.onTabEvent(({ tabId, event }) => {
            if (tabId === worker.activeTask()?.tabId) {
                this._ingest(event);
            }
        });
    }

    dispose(): void {
        this._subscription.dispose();
        this._before.clear();
    }

    private _ingest(event: WorkerEvent): void {
        const tool = String(event.toolName ?? '');
        const id = String(event.toolCallId ?? '');
        if (event.type === 'tool_execution_start') {
            if (tool === 'read') {
                const target = readTarget(event.args);
                if (target) {
                    this._onFocus('reading', target);
                }
                return;
            }
            if (tool !== 'edit' && tool !== 'write') {
                return;
            }
            const paths = editPaths(event.args);
            if (paths.length === 0) {
                return;
            }
            // Read now, synchronously: the tool runs as soon as this event is out.
            this._before.set(id, paths.map((p) => ({ path: p, content: this._read(p) })));
            this._onFocus('writing', { path: paths[0] });
        } else if (event.type === 'tool_execution_end') {
            const before = this._before.get(id);
            this._before.delete(id);
            if (!before || event.isError === true) {
                return;
            }
            for (const file of before) {
                const after = this._read(file.path);
                const lines = after === undefined ? undefined : changedLines(file.content, after);
                if (lines) {
                    this._onFocus('writing', { path: file.path, ...lines });
                    return;
                }
            }
        }
    }

    /** Undefined when the file does not exist yet, or is too big to compare. */
    private _read(file: string): string | undefined {
        const abs = path.isAbsolute(file) ? file : path.join(this._root, file);
        try {
            return fs.statSync(abs).size > MAX_COMPARE_BYTES ? undefined : fs.readFileSync(abs, 'utf8');
        } catch {
            return undefined;
        }
    }
}
