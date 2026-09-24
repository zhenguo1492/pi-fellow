import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { getAgentLayout, getPiAgentDir } from './piCliPaths';
import type { AgentBackend } from './agentBackend';

const execFileAsync = promisify(execFile);

export type McpScopeId = 'global' | 'project' | 'projectPi';

export type McpConnectionStatus =
    | 'disabled'
    | 'unknown'
    | 'idle'
    | 'cached'
    | 'connected'
    | 'failed'
    | 'testing';

export interface McpToolSummary {
    name: string;
    description?: string;
}

export interface McpServerSummary {
    name: string;
    scope: McpScopeId | 'import';
    importSource?: string;
    enabled: boolean;
    canToggle: boolean;
    ownerPath: string;
    transport: 'stdio' | 'http' | 'unknown';
    commandPreview?: string;
    url?: string;
    directTools?: boolean | string[];
    tools: McpToolSummary[];
    toolCount: number;
    cacheStatus: 'fresh' | 'stale' | 'none';
    status: McpConnectionStatus;
    statusMessage?: string;
}

export interface McpConfigPathInfo {
    id: McpScopeId;
    label: string;
    path: string;
    exists: boolean;
}

export interface McpSettingsSnapshot {
    hasMcpAdapter: boolean;
    disableProxyTool: boolean;
    globalDirectTools?: boolean;
    toolPrefix?: string;
    configPaths: McpConfigPathInfo[];
    importSources: string[];
    servers: McpServerSummary[];
}

interface ServerEntry {
    command?: string;
    args?: string[];
    url?: string;
    directTools?: boolean | string[];
}

interface McpConfigFile {
    mcpServers?: Record<string, ServerEntry>;
    disabledMcpServers?: Record<string, ServerEntry>;
    imports?: string[];
    settings?: {
        toolPrefix?: string;
        directTools?: boolean;
        disableProxyTool?: boolean;
    };
}

interface CachedTool {
    name: string;
    description?: string;
}

interface MetadataCache {
    version: number;
    servers: Record<string, { tools?: CachedTool[]; cachedAt?: number }>;
}

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Shared user-global MCP file (merged before ~/.pi/agent/mcp.json by pi-mcp-adapter). */
const SHARED_GLOBAL_MCP = path.join(os.homedir(), '.config', 'mcp', 'mcp.json');
const IMPORT_PATHS: Record<string, string[]> = {
    cursor: [path.join(os.homedir(), '.cursor', 'mcp.json')],
    'claude-code': [
        path.join(os.homedir(), '.claude', 'mcp.json'),
        path.join(os.homedir(), '.claude.json'),
    ],
    windsurf: [path.join(os.homedir(), '.windsurf', 'mcp.json')],
    codex: [path.join(os.homedir(), '.codex', 'config.json')],
};

function workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function readJsonFile(filePath: string): McpConfigFile | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as McpConfigFile;
    } catch {
        return null;
    }
}

function writeJsonFile(filePath: string, data: McpConfigFile): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
}

function normalizeRaw(filePath: string): McpConfigFile {
    const raw = readJsonFile(filePath);
    if (!raw || typeof raw !== 'object') {
        return { mcpServers: {}, disabledMcpServers: {} };
    }
    if (!raw.mcpServers || typeof raw.mcpServers !== 'object') {
        raw.mcpServers = {};
    }
    if (!raw.disabledMcpServers || typeof raw.disabledMcpServers !== 'object') {
        raw.disabledMcpServers = {};
    }
    return raw;
}

async function globalConfigPath(preferredBackend?: AgentBackend): Promise<string> {
    const agentDir = getPiAgentDir(preferredBackend);
    return path.join(agentDir, 'mcp.json');
}

function projectConfigPath(cwd: string): string {
    return path.join(cwd, '.mcp.json');
}

function projectPiConfigPath(cwd: string): string {
    return path.join(cwd, '.pi', 'mcp.json');
}

function scopePath(scope: McpScopeId, cwd: string, globalPath: string): string {
    switch (scope) {
        case 'global':
            return globalPath;
        case 'project':
            return projectConfigPath(cwd);
        case 'projectPi':
            return projectPiConfigPath(cwd);
    }
}

function extractImportedServers(kind: string, configPath: string): Record<string, ServerEntry> {
    const raw = readJsonFile(configPath);
    if (!raw) {
        return {};
    }
    const servers = (raw as Record<string, unknown>).mcpServers ?? (raw as Record<string, unknown>)['mcp-servers'];
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
        return {};
    }
    return servers as Record<string, ServerEntry>;
}

function expandImports(config: McpConfigFile, cwd: string): Record<string, ServerEntry> {
    const merged: Record<string, ServerEntry> = {};
    for (const kind of config.imports ?? []) {
        const paths = IMPORT_PATHS[kind] ?? [];
        for (const p of paths) {
            const resolved = p.startsWith('.') ? path.join(cwd, p) : p;
            Object.assign(merged, extractImportedServers(kind, resolved));
        }
    }
    return merged;
}

