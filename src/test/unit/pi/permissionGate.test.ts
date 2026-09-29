import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ window: {} }));

import permissionGate, { type GateContext, type GateExtensionApi, type GateToolCallEvent } from '../../../piExtension/permissionGate';
import { EDITS_FILE_ENV, PERMISSION_FILE_ENV, type PermissionGateState } from '../../../pi/permissionPolicy';
import { RpcExtensionUiHandler } from '../../../pi/rpcExtensionUi';
import type { PiRpcBridge } from '../../../pi/piRpcBridge';
import type { RpcExtensionUIRequest } from '../../../pi/rpcTypes';

type Handler = (event: GateToolCallEvent, ctx: GateContext) => Promise<{ block: true; reason: string } | undefined>;

let dir: string;
let file: string;
let editsFile: string;
let handler: Handler;

function writeState(state: PermissionGateState): void {
    fs.writeFileSync(file, JSON.stringify(state));
}

/** What the gate reported to the host so far: one list of absolute paths per call. */
function reported(): string[][] {
    const text = fs.existsSync(editsFile) ? fs.readFileSync(editsFile, 'utf8') : '';
    return text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const report: { paths: string[] } = JSON.parse(line);
            return report.paths;
        });
}

/** A worker-side context whose dialogs answer `choice`; records what was asked. */
function context(choice: string | undefined, branch: GateContext['sessionManager'] = undefined) {
    const asked: Array<{ title: string; options: string[] }> = [];
    const ctx: GateContext = {
        ui: {
            select: async (title, options) => {
                asked.push({ title, options });
                return choice;
            },
        },
        sessionManager: branch,
    };
    return { ctx, asked };
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-gate-'));
    file = path.join(dir, 'state.json');
    editsFile = path.join(dir, 'edits.ndjson');
    process.env[PERMISSION_FILE_ENV] = file;
    process.env[EDITS_FILE_ENV] = editsFile;
    const pi: GateExtensionApi = {
        on: (_event, h) => {
            handler = h;
        },
    };
    permissionGate(pi);
});

