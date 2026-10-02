import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ModelInfo, PiAgentConfigData } from '../shared/protocol';
import type { PiChatSession } from './slashCommands';
import { getAgentLayout, getPiAgentDir } from './piCliPaths';
import type { AgentBackend } from './agentBackend';
import { normalizePiPackageSource } from './piPackageCatalog';
import { installPiPackage, removePiPackageBySource } from './piPackageInstall';
import { getPiPackagesFromSettings, readPiSettingsJson, writePiSettingsJson } from './piSettingsJson';
import {
    cleanPaths,
    readOmpAgentConfigData,
    setOmpSkillPaths,
    setOmpEnableSkillCommands,
    setOmpFollowUpMode,
    setOmpSteeringMode,
    updateOmpDefaults,
    writeOmpConfig,
} from './ompAgentConfig';

export interface PiAuthProviderInfo {
    id: string;
    configured: boolean;
}

export interface PiCommandInfo {
    name: string;
    invocationName: string;
    description?: string;
    source?: string;
}

export interface PiAgentConfigSnapshot {
    agentDir: string;
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
    packages: string[];
    extensionPaths: string[];
    skillPaths: string[];
    enableSkillCommands: boolean;
    steeringMode: 'all' | 'one-at-a-time';
    followUpMode: 'all' | 'one-at-a-time';
    authProviders: PiAuthProviderInfo[];
    mcpFileExists: boolean;
    commands: PiCommandInfo[];
    availableModels: ModelInfo[];
}

function getCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

export function packageSourceToString(source: string | { source: string }): string {
    return typeof source === 'string' ? source : source.source;
}

async function createSettingsManager() {
    const agentDir = getPiAgentDir();
    const cwd = getCwd();
    return { agentDir, cwd, settings: readPiSettingsJson() };
}

export function emptyPiAgentConfig(): PiAgentConfigData {
    return {
        packages: [],
        extensionPaths: [],
        skillPaths: [],
        enableSkillCommands: true,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        authProviders: [],
        mcpFileExists: false,
        commands: [],
        availableModels: [],
    };
}

function snapshotToConfigData(snap: PiAgentConfigSnapshot): PiAgentConfigData {
    return {
        packages: snap.packages,
        extensionPaths: snap.extensionPaths,
        skillPaths: snap.skillPaths,
        enableSkillCommands: snap.enableSkillCommands,
        steeringMode: snap.steeringMode,
        followUpMode: snap.followUpMode,
        authProviders: snap.authProviders,
        mcpFileExists: snap.mcpFileExists,
        commands: snap.commands,
        availableModels: snap.availableModels,
    };
}

/** Read ~/.pi/agent/settings.json when SDK load fails (settings UI still usable). */
function readSettingsJsonFallback(agentDir: string): PiAgentConfigData {
    const base = emptyPiAgentConfig();
    const settingsPath = path.join(agentDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) {
        return base;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
        const packages = Array.isArray(raw.packages)
            ? raw.packages.map((p) => packageSourceToString(p as string | { source: string }))
            : [];
        const extensionPaths = Array.isArray(raw.extensions)
            ? raw.extensions.filter((x): x is string => typeof x === 'string')
            : [];
        const skillPaths = Array.isArray(raw.skills)
            ? raw.skills.filter((x): x is string => typeof x === 'string')
            : [];
        return {
            ...base,
            packages,
            extensionPaths,
            skillPaths,
            enableSkillCommands: typeof raw.enableSkillCommands === 'boolean'
                ? raw.enableSkillCommands
                : base.enableSkillCommands,
            steeringMode: raw.steeringMode === 'all' ? 'all' : 'one-at-a-time',
            followUpMode: raw.followUpMode === 'all' ? 'all' : 'one-at-a-time',
            authProviders: readAuthProviders(agentDir),
            mcpFileExists: fs.existsSync(path.join(agentDir, 'mcp.json')),
        };
    } catch {
        return base;
    }
}

/** Load config for settings panel; never throws — returns partial data + error message on failure. */
export async function loadPiAgentConfigForSettings(
    sessionManager?: PiChatSession,
    preferredBackend?: AgentBackend,
): Promise<{ config: PiAgentConfigData; error?: string }> {
    const layout = getAgentLayout(preferredBackend);
    if (layout.backend === 'omp') {
        try {
            const config = await readOmpAgentConfigData(sessionManager, layout.agentDir);
            return { config };
        } catch (err: any) {
            return {
                config: emptyPiAgentConfig(),
                error: err?.message ?? String(err),
            };
        }
    }
    try {
        const snap = await loadPiAgentConfigSnapshot(sessionManager);
        return { config: snapshotToConfigData(snap) };
    } catch (err: any) {
        return {
            config: readSettingsJsonFallback(layout.agentDir),
            error: err?.message ?? String(err),
        };
    }
}