function mergeLayer(
    base: Record<string, { entry: ServerEntry; scope: McpScopeId | 'import'; ownerPath: string; importSource?: string; enabled: boolean; canToggle: boolean }>,
    servers: Record<string, ServerEntry>,
    scope: McpScopeId | 'import',
    ownerPath: string,
    importSource?: string,
    disabled?: Record<string, ServerEntry>,
): void {
    for (const [name, entry] of Object.entries(servers)) {
        const isDisabled = !!disabled?.[name];
        base[name] = {
            entry,
            scope,
            ownerPath,
            importSource,
            enabled: !isDisabled,
            canToggle: scope !== 'import',
        };
    }
    if (!disabled) {
        return;
    }
    for (const [name, entry] of Object.entries(disabled)) {
        if (base[name]) {
            continue;
        }
        base[name] = {
            entry,
            scope,
            ownerPath,
            importSource,
            enabled: false,
            canToggle: scope !== 'import',
        };
    }
}

function loadMetadataCache(agentDir: string): MetadataCache | null {
    const cachePath = path.join(agentDir, 'mcp-cache.json');
    if (!fs.existsSync(cachePath)) {
        return null;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as MetadataCache;
        if (raw?.version !== 1 || !raw.servers) {
            return null;
        }
        return raw;
    } catch {
        return null;
    }
}

function cacheStatusFor(serverName: string, cache: MetadataCache | null): 'fresh' | 'stale' | 'none' {
    const entry = cache?.servers?.[serverName];
    if (!entry?.tools?.length) {
        return 'none';
    }
    const age = entry.cachedAt ? Date.now() - entry.cachedAt : CACHE_MAX_AGE_MS + 1;
    return age <= CACHE_MAX_AGE_MS ? 'fresh' : 'stale';
}

function sanitizeCommandPreview(entry: ServerEntry): string | undefined {
    if (entry.url) {
        return undefined;
    }
    if (!entry.command) {
        return undefined;
    }
    const args = (entry.args ?? []).slice(0, 4).join(' ');
    const preview = args ? `${entry.command} ${args}` : entry.command;
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}

function transportOf(entry: ServerEntry): 'stdio' | 'http' | 'unknown' {
    if (entry.url) {
        return 'http';
    }
    if (entry.command) {
        return 'stdio';
    }
    return 'unknown';
}

export function hasPiMcpAdapterPackage(packages: string[]): boolean {
    return packages.some(
        (p) =>
            p === 'npm:pi-mcp-adapter' ||
            p.includes('pi-mcp-adapter') ||
            p.endsWith('/pi-mcp-adapter'),
    );
}

export async function loadMcpSettingsSnapshot(
    packages: string[],
    probeResults?: Map<string, { ok: boolean; message: string }>,
    preferredBackend?: AgentBackend,
): Promise<McpSettingsSnapshot> {
    const cwd = workspaceRoot();
    const agentDir = getPiAgentDir(preferredBackend);
    const globalPath = await globalConfigPath(preferredBackend);
    const backend = getAgentLayout(preferredBackend).backend;
    const globalLabel = backend === 'omp' ? 'Global (~/.omp/agent/mcp.json)' : 'Global (~/.pi/agent/mcp.json)';
    const paths: McpConfigPathInfo[] = [
        { id: 'global', label: globalLabel, path: globalPath, exists: fs.existsSync(globalPath) },
        {
            id: 'project',
            label: 'Project (.mcp.json)',
            path: projectConfigPath(cwd),
            exists: fs.existsSync(projectConfigPath(cwd)),
        },
        {
            id: 'projectPi',
            label: backend === 'omp' ? 'Project (.omp/mcp.json)' : 'Project Pi (.pi/mcp.json)',
            path: projectPiConfigPath(cwd),
            exists: fs.existsSync(projectPiConfigPath(cwd)),
        },
    ];

    const globalRaw = normalizeRaw(globalPath);
    const projectRaw = normalizeRaw(projectConfigPath(cwd));
    const projectPiRaw = normalizeRaw(projectPiConfigPath(cwd));

    const importSources = [
        ...new Set([
            ...(globalRaw.imports ?? []),
            ...(projectRaw.imports ?? []),
            ...(projectPiRaw.imports ?? []),
        ]),
    ];

    const merged: Record<
        string,
        {
            entry: ServerEntry;
            scope: McpScopeId | 'import';
            ownerPath: string;
            importSource?: string;
            enabled: boolean;
            canToggle: boolean;
        }
    > = {};

    if (SHARED_GLOBAL_MCP !== globalPath && fs.existsSync(SHARED_GLOBAL_MCP)) {
        const shared = normalizeRaw(SHARED_GLOBAL_MCP);
        mergeLayer(merged, shared.mcpServers ?? {}, 'global', SHARED_GLOBAL_MCP, undefined, shared.disabledMcpServers);
    }

    mergeLayer(merged, expandImports(globalRaw, cwd), 'import', globalPath, 'imports');
    mergeLayer(merged, globalRaw.mcpServers ?? {}, 'global', globalPath, undefined, globalRaw.disabledMcpServers);
    mergeLayer(merged, expandImports(projectRaw, cwd), 'import', projectConfigPath(cwd), 'imports');
    mergeLayer(merged, projectRaw.mcpServers ?? {}, 'project', projectConfigPath(cwd), undefined, projectRaw.disabledMcpServers);
    mergeLayer(merged, expandImports(projectPiRaw, cwd), 'import', projectPiConfigPath(cwd), 'imports');
    mergeLayer(
        merged,
        projectPiRaw.mcpServers ?? {},
        'projectPi',
        projectPiConfigPath(cwd),
        undefined,
        projectPiRaw.disabledMcpServers,
    );

    const cache = loadMetadataCache(agentDir);
    const settings = globalRaw.settings ?? projectPiRaw.settings ?? projectRaw.settings;

    const servers: McpServerSummary[] = Object.entries(merged)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, meta]) => {
            const cacheSt = cacheStatusFor(name, cache);
            const tools = (cache?.servers?.[name]?.tools ?? []).map((t) => ({
                name: t.name,
                description: t.description,
            }));
            const probe = probeResults?.get(name);
            let status: McpConnectionStatus = 'unknown';
            let statusMessage: string | undefined;

            if (!meta.enabled) {
                status = 'disabled';
                statusMessage = 'Disabled in config';
            } else if (probe) {
                status = probe.ok ? 'connected' : 'failed';
                statusMessage = probe.message;
            } else if (cacheSt === 'fresh') {
                status = 'cached';
                statusMessage = 'Metadata cached (connects on first tool use)';
            } else if (cacheSt === 'stale') {
                status = 'idle';
                statusMessage = 'Stale cache — reload session or test connection';
            } else {
                status = 'idle';
                statusMessage = 'Not connected yet';
            }

            return {
                name,
                scope: meta.scope,
                importSource: meta.importSource,
                enabled: meta.enabled,
                canToggle: meta.canToggle,
                ownerPath: meta.ownerPath,
                transport: transportOf(meta.entry),
                commandPreview: sanitizeCommandPreview(meta.entry),
                url: meta.entry.url,
                directTools: meta.entry.directTools,
                tools,
                toolCount: tools.length,
                cacheStatus: cacheSt,
                status,
                statusMessage,
            };
        });

    return {
        hasMcpAdapter: backend === 'omp' || hasPiMcpAdapterPackage(packages),
        disableProxyTool: settings?.disableProxyTool === true,
        globalDirectTools: settings?.directTools,
        toolPrefix: settings?.toolPrefix,
        configPaths: paths,
        importSources,
        servers,
    };
}

