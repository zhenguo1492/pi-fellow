/**
 * Pi extension shipped with this VS Code extension: omp's host tools on Pi (protocol in
 * src/pi/hostToolsProtocol.ts). PiRpcBridge loads it with `--extension` only for processes that
 * use host tools, so normal Pi sessions never see it. Built to out/pi-extension/hostTools.js.
 */
import { readFileSync } from 'node:fs';
import {
    HOST_TOOL_CALL_TITLE,
    HOST_TOOL_CANCEL_STATUS_KEY,
    HOST_TOOLS_COMMAND,
    HOST_TOOLS_FILE_ENV,
    type HostToolCallPayload,
    type HostToolResultPayload,
} from '../pi/hostToolsProtocol';
import type { RpcHostToolDefinition } from '../pi/rpcTypes';

/** The slice of Pi's ExtensionAPI used here (pi-coding-agent core/extensions/types.ts). */
interface PiContext {
    ui: {
        input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
        setStatus(key: string, text: string | undefined): void;
    };
}

interface PiToolResult {
    content: Array<{ type: 'text'; text: string }>;
    details: undefined;
}

interface PiExtensionApi {
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: PiContext) => Promise<void> }): void;
    registerTool(tool: {
        name: string;
        label: string;
        description: string;
        parameters: Record<string, unknown>;
        execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiContext): Promise<PiToolResult>;
    }): void;
    getActiveTools(): string[];
    setActiveTools(toolNames: string[]): void;
}

/** Asks the host to run one call; resolves with its result, throws for an error result or a cancelled call. */
async function callHost(toolName: string, toolCallId: string, params: unknown, signal: AbortSignal | undefined, ctx: PiContext): Promise<PiToolResult> {
    const payload: HostToolCallPayload = {
        callKey: toolCallId,
        toolName,
        arguments: params && typeof params === 'object' ? (params as Record<string, unknown>) : {},
    };
    const onAbort = () => ctx.ui.setStatus(HOST_TOOL_CANCEL_STATUS_KEY, toolCallId);
    signal?.addEventListener('abort', onAbort, { once: true });
    let reply: string | undefined;
    try {
        reply = await ctx.ui.input(HOST_TOOL_CALL_TITLE, JSON.stringify(payload), { signal });
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
    if (reply === undefined) {
        throw new Error(signal?.aborted ? `${toolName} was cancelled` : `The host did not answer ${toolName}`);
    }
    const result = JSON.parse(reply) as HostToolResultPayload;
    if (result.isError) {
        // Pi marks a tool result as failed only when execute throws.
        throw new Error(result.content.map((part) => part.text).join('\n'));
    }
    return { content: result.content, details: undefined };
}

export default function hostToolsExtension(pi: PiExtensionApi): void {
    const file = process.env[HOST_TOOLS_FILE_ENV];
    if (!file) {
        return;
    }
    /** Registers the file's tool set; returns its names. Registering a name again replaces it. */
    const registerFromFile = (): Set<string> => {
        const tools = JSON.parse(readFileSync(file, 'utf8')) as RpcHostToolDefinition[];
        for (const tool of tools) {
            pi.registerTool({
                name: tool.name,
                label: tool.label ?? tool.name,
                description: tool.description,
                parameters: tool.parameters,
                execute: (toolCallId, params, signal, _onUpdate, ctx) => callHost(tool.name, toolCallId, params, signal, ctx),
            });
        }
        return new Set(tools.map((tool) => tool.name));
    };

    // Pi activates tools registered while loading (within a `--tools` allowlist, if one is given).
    let hostNames = registerFromFile();

    pi.registerCommand(HOST_TOOLS_COMMAND, {
        description: 'Internal: reload the VS Code host tool set (omp set_host_tools emulation)',
        handler: async () => {
            const previous = hostNames;
            hostNames = registerFromFile();
            // Tools dropped from the set stay registered (Pi cannot unregister) but go inactive.
            const kept = pi.getActiveTools().filter((name) => !previous.has(name) && !hostNames.has(name));
            pi.setActiveTools([...kept, ...hostNames]);
        },
    });
}
