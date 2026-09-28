import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { getKemdiMcpHints } from '../shared/kemdiMcpHints';
import type {
    McpConfigPathInfo,
    McpConnectionStatus,
    McpScopeId,
    McpServerSummary,
    McpSettingsSnapshot,
} from '../shared/protocol';
import type { AgentBackend } from './agentBackend';
import { getAgentLayout } from './piCliPaths';

const execFileAsync = promisify(execFile);

type JsonObject = Record<string, unknown>;

/** A server entry as written in mcp.json; only the fields read here are typed. */
interface ServerEntry extends JsonObject {
    command?: unknown;
    args?: unknown;
    url?: unknown;
    directTools?: unknown;
    /** pi-mcp-adapter: only literal `true` disables (its `isServerDisabled`). */
    disabled?: unknown;
    /** omp: only literal `false` disables. */
    enabled?: unknown;
}

/** An mcp.json the backend reads. */
interface McpSource {
    scope: McpScopeId;
    label: string;
    path: string;
    /** Listed even when missing; shared and compatibility files are listed only when present. */
    primary: boolean;
}

interface McpContext {
    backend: AgentBackend;
    agentDir: string;
    cwd: string;
    home: string;
}

interface ResolvedServer {
    /** Effective definition (pi: merged per field across files; omp: the first definition). */
    entry: ServerEntry;
    /** Config file owning the entry — the one a toggle writes. Absent for servers pulled in by pi `imports`. */
    source?: McpSource;
    importKind?: string;
    importPath?: string;
    /** Only present in a `disabledMcpServers` block written by older versions of this extension. */
    legacy: boolean;
}

interface ResolvedConfig {
    backend: AgentBackend;
    sources: McpSource[];
    servers: Map<string, ResolvedServer>;
    /** omp user-level overrides (`disabledServers` / `enabledServers` in the user mcp.json). */
    disabledServers: ReadonlySet<unknown>;
    enabledServers: ReadonlySet<unknown>;
    /** pi-mcp-adapter `settings`, merged across files. */
    settings: JsonObject;
    importKinds: string[];
}

interface MetadataCache {
    version: number;
    servers: Record<string, { tools?: { name: string; description?: string }[]; cachedAt?: number }>;
}

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;

/** pi-mcp-adapter `imports` kinds this panel can read (JSON files only). */
function importPaths(home: string): Record<string, string[]> {
    return {
        cursor: [path.join(home, '.cursor', 'mcp.json')],
        'claude-code': [path.join(home, '.claude', 'mcp.json'), path.join(home, '.claude.json')],
        windsurf: [path.join(home, '.windsurf', 'mcp.json')],
        codex: [path.join(home, '.codex', 'config.json')],
    };
}

function hostContext(preferredBackend?: AgentBackend): McpContext {
    const layout = getAgentLayout(preferredBackend);
    return {
        backend: layout.backend,
        agentDir: layout.agentDir,
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        home: os.homedir(),
    };
}

