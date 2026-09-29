import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PermissionLevel } from '../shared/protocol';
import { getPiExtensionPath } from './extensionPath';
import { EDITS_FILE_ENV, isPermissionLevel, PERMISSION_FILE_ENV, type PermissionGateState } from './permissionPolicy';
import { WorkerEditLocks } from './workerEdits';

/**
 * Host side of the worker's permission gate (protocol in permissionPolicy.ts): owns one CLI
 * process's state file, the edits file the gate reports file changes to, and the args that load the
 * gate extension.
 */
export class PermissionGateFile {
    readonly file: string;
    readonly editsFile: string;
    private readonly _edits = new WorkerEditLocks();
    /** Bytes of the edits file already taken into `_edits`. */
    private _editsRead = 0;

    constructor(state: PermissionGateState) {
        const id = randomUUID();
        this.file = path.join(os.tmpdir(), `vscode-pi-permission-${id}.json`);
        this.editsFile = path.join(os.tmpdir(), `vscode-pi-edits-${id}.ndjson`);
        this.write(state);
        fs.writeFileSync(this.editsFile, '');
    }

    /** CLI args and env that load the gate; the built file ships in the VSIX under out/. */
    launch(): { args: string[]; env: NodeJS.ProcessEnv } {
        const root = getPiExtensionPath();
        if (!root) {
            throw new Error('Extension path unknown; cannot load the permission gate extension');
        }
        return {
            args: ['--extension', path.join(root, 'out', 'pi-extension', 'permissionGate.js')],
            env: { [PERMISSION_FILE_ENV]: this.file, [EDITS_FILE_ENV]: this.editsFile },
        };
    }

    /** Read by the gate on its next tool call. */
    write(state: PermissionGateState): void {
        fs.writeFileSync(this.file, JSON.stringify(state));
    }

    /**
     * The files the worker changed or is about to change since `clearEdits`, up to date: read
     * synchronously, so a report the gate wrote before its tool ran is always seen.
     */
    edits(): WorkerEditLocks {
        let fd: number | undefined;
        try {
            fd = fs.openSync(this.editsFile, 'r');
            const size = fs.fstatSync(fd).size;
            if (size > this._editsRead) {
                const chunk = Buffer.alloc(size - this._editsRead);
                fs.readSync(fd, chunk, 0, chunk.length, this._editsRead);
                // Whole lines only: a report being written is taken on the next read.
                const end = chunk.lastIndexOf(0x0a) + 1;
                this._editsRead += end;
                this._edits.ingest(chunk.subarray(0, end).toString('utf8'));
            }
        } catch {
            // Removed with the worker: nothing more to read.
        } finally {
            if (fd !== undefined) {
                fs.closeSync(fd);
            }
        }
        return this._edits;
    }

    /** The worker's task ended: its files are free again. */
    clearEdits(): void {
        this._edits.clear();
        this._editsRead = 0;
        try {
            fs.writeFileSync(this.editsFile, '');
        } catch {
            // Removed with the worker.
        }
    }

    dispose(): void {
        fs.rmSync(this.file, { force: true });
        fs.rmSync(this.editsFile, { force: true });
    }
}

/**
 * Level of a new tab: `defaultPermissionLevel` when set; otherwise the legacy `autoApproveTools`
 * (true → auto), else ask.
 */
export function readDefaultPermissionLevel(): PermissionLevel {
    const config = vscode.workspace.getConfiguration('oh-my-pi-chater');
    const inspected = config.inspect<string>('defaultPermissionLevel');
    const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    if (isPermissionLevel(explicit)) {
        return explicit;
    }
    return config.get<boolean>('autoApproveTools', false) ? 'auto' : 'ask';
}

/** Manual / Edit automatically: tools that run without asking. */
export function readAllowedTools(): string[] {
    const tools = vscode.workspace.getConfiguration('oh-my-pi-chater').get<unknown>('allowedTools', []);
    return Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()) : [];
}
