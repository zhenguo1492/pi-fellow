import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiChatSession } from '../../pi/slashCommands';

const state = vi.hoisted(() => ({
    backend: 'pi' as 'pi' | 'omp',
    listeners: [] as Array<(event: { affectsConfiguration: (key: string) => boolean }) => void>,
    messages: [] as Array<{ type: string; data?: { backend: string } }>,
    dispose: undefined as (() => void) | undefined,
}));

vi.mock('vscode', () => ({
    ConfigurationTarget: { Global: 1 },
    ViewColumn: { One: 1 },
    Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
    workspace: {
        getConfiguration: () => ({
            get: (key: string, fallback: unknown) => key === 'backend' ? state.backend : fallback,
            update: async (key: string, value: 'pi' | 'omp') => {
                if (key !== 'backend') return;
                state.backend = value;
                for (const listener of state.listeners) {
                    listener({ affectsConfiguration: (name) => name === 'oh-my-pi-chater' || name === 'oh-my-pi-chater.backend' });
                }
            },
        }),
        onDidChangeConfiguration: (listener: (event: { affectsConfiguration: (key: string) => boolean }) => void) => {
            state.listeners.push(listener);
            return { dispose: () => { state.listeners.splice(state.listeners.indexOf(listener), 1); } };
        },
    },
    window: {
        createWebviewPanel: () => ({
            webview: {
                cspSource: 'test',
                asWebviewUri: (uri: unknown) => uri,
                postMessage: (message: { type: string; data?: { backend: string } }) => { state.messages.push(message); },
                onDidReceiveMessage: () => ({ dispose() {} }),
            },
            onDidDispose: (listener: () => void) => {
                state.dispose = listener;
                return { dispose() {} };
            },
            reveal() {},
        }),
    },
}));

vi.mock('../../pi/piCliPaths', () => ({
    getAgentLayout: () => ({ backend: state.backend, agentDir: `/agent/${state.backend}` }),
    getAvailableBackends: () => ['omp', 'pi'],
    clearCliTargetCache: () => {},
}));
vi.mock('../../pi/piCliSync', () => ({
    getPiAgentDir: (backend: string) => `/agent/${backend}`,
    isSyncWithPiCli: () => false,
}));
vi.mock('../../pi/piAgentConfig', () => ({}));
vi.mock('../../pi/mcpConfig', () => ({}));
vi.mock('../../pi/recommendedPackages', () => ({}));
vi.mock('../../pi/piPackageCatalogPicker', () => ({}));
vi.mock('../../pi/piExtensionCompat', () => ({}));
vi.mock('../../pi/slashCommands', () => ({}));
vi.mock('../../voice/stt', () => ({}));
vi.mock('../../voice/voiceSettings', () => ({ readVoiceSettings: () => ({}) }));

import { SettingsPanel } from '../../providers/settings-panel';

describe('settings backend selection', () => {
    afterEach(() => {
        state.dispose?.();
        state.messages.length = 0;
        state.listeners.length = 0;
        state.backend = 'pi';
        state.dispose = undefined;
    });

    it('follows chat backend changes in an open panel and on reopen despite a stale session', async () => {
        const staleSession = {
            backend: 'pi',
            getSkillsAsync: async () => [],
            getExtensionLoadIssues: () => [],
            getLoadedExtensionCount: () => 0,
        } as unknown as PiChatSession;
        SettingsPanel.show({} as vscode.Uri, {} as vscode.SecretStorage, staleSession);
        const shownBackend = () => state.messages.filter((msg) => msg.type === 'settings').at(-1)?.data?.backend;
        expect(shownBackend()).toBe('pi');

        await vi.mocked(vscode.workspace.getConfiguration().update)('backend', 'omp', vscode.ConfigurationTarget.Global);
        expect(shownBackend()).toBe('omp');

        SettingsPanel.show({} as vscode.Uri, {} as vscode.SecretStorage, staleSession);
        expect(shownBackend()).toBe('omp');

        state.dispose?.();
        SettingsPanel.show({} as vscode.Uri, {} as vscode.SecretStorage, staleSession);
        expect(shownBackend()).toBe('omp');

        await vi.mocked(vscode.workspace.getConfiguration().update)('backend', 'pi', vscode.ConfigurationTarget.Global);
        expect(shownBackend()).toBe('pi');
    });
});
