/**
 * Pi/omp extension shipped with this VS Code extension: the tab's permission level (auto / ask /
 * plan) applied to every tool call of the worker. PiRpcBridge loads it with `--extension` into each
 * chat worker, on both backends; the level lives in the file named by PERMISSION_FILE_ENV (protocol
 * in src/pi/permissionPolicy.ts). Built to out/pi-extension/permissionGate.js.
 */
import { readFileSync } from 'node:fs';
import { APPROVE_OPTION, DENY_OPTION, decideToolCall, deniedReason, nativePlanEnabled, parseGateState, PERMISSION_FILE_ENV } from '../pi/permissionPolicy';

/** The slice of the extension API used here: the same on pi (core/extensions/types.ts) and omp (extensibility/extensions/types.ts). */
export interface GateContext {
    ui: { select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> };
    /** pi only; omp binds the handler's signal into dialogs itself. */
    signal?: AbortSignal;
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

export default function permissionGate(pi: GateExtensionApi): void {
    pi.on('tool_call', async (event, ctx) => {
        // pi's own plan mode (pi-plan-mode) is on: its tool_call gate, which runs after this one, owns the policy.
        if (nativePlanEnabled(ctx.sessionManager?.getBranch?.())) {
            return undefined;
        }
        const decision = decideToolCall(readState(), event.toolName, event.input ?? {});
        switch (decision.kind) {
            case 'allow':
                return undefined;
            case 'block':
                return { block: true, reason: decision.reason };
            case 'ask': {
                const choice = await ctx.ui.select(decision.title, [APPROVE_OPTION, DENY_OPTION], { signal: ctx.signal });
                return choice === APPROVE_OPTION ? undefined : { block: true, reason: deniedReason(event.toolName) };
            }
        }
    });
}
