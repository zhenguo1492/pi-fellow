import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getPiExtensionPath } from './extensionPath';
import {
    HOST_TOOL_CALL_TITLE,
    HOST_TOOL_CANCEL_STATUS_KEY,
    HOST_TOOLS_FILE_ENV,
    type HostToolCallPayload,
    type HostToolResultPayload,
} from './hostToolsProtocol';
import type { PiRpcOutbound, RpcExtensionUIResponse, RpcHostToolDefinition } from './rpcTypes';

/**
 * Host side of omp host tools on Pi (protocol in hostToolsProtocol.ts): owns the tool-set file and
 * turns the bundled extension's UI frames into omp's `host_tool_call` / `host_tool_cancel`.
 */
export class PiHostTools {
    readonly file = path.join(os.tmpdir(), `vscode-pi-host-tools-${randomUUID()}.json`);
    /** Pi toolCallId → extension_ui_request id (the host-facing call id) of calls not yet answered. */
    private readonly _open = new Map<string, string>();

    constructor() {
        fs.writeFileSync(this.file, '[]');
    }

    /** CLI args and env that load the extension; the built file ships in the VSIX under out/. */
    launch(): { args: string[]; env: NodeJS.ProcessEnv } {
        const root = getPiExtensionPath();
        if (!root) {
            throw new Error('Extension path unknown; cannot load the Pi host-tools extension');
        }
        return {
            args: ['--extension', path.join(root, 'out', 'pi-extension', 'hostTools.js')],
            env: { [HOST_TOOLS_FILE_ENV]: this.file },
        };
    }

    writeTools(tools: RpcHostToolDefinition[]): void {
        fs.writeFileSync(this.file, JSON.stringify(tools));
    }

    /** The frame to hand on: an omp host-tool frame for the extension's own, `frame` unchanged otherwise, null to drop. */
    translate(frame: PiRpcOutbound): PiRpcOutbound | null {
        if (frame.type !== 'extension_ui_request') {
            return frame;
        }
        const request = frame as { id?: unknown; method?: unknown; title?: unknown; placeholder?: unknown; statusKey?: unknown; statusText?: unknown };
        if (request.method === 'input' && request.title === HOST_TOOL_CALL_TITLE) {
            const id = String(request.id);
            const call = JSON.parse(String(request.placeholder)) as HostToolCallPayload;
            this._open.set(call.callKey, id);
            return { type: 'host_tool_call', id, toolCallId: call.callKey, toolName: call.toolName, arguments: call.arguments };
        }
        if (request.method === 'setStatus' && request.statusKey === HOST_TOOL_CANCEL_STATUS_KEY) {
            const callKey = String(request.statusText);
            const id = this._open.get(callKey);
            if (id === undefined) {
                return null;
            }
            this._open.delete(callKey);
            return { type: 'host_tool_cancel', targetId: id };
        }
        return frame;
    }

    /** The extension_ui_response carrying the host's result for call `id`. */
    response(id: string, result: HostToolResultPayload): RpcExtensionUIResponse {
        for (const [callKey, openId] of this._open) {
            if (openId === id) {
                this._open.delete(callKey);
                break;
            }
        }
        return { type: 'extension_ui_response', id, value: JSON.stringify(result) };
    }

    dispose(): void {
        fs.rmSync(this.file, { force: true });
    }
}
