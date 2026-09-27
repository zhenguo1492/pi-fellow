import type * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
    const nodeFs = require('node:fs') as typeof fs;
    const nodeOs = require('node:os') as typeof os;
    const nodePath = require('node:path') as typeof path;
    // Fake home + PATH holding only `pi`, so the omp fallback install dirs under $HOME are empty.
    const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'stale-backend-'));
    const bin = nodePath.join(home, 'bin');
    nodeFs.mkdirSync(bin);
    nodeFs.writeFileSync(nodePath.join(bin, 'pi'), '#!/bin/sh\n', { mode: 0o755 });
    return { home, bin };
});

vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof os>();
    return { ...actual, homedir: () => env.home };
});

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (key: string, fallback: unknown) => (key === 'backend' ? 'auto' : key === 'cliPath' ? '' : fallback),
        }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
}));

import { getAvailableBackends, initWindowBackend, resolveCliTarget } from '../../../pi/piCliPaths';

const systemOmp = ['/opt/homebrew/bin/omp', '/usr/local/bin/omp'].some((p) => fs.existsSync(p));

describe('window backend pick whose CLI is gone', () => {
    const originalPath = process.env.PATH;
    afterAll(() => {
        process.env.PATH = originalPath;
        fs.rmSync(env.home, { recursive: true, force: true });
    });

    it.skipIf(systemOmp || os.platform() === 'win32')('falls back to the installed CLI instead of failing', () => {
        process.env.PATH = env.bin;
        const saved: Record<string, unknown> = { 'oh-my-pi-chater.windowBackend': 'omp' };
        initWindowBackend({ get: (key: string) => saved[key] } as vscode.Memento);

        expect(getAvailableBackends()).toEqual(['pi']);
        expect(resolveCliTarget()).toEqual({ backend: 'pi', cliPath: path.join(env.bin, 'pi') });
    });
});
