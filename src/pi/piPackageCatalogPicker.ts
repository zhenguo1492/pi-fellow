import * as vscode from 'vscode';
import type { PiChatSession } from './slashCommands';
import {
    formatCatalogDetail,
    formatCatalogOwnerLine,
    type PiCatalogEntry,
    searchPiPackageCatalog,
} from './piPackageCatalog';
import { installPiPackage } from './piPackageInstall';
import { packageSourceToString } from './piAgentConfig';
import { getPiPackagesFromSettings } from './piSettingsJson';

interface CatalogQuickPickItem extends vscode.QuickPickItem {
    entry: PiCatalogEntry;
    installed: boolean;
}

async function getInstalledPackageSources(): Promise<Set<string>> {
    return new Set(getPiPackagesFromSettings());
}

function entryToQuickPickItem(entry: PiCatalogEntry, installed: boolean): CatalogQuickPickItem {
    return {
        label: installed ? `$(check) ${entry.name}` : entry.name,
        description: formatCatalogOwnerLine(entry),
        detail: formatCatalogDetail(entry),
        entry,
        installed,
        buttons: entry.homepage
            ? [{ iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Open homepage' }]
            : undefined,
    };
}

export async function showPiPackageCatalogPicker(
    piSession: PiChatSession | undefined,
    outputChannel?: vscode.OutputChannel,
): Promise<void> {
    const quickPick = vscode.window.createQuickPick<CatalogQuickPickItem>();
    quickPick.title = 'Pi Package Catalog';
    quickPick.placeholder = 'Search packages from pi.dev (npm: pi-package). Same as pi install npm:…';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.ignoreFocusOut = true;

    let searchGeneration = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const runSearch = async (query: string) => {
        const gen = ++searchGeneration;
        quickPick.busy = true;
        try {
            const [entries, installed] = await Promise.all([
                searchPiPackageCatalog(query),
                getInstalledPackageSources(),
            ]);
            if (gen !== searchGeneration) {
                return;
            }
            quickPick.items = entries.map((e) => entryToQuickPickItem(e, installed.has(e.source)));
        } catch (err: any) {
            if (gen === searchGeneration) {
                quickPick.items = [{
                    label: '$(error) Search failed',
                    description: err?.message ?? String(err),
                    entry: {
                        name: '',
                        source: '',
                        description: '',
                        version: '',
                        monthlyDownloads: 0,
                        resourceTypes: [],
                    },
                    installed: false,
                    alwaysShow: true,
                }];
            }
        } finally {
            if (gen === searchGeneration) {
                quickPick.busy = false;
            }
        }
    };

    void runSearch('');

    quickPick.onDidChangeValue((value) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => void runSearch(value), 250);
    });

    quickPick.onDidTriggerItemButton(async ({ item, button }) => {
        if (button.tooltip === 'Open homepage' && item.entry.homepage) {
            await vscode.env.openExternal(vscode.Uri.parse(item.entry.homepage));
        }
    });

    quickPick.onDidAccept(async () => {
        const item = quickPick.selectedItems[0];
        quickPick.hide();
        if (!item?.entry?.source || !item.entry.name) {
            return;
        }
        if (item.installed) {
            vscode.window.showInformationMessage(`${item.entry.name} is already installed.`);
            return;
        }

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Installing ${item.entry.source}`,
                    cancellable: false,
                },
                async () => {
                    await installPiPackage(
                        item.entry.source,
                        piSession,
                        outputChannel,
                        (msg) => {
                            void vscode.window.setStatusBarMessage(`Pi Fellow: ${msg}`, 2000);
                        },
                    );
                },
            );
            vscode.window.showInformationMessage(
                `Installed ${item.entry.name}. Session reloaded.`,
                'Open pi.dev/packages',
            ).then((choice) => {
                if (choice === 'Open pi.dev/packages') {
                    void vscode.env.openExternal(vscode.Uri.parse('https://pi.dev/packages'));
                }
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Install failed: ${err?.message ?? err}`);
        }
    });

    quickPick.show();
}
