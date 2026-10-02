import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAgentDir } from './agentBackend';
import { readLoggedInProviders } from './loggedInProviders';
import type { ModelInfo, PiAgentConfigData, PiAuthProviderInfo } from '../shared/protocol';
import type { PiChatSession } from './slashCommands';

// js-yaml is bundled by esbuild
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml: any = require('js-yaml');

export function getOmpAgentDir(): string {
    return resolveAgentDir('omp');
}

export function readOmpConfig(agentDir: string = getOmpAgentDir()): Record<string, any> {
    const filePath = path.join(agentDir, 'config.yml');
    if (!fs.existsSync(filePath)) {
        return {};
    }
    try {
        const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function writeOmpConfig(
    mutator: (current: Record<string, any>) => Record<string, any>,
    agentDir: string = getOmpAgentDir(),
): void {
    const filePath = path.join(agentDir, 'config.yml');
    fs.mkdirSync(agentDir, { recursive: true });
    const current = readOmpConfig(agentDir);
    const next = mutator({ ...current });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, yaml.dump(next, { indent: 2, lineWidth: -1 }), 'utf8');
    fs.renameSync(tmp, filePath);
}

export function readOmpModelsYml(agentDir: string = getOmpAgentDir()): Record<string, any> {
    const filePath = path.join(agentDir, 'models.yml');
    if (!fs.existsSync(filePath)) {
        return {};
    }
    try {
        const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export async function readOmpAuthProviders(agentDir: string = getOmpAgentDir()): Promise<PiAuthProviderInfo[]> {
    const providersMap = new Map<string, boolean>();

    // 1. Logged in providers via agent.db
    try {
        const dbProviders = await readLoggedInProviders({ backend: 'omp', agentDir });
        if (dbProviders) {
            for (const p of dbProviders) {
                providersMap.set(p, true);
            }
        }
    } catch {
        /* ignore */
    }

    // 2. Providers configured in models.yml
    try {
        const models = readOmpModelsYml(agentDir);
        if (models?.providers && typeof models.providers === 'object') {
            for (const p of Object.keys(models.providers)) {
                providersMap.set(p, true);
            }
        }
    } catch {
        /* ignore */
    }

    // 3. Environment variables
    const envVarMap: Record<string, string> = {
        anthropic: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY',
        google: 'GEMINI_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        groq: 'GROQ_API_KEY',
        xai: 'XAI_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        mistral: 'MISTRAL_API_KEY',
    };
    for (const [provider, envName] of Object.entries(envVarMap)) {
        if (process.env[envName]) {
            providersMap.set(provider, true);
        }
    }

    return Array.from(providersMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, configured]) => ({ id, configured }));
}

export function readOmpConfigSummary(agentDir: string = getOmpAgentDir()): {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
    packageCount: number;
    extensionCount: number;
} {
    const cfg = readOmpConfig(agentDir);
    let defaultProvider: string | undefined;
    let defaultModel: string | undefined;

    const defaultRole = cfg.modelRoles?.default;
    if (typeof defaultRole === 'string' && defaultRole.trim()) {
        const parts = defaultRole.trim().split('/');
        if (parts.length >= 2) {
            defaultProvider = parts[0];
            defaultModel = parts.slice(1).join('/');
        } else {
            defaultModel = defaultRole.trim();
        }
    }

    return {
        defaultProvider,
        defaultModel,
        defaultThinkingLevel: typeof cfg.defaultThinkingLevel === 'string' ? cfg.defaultThinkingLevel : 'high',
        packageCount: 0,
        extensionCount: Array.isArray(cfg.extensions) ? cfg.extensions.length : 0,
    };
}

export async function readOmpAgentConfigData(
    sessionManager?: PiChatSession,
    agentDir: string = getOmpAgentDir(),
): Promise<PiAgentConfigData> {
    const cfg = readOmpConfig(agentDir);
    const authProviders = await readOmpAuthProviders(agentDir);
    const skillPaths = Array.isArray(cfg.skills?.customDirectories)
        ? cfg.skills.customDirectories.filter((x: any): x is string => typeof x === 'string')
        : [];
    const enableSkillCommands = cfg.skills?.enableSkillCommands !== false;
    const steeringMode = cfg.steeringMode === 'all' ? 'all' : 'one-at-a-time';
    const followUpMode = cfg.followUpMode === 'all' ? 'all' : 'one-at-a-time';
    const mcpFileExists = fs.existsSync(path.join(agentDir, 'mcp.json'));

    let availableModels: ModelInfo[] = [];
    if (sessionManager) {
        availableModels = sessionManager.getModels();
    }

    let commands: any[] = [];
    if (sessionManager) {
        try {
            const cmds = await sessionManager.listSlashCommands();
            commands = cmds.map((c) => ({
                name: c.name,
                invocationName: c.name,
                description: c.description,
                source: c.source,
            }));
        } catch {
            commands = [];
        }
    }

    return {
        packages: [],
        extensionPaths: Array.isArray(cfg.extensions) ? cfg.extensions : [],
        skillPaths,
        enableSkillCommands,
        steeringMode,
        followUpMode,
        authProviders,
        mcpFileExists,
        commands,
        availableModels,
    };
}

/** `modelRoles.default` and `defaultThinkingLevel` in config.yml; `''` model clears the default (auto). */
export function updateOmpDefaults(
    fields: { provider?: string; model?: string; thinkingLevel?: string },
    agentDir: string = getOmpAgentDir(),
): void {
    writeOmpConfig((current) => {
        const next = { ...current };
        if (fields.thinkingLevel !== undefined) {
            next.defaultThinkingLevel = fields.thinkingLevel;
        }
        if (fields.model !== undefined) {
            const modelRoles = { ...(next.modelRoles || {}) };
            if (fields.model) {
                modelRoles.default = fields.provider ? `${fields.provider}/${fields.model}` : fields.model;
            } else {
                delete modelRoles.default;
            }
            next.modelRoles = modelRoles;
        }
        return next;
    }, agentDir);
}

/** `skills.customDirectories`, as given (trimmed, without blanks or repeats). */
export async function setOmpSkillPaths(paths: readonly string[], agentDir: string = getOmpAgentDir()): Promise<void> {
    writeOmpConfig((current) => ({
        ...current,
        skills: { ...(current.skills || {}), customDirectories: cleanPaths(paths) },
    }), agentDir);
}

/** A path list as it is written: trimmed, without blanks or repeats, in order. */
export function cleanPaths(paths: readonly string[]): string[] {
    return [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
}

export async function setOmpEnableSkillCommands(enabled: boolean, agentDir: string = getOmpAgentDir()): Promise<void> {
    writeOmpConfig((current) => {
        const skillsObj = { ...(current.skills || {}) };
        skillsObj.enableSkillCommands = enabled;
        return { ...current, skills: skillsObj };
    }, agentDir);
}

export async function setOmpSteeringMode(
    mode: 'all' | 'one-at-a-time',
    agentDir: string = getOmpAgentDir(),
): Promise<void> {
    writeOmpConfig((current) => ({ ...current, steeringMode: mode }), agentDir);
}

export async function setOmpFollowUpMode(
    mode: 'all' | 'one-at-a-time',
    agentDir: string = getOmpAgentDir(),
): Promise<void> {
    writeOmpConfig((current) => ({ ...current, followUpMode: mode }), agentDir);
}
