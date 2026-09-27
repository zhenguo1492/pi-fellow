import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { type AgentBackend, type AgentLayout, resolveAgentDir } from './agentBackend';

const execFileAsync = promisify(execFile);

/** pi runs as `node cli.js` under the user's Node (native addons must match that ABI). */
export interface PiNodeInvocation {
    backend: 'pi';
    nodePath: string;
    cliJsPath: string;
    /** Directory containing the CLI executable (prepended to PATH for child processes). */
    binDir: string;
}

/** omp is a self-contained binary: spawned directly, no Node involved. */
export interface OmpInvocation {
    backend: 'omp';
    executablePath: string;
    binDir: string;
}

export type PiCliInvocation = PiNodeInvocation | OmpInvocation;

type BackendSetting = 'auto' | AgentBackend;

interface CliTarget {
    backend: AgentBackend;
    cliPath: string;
}

/** Install locations checked when the extension host PATH lacks the CLI (e.g. GUI-launched editors). */
const FALLBACK_CLI_PATHS: Record<AgentBackend, string[]> = {
    omp: [
        path.join(os.homedir(), '.local/bin/omp'),
        path.join(os.homedir(), '.bun/bin/omp'),
        '/opt/homebrew/bin/omp',
        '/usr/local/bin/omp',
    ],
    pi: [
        path.join(os.homedir(), '.pi/agent/bin/pi'),
        path.join(os.homedir(), '.nvm/versions/node/v22.22.2/bin/pi'),
        '/opt/homebrew/bin/pi',
        '/usr/local/bin/pi',
    ],
};

/** First executable named `name` on PATH (sync `which`; honours PATHEXT on Windows). */
function findOnPath(name: string): string | undefined {
    const exts =
        process.platform === 'win32'
            ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
            : [''];
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) {
            continue;
        }
        for (const ext of exts) {
            const candidate = path.join(dir, name + ext);
            try {
                if (fs.statSync(candidate).isFile()) {
                    fs.accessSync(candidate, fs.constants.X_OK);
                    return candidate;
                }
            } catch {
                /* not here */
            }
        }
    }
    return undefined;
}

function findCliTarget(setting: BackendSetting, configured: string): CliTarget {
    if (configured) {
        if (!fs.existsSync(configured)) {
            throw new Error(`Agent CLI not found at configured oh-my-pi-chater.cliPath: ${configured}`);
        }
        if (setting !== 'auto') {
            return { backend: setting, cliPath: configured };
        }
        let real = configured;
        try {
            real = fs.realpathSync(configured);
        } catch {
            /* keep configured */
        }
        const isOmp = [configured, real].some((p) => path.basename(p).toLowerCase().startsWith('omp'));
        return { backend: isOmp ? 'omp' : 'pi', cliPath: configured };
    }

    const order: AgentBackend[] = setting === 'auto' ? ['omp', 'pi'] : [setting];
    for (const backend of order) {
        const found = findOnPath(backend) ?? FALLBACK_CLI_PATHS[backend].find((p) => fs.existsSync(p));
        if (found) {
            return { backend, cliPath: found };
        }
    }
    throw new Error(
        `${order.join(' / ')} CLI not found on PATH. Install omp or pi, or set oh-my-pi-chater.cliPath.`,
    );
}

let cachedTarget: { key: string; target: CliTarget } | undefined;
let cachedPiCliJs: { key: string; cliJs: string } | undefined;
let cachedAvailable: { key: string; backends: AgentBackend[] } | undefined;

export function clearCliTargetCache(): void {
    cachedTarget = undefined;
    cachedPiCliJs = undefined;
    cachedAvailable = undefined;
}

const WINDOW_BACKEND_STATE_KEY = 'oh-my-pi-chater.windowBackend';

/** Backend picked in this window's chat/settings UI; each window runs its own extension host. */
let windowBackend: AgentBackend | undefined;
let windowState: vscode.Memento | undefined;
const windowBackendListeners = new Set<(backend: AgentBackend) => void>();

function emitWindowBackend(): void {
    const backend = getAgentLayout().backend;
    for (const listener of windowBackendListeners) {
        listener(backend);
    }
}

/**
 * `oh-my-pi-chater.backend` is a user setting shared by every VS Code window, so the UI picker must not
 * write it: switching in one window would switch every other window mid-task. The pick lives in
 * `workspaceState` instead; the setting stays the default for workspaces that never picked one.
 */
export function initWindowBackend(workspaceState: vscode.Memento): vscode.Disposable {
    windowState = workspaceState;
    const saved = workspaceState.get<string>(WINDOW_BACKEND_STATE_KEY);
    windowBackend = saved === 'omp' || saved === 'pi' ? saved : undefined;
    return vscode.workspace.onDidChangeConfiguration((e) => {
        if (!windowBackend && e.affectsConfiguration('oh-my-pi-chater.backend')) {
            emitWindowBackend();
        }
    });
}