export async function loadPiAgentConfigSnapshot(
    sessionManager?: PiChatSession,
): Promise<PiAgentConfigSnapshot> {
    const { settings, agentDir } = await createSettingsManager();
    const packages = getPiPackagesFromSettings();
    const extensionPaths = settings.extensions ?? [];
    const skillPaths = settings.skills ?? [];

    let availableModels: ModelInfo[] = [];
    if (sessionManager) {
        availableModels = sessionManager.getModels();
    }

    const commands = await listPiCommands(sessionManager);

    return {
        agentDir,
        defaultProvider: settings.defaultProvider,
        defaultModel: settings.defaultModel,
        defaultThinkingLevel: settings.defaultThinkingLevel,
        packages,
        extensionPaths,
        skillPaths,
        enableSkillCommands: settings.enableSkillCommands ?? true,
        steeringMode: settings.steeringMode === 'all' ? 'all' : 'one-at-a-time',
        followUpMode: settings.followUpMode === 'all' ? 'all' : 'one-at-a-time',
        authProviders: readAuthProviders(agentDir),
        mcpFileExists: fs.existsSync(path.join(agentDir, 'mcp.json')),
        commands,
        availableModels,
    };
}

function readAuthProviders(agentDir: string): PiAuthProviderInfo[] {
    const authPath = path.join(agentDir, 'auth.json');
    if (!fs.existsSync(authPath)) {
        return [];
    }
    try {
        const raw = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;
        return Object.keys(raw).sort().map((id) => ({
            id,
            configured: raw[id] !== null && raw[id] !== undefined && raw[id] !== '',
        }));
    } catch {
        return [];
    }
}

async function listPiCommands(sessionManager?: PiChatSession): Promise<PiCommandInfo[]> {
    if (sessionManager) {
        const cmds = await sessionManager.listSlashCommands();
        return cmds.map((c) => ({
            name: c.name,
            invocationName: c.name,
            description: c.description,
            source: c.source,
        }));
    }
    return [];
}

/**
 * Default model and thinking level of new sessions: `''` clears a field (auto), `undefined` leaves it.
 * The live session takes only what was given, so a thinking-only change keeps its current model.
 */
export async function updatePiDefaults(
    fields: { provider?: string; model?: string; thinkingLevel?: string },
    sessionManager?: PiChatSession,
    preferredBackend?: AgentBackend,
): Promise<void> {
    const layout = getAgentLayout(preferredBackend);
    if (layout.backend === 'omp') {
        updateOmpDefaults(fields, layout.agentDir);
    } else {
        writePiSettingsJson((current) => {
            const next = { ...current };
            const updates = [
                ['defaultProvider', fields.provider],
                ['defaultModel', fields.model],
                ['defaultThinkingLevel', fields.thinkingLevel],
            ] as const;
            for (const [key, value] of updates) {
                if (value === '') {
                    delete next[key];
                } else if (value !== undefined) {
                    next[key] = value;
                }
            }
            return next;
        });
    }
    if (fields.provider && fields.model) {
        await sessionManager?.setModel(fields.provider, fields.model).catch(() => {});
    }
    if (fields.thinkingLevel) {
        sessionManager?.setThinkingLevel(fields.thinkingLevel);
    }
}

export async function addPiPackage(
    source: string,
    sessionManager?: PiChatSession,
    outputChannel?: import('vscode').OutputChannel,
): Promise<void> {
    const normalized = normalizePiPackageSource(source);
    const current = getPiPackagesFromSettings();
    if (current.includes(normalized)) {
        return;
    }
    await installPiPackage(normalized, sessionManager, outputChannel);
}

export async function removePiPackageAt(
    index: number,
    sessionManager?: PiChatSession,
    outputChannel?: import('vscode').OutputChannel,
): Promise<void> {
    const packages = getPiPackagesFromSettings();
    const source = packages[index];
    if (!source) {
        throw new Error('Invalid package index');
    }
    await removePiPackageBySource(source, sessionManager, outputChannel);
}

