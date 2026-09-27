import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    configBackend: 'pi' as 'pi' | 'omp',
    configListeners: [] as Array<(event: { affectsConfiguration: (key: string) => boolean }) => void>,
}));

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            // A missing CLI path forces the layout fallback, so tests do not depend on installed CLIs.
            get: (key: string, fallback: unknown) =>
                key === 'backend' ? state.configBackend : key === 'cliPath' ? '/nonexistent/cli' : fallback,
        }),
        onDidChangeConfiguration: (listener: (event: { affectsConfiguration: (key: string) => boolean }) => void) => {
            state.configListeners.push(listener);
            return { dispose: () => state.configListeners.splice(state.configListeners.indexOf(listener), 1) };
        },
    },
}));

import { resolveAgentDir } from '../../../pi/agentBackend';
import {
    getAgentLayout,
    getPiAgentDir,
    initWindowBackend,
    onDidChangeWindowBackend,
    setWindowBackend,
} from '../../../pi/piCliPaths';

function memento(): vscode.Memento {
    const values = new Map<string, unknown>();
    return {
        keys: () => [...values.keys()],
        get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
        update: async (key: string, value: unknown) => {
            values.set(key, value);
        },
    } as vscode.Memento;
}

/** Another window writing the shared user setting. */
function changeSharedSetting(backend: 'pi' | 'omp'): void {
    state.configBackend = backend;
    for (const listener of [...state.configListeners]) {
        listener({ affectsConfiguration: (key) => key === 'oh-my-pi-chater' || key === 'oh-my-pi-chater.backend' });
    }
}

describe('per-window backend', () => {
    beforeEach(() => {
        state.configBackend = 'pi';
        state.configListeners.length = 0;
    });

    it('keeps the picked backend when another window changes the shared setting', () => {
        initWindowBackend(memento());
        const seen: string[] = [];
        const sub = onDidChangeWindowBackend((b) => seen.push(b));

        setWindowBackend('omp');
        changeSharedSetting('pi');

        expect(getAgentLayout().backend).toBe('omp');
        expect(seen).toEqual(['omp']);
        sub.dispose();
    });

    it('restores the pick for the same workspace after reload', () => {
        const workspaceState = memento();
        initWindowBackend(workspaceState);
        setWindowBackend('omp');

        initWindowBackend(workspaceState);
        expect(getAgentLayout().backend).toBe('omp');
    });

    it('follows the shared setting until this window picks a backend', () => {
        initWindowBackend(memento());
        const seen: string[] = [];
        const sub = onDidChangeWindowBackend((b) => seen.push(b));

        changeSharedSetting('omp');

        expect(getAgentLayout().backend).toBe('omp');
        expect(seen).toEqual(['omp']);
        sub.dispose();
    });

    it('resolves the agent dir of an explicitly requested backend, not the window one', () => {
        initWindowBackend(memento());
        setWindowBackend('omp');

        expect(getPiAgentDir('pi')).toBe(resolveAgentDir('pi'));
        expect(getPiAgentDir()).toBe(resolveAgentDir('omp'));
    });
});