/** Switch this window's backend (persisted per workspace); other windows are unaffected. */
export function setWindowBackend(backend: AgentBackend): void {
    const previous = getAgentLayout().backend;
    windowBackend = backend;
    void windowState?.update(WINDOW_BACKEND_STATE_KEY, backend);
    if (backend !== previous) {
        emitWindowBackend();
    }
}

/** Fires with the effective backend when this window's backend changes. */
export function onDidChangeWindowBackend(listener: (backend: AgentBackend) => void): vscode.Disposable {
    windowBackendListeners.add(listener);
    return { dispose: () => windowBackendListeners.delete(listener) };
}

/**
 * CLI to run. This window's picked backend wins, then `oh-my-pi-chater.backend` (`auto` prefers omp,
 * then pi); `oh-my-pi-chater.cliPath` pins the executable. A window pick whose CLI has since been
 * uninstalled yields to the setting. Sync so agent-dir lookups stay sync.
 */
export function resolveCliTarget(preferredBackend?: BackendSetting): CliTarget {
    const config = vscode.workspace.getConfiguration('oh-my-pi-chater');
    const configuredSetting = config.get<BackendSetting>('backend', 'auto');
    const setting = preferredBackend ?? windowBackend ?? configuredSetting;
    const configured = config.get<string>('cliPath', '').trim();
    const key = `${setting}\0${configured}\0${process.env.PATH ?? ''}`;
    if (cachedTarget?.key === key && fs.existsSync(cachedTarget.target.cliPath)) {
        return cachedTarget.target;
    }
    let target: CliTarget;
    try {
        target = findCliTarget(setting, configured);
    } catch (err) {
        if (preferredBackend || !windowBackend || setting === configuredSetting) {
            throw err;
        }
        target = findCliTarget(configuredSetting, configured);
    }
    cachedTarget = { key, target };
    return target;
}

/**
 * Backends installed on this machine (PATH, fallback install dirs, or `oh-my-pi-chater.cliPath`).
 * Empty when neither CLI is found. Cached per PATH/cliPath: this runs on every state sync.
 */
export function getAvailableBackends(): AgentBackend[] {
    const configured = vscode.workspace.getConfiguration('oh-my-pi-chater').get<string>('cliPath', '').trim();
    const key = `${configured}\0${process.env.PATH ?? ''}`;
    if (cachedAvailable?.key === key) {
        return cachedAvailable.backends;
    }
    let configuredBackend: AgentBackend | undefined;
    if (configured) {
        try {
            configuredBackend = findCliTarget('auto', configured).backend;
        } catch {
            /* configured path missing */
        }
    }
    const backends = (['omp', 'pi'] as const).filter((b) => {
        if (b === configuredBackend) {
            return true;
        }
        try {
            findCliTarget(b, '');
            return true;
        } catch {
            return false;
        }
    });
    cachedAvailable = { key, backends };
    return backends;
}

/** Active backend + its state dir. Falls back to the configured preference when no CLI is installed. */
export function getAgentLayout(preferredBackend?: AgentBackend): AgentLayout {
    let backend: AgentBackend;
    if (preferredBackend) {
        backend = preferredBackend;
    } else {
        try {
            backend = resolveCliTarget().backend;
        } catch {
            backend = windowBackend
                ?? (vscode.workspace.getConfiguration('oh-my-pi-chater').get<BackendSetting>('backend', 'auto') === 'omp'
                    ? 'omp'
                    : 'pi');
        }
    }
    return { backend, agentDir: resolveAgentDir(backend) };
}

/** Agent state dir of the active backend (`~/.omp/agent` or `~/.pi/agent`, env overrides honoured). */
export function getPiAgentDir(): string {
    return getAgentLayout().agentDir;
}

/** Workspace folder for Pi session scope (realpath when possible, matches CLI resolvePath). */
export function resolvePiWorkspaceCwd(sessionCwd?: string): string {
    if (sessionCwd?.trim()) {
        try {
            return fs.realpathSync(sessionCwd);
        } catch {
            return path.resolve(sessionCwd);
        }
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) {
        try {
            return fs.realpathSync(folder);
        } catch {
            return path.resolve(folder);
        }
    }
    return process.cwd();
}

function resolveSiblingNode(binDir: string): string | undefined {
    const name = process.platform === 'win32' ? 'node.exe' : 'node';
    const sibling = path.join(binDir, name);
    return fs.existsSync(sibling) ? sibling : undefined;
}

