import type { AgentBackend } from './agentBackend';

export interface RecommendedPiPackage {
    id: string;
    source: string;
    label: string;
    description: string;
    packageMatch: string;
    slashCommand?: string;
    tier: 'core' | 'optional';
}

/** Pi CLI packages this VS Code extension is designed around (not bundled in the VSIX). */
export const RECOMMENDED_PI_PACKAGES: readonly RecommendedPiPackage[] = [
    {
        id: 'pi-plan-mode',
        source: 'npm:@narumitw/pi-plan-mode',
        label: 'Plan mode',
        description: 'Plan/Agent switch, /plan, and interactive plan questions in chat.',
        packageMatch: 'pi-plan-mode',
        slashCommand: 'plan',
        tier: 'core',
    },
    {
        id: 'pi-mcp-adapter',
        source: 'npm:pi-mcp-adapter',
        label: 'MCP adapter',
        description: 'Load MCP servers from ~/.pi/agent/mcp.json and workspace configs.',
        packageMatch: 'pi-mcp-adapter',
        tier: 'optional',
    },
] as const;

export function isPackageSourceConfigured(packages: string[], match: string): boolean {
    const needle = match.toLowerCase();
    return packages.some((p) => p.toLowerCase().includes(needle));
}

/**
 * Missing = not listed in the agent settings packages.
 * omp: always none. These are pi extensions — omp's legacy pi shim cannot load them
 * (pi-plan-mode needs `withFileMutationQueue`), and omp ships MCP natively (`/mcp`).
 */
export function getMissingRecommendedPackages(
    configuredPackages: string[],
    slashCommands: string[],
    backend: AgentBackend,
): RecommendedPiPackage[] {
    if (backend === 'omp') {
        return [];
    }
    return RECOMMENDED_PI_PACKAGES.filter((pkg) => {
        if (isPackageSourceConfigured(configuredPackages, pkg.packageMatch)) {
            return false;
        }
        if (pkg.slashCommand && slashCommands.includes(pkg.slashCommand)) {
            return false;
        }
        return true;
    });
}

export function formatMissingPackagesList(missing: readonly RecommendedPiPackage[]): string {
    return missing.map((p) => `${p.label} (${p.source})`).join(', ');
}
