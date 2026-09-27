/**
 * Per-tab permission levels for the worker's tool calls, named like Claude's modes in the UI:
 * ask = Manual, edit = Edit automatically, plan = Plan, auto = Auto. Pure: bundled into the
 * worker-side gate extension (src/piExtension/permissionGate.ts) and used by the host.
 *
 * Host ↔ gate protocol: the host writes JSON PermissionGateState to the file named by env
 * PERMISSION_FILE_ENV (one file per worker process); the gate re-reads it on every tool call, so a
 * level change applies to the next call without restarting the CLI. Approvals are an extension_ui
 * `select` titled like omp's own approval prompt (`Allow tool: <name>`, options Approve / Deny),
 * so the chat's dialog, the fallback modal and the voice agent's answer_worker all handle them the
 * same way.
 */
import type { PermissionLevel } from '../shared/protocol';

export const PERMISSION_FILE_ENV = 'VSCODE_PI_PERMISSION_FILE';
export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['ask', 'edit', 'plan', 'auto'];
export const APPROVE_OPTION = 'Approve';
export const DENY_OPTION = 'Deny';
const APPROVAL_TITLE_PREFIX = 'Allow tool: ';

export interface PermissionGateState {
    level: PermissionLevel;
    /** Manual / Edit automatically: tools that run without asking (setting `oh-my-pi-chater.allowedTools`). */
    allowedTools: string[];
}

export type GateDecision = { kind: 'allow' } | { kind: 'block'; reason: string } | { kind: 'ask'; title: string };

export function isPermissionLevel(value: unknown): value is PermissionLevel {
    return typeof value === 'string' && (PERMISSION_LEVELS as readonly string[]).includes(value);
}

/** Reading, searching and talking to the user; everything else (unknown and MCP tools included) counts as a change. */
const READ_ONLY_TOOLS: Record<string, true> = {
    read: true,
    grep: true,
    find: true,
    glob: true,
    ls: true,
    ast_grep: true,
    web_search: true,
    fetch: true,
    ask: true,
    todo: true,
    todo_write: true,
    wait: true,
    think: true,
    yield: true,
    goal: true,
    checkpoint: true,
    rewind: true,
    recall: true,
    reflect: true,
    // pi-plan-mode's own helpers.
    plan_mode_question: true,
    plan_mode_complete: true,
};

/** omp internal URLs that may be written in any mode: plan scratch files, and `xd://` device dispatch (the dispatched tool is gated again under its own name). */
const INTERNAL_WRITE_TARGET = /^(xd|local|memory):\/\//i;

function writeTargets(input: Record<string, unknown>): string[] {
    const targets: unknown[] = [input.path, input.file_path];
    if (Array.isArray(input.paths)) {
        targets.push(...input.paths);
    }
    return targets.filter((t): t is string => typeof t === 'string' && t.length > 0);
}

function lspMutates(input: Record<string, unknown>): boolean {
    switch (input.action) {
        case 'rename':
        case 'rename_file':
            return input.apply !== false;
        case 'code_actions':
            return input.apply === true;
        case 'request':
            return true;
        default:
            return false;
    }
}

/**
 * omp's `edit` also deletes and moves files: hashline `REM` / `MV dest` op lines (body rows start
 * with `+`), apply_patch `*** Delete File:` / `*** Move to:`, and the patch form's `op: 'delete'` /
 * `rename`. Those need asking in Edit automatically, like `rm` / `mv` through bash.
 */
function removesOrMovesFiles(input: Record<string, unknown>): boolean {
    if (typeof input.input === 'string' && /^[ \t]*(?:REM[ \t]*$|MV[ \t]+\S|\*\*\* (?:Delete File|Move to):)/m.test(input.input)) {
        return true;
    }
    return (
        Array.isArray(input.edits) &&
        input.edits.some((e: unknown) => {
            const entry = e as { op?: unknown; rename?: unknown } | null;
            return entry?.op === 'delete' || (typeof entry?.rename === 'string' && entry.rename.length > 0);
        })
    );
}

/**
 * What a call can do: `read` runs in every mode; `write` changes file contents (runs unasked in
 * Edit automatically); `exec` runs commands, subagents or unknown tools, or deletes/moves files.
 * Plan blocks write and exec; Manual asks for both; Auto runs everything.
 */
