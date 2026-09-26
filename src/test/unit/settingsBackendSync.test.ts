import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiChatSession } from '../../pi/slashCommands';

const state = vi.hoisted(() => ({
    backend: 'pi' as 'pi' | 'omp',
    listeners: [] as Array<(event: { affectsConfiguration: (key: string) => boolean }) => void>,
    backendListeners: [] as Array<(backend: 'pi' | 'omp') => void>,
    messages: [] as Array<{ type: string; data?: { backend: string } }>,
    dispose: undefined as (() => void) | undefined,
}));

vi.mock('vscode', () => ({
    ConfigurationTarget: { Global: 1 },
    ViewColumn: { One: 1 },
    Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, fallback: unknown) => fallback,
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
    setWindowBackend: (backend: 'pi' | 'omp') => {
        state.backend = backend;
        for (const listener of state.backendListeners) {
            listener(backend);
        }
    },
    onDidChangeWindowBackend: (listener: (backend: 'pi' | 'omp') => void) => {
        state.backendListeners.push(listener);
        return { dispose: () => { state.backendListeners.splice(state.backendListeners.indexOf(listener), 1); } };
    },
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
vi.mock('../../voice/voiceSettings', () => ({
    readVoiceSettings: () => ({}),
    readTtsSettings: () => ({}),
    onVoiceReadinessChange: () => ({ dispose: () => {} }),
    voiceReadiness: () => ({ stt: { ok: true }, tts: { ok: true } }),
}));

import { setWindowBackend } from '../../pi/piCliPaths';
import { SettingsPanel } from '../../providers/settings-panel';

describe('settings backend selection', () => {
    afterEach(() => {
        state.dispose?.();
        state.messages.length = 0;
        state.listeners.length = 0;
        state.backendListeners.length = 0;
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

        setWindowBackend('omp');
        expect(shownBackend()).toBe('omp');

        SettingsPanel.show({} as vscode.Uri, {} as vscode.SecretStorage, staleSession);
        expect(shownBackend()).toBe('omp');

        state.dispose?.();
        SettingsPanel.show({} as vscode.Uri, {} as vscode.SecretStorage, staleSession);
        expect(shownBackend()).toBe('omp');

        setWindowBackend('pi');
        expect(shownBackend()).toBe('pi');
    });
});
