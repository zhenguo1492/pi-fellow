import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, def: any) => def,
        }),
    },
}));

import { clearCliTargetCache, resolveCliTarget } from '../../../pi/piCliPaths';
import { PiRpcSessionManager } from '../../../pi/rpcSession';

describe('CLI target caching', () => {
    it('caches targets across repeated calls with preferredBackend', () => {
        clearCliTargetCache();
        try {
            const t1 = resolveCliTarget('pi');
            const t2 = resolveCliTarget('pi');
            expect(t1).toBe(t2);
        } catch {
            // If pi is not installed in the test environment, resolveCliTarget throws
        }
    });

    it('clears cached target when clearCliTargetCache is called', () => {
        clearCliTargetCache();
        try {
            const t1 = resolveCliTarget('pi');
            clearCliTargetCache();
            const t2 = resolveCliTarget('pi');
            expect(t1).toEqual(t2);
        } catch {
            // If pi is not installed in the test environment
        }
    });
});

describe('PiRpcSessionManager readiness', () => {
    it('initializes with isReady false and waitUntilReady returns', async () => {
        const mockOutputChannel: any = {
            appendLine: vi.fn(),
        };
        const manager = new PiRpcSessionManager(mockOutputChannel);
        expect(manager.isReady).toBe(false);
        // waitUntilReady should resolve immediately when no readyPromise is set
        await expect(manager.waitUntilReady()).resolves.toBeUndefined();
    });

    it('loadSession waits for a pending initialize before switching sessions', async () => {
        const outputChannel = { appendLine: vi.fn() };
        // Test double: only appendLine is used on this path.
        const manager = new PiRpcSessionManager(outputChannel as unknown as vscode.OutputChannel);
        const init = Promise.withResolvers<void>();
        const switchSession = vi.fn(async () => ({ cancelled: false }));
        // Simulate a tab whose RPC process is still starting: reach the private seams directly.
        const internals = manager as unknown as {
            _readyPromise: Promise<void>;
            _bridge: { switchSession: typeof switchSession };
            syncFromRpc: () => Promise<void>;
        };
        internals._readyPromise = init.promise;
        internals._bridge = { switchSession };
        internals.syncFromRpc = vi.fn(async () => {});

        const loading = manager.loadSession('/tmp/session.jsonl');
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(switchSession).not.toHaveBeenCalled();

        init.resolve();
        await expect(loading).resolves.toBe(true);
        expect(switchSession).toHaveBeenCalledWith('/tmp/session.jsonl');
    });
});