export function toolTier(toolName: string, input: Record<string, unknown>): 'read' | 'write' | 'exec' {
    if (Object.hasOwn(READ_ONLY_TOOLS, toolName)) {
        return 'read';
    }
    if (toolName === 'lsp') {
        return lspMutates(input) ? 'write' : 'read';
    }
    if (toolName === 'write' || toolName === 'edit') {
        const targets = writeTargets(input);
        if (targets.length > 0 && targets.every((t) => INTERNAL_WRITE_TARGET.test(t))) {
            return 'read';
        }
        return removesOrMovesFiles(input) ? 'exec' : 'write';
    }
    return toolName === 'ast_edit' ? 'write' : 'exec';
}

export function planBlockReason(toolName: string): string {
    return (
        `Blocked: ${toolName} is not allowed. This conversation is in read-only Plan mode (set in the VS Code chat's permission menu): ` +
        'you may only read and search. Do not modify files or run commands, and do not try to work around this. ' +
        'Finish investigating, then propose a concrete plan (which files change and how) for the user to review. ' +
        'The user leaves Plan mode when they want it carried out.'
    );
}

export function deniedReason(toolName: string): string {
    return (
        `The user denied ${toolName}: in this conversation's permission mode it needs the user's approval. ` +
        'Do not retry the same call; ask the user how to proceed.'
    );
}

/** Same shape as omp's own approval prompt: `Allow tool: <name>` then detail lines. */
export function approvalTitle(toolName: string, input: Record<string, unknown>): string {
    const targets = writeTargets(input);
    let detail: string;
    if (typeof input.command === 'string') {
        detail = `Command: ${input.command}`;
    } else if (targets.length > 0) {
        detail = targets.map((t) => `File: ${t}`).join('\n');
    } else {
        try {
            detail = `Arguments: ${JSON.stringify(input)}`;
        } catch {
            detail = 'Arguments: (not serializable)';
        }
    }
    const MAX_DETAIL = 600;
    return `${APPROVAL_TITLE_PREFIX}${toolName}\n${detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail}`;
}

/** A tool-approval dialog (omp's built-in gate or this gate's Ask prompt). */
export function isToolApprovalSelect(request: { method?: unknown; title?: unknown; options?: unknown }): boolean {
    return (
        request.method === 'select' &&
        typeof request.title === 'string' &&
        request.title.startsWith(APPROVAL_TITLE_PREFIX) &&
        Array.isArray(request.options) &&
        request.options.length === 2 &&
        request.options[0] === APPROVE_OPTION &&
        request.options[1] === DENY_OPTION
    );
}

export function decideToolCall(state: PermissionGateState, toolName: string, input: Record<string, unknown>): GateDecision {
    if (state.level === 'auto') {
        return { kind: 'allow' };
    }
    const tier = toolTier(toolName, input);
    if (tier === 'read' || (state.level === 'edit' && tier === 'write')) {
        return { kind: 'allow' };
    }
    if (state.level === 'plan') {
        return { kind: 'block', reason: planBlockReason(toolName) };
    }
    if (state.allowedTools.includes(toolName)) {
        return { kind: 'allow' };
    }
    return { kind: 'ask', title: approvalTitle(toolName, input) };
}

/** The gate file's state; anything unreadable fails closed to Ask. */
export function parseGateState(text: string | undefined): PermissionGateState {
    try {
        const raw = JSON.parse(text ?? '') as { level?: unknown; allowedTools?: unknown };
        if (isPermissionLevel(raw.level)) {
            const allowedTools = Array.isArray(raw.allowedTools) ? raw.allowedTools.filter((t): t is string => typeof t === 'string') : [];
            return { level: raw.level, allowedTools };
        }
    } catch {
        /* fall through */
    }
    return { level: 'ask', allowedTools: [] };
}

/** pi-plan-mode's state entry on the session branch (same entry src/pi/planModeState.ts reads from the jsonl). */
export function nativePlanEnabled(branch: ReadonlyArray<{ type?: unknown; customType?: unknown; data?: unknown }> | undefined): boolean {
    if (!branch) {
        return false;
    }
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === 'custom' && (entry.customType === 'plan-mode-state' || entry.customType === 'plan-mode')) {
            return (entry.data as { enabled?: unknown } | undefined)?.enabled === true;
        }
    }
    return false;
}
