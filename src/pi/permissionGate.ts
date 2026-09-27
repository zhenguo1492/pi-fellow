import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PermissionLevel } from '../shared/protocol';
import { getPiExtensionPath } from './extensionPath';
import { isPermissionLevel, PERMISSION_FILE_ENV, type PermissionGateState } from './permissionPolicy';

/**
 * Host side of the worker's permission gate (protocol in permissionPolicy.ts): owns one CLI
 * process's state file and the args that load the gate extension.
 */
export class PermissionGateFile {
    readonly file = path.join(os.tmpdir(), `vscode-pi-permission-${randomUUID()}.json`);

    constructor(state: PermissionGateState) {
        this.write(state);
    }

    /** CLI args and env that load the gate; the built file ships in the VSIX under out/. */
    launch(): { args: string[]; env: NodeJS.ProcessEnv } {
        const root = getPiExtensionPath();
        if (!root) {
            throw new Error('Extension path unknown; cannot load the permission gate extension');
        }
        return {
            args: ['--extension', path.join(root, 'out', 'pi-extension', 'permissionGate.js')],
            env: { [PERMISSION_FILE_ENV]: this.file },
        };
    }

    /** Read by the gate on its next tool call. */
    write(state: PermissionGateState): void {
        fs.writeFileSync(this.file, JSON.stringify(state));
    }

    dispose(): void {
        fs.rmSync(this.file, { force: true });
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