function findNodeBinary(binDir: string): string | undefined {
    // 1. Sibling next to pi CLI (e.g. nvm global install where pi and node share bin/)
    const sibling = resolveSiblingNode(binDir);
    if (sibling) {
        return sibling;
    }

    // 2. PATH
    const onPath = findOnPath('node');
    if (onPath) {
        return onPath;
    }

    // 3. Known common locations
    const home = os.homedir();
    const staticCandidates: string[] = [
        '/usr/local/bin/node',
        '/usr/bin/node',
        path.join(home, '.local/bin/node'),
    ];

    // fnm: check current alias, and scan installed versions
    staticCandidates.push(path.join(home, '.local/share/fnm/current/bin/node'));
    const fnmDir = path.join(home, '.local/share/fnm/node-versions');
    if (fs.existsSync(fnmDir)) {
        try {
            const versions = fs.readdirSync(fnmDir).sort().reverse();
            for (const v of versions) {
                staticCandidates.push(path.join(fnmDir, v, 'installation/bin/node'));
            }
        } catch {
            /* ignore */
        }
    }

    // nvm: check current alias, and scan installed versions
    staticCandidates.push(path.join(home, '.nvm/current/bin/node'));
    const nvmDir = path.join(home, '.nvm/versions/node');
    if (fs.existsSync(nvmDir)) {
        try {
            const versions = fs.readdirSync(nvmDir).sort().reverse();
            for (const v of versions) {
                staticCandidates.push(path.join(nvmDir, v, 'bin/node'));
            }
        } catch {
            /* ignore */
        }
    }

    for (const candidate of staticCandidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

/**
 * Resolve the pi `cli.js` entry (not the `pi` shell wrapper).
 * VS Code must spawn `node cli.js --mode rpc` so native modules use pi's Node, not the extension host.
 */
async function resolvePiCliJsPath(
    nodePath: string,
    cliPath: string,
    binDir: string,
): Promise<string> {
    const cacheKey = `${nodePath}\0${cliPath}\0${binDir}`;
    if (cachedPiCliJs?.key === cacheKey && fs.existsSync(cachedPiCliJs.cliJs)) {
        return cachedPiCliJs.cliJs;
    }

    try {
        const resolved = fs.realpathSync(cliPath);
        if (resolved.endsWith('.js') && fs.existsSync(resolved)) {
            cachedPiCliJs = { key: cacheKey, cliJs: resolved };
            return resolved;
        }
        const agentDir = path.dirname(path.dirname(resolved));
        const currentVersionFile = path.join(agentDir, 'install', 'current-version');
        if (fs.existsSync(currentVersionFile)) {
            const version = fs.readFileSync(currentVersionFile, 'utf8').trim();
            const managedCliJs = path.join(
                agentDir,
                'install',
                'releases',
                version,
                'node_modules',
                '@earendil-works',
                'pi-coding-agent',
                'dist',
                'cli.js',
            );
            if (fs.existsSync(managedCliJs)) {
                cachedPiCliJs = { key: cacheKey, cliJs: managedCliJs };
                return managedCliJs;
            }
        }
    } catch {
        /* fall through */
    }

    const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    };

    try {
        const { stdout } = await execFileAsync(
            nodePath,
            [
                '-p',
                "require('path').join(require.resolve('@earendil-works/pi-coding-agent/package.json'), '../dist/cli.js')",
            ],
            { timeout: 10_000, env },
        );
        const cliJs = stdout.trim();
        if (cliJs && fs.existsSync(cliJs)) {
            cachedPiCliJs = { key: cacheKey, cliJs };
            return cliJs;
        }
    } catch {
        /* fall through */
    }

    if (cliPath.endsWith('.js') && fs.existsSync(cliPath)) {
        cachedPiCliJs = { key: cacheKey, cliJs: cliPath };
        return cliPath;
    }

    throw new Error(
        `Could not resolve pi cli.js from ${cliPath}. Set oh-my-pi-chater.cliPath to your global pi binary or install @earendil-works/pi-coding-agent globally.`,
    );
}

/**
 * Resolve how to launch the agent CLI.
 * - omp: the binary itself.
 * - pi: Node + cli.js. VS Code/Cursor extension hosts embed Node 20; pi's `#!/usr/bin/env node`
 *   shebang would pick that runtime and break native modules (better-sqlite3) compiled for the
 *   user's global Node.
 */
export async function resolvePiCliInvocation(preferredBackend?: AgentBackend): Promise<PiCliInvocation> {
    const { backend, cliPath } = resolveCliTarget(preferredBackend);
    const binDir = path.dirname(cliPath);
    if (backend === 'omp') {
        return { backend, executablePath: cliPath, binDir };
    }

    const configuredNode = vscode.workspace.getConfiguration('oh-my-pi-chater').get<string>('nodePath', '').trim();
    let nodePath: string | undefined = configuredNode;
    if (nodePath && !fs.existsSync(nodePath)) {
        throw new Error(`oh-my-pi-chater.nodePath not found: ${nodePath}`);
    }
    if (!nodePath) {
        nodePath = findNodeBinary(binDir);
    }
    if (!nodePath) {
        throw new Error(
            `Could not find Node.js on PATH or next to pi (${binDir}). Set oh-my-pi-chater.nodePath to your global Node binary (e.g. ~/.nvm/versions/node/v22.x/bin/node).`,
        );
    }

    const cliJsPath = await resolvePiCliJsPath(nodePath, cliPath, binDir);
    return { backend, nodePath, cliJsPath, binDir };
}

/** Command + argv that run the CLI with `args`. */
export function cliCommand(invocation: PiCliInvocation, args: string[]): [command: string, argv: string[]] {
    return invocation.backend === 'omp'
        ? [invocation.executablePath, args]
        : [invocation.nodePath, [invocation.cliJsPath, ...args]];
}

/** Human-readable launch target for the Output channel. */
export function describeCliInvocation(invocation: PiCliInvocation): string {
    return invocation.backend === 'omp'
        ? `omp: ${invocation.executablePath}`
        : `pi: Node ${invocation.nodePath} | CLI ${invocation.cliJsPath}`;
}

/** Child-process env: user's pi Node wins over the extension host's embedded Node. */
export function piCliChildEnv(invocation: PiCliInvocation): NodeJS.ProcessEnv {
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const existing = process.env[pathKey] ?? '';
    let prefix = invocation.binDir;
    if (invocation.backend === 'pi') {
        const nodeDir = path.dirname(invocation.nodePath);
        if (nodeDir !== invocation.binDir) {
            prefix = `${invocation.binDir}${path.delimiter}${nodeDir}`;
        }
    }
    const merged = existing.includes(prefix) ? existing : `${prefix}${path.delimiter}${existing}`;
    return { ...process.env, [pathKey]: merged };
}

export async function verifyPiCliAvailable(outputChannel: vscode.OutputChannel): Promise<boolean> {
    try {
        const invocation = await resolvePiCliInvocation();
        const [command, argv] = cliCommand(invocation, ['--version']);
        const { stdout: version } = await execFileAsync(command, argv, {
            timeout: 8000,
            env: piCliChildEnv(invocation),
        });
        let runtime = '';
        if (invocation.backend === 'pi') {
            const { stdout: nodeVer } = await execFileAsync(invocation.nodePath, ['--version'], { timeout: 8000 });
            runtime = `, Node ${nodeVer.trim()}`;
        }
        outputChannel.appendLine(
            `Agent CLI OK (${describeCliInvocation(invocation)}; ${version.trim()}${runtime})`,
        );
        return true;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Agent CLI check failed: ${msg}`);
        vscode.window.showErrorMessage(`Oh My Pi Chater: agent CLI (omp / pi) not available. ${msg}`);
        return false;
    }
}

export async function runPiCliCommand(
    args: string[],
    cwd: string,
    outputChannel?: vscode.OutputChannel,
): Promise<{ stdout: string; stderr: string }> {
    const invocation = await resolvePiCliInvocation();
    const [command, argv] = cliCommand(invocation, args);
    outputChannel?.appendLine(`[${invocation.backend}] ${command} ${argv.join(' ')}`);
    const { stdout, stderr } = await execFileAsync(command, argv, {
        cwd,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: piCliChildEnv(invocation),
    });
    if (stderr.trim()) {
        outputChannel?.appendLine(`[${invocation.backend} stderr] ${stderr.trim()}`);
    }
    return { stdout, stderr };
}

/**
 * One `-p` run of the CLI with `args`: `input` goes over stdin, so text starting with "-" is never
 * read as a flag. Resolves with its trimmed output; rejects when it fails, prints nothing, or runs
 * past `timeoutMs`. `onSpawn` gets the process, to stop it early.
 */
export function runPrintMode(
    invocation: PiCliInvocation,
    args: string[],
    input: string,
    cwd: string,
    options: { timeoutMs?: number; onSpawn?: (child: ChildProcess) => void } = {},
): Promise<string> {
    const [command, argv] = cliCommand(invocation, args);
    const child = spawn(command, argv, { cwd, env: piCliChildEnv(invocation), stdio: ['pipe', 'pipe', 'pipe'] });
    options.onSpawn?.(child);
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.end(input);
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    child.on('error', reject);
    child.on('close', (code, signal) => {
        clearTimeout(timer);
        const output = stdout.trim();
        if (code === 0 && output) {
            resolve(output);
        } else {
            reject(new Error(signal ? `stopped (${signal})` : `${invocation.backend} exited with code ${code}: ${stderr.trim().slice(-300)}`));
        }
    });
    return promise;
}
