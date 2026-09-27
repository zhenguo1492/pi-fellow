import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';

type ButtonListener = (event: vscode.QuickPickItemButtonEvent<vscode.QuickPickItem>) => Promise<void>;

const state = vi.hoisted(() => ({
    quickPick: undefined as undefined | { items: vscode.QuickPickItem[]; triggerItemButton?: ButtonListener },
    opened: [] as string[],
}));

vi.mock('vscode', () => ({
    ThemeIcon: class {
        constructor(readonly id: string) {}
    },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    env: {
        openExternal: async (uri: { toString(): string }) => {
            state.opened.push(uri.toString());
            return true;
        },
    },
    window: {
        createQuickPick: () => {
            const quickPick = {
                items: [] as vscode.QuickPickItem[],
                triggerItemButton: undefined as ButtonListener | undefined,
                onDidChangeValue: () => ({ dispose: () => {} }),
                onDidTriggerItemButton: (listener: ButtonListener) => {
                    quickPick.triggerItemButton = listener;
                    return { dispose: () => {} };
                },
                onDidAccept: () => ({ dispose: () => {} }),
                show: () => {},
            };
            state.quickPick = quickPick;
            return quickPick;
        },
    },
}));

vi.mock('../../../pi/piPackageCatalog', () => ({
    formatCatalogDetail: () => '',
    formatCatalogOwnerLine: () => '',
    searchPiPackageCatalog: async () => [
        {
            name: 'pi-demo',
            source: 'npm:pi-demo',
            description: '',
            version: '1.0.0',
            monthlyDownloads: 0,
            resourceTypes: [],
            homepage: 'https://example.com/pi-demo',
        },
    ],
}));
vi.mock('../../../pi/piSettingsJson', () => ({ getPiPackagesFromSettings: () => [] }));
vi.mock('../../../pi/piPackageInstall', () => ({}));
vi.mock('../../../pi/piAgentConfig', () => ({}));

import { showPiPackageCatalogPicker } from '../../../pi/piPackageCatalogPicker';

describe('package catalog picker', () => {
    it('opens the homepage when its item button is clicked', async () => {
        await showPiPackageCatalogPicker(undefined);
        const quickPick = state.quickPick!;
        await vi.waitFor(() => expect(quickPick.items).toHaveLength(1));

        // VS Code passes a single event object, not (item, button).
        const [item] = quickPick.items;
        await quickPick.triggerItemButton!({ item, button: item.buttons![0] });

        expect(state.opened).toEqual(['https://example.com/pi-demo']);
    });
});