afterEach(() => {
    delete process.env[PERMISSION_FILE_ENV];
    delete process.env[EDITS_FILE_ENV];
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('permission gate: auto', () => {
    it('runs commands and edits without asking', async () => {
        writeState({ level: 'auto', allowedTools: [] });
        const { ctx, asked } = context('Deny');
        expect(await handler({ toolName: 'bash', input: { command: 'rm -rf build' } }, ctx)).toBeUndefined();
        expect(await handler({ toolName: 'write', input: { path: 'a.ts', content: 'x' } }, ctx)).toBeUndefined();
        expect(asked).toEqual([]);
    });
});

describe('permission gate: plan', () => {
    it('blocks tools that change files or run commands, telling the model it is read-only', async () => {
        writeState({ level: 'plan', allowedTools: ['bash'] });
        const { ctx, asked } = context('Approve');
        for (const [toolName, input] of [
            ['bash', { command: 'ls' }],
            ['edit', { path: 'src/a.ts' }],
            ['write', { path: 'src/a.ts', content: '' }],
            ['ast_edit', {}],
            ['task', { tasks: [] }],
            ['mcp__github__create_issue', {}],
            ['lsp', { action: 'rename', symbol: 'x', new_name: 'y' }],
        ] as const) {
            const result = await handler({ toolName, input }, ctx);
            expect(result, toolName).toEqual({ block: true, reason: expect.stringMatching(/read-only Plan mode.*propose a concrete plan/s) });
        }
        // Plan never asks, even for tools allowed in Manual.
        expect(asked).toEqual([]);
    });

    it('lets reading, searching and plan scratch files through', async () => {
        writeState({ level: 'plan', allowedTools: [] });
        const { ctx } = context(undefined);
        for (const [toolName, input] of [
            ['read', { path: 'a.ts' }],
            ['grep', { pattern: 'x' }],
            ['find', { pattern: '*.ts' }],
            ['lsp', { action: 'references', symbol: 'x' }],
            ['lsp', { action: 'rename', apply: false }],
            ['write', { path: 'local://PLAN.md', content: '# plan' }],
        ] as const) {
            expect(await handler({ toolName, input }, ctx), toolName).toBeUndefined();
        }
    });
});

describe('permission gate: manual (ask)', () => {
    it("runs a change only after the user's Approve, showing what it would do", async () => {
        writeState({ level: 'ask', allowedTools: [] });
        const approve = context('Approve');
        expect(await handler({ toolName: 'bash', input: { command: 'npm test' } }, approve.ctx)).toBeUndefined();
        expect(approve.asked).toEqual([{ title: 'Allow tool: bash\nCommand: npm test', options: ['Approve', 'Deny'] }]);
        expect(await handler({ toolName: 'read', input: { path: 'a.ts' } }, approve.ctx)).toBeUndefined();
        expect(approve.asked).toHaveLength(1);
    });

    it('blocks the call when the user denies or dismisses the dialog', async () => {
        writeState({ level: 'ask', allowedTools: [] });
        for (const choice of ['Deny', undefined]) {
            const result = await handler({ toolName: 'edit', input: { path: 'src/a.ts' } }, context(choice).ctx);
            expect(result).toEqual({ block: true, reason: expect.stringMatching(/user denied edit/) });
        }
    });

    it('does not ask for tools in allowedTools', async () => {
        writeState({ level: 'ask', allowedTools: ['edit'] });
        const { ctx, asked } = context('Deny');
        expect(await handler({ toolName: 'edit', input: { path: 'a.ts' } }, ctx)).toBeUndefined();
        expect(await handler({ toolName: 'bash', input: { command: 'ls' } }, ctx)).toEqual({ block: true, reason: expect.any(String) });
        expect(asked.map((a) => a.title.split('\n')[0])).toEqual(['Allow tool: bash']);
    });

    it('picks up a level change on the next call, without a restart', async () => {
        writeState({ level: 'ask', allowedTools: [] });
        const { ctx, asked } = context('Deny');
        writeState({ level: 'auto', allowedTools: [] });
        expect(await handler({ toolName: 'bash', input: { command: 'ls' } }, ctx)).toBeUndefined();
        writeState({ level: 'plan', allowedTools: [] });
        expect(await handler({ toolName: 'bash', input: { command: 'ls' } }, ctx)).toMatchObject({ block: true });
        expect(asked).toEqual([]);
    });
});

describe('permission gate: edit automatically', () => {
    it('changes file contents without asking', async () => {
        writeState({ level: 'edit', allowedTools: [] });
        const { ctx, asked } = context('Deny');
        for (const [toolName, input] of [
            ['edit', { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }],
            ['edit', { path: 'src/a.ts', old_string: 'a', new_string: 'b' }],
            ['edit', { input: '[src/a.ts#1A2B]\nPUT 3.=3:\n+REM is a word here, not an op\n' }],
            ['write', { path: 'src/new.ts', content: 'x' }],
            ['ast_edit', { ops: [], paths: ['src'] }],
            ['lsp', { action: 'rename', symbol: 'x', new_name: 'y' }],
        ] as const) {
            expect(await handler({ toolName, input }, ctx), JSON.stringify(input)).toBeUndefined();
        }
        expect(asked).toEqual([]);
    });

    it('still asks before commands, subagents, unknown tools, and edits that delete or move files', async () => {
        writeState({ level: 'edit', allowedTools: [] });
        const { ctx, asked } = context('Deny');
        for (const [toolName, input] of [
            ['bash', { command: 'rm -rf build' }],
            ['task', { tasks: [] }],
            ['mcp__github__create_issue', {}],
            ['edit', { input: '[src/old.ts#1A2B]\nREM\n' }],
            ['edit', { input: '[src/a.ts#1A2B]\nMV src/b.ts\n' }],
            ['edit', { input: '*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch' }],
            ['edit', { input: '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n*** End Patch' }],
            ['edit', { path: 'src/old.ts', edits: [{ op: 'delete' }] }],
            ['edit', { path: 'src/a.ts', edits: [{ rename: 'src/b.ts' }] }],
        ] as const) {
            const result = await handler({ toolName, input }, ctx);
            expect(result, JSON.stringify(input)).toEqual({ block: true, reason: expect.stringMatching(/user denied/) });
        }
        expect(asked.map((a) => a.title.split('\n')[0])).toEqual([
            'Allow tool: bash',
            'Allow tool: task',
            'Allow tool: mcp__github__create_issue',
            ...Array(6).fill('Allow tool: edit'),
        ]);
    });
});

describe('permission gate: state file and pi plan mode', () => {
    it('fails closed to Ask when the state file is missing or unreadable', async () => {
        fs.writeFileSync(file, 'not json');
        const broken = context('Deny');
        expect(await handler({ toolName: 'bash', input: { command: 'ls' } }, broken.ctx)).toMatchObject({ block: true });
        fs.rmSync(file);
        const missing = context('Deny');
        expect(await handler({ toolName: 'bash', input: { command: 'ls' } }, missing.ctx)).toMatchObject({ block: true });
        expect([broken.asked.length, missing.asked.length]).toEqual([1, 1]);
    });

    it("defers to pi's own plan mode while it is on, and applies the level again once it is left", async () => {
        writeState({ level: 'ask', allowedTools: [] });
        const entries = [{ type: 'custom', customType: 'plan-mode-state', data: { enabled: true } }];
        const { ctx, asked } = context('Deny', { getBranch: () => entries });
        expect(await handler({ toolName: 'bash', input: { command: 'git status' } }, ctx)).toBeUndefined();
        entries.push({ type: 'custom', customType: 'plan-mode-state', data: { enabled: false } });
        expect(await handler({ toolName: 'bash', input: { command: 'npm run build' } }, ctx)).toMatchObject({ block: true });
        expect(asked).toHaveLength(1);
    });
});

describe('permission gate: reporting file changes to the host', () => {
    const cwd = path.resolve('/ws');
    const at = (...paths: string[]) => paths.map((p) => path.join(cwd, p));

    it('reports the files a change will touch, absolute, before the tool runs', async () => {
        writeState({ level: 'auto', allowedTools: [] });
        const { ctx } = context(undefined);
        const worker = { ...ctx, cwd };
        for (const [toolName, input] of [
            ['write', { path: 'src/new.ts', content: 'x' }],
            ['edit', { file_path: path.join(cwd, 'src/abs.ts'), old_string: 'a', new_string: 'b' }],
            // An omp hashline patch: every section once, and where a moved file goes.
            ['edit', { input: '[src/a.ts#1A2B]\nPUT 3.=4:\n+x\n[src/b.ts#3C4D]\nMV src/c.ts\n[src/a.ts#1A2B]\nPUT >9:\n+MV not/an/op.ts\n' }],
            ['edit', { input: '*** Begin Patch\n*** Update File: src/d.ts\n*** Move to: src/e.ts\n*** Delete File: src/f.ts\n*** End Patch' }],
            ['edit', { path: 'src/g.ts', edits: [{ rename: 'src/h.ts' }] }],
        ] as const) {
            expect(await handler({ toolName, input }, worker), JSON.stringify(input)).toBeUndefined();
        }
        expect(reported()).toEqual([
            at('src/new.ts'),
            at('src/abs.ts'),
            at('src/a.ts', 'src/b.ts', 'src/c.ts'),
            at('src/d.ts', 'src/e.ts', 'src/f.ts'),
            at('src/g.ts', 'src/h.ts'),
        ]);
    });

    it('reports a rewrite over a glob as its folder, and one without paths as the whole working folder', async () => {
        writeState({ level: 'auto', allowedTools: [] });
        const worker = { ...context(undefined).ctx, cwd };
        await handler({ toolName: 'ast_edit', input: { ops: [], paths: ['src/gen/**/*.ts', 'lib/util.ts'] } }, worker);
        await handler({ toolName: 'ast_edit', input: { ops: [] } }, worker);
        await handler({ toolName: 'lsp', input: { action: 'rename_file', file: 'src/old.ts', new_name: 'src/new.ts' } }, worker);
        expect(reported()).toEqual([at('src/gen', 'lib/util.ts'), [cwd], at('src/old.ts', 'src/new.ts')]);
    });

    it('reports a change still waiting on the user, since it may run the moment they approve', async () => {
        writeState({ level: 'ask', allowedTools: [] });
        const worker = { ...context('Deny').ctx, cwd };
        expect(await handler({ toolName: 'edit', input: { path: 'src/a.ts' } }, worker)).toMatchObject({ block: true });
        expect(reported()).toEqual([at('src/a.ts')]);
    });

    it('reports nothing for reads, commands, internal scratch files, or changes Plan blocks', async () => {
        writeState({ level: 'auto', allowedTools: [] });
        const worker = { ...context(undefined).ctx, cwd };
        await handler({ toolName: 'read', input: { path: 'src/a.ts' } }, worker);
        await handler({ toolName: 'bash', input: { command: 'rm src/a.ts' } }, worker);
        await handler({ toolName: 'write', input: { path: 'local://PLAN.md', content: '# plan' } }, worker);
        await handler({ toolName: 'lsp', input: { action: 'references', file: 'src/a.ts' } }, worker);
        writeState({ level: 'plan', allowedTools: [] });
        expect(await handler({ toolName: 'edit', input: { path: 'src/a.ts' } }, worker)).toMatchObject({ block: true });
        expect(reported()).toEqual([]);
    });

    it("resolves relative paths against the process's folder when the context has none", async () => {
        writeState({ level: 'auto', allowedTools: [] });
        await handler({ toolName: 'write', input: { path: 'a.ts', content: '' } }, context(undefined).ctx);
        expect(reported()).toEqual([[path.resolve(process.cwd(), 'a.ts')]]);
    });
});

describe('RpcExtensionUiHandler: tool approval prompts', () => {
    const ompPrompt: RpcExtensionUIRequest = { type: 'extension_ui_request', id: 'r1', method: 'select', title: 'Allow tool: bash\nCommand: ls', options: ['Approve', 'Deny'] };

    function handlerWithBridge() {
        const sent: unknown[] = [];
        const ui = new RpcExtensionUiHandler({ sendExtensionUiResponse: (r: unknown) => sent.push(r) } as unknown as PiRpcBridge);
        const posted: unknown[] = [];
        ui.setPost((m) => posted.push(m));
        return { ui, sent, posted };
    }

    it('in Auto approves them without showing a dialog', () => {
        const { ui, sent, posted } = handlerWithBridge();
        ui.autoApproveTools = true;
        ui.handleRequest(ompPrompt);
        expect(sent).toEqual([{ type: 'extension_ui_response', id: 'r1', value: 'Approve' }]);
        expect([posted, ui.pendingRequests()]).toEqual([[], []]);
    });

    it('otherwise shows them to the user, as it does any other select', () => {
        const { ui, sent, posted } = handlerWithBridge();
        ui.handleRequest(ompPrompt);
        ui.autoApproveTools = true;
        ui.handleRequest({ ...ompPrompt, id: 'r2', title: 'Pick a color', options: ['Approve', 'Deny'] });
        expect(sent).toEqual([]);
        expect(ui.pendingRequests().map((r) => r.id)).toEqual(['r1', 'r2']);
        expect(posted).toHaveLength(2);
    });
});
