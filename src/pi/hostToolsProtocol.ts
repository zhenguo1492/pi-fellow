/**
 * Pi has no omp `set_host_tools`; the bundled Pi extension (src/piExtension/hostTools.ts, built to
 * out/pi-extension/hostTools.js) emulates it over channels Pi RPC already has. PiRpcBridge speaks
 * the host side and turns it back into omp's host-tool frames.
 *
 * - Tool set: JSON RpcHostToolDefinition[] in the file named by env HOST_TOOLS_FILE_ENV. The
 *   extension registers it on load, so it survives Pi rebuilding the extension runtime on
 *   new_session / switch_session. After rewriting it the host prompts `/<HOST_TOOLS_COMMAND>`,
 *   which re-reads it; Pi answers that prompt only after the handler finished.
 * - Tool call: `input` dialog titled HOST_TOOL_CALL_TITLE, `placeholder` = JSON
 *   HostToolCallPayload. The host answers with `value` = JSON HostToolResultPayload.
 * - Cancel: `setStatus` with statusKey HOST_TOOL_CANCEL_STATUS_KEY, statusText = the call's
 *   `callKey`. Pi drops the pending dialog itself when the tool's signal aborts.
 */
export const HOST_TOOLS_FILE_ENV = 'VSCODE_PI_HOST_TOOLS_FILE';
export const HOST_TOOLS_COMMAND = 'vscode-host-tools';
export const HOST_TOOL_CALL_TITLE = 'vscode-host-tool-call';
export const HOST_TOOL_CANCEL_STATUS_KEY = 'vscode-host-tool-cancel';

export interface HostToolCallPayload {
    /** Pi's toolCallId: names the call in the cancel status. */
    callKey: string;
    toolName: string;
    arguments: Record<string, unknown>;
}

export interface HostToolResultPayload {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}