/** Config files each backend reads, highest precedence first. */
function mcpSources(ctx: McpContext): McpSource[] {
    const tilde = (p: string) => (p.startsWith(ctx.home + path.sep) ? `~${p.slice(ctx.home.length)}` : p);
    const user = path.join(ctx.agentDir, 'mcp.json');
    const userCompat = path.join(ctx.agentDir, '.mcp.json');
    const list: McpSource[] =
        ctx.backend === 'omp'
            ? // omp://mcp-config.md "Discovery and precedence": the first definition of a name wins. Claude/Cursor/…
              // configs rank between the native files and the root fallbacks; they are not listed here.
              [
                  { scope: 'projectAgent', label: 'Project (.omp/mcp.json)', path: path.join(ctx.cwd, '.omp', 'mcp.json'), primary: true },
                  { scope: 'projectAgentCompat', label: 'Project (.omp/.mcp.json)', path: path.join(ctx.cwd, '.omp', '.mcp.json'), primary: false },
                  { scope: 'global', label: `User (${tilde(user)})`, path: user, primary: true },
                  { scope: 'globalCompat', label: `User (${tilde(userCompat)})`, path: userCompat, primary: false },
                  { scope: 'projectRoot', label: 'Project fallback (mcp.json)', path: path.join(ctx.cwd, 'mcp.json'), primary: false },
                  { scope: 'project', label: 'Project fallback (.mcp.json)', path: path.join(ctx.cwd, '.mcp.json'), primary: true },
              ]
            : // pi-mcp-adapter getConfigSources, reversed: it merges entries per field, later files overriding earlier.
              [
                  { scope: 'projectAgent', label: 'Project (.pi/mcp.json)', path: path.join(ctx.cwd, '.pi', 'mcp.json'), primary: true },
                  { scope: 'project', label: 'Project (.mcp.json)', path: path.join(ctx.cwd, '.mcp.json'), primary: true },
                  { scope: 'global', label: `User (${tilde(user)})`, path: user, primary: true },
                  { scope: 'agentsNestedGlobal', label: 'Shared (~/.agents/mcp/mcp.json)', path: path.join(ctx.home, '.agents', 'mcp', 'mcp.json'), primary: false },
                  { scope: 'agentsGlobal', label: 'Shared (~/.agents/mcp.json)', path: path.join(ctx.home, '.agents', 'mcp.json'), primary: false },
                  { scope: 'sharedGlobal', label: 'Shared (~/.config/mcp/mcp.json)', path: path.join(ctx.home, '.config', 'mcp', 'mcp.json'), primary: false },
              ];
    // A file reachable two ways (e.g. PI_CODING_AGENT_DIR=~/.config/mcp) is read once, at its highest precedence.
    const seen = new Set<string>();
    return list.filter((s) => !seen.has(s.path) && !!seen.add(s.path));
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parsed config; `undefined` when missing or not a JSON object. */
function readConfig(filePath: string): JsonObject | undefined {
    let text: string;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(text);
        return isObject(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/** Like readConfig, but a file that cannot be edited safely is an error rather than an empty config to overwrite. */
function readConfigForWrite(filePath: string): JsonObject {
    let text: string;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch {
        throw new Error(`${filePath} does not exist`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`Cannot parse ${filePath} (${err instanceof Error ? err.message : String(err)}); edit it by hand`);
    }
    if (!isObject(parsed)) {
        throw new Error(`${filePath} is not a JSON object; edit it by hand`);
    }
    return parsed;
}

function writeConfig(filePath: string, data: JsonObject): void {
    // Write through symlinks (dotfile setups) and keep the file's permissions: mcp.json often holds tokens.
    const target = fs.realpathSync(filePath);
    const mode = fs.statSync(target).mode & 0o777;
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
}

function entriesOf(value: unknown): [string, ServerEntry][] {
    return isObject(value)
        ? Object.entries(value).filter((pair): pair is [string, ServerEntry] => isObject(pair[1]))
        : [];
}

/** pi-mcp-adapter merges a later entry into an earlier one per field; switching transport drops the other one's fields. */
function mergePiEntry(base: ServerEntry | undefined, next: ServerEntry): ServerEntry {
    const merged: ServerEntry = { ...base };
    if (typeof next.command === 'string') {
        delete merged.url;
    } else if (typeof next.url === 'string') {
        delete merged.command;
        delete merged.args;
    }
    return { ...merged, ...next };
}

/** Servers a pi config pulls in via `imports`; the first definition of a name wins, as in pi-mcp-adapter. */
function importedServers(raw: JsonObject, home: string): Map<string, { entry: ServerEntry; kind: string; path: string }> {
    const imported = new Map<string, { entry: ServerEntry; kind: string; path: string }>();
    const kinds = Array.isArray(raw.imports) ? raw.imports.filter((k): k is string => typeof k === 'string') : [];
    const table = importPaths(home);
    for (const kind of kinds) {
        for (const filePath of table[kind] ?? []) {
            const file = readConfig(filePath);
            for (const [name, entry] of entriesOf(file?.mcpServers ?? file?.['mcp-servers'])) {
                if (!imported.has(name)) {
                    imported.set(name, { entry, kind, path: filePath });
                }
            }
        }
    }
    return imported;
}

/**
 * Every server the backend would load from its mcp.json files. `pending` substitutes an edited, not yet written
 * config for the file at its path.
 */
function resolveConfig(ctx: McpContext, pending?: { path: string; raw: JsonObject }): ResolvedConfig {
    const sources = mcpSources(ctx);
    const read = (filePath: string) => (filePath === pending?.path ? pending.raw : readConfig(filePath));
    const servers = new Map<string, ResolvedServer>();
    const legacy = new Map<string, ResolvedServer>();
    let settings: JsonObject = {};
    const importKinds = new Set<string>();
    let disabledServers: ReadonlySet<unknown> = new Set();
    let enabledServers: ReadonlySet<unknown> = new Set();

    if (ctx.backend === 'pi') {
        for (const source of [...sources].reverse()) {
            const raw = read(source.path);
            if (!raw) {
                continue;
            }
            // Imported servers sit under the importing file's own entries (pi-mcp-adapter expandImports).
            for (const [name, imp] of importedServers(raw, ctx.home)) {
                importKinds.add(imp.kind);
                servers.set(name, {
                    entry: mergePiEntry(servers.get(name)?.entry, imp.entry),
                    importKind: imp.kind,
                    importPath: imp.path,
                    legacy: false,
                });
            }
            for (const [name, entry] of entriesOf(raw.mcpServers)) {
                servers.set(name, { entry: mergePiEntry(servers.get(name)?.entry, entry), source, legacy: false });
            }
            for (const [name, entry] of entriesOf(raw.disabledMcpServers)) {
                legacy.set(name, { entry, source, legacy: true });
            }
            if (isObject(raw.settings)) {
                settings = { ...settings, ...raw.settings };
            }
        }
    } else {
        for (const source of sources) {
            const raw = read(source.path);
            for (const [name, entry] of entriesOf(raw?.mcpServers)) {
                if (!servers.has(name)) {
                    servers.set(name, { entry, source, legacy: false });
                }
            }
            for (const [name, entry] of entriesOf(raw?.disabledMcpServers)) {
                if (!legacy.has(name)) {
                    legacy.set(name, { entry, source, legacy: true });
                }
            }
            if (source.scope === 'global') {
                disabledServers = new Set(Array.isArray(raw?.disabledServers) ? raw.disabledServers : []);
                enabledServers = new Set(Array.isArray(raw?.enabledServers) ? raw.enabledServers : []);
            }
        }
    }
    // Neither CLI reads disabledMcpServers; list those entries only so they can be restored.
    for (const [name, server] of legacy) {
        if (!servers.has(name)) {
            servers.set(name, server);
        }
    }
    return {
        backend: ctx.backend,
        sources,
        servers,
        disabledServers,
        enabledServers,
        settings,
        importKinds: [...importKinds],
    };
}

function isServerEnabled(config: ResolvedConfig, name: string, server: ResolvedServer): boolean {
    if (server.legacy) {
        return false;
    }
    if (config.backend === 'pi') {
        return server.entry.disabled !== true;
    }
    // omp: the user denylist beats everything; the allowlist overrides a source's `enabled: false`.
    if (config.disabledServers.has(name)) {
        return false;
    }
    return server.entry.enabled !== false || config.enabledServers.has(name);
}

function disabledReason(config: ResolvedConfig, name: string, server: ResolvedServer): string {
    if (server.legacy) {
        return 'Parked in "disabledMcpServers" by an older version of this extension (not read by pi or omp) — enable to restore';
    }
    if (config.backend === 'pi') {
        return 'Disabled ("disabled": true)';
    }
    return config.disabledServers.has(name)
        ? 'Disabled by "disabledServers" in the user mcp.json'
        : 'Disabled ("enabled": false)';
}

function loadMetadataCache(agentDir: string): MetadataCache | undefined {
    const raw = readConfig(path.join(agentDir, 'mcp-cache.json'));
    return raw?.version === 1 && isObject(raw.servers) ? (raw as unknown as MetadataCache) : undefined;
}

function cacheStatusFor(serverName: string, cache: MetadataCache | undefined): 'fresh' | 'stale' | 'none' {
    const entry = cache?.servers?.[serverName];
    if (!entry?.tools?.length) {
        return 'none';
    }
    const age = entry.cachedAt ? Date.now() - entry.cachedAt : CACHE_MAX_AGE_MS + 1;
    return age <= CACHE_MAX_AGE_MS ? 'fresh' : 'stale';
}

function commandPreview(entry: ServerEntry, args: string[]): string | undefined {
    if (typeof entry.url === 'string' || typeof entry.command !== 'string') {
        return undefined;
    }
    const preview = [entry.command, ...args.slice(0, 4)].join(' ');
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}

function transportOf(entry: ServerEntry): 'stdio' | 'http' | 'unknown' {
    if (typeof entry.url === 'string') {
        return 'http';
    }
    return typeof entry.command === 'string' ? 'stdio' : 'unknown';
}

function buildSnapshot(
    ctx: McpContext,
    packages: string[],
    probeResults?: Map<string, { ok: boolean; message: string }>,
): McpSettingsSnapshot {
    const config = resolveConfig(ctx);
    const isPi = ctx.backend === 'pi';
    // omp caches tool metadata in its agent.db; only pi-mcp-adapter's mcp-cache.json is readable here.
    const cache = isPi ? loadMetadataCache(ctx.agentDir) : undefined;
    const settings = config.settings;

    const configPaths: McpConfigPathInfo[] = config.sources.flatMap((s) => {
        const exists = fs.existsSync(s.path);
        return s.primary || exists ? [{ id: s.scope, label: s.label, path: s.path, exists }] : [];
    });

    const servers: McpServerSummary[] = [...config.servers.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, server]) => {
            const { entry } = server;
            const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
            const enabled = isServerEnabled(config, name, server);
            const cacheStatus = isPi ? cacheStatusFor(name, cache) : 'unavailable';
            const tools = (cache?.servers?.[name]?.tools ?? []).map((t) => ({ name: t.name, description: t.description }));
            const probe = probeResults?.get(name);
            let status: McpConnectionStatus;
            let statusMessage: string;
            if (!enabled) {
                status = 'disabled';
                statusMessage = disabledReason(config, name, server);
            } else if (probe) {
                status = probe.ok ? 'reachable' : 'failed';
                statusMessage = probe.message;
            } else if (!isPi) {
                status = 'idle';
                statusMessage = 'Not checked — omp connects when the session starts (/mcp list in chat shows live status)';
            } else if (cacheStatus === 'fresh') {
                status = 'cached';
                statusMessage = 'Tool list cached; connects on first use';
            } else if (cacheStatus === 'stale') {
                status = 'idle';
                statusMessage = 'Cached tool list is over 7 days old; it refreshes on the next connect';
            } else {
                status = 'idle';
                statusMessage = 'No cached tool list yet';
            }
            return {
                name,
                scope: server.source?.scope ?? 'import',
                sourceLabel: server.source?.label ?? `${server.importKind} import`,
                enabled,
                canToggle: server.source !== undefined,
                ownerPath: server.source?.path ?? server.importPath ?? '',
                transport: transportOf(entry),
                commandPreview: commandPreview(entry, args),
                url: typeof entry.url === 'string' ? entry.url : undefined,
                hints: getKemdiMcpHints(
                    { name, args, directTools: entry.directTools ?? settings.directTools },
                    ctx.backend,
                ),
                tools,
                toolCount: tools.length,
                cacheStatus,
                status,
                statusMessage,
            };
        });

    return {
        hasMcpAdapter: !isPi || packages.some((p) => p.includes('pi-mcp-adapter')),
        disableProxyTool: settings.disableProxyTool === true,
        globalDirectTools: typeof settings.directTools === 'boolean' ? settings.directTools : undefined,
        toolPrefix: typeof settings.toolPrefix === 'string' ? settings.toolPrefix : undefined,
        configPaths,
        importSources: config.importKinds,
        servers,
    };
}

export async function loadMcpSettingsSnapshot(
    packages: string[],
    probeResults?: Map<string, { ok: boolean; message: string }>,
    preferredBackend?: AgentBackend,
): Promise<McpSettingsSnapshot> {
    return buildSnapshot(hostContext(preferredBackend), packages, probeResults);
}

/** Drops `name` from a string-list key; the key goes when the list empties. Returns whether it changed. */
function removeFromList(raw: JsonObject, key: string, name: string): boolean {
    const list = raw[key];
    if (!Array.isArray(list) || !list.includes(name)) {
        return false;
    }
    const rest = list.filter((v) => v !== name);
    if (rest.length > 0) {
        raw[key] = rest;
    } else {
        delete raw[key];
    }
    return true;
}

/**
 * Flips the backend's native field on the entry in the file `scope` names — pi-mcp-adapter `"disabled": true`,
 * omp `"enabled": false` — dropping it again to enable.
 */
function setServerEnabled(ctx: McpContext, scope: McpScopeId, name: string, enabled: boolean): void {
    const sources = mcpSources(ctx);
    const source = sources.find((s) => s.scope === scope);
    if (!source) {
        throw new Error(`${ctx.backend} reads no MCP config for scope "${scope}"`);
    }
    const raw = readConfigForWrite(source.path);
    if (raw.mcpServers !== undefined && !isObject(raw.mcpServers)) {
        throw new Error(`"mcpServers" in ${source.path} is not an object; edit it by hand`);
    }
    const servers = (raw.mcpServers ??= {}) as JsonObject;

    const legacy = raw.disabledMcpServers;
    if (enabled && isObject(legacy) && name in legacy) {
        // Older versions of this extension parked disabled entries here, where neither CLI looks: move it back.
        if (!isObject(servers[name]) && isObject(legacy[name])) {
            servers[name] = legacy[name];
        }
        delete legacy[name];
        if (Object.keys(legacy).length === 0) {
            delete raw.disabledMcpServers;
        }
    }

    const entry = servers[name];
    if (!isObject(entry)) {
        throw new Error(`"${name}" is not defined in ${source.path}`);
    }
    if (!enabled) {
        if (ctx.backend === 'omp') {
            entry.enabled = false;
        } else {
            entry.disabled = true;
        }
    } else if (ctx.backend === 'omp') {
        delete entry.enabled;
    } else {
        delete entry.disabled;
        // pi merges entries per field, so a lower-precedence file's `disabled: true` would show through.
        if (resolveConfig(ctx, { path: source.path, raw }).servers.get(name)?.entry.disabled === true) {
            entry.disabled = false;
        }
    }
    if (Object.keys(entry).length === 0) {
        // A pure override such as pi-mcp-adapter's own `{ "disabled": true }` for a server defined elsewhere.
        delete servers[name];
    }

    const writes = new Map<string, JsonObject>([[source.path, raw]]);
    const userSource = sources.find((s) => s.scope === 'global');
    if (ctx.backend === 'omp' && userSource) {
        // As omp's /mcp enable|disable: drop user-level overrides that would contradict the entry's new state.
        const user = userSource.path === source.path ? raw : readConfig(userSource.path);
        if (user) {
            const allowChanged = removeFromList(user, 'enabledServers', name);
            const denyChanged = enabled && removeFromList(user, 'disabledServers', name);
            if (allowChanged || denyChanged) {
                writes.set(userSource.path, user);
            }
        }
    }
    for (const [filePath, data] of writes) {
        writeConfig(filePath, data);
    }
}

export async function setMcpServerEnabled(
    scope: McpScopeId,
    serverName: string,
    enabled: boolean,
    preferredBackend?: AgentBackend,
): Promise<void> {
    setServerEnabled(hostContext(preferredBackend), scope, serverName, enabled);
}

/** Reachability only: the MCP handshake (initialize, tools/list) is left to the agent. */
export async function probeMcpServer(
    server: McpServerSummary,
    preferredBackend?: AgentBackend,
): Promise<{ ok: boolean; message: string }> {
    const config = resolveConfig(hostContext(preferredBackend));
    const resolved = config.servers.get(server.name);
    if (!resolved) {
        return { ok: false, message: 'Server definition not found in any MCP config file' };
    }
    if (!isServerEnabled(config, server.name, resolved)) {
        return { ok: false, message: 'Server is disabled' };
    }
    const { entry } = resolved;
    if (typeof entry.url === 'string') {
        return probeUrl(entry.url);
    }
    if (typeof entry.command === 'string') {
        return probeCommand(entry.command);
    }
    return { ok: false, message: 'No url or command configured' };
}

async function probeUrl(url: string): Promise<{ ok: boolean; message: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { Accept: 'application/json, text/event-stream' },
            signal: controller.signal,
        });
        // The status line is all this check needs; an SSE endpoint would otherwise hold the socket open.
        await res.body?.cancel().catch(() => undefined);
        const { status } = res;
        if (status === 401 || status === 403) {
            return { ok: true, message: `HTTP ${status} — reachable, needs auth` };
        }
        if (status === 404) {
            return { ok: false, message: 'HTTP 404 — host reachable, but nothing at this URL' };
        }
        if (status >= 500) {
            return { ok: false, message: `HTTP ${status} — server error` };
        }
        return { ok: true, message: `HTTP ${status} — reachable (MCP handshake not tested)` };
    } catch (err) {
        if (controller.signal.aborted) {
            return { ok: false, message: `No response within ${PROBE_TIMEOUT_MS / 1000} s` };
        }
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
        return { ok: false, message: `Unreachable: ${cause instanceof Error ? cause.message : String(cause)}` };
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}

async function probeCommand(command: string): Promise<{ ok: boolean; message: string }> {
    try {
        const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [command], {
            timeout: 4000,
        });
        const found = stdout.split(/\r?\n/)[0]?.trim() || command;
        return { ok: true, message: `Command found on PATH (${found}); server not started by this check` };
    } catch {
        return { ok: false, message: `Command not found on PATH: ${command}` };
    }
}