export async function setMcpServerEnabled(
    scope: McpScopeId,
    serverName: string,
    enabled: boolean,
    preferredBackend?: AgentBackend,
): Promise<void> {
    const cwd = workspaceRoot();
    const globalPath = await globalConfigPath(preferredBackend);
    const filePath = scopePath(scope, cwd, globalPath);
    const raw = normalizeRaw(filePath);

    const active = raw.mcpServers ?? {};
    const disabled = raw.disabledMcpServers ?? {};

    if (enabled) {
        const entry = disabled[serverName];
        if (!entry) {
            throw new Error(`Server "${serverName}" is not in disabledMcpServers for this scope`);
        }
        active[serverName] = entry;
        delete disabled[serverName];
    } else {
        const entry = active[serverName];
        if (!entry) {
            throw new Error(`Server "${serverName}" is not in mcpServers for this scope`);
        }
        disabled[serverName] = entry;
        delete active[serverName];
    }

    raw.mcpServers = active;
    raw.disabledMcpServers = disabled;
    writeJsonFile(filePath, raw);
}

export async function probeMcpServer(
    server: McpServerSummary,
    preferredBackend?: AgentBackend,
): Promise<{ ok: boolean; message: string }> {
    if (!server.enabled) {
        return { ok: false, message: 'Server is disabled' };
    }

    const cwd = workspaceRoot();
    const globalPath = await globalConfigPath(preferredBackend);
    const filePath =
        server.scope === 'import'
            ? server.ownerPath
            : scopePath(server.scope as McpScopeId, cwd, globalPath);
    const raw = normalizeRaw(filePath);
    const entry =
        raw.mcpServers?.[server.name] ??
        raw.disabledMcpServers?.[server.name] ??
        expandImports(raw, cwd)[server.name];

    if (!entry) {
        return { ok: false, message: 'Server definition not found in config file' };
    }

    if (entry.url) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(entry.url, { method: 'GET', signal: controller.signal });
            clearTimeout(timer);
            if (res.ok || res.status < 500) {
                return { ok: true, message: `HTTP reachable (${res.status})` };
            }
            return { ok: false, message: `HTTP ${res.status}` };
        } catch (err: unknown) {
            return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
    }

    if (entry.command) {
        try {
            await execFileAsync('which', [entry.command], { timeout: 4000 });
            return {
                ok: true,
                message: 'Executable found on PATH (full MCP handshake runs on first tool use)',
            };
        } catch {
            return { ok: false, message: `Command not found: ${entry.command}` };
        }
    }

    return { ok: false, message: 'No url or command configured' };
}