/** Extension files the CLI loads, as given: omp `config.yml#extensions`, pi `settings.json#extensions`. */
export async function setPiExtensionPaths(paths: readonly string[], preferredBackend?: AgentBackend): Promise<void> {
    const extensions = cleanPaths(paths);
    const layout = getAgentLayout(preferredBackend);
    if (layout.backend === 'omp') {
        writeOmpConfig((current) => ({ ...current, extensions }), layout.agentDir);
    } else {
        writePiSettingsJson((current) => ({ ...current, extensions }));
    }
}

/** Directories of SKILL.md files, as given: omp `config.yml#skills.customDirectories`, pi `settings.json#skills`. */
export async function setPiSkillPaths(paths: readonly string[], preferredBackend?: AgentBackend): Promise<void> {
    const layout = getAgentLayout(preferredBackend);
    if (layout.backend === 'omp') {
        await setOmpSkillPaths(paths, layout.agentDir);
        return;
    }
    const skills = cleanPaths(paths);
    writePiSettingsJson((current) => ({ ...current, skills }));
}

export async function setPiEnableSkillCommands(
    enabled: boolean,
    sessionManager?: PiChatSession,
    preferredBackend?: AgentBackend,
): Promise<void> {
    const layout = getAgentLayout(preferredBackend);
    if (layout.backend === 'omp') {
        await setOmpEnableSkillCommands(enabled, layout.agentDir);
        return;
    }
    writePiSettingsJson((current) => ({ ...current, enableSkillCommands: enabled }));
    schedulePiSessionReload(sessionManager);
}

/** Saved for new sessions and applied to the live one. */
export async function setPiSteeringMode(
    mode: 'all' | 'one-at-a-time',
    sessionManager?: PiChatSession,
    preferredBackend?: AgentBackend,
): Promise<void> {
    const layout = getAgentLayout(preferredBackend);
    if (layout.backend === 'omp') {
        await setOmpSteeringMode(mode, layout.agentDir);
    } else {
        writePiSettingsJson((current) => ({ ...current, steeringMode: mode }));
    }
    await sessionManager?.applySteeringMode(mode);
}

/** Saved for new sessions and applied to the live one. */
export async function setPiFollowUpMode(
    mode: 'all' | 'one-at-a-time',
    sessionManager?: PiChatSession,
    preferredBackend?: AgentBackend,
): Promise<void> {
    const layout = getAgentLayout(preferredBackend);
    if (layout.backend === 'omp') {
        await setOmpFollowUpMode(mode, layout.agentDir);
    } else {
        writePiSettingsJson((current) => ({ ...current, followUpMode: mode }));
    }
    await sessionManager?.applyFollowUpMode(mode);
}

export async function openPiAgentFile(
    file: 'settings' | 'auth' | 'mcp',
    preferredBackend?: AgentBackend,
): Promise<void> {
    const layout = getAgentLayout(preferredBackend);
    const agentDir = layout.agentDir;
    let targetName: string;
    if (layout.backend === 'omp') {
        const ompNames: Record<typeof file, string> = {
            settings: 'config.yml',
            auth: 'models.yml',
            mcp: 'mcp.json',
        };
        targetName = ompNames[file];
    } else {
        const piNames: Record<typeof file, string> = {
            settings: 'settings.json',
            auth: 'auth.json',
            mcp: 'mcp.json',
        };
        targetName = piNames[file];
    }
    const filePath = path.join(agentDir, targetName);
    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(agentDir, { recursive: true });
        if (file === 'mcp') {
            fs.writeFileSync(filePath, '{\n  "mcpServers": {}\n}\n', 'utf8');
        } else if (file === 'auth' && layout.backend === 'omp') {
            fs.writeFileSync(filePath, '# Custom providers and models for omp\nproviders: {}\n', 'utf8');
        } else if (file === 'settings' && layout.backend === 'omp') {
            fs.writeFileSync(filePath, '# Configuration for omp\n', 'utf8');
        } else {
            fs.writeFileSync(filePath, '{}\n', 'utf8');
        }
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
}

/** Apply ~/.pi/agent changes to the live session without blocking the settings UI. */
export function schedulePiSessionReload(
    sessionManager: PiChatSession | undefined,
    outputChannel?: import('vscode').OutputChannel,
): void {
    if (!sessionManager) {
        return;
    }
    void sessionManager.reloadPiAgentResources().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel?.appendLine(`Pi session reload (background): ${msg}`);
    });
}
