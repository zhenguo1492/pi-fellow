import * as vscode from 'vscode';
import type { PiChatSession } from './slashCommands';
import { isSyncWithPiCli } from './piCliSync';
import { getAgentLayout } from './piCliPaths';
import { installPiPackage } from './piPackageInstall';
import { getPiPackagesFromSettings } from './piSettingsJson';
import {
    formatMissingPackagesList,
    getMissingRecommendedPackages,
    RECOMMENDED_PI_PACKAGES,
    type RecommendedPiPackage,
} from './recommendedPackages';

async function installRecommendedPackages(
    packages: readonly RecommendedPiPackage[],
    sessionManager: PiChatSession | undefined,
    outputChannel: vscode.OutputChannel,
    onProgress?: (message: string) => void,
): Promise<string[]> {
    const installed: string[] = [];
    for (const pkg of packages) {
        onProgress?.(`Installing ${pkg.label}…`);
        await installPiPackage(pkg.source, sessionManager, outputChannel);
        installed.push(pkg.source);
    }
    return installed;
}

async function readSlashCommandNames(sessionManager?: PiChatSession): Promise<string[]> {
    if (!sessionManager) {
        return [];
    }
    const cmds = await sessionManager.listSlashCommands();
    return cmds.map((c) => c.name.replace(/^skill:/, ''));
}

export async function runRecommendedPackagesSetup(
    sessionManager: PiChatSession | undefined,
    outputChannel: vscode.OutputChannel,
    packagesToInstall?: readonly RecommendedPiPackage[],
): Promise<void> {
    const { backend } = getAgentLayout();
    if (backend === 'omp') {
        vscode.window.showInformationMessage(
            'Recommended Pi packages are pi extensions and do not load under omp (omp has MCP built in). Set oh-my-pi-chater.backend to "pi" to use them.',
        );
        return;
    }
    const configured = getPiPackagesFromSettings();
    const slash = await readSlashCommandNames(sessionManager);
    const missing =
        packagesToInstall ??
        getMissingRecommendedPackages(configured, slash, backend);

    if (missing.length === 0) {
        vscode.window.showInformationMessage('All recommended Pi packages are already configured.');
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Installing Pi packages',
            cancellable: false,
        },
        async (progress) => {
            await installRecommendedPackages(
                missing,
                sessionManager,
                outputChannel,
                (msg) => progress.report({ message: msg }),
            );
        },
    );

    if (sessionManager) {
        await sessionManager.reloadPiAgentResources();
    }

    vscode.window.showInformationMessage(
        `Installed: ${formatMissingPackagesList(missing)}. Reloaded Pi session.`,
    );
}

export async function maybePromptForRecommendedPackages(
    context: vscode.ExtensionContext,
    sessionManager: PiChatSession,
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    if (!isSyncWithPiCli()) {
        return;
    }

    const config = vscode.workspace.getConfiguration('oh-my-pi-chater');
    if (!config.get<boolean>('promptRecommendedPackages', true)) {
        return;
    }

    if (context.globalState.get<boolean>('ohMyPiChater.recommendedPackagesDismissed', false)) {
        return;
    }

    const configured = getPiPackagesFromSettings();
    const slash = await readSlashCommandNames(sessionManager);
    const missing = getMissingRecommendedPackages(configured, slash, getAgentLayout().backend);
    if (missing.length === 0) {
        return;
    }

    const coreMissing = missing.filter((p) => p.tier === 'core');
    const list = formatMissingPackagesList(missing);
    const detail =
        coreMissing.length > 0
            ? `Plan mode and related UI need: ${formatMissingPackagesList(coreMissing)}.`
            : `Optional: ${list}.`;

    if (config.get<boolean>('autoInstallRecommendedPackages', false)) {
        outputChannel.appendLine(`Auto-installing Pi packages: ${list}`);
        try {
            await runRecommendedPackagesSetup(sessionManager, outputChannel, missing);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Pi package install failed: ${msg}`);
        }
        return;
    }

    const choice = await vscode.window.showWarningMessage(
        `Pi Fellow: missing Pi CLI packages — ${list}. ${detail} Install via npm into ~/.pi/agent?`,
        { modal: false },
        'Install all',
        'Open Settings',
        'Later',
        "Don't ask again",
    );

    switch (choice) {
        case 'Install all':
            try {
                await runRecommendedPackagesSetup(sessionManager, outputChannel, missing);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Pi package install failed: ${msg}`);
            }
            break;
        case 'Open Settings':
            await vscode.commands.executeCommand('oh-my-pi-chater.openSettings');
            break;
        case "Don't ask again":
            await context.globalState.update('ohMyPiChater.recommendedPackagesDismissed', true);
            break;
        default:
            break;
    }
}

export function getRecommendedPackagesHelpMarkdown(): string {
    return RECOMMENDED_PI_PACKAGES.map(
        (p) => `- **${p.label}** — \`${p.source}\`: ${p.description}`,
    ).join('\n');
}
