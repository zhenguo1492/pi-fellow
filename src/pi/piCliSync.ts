import * as vscode from 'vscode';
import { readPiCliSettingsSummary } from './piSettingsJson';
import { getAgentLayout } from './piCliPaths';
import { readOmpConfigSummary } from './ompAgentConfig';
import type { AgentBackend } from './agentBackend';

export { getPiAgentDir } from './piCliPaths';
export { readPiCliSettingsSummary } from './piSettingsJson';
export { readOmpConfigSummary } from './ompAgentConfig';

export const SYNC_WITH_PI_CLI_KEY = 'syncWithPiCli';

export function readAgentSettingsSummary(preferredBackend?: AgentBackend): {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
    packageCount: number;
    extensionCount: number;
} {
    const layout = getAgentLayout(preferredBackend);
    if (layout.backend === 'omp') {
        return readOmpConfigSummary(layout.agentDir);
    }
    return readPiCliSettingsSummary();
}

/** Pi config always follows ~/.pi/agent when using CLI RPC backend. */
export function isSyncWithPiCli(): boolean {
    return vscode.workspace.getConfiguration('oh-my-pi-chater').get<boolean>(SYNC_WITH_PI_CLI_KEY, true);
}

/** Remove extension-only API keys so ~/.pi/agent/auth.json is the single source. */
export async function clearExtensionApiKeySecrets(secrets: vscode.SecretStorage): Promise<number> {
    const providers = [
        'anthropic', 'openai', 'google', 'deepseek', 'azure', 'mistral', 'groq',
        'xai', 'openrouter', 'cursor',
    ];
    let cleared = 0;
    for (const provider of providers) {
        const key = `oh-my-pi-chater.apiKey.${provider}`;
        const existing = await secrets.get(key);
        if (existing) {
            await secrets.delete(key);
            cleared++;
        }
    }
    return cleared;
}

export async function applyPiCliDefaultModel(
    sessionManager: {
        backend?: AgentBackend;
        setModel: (provider: string, modelId: string) => Promise<void>;
        setThinkingLevel: (level: string) => void;
        getModels?: () => Array<{ provider: string; id: string }>;
    },
    preferredBackend?: AgentBackend,
): Promise<boolean> {
    if (!isSyncWithPiCli()) {
        return false;
    }
    const targetBackend = preferredBackend ?? sessionManager.backend;
    const summary = readAgentSettingsSummary(targetBackend);
    if (!summary.defaultProvider || !summary.defaultModel) {
        return false;
    }
    if (sessionManager.getModels) {
        try {
            const available = sessionManager.getModels();
            if (available.length > 0) {
                const hasModel = available.some(
                    (m) =>
                        m.provider.toLowerCase() === summary.defaultProvider?.toLowerCase() &&
                        m.id.toLowerCase() === summary.defaultModel?.toLowerCase(),
                );
                if (!hasModel) {
                    return false;
                }
            }
        } catch {
            /* ignore */
        }
    }
    try {
        await sessionManager.setModel(summary.defaultProvider, summary.defaultModel);
        if (summary.defaultThinkingLevel) {
            sessionManager.setThinkingLevel(summary.defaultThinkingLevel);
        }
        return true;
    } catch {
        return false;
    }
}

export function listConfiguredProviders(models: Array<{ provider: string }>): string[] {
    return [...new Set(models.map((m) => m.provider))].sort();
}
