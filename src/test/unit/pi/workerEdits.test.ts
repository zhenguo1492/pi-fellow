import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: {}, window: {} }));

import permissionGate, { type GateContext, type GateExtensionApi, type GateToolCallEvent } from '../../../piExtension/permissionGate';
import { PermissionGateFile } from '../../../pi/permissionGate';
import { EDITS_FILE_ENV, PERMISSION_FILE_ENV } from '../../../pi/permissionPolicy';
import { WorkerEditLocks } from '../../../pi/workerEdits';

const ws = (p = '') => path.join(path.resolve('/ws'), p);
const line = (...paths: string[]) => `${JSON.stringify({ paths })}\n`;

describe('WorkerEditLocks', () => {
    it('overlaps the same file, anything in a locked folder, and a folder holding a locked file', () => {
        const locks = new WorkerEditLocks();
        locks.ingest(line(ws('src/a.ts'), ws('gen')));
        expect(locks.overlapping([ws('src/a.ts')])).toEqual([ws('src/a.ts')]);
        expect(locks.overlapping([ws('gen/deep/model.ts')])).toEqual([ws('gen')]);
        expect(locks.overlapping([ws('src')])).toEqual([ws('src/a.ts')]);
        expect(locks.overlapping([ws()])).toEqual([ws('src/a.ts'), ws('gen')]);
        // Names that only start the same, and siblings, are other files.
        expect(locks.overlapping([ws('src/a.tsx'), ws('generated'), ws('src/b.ts')])).toEqual([]);
    });

    it('skips lines that are not reports, and paths that are not absolute', () => {
        const locks = new WorkerEditLocks();
        locks.ingest(`not json\n${line('relative.ts', ws('ok.ts'))}{"paths":"x"}\nnull\n`);
        expect(locks.overlapping([ws()])).toEqual([ws('ok.ts')]);
    });

    it('frees everything when cleared', () => {
        const locks = new WorkerEditLocks();
        locks.ingest(line(ws('a.ts')));
        locks.clear();
        expect(locks.overlapping([ws()])).toEqual([]);
    });
});

describe('PermissionGateFile: the edits file the gate reports to', () => {
    let gate: PermissionGateFile | undefined;

    afterEach(() => {
        gate?.dispose();
        delete process.env[EDITS_FILE_ENV];
        delete process.env[PERMISSION_FILE_ENV];
    });

    it('takes whole reports as they are appended, a half-written one on the next read, and starts over when cleared', () => {
        gate = new PermissionGateFile({ level: 'auto', allowedTools: [] });
        fs.appendFileSync(gate.editsFile, `${line(ws('a.ts'))}{"paths":["${ws('b')}`);
        expect(gate.edits().overlapping([ws()])).toEqual([ws('a.ts')]);
        fs.appendFileSync(gate.editsFile, '.ts"]}\n');
        expect(gate.edits().overlapping([ws()])).toEqual([ws('a.ts'), ws('b.ts')]);
        gate.clearEdits();
        expect(gate.edits().overlapping([ws()])).toEqual([]);
        fs.appendFileSync(gate.editsFile, line(ws('c.ts')));
        expect(gate.edits().overlapping([ws()])).toEqual([ws('c.ts')]);
    });

    it('removes the file with the worker', () => {
        const disposed = new PermissionGateFile({ level: 'auto', allowedTools: [] });
        disposed.dispose();
        expect(fs.existsSync(disposed.editsFile)).toBe(false);
    });

    it("sees the worker gate's report before the tool it announces runs", async () => {
        gate = new PermissionGateFile({ level: 'edit', allowedTools: [] });
        process.env[PERMISSION_FILE_ENV] = gate.file;
        process.env[EDITS_FILE_ENV] = gate.editsFile;
        let handler: ((event: GateToolCallEvent, ctx: GateContext) => Promise<unknown>) | undefined;
        const pi: GateExtensionApi = { on: (_event, h) => (handler = h) };
        permissionGate(pi);
        const ctx: GateContext = { ui: { select: async () => undefined }, cwd: ws() };
        expect(await handler!({ toolName: 'edit', input: { path: 'src/a.ts', edits: [] } }, ctx)).toBeUndefined();
        expect(gate.edits().overlapping([ws('src/a.ts')])).toEqual([ws('src/a.ts')]);
    });
});
