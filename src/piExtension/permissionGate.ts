/**
 * Pi/omp extension shipped with this VS Code extension: the tab's permission level (auto / ask /
 * plan) applied to every tool call of the worker. PiRpcBridge loads it with `--extension` into each
 * chat worker, on both backends; the level lives in the file named by PERMISSION_FILE_ENV (protocol
 * in src/pi/permissionPolicy.ts). Before a call that changes files runs, it appends the files to the
 * file named by EDITS_FILE_ENV: the host's lock that keeps the voice agent off them. Built to
 * out/pi-extension/permissionGate.js.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
    APPROVE_OPTION,
    DENY_OPTION,
    decideToolCall,
    deniedReason,
    EDITS_FILE_ENV,
    modifiedPaths,
    nativePlanEnabled,
    parseGateState,
    PERMISSION_FILE_ENV,
} from '../pi/permissionPolicy';

/** The slice of the extension API used here: the same on pi (core/extensions/types.ts) and omp (extensibility/extensions/types.ts). */
export interface GateContext {
    ui: { select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> };
    /** pi only; omp binds the handler's signal into dialogs itself. */
    signal?: AbortSignal;
    /** The worker's working folder; tool paths are relative to it. */
    cwd?: string;
    sessionManager?: { getBranch?(): ReadonlyArray<{ type?: unknown; customType?: unknown; data?: unknown }> };
}

export interface GateToolCallEvent {
    toolName: string;
    input?: Record<string, unknown>;
}

export interface GateExtensionApi {
    on(event: 'tool_call', handler: (event: GateToolCallEvent, ctx: GateContext) => Promise<{ block: true; reason: string } | undefined>): void;
}

function readState() {
    const file = process.env[PERMISSION_FILE_ENV];
    let text: string | undefined;
    try {
        text = file ? readFileSync(file, 'utf8') : undefined;
    } catch {
        text = undefined;
    }
    return parseGateState(text);
}

/**
 * Tells the host, synchronously and before the tool runs, which files the call is about to change.
 * Also for a call that still waits on the user's approval: a denied one leaves its files locked until
 * the task ends, which only keeps the voice agent off them a little longer.
 */
function recordEdits(event: GateToolCallEvent, ctx: GateContext): void {
    const file = process.env[EDITS_FILE_ENV];
    if (!file) {
        return;
    }
    const cwd = ctx.cwd ?? process.cwd();
    const paths = modifiedPaths(event.toolName, event.input ?? {}).map((p) => path.resolve(cwd, p));
    if (paths.length === 0) {
        return;
    }
    try {
        appendFileSync(file, `${JSON.stringify({ paths })}\n`);
    } catch {
        // The host removed the file (worker shutting down): nothing is listening.
    }
}

export default function permissionGate(pi: GateExtensionApi): void {
    pi.on('tool_call', async (event, ctx) => {
        // pi's own plan mode (pi-plan-mode) is on: its tool_call gate, which runs after this one, owns the policy.
        if (nativePlanEnabled(ctx.sessionManager?.getBranch?.())) {
            recordEdits(event, ctx);
            return undefined;
        }
        const decision = decideToolCall(readState(), event.toolName, event.input ?? {});
        if (decision.kind === 'block') {
            return { block: true, reason: decision.reason };
        }
        recordEdits(event, ctx);
        if (decision.kind === 'allow') {
            return undefined;
        }
        const choice = await ctx.ui.select(decision.title, [APPROVE_OPTION, DENY_OPTION], { signal: ctx.signal });
        return choice === APPROVE_OPTION ? undefined : { block: true, reason: deniedReason(event.toolName) };
    });
}
