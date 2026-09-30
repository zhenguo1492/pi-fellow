import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ cwd: '', agentDirs: { pi: '', omp: '' }, piDist: '' }));

vi.mock('vscode', () => ({
    workspace: {
        get workspaceFolders() {
            return [{ uri: { fsPath: env.cwd } }];
        },
    },
}));
vi.mock('../../../pi/piCliPaths', () => ({
    getAgentLayout: (backend: 'pi' | 'omp' = 'pi') => ({ backend, agentDir: env.agentDirs[backend] }),
    resolvePiCliInvocation: async () => ({ backend: 'pi', nodePath: 'node', cliJsPath: path.join(env.piDist, 'cli.js'), binDir: env.piDist }),
}));

import { loadMcpSettingsSnapshot, probeMcpServer, setMcpServerEnabled } from '../../../pi/mcpConfig';

let root: string;
let home: string;
let originalHome: string | undefined;

function writeJson(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

interface McpFile {
    mcpServers: Record<string, unknown>;
    enabledServers?: string[];
    disabledServers?: string[];
}

function readJson(file: string): McpFile {
    // Files these tests wrote themselves; the assertions check the shape.
    return JSON.parse(fs.readFileSync(file, 'utf8')) as McpFile;
}

async function server(name: string, backend: 'pi' | 'omp') {
    const snap = await loadMcpSettingsSnapshot(undefined, backend);
    const found = snap.servers.find((s) => s.name === name);
    if (!found) {
        throw new Error(`no server ${name} in ${snap.servers.map((s) => s.name).join(', ')}`);
    }
    return found;
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-test-'));
    home = path.join(root, 'home');
    env.cwd = path.join(root, 'workspace');
    env.agentDirs = { pi: path.join(home, '.pi', 'agent'), omp: path.join(home, '.omp', 'agent') };
    // The installed pi's dist/: this one ships the built-in mcp extension.
    env.piDist = path.join(root, 'pi', 'dist');
    fs.mkdirSync(path.join(env.piDist, 'extensions', 'mcp'), { recursive: true });
    fs.mkdirSync(env.cwd, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = home;
});

afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
});

describe('omp MCP config', () => {
    it('reads project servers from .omp/mcp.json, not .pi/mcp.json or ~/.config/mcp', async () => {
        writeJson(path.join(env.cwd, '.omp', 'mcp.json'), { mcpServers: { proj: { command: 'x' } } });
        writeJson(path.join(env.cwd, '.pi', 'mcp.json'), { mcpServers: { piOnly: { command: 'x' } } });
        writeJson(path.join(home, '.config', 'mcp', 'mcp.json'), { mcpServers: { shared: { command: 'x' } } });

        const snap = await loadMcpSettingsSnapshot(undefined, 'omp');

        expect(snap.servers.map((s) => [s.name, s.scope])).toEqual([['proj', 'projectAgent']]);
        expect(snap.configPaths.find((p) => p.id === 'projectAgent')?.path).toBe(path.join(env.cwd, '.omp', 'mcp.json'));
        expect(snap.configPaths.some((p) => p.path.includes(path.join('.config', 'mcp')))).toBe(false);
    });

    it('toggles "enabled" on the winning entry and drops contradicting user overrides', async () => {
        const project = path.join(env.cwd, '.omp', 'mcp.json');
        const user = path.join(env.agentDirs.omp, 'mcp.json');
        writeJson(project, { mcpServers: { gh: { type: 'http', url: 'https://example.invalid/mcp' } } });
        writeJson(user, { mcpServers: { gh: { command: 'shadowed' } }, enabledServers: ['gh'] });

        await setMcpServerEnabled('projectAgent', 'gh', false, 'omp');

        expect(readJson(project).mcpServers.gh).toEqual({ type: 'http', url: 'https://example.invalid/mcp', enabled: false });
        expect(readJson(user).enabledServers).toBeUndefined();
        const disabled = await server('gh', 'omp');
        expect(disabled).toMatchObject({ enabled: false, scope: 'projectAgent', transport: 'http' });

        writeJson(user, { ...readJson(user), disabledServers: ['gh', 'other'] });
        await setMcpServerEnabled('projectAgent', 'gh', true, 'omp');

        expect(readJson(project).mcpServers.gh).toEqual({ type: 'http', url: 'https://example.invalid/mcp' });
        expect(readJson(user).disabledServers).toEqual(['other']);
        expect((await server('gh', 'omp')).enabled).toBe(true);
    });

    it('shows a server hidden by the user disabledServers list as disabled', async () => {
        writeJson(path.join(env.cwd, '.mcp.json'), { mcpServers: { root: { command: 'x' } } });
        writeJson(path.join(env.agentDirs.omp, 'mcp.json'), { disabledServers: ['root'] });

        expect(await server('root', 'omp')).toMatchObject({ enabled: false, scope: 'project' });
    });
});

/** pi settings.json listing pi-mcp-adapter: it replaces pi's built-in MCP client. */
function installAdapter(): void {
    writeJson(path.join(env.agentDirs.pi, 'settings.json'), { packages: ['npm:pi-mcp-adapter'] });
}

describe("pi's built-in MCP client", () => {
    it('reads only the agent dir mcp.json and .pi/mcp.json, a project entry replacing the user one', async () => {
        writeJson(path.join(env.agentDirs.pi, 'mcp.json'), { mcpServers: { a: { command: 'user' }, u: { command: 'x' } } });
        writeJson(path.join(env.cwd, '.pi', 'mcp.json'), { mcpServers: { a: { url: 'https://example.invalid/mcp' } } });
        writeJson(path.join(env.cwd, '.mcp.json'), { mcpServers: { root: { command: 'x' } } });
        writeJson(path.join(home, '.config', 'mcp', 'mcp.json'), { mcpServers: { shared: { command: 'x' } } });

        const snap = await loadMcpSettingsSnapshot(undefined, 'pi');

        expect(snap.client).toBe('pi-builtin');
        expect(snap.clientMissing).toBeUndefined();
        expect(snap.configPaths.map((p) => p.id)).toEqual(['projectAgent', 'global']);
        expect(snap.servers.map((s) => [s.name, s.scope, s.transport])).toEqual([
            ['a', 'projectAgent', 'http'],
            ['u', 'global', 'stdio'],
        ]);
    });

    it('toggles "enabled": false, the field pi reads, not "disabled"', async () => {
        const file = path.join(env.agentDirs.pi, 'mcp.json');
        writeJson(file, { mcpServers: { a: { command: 'x' }, off: { command: 'y', disabled: true } } });

        // "disabled" is pi-mcp-adapter's field; the built-in client ignores it.
        expect(await server('off', 'pi')).toMatchObject({ enabled: true });

        await setMcpServerEnabled('global', 'a', false, 'pi');
        expect(readJson(file).mcpServers.a).toEqual({ command: 'x', enabled: false });
        expect(await server('a', 'pi')).toMatchObject({ enabled: false, statusMessage: 'Disabled ("enabled": false)' });

        await setMcpServerEnabled('global', 'a', true, 'pi');
        expect(readJson(file).mcpServers.a).toEqual({ command: 'x' });
    });

    it('reports no client when settings turn builtin:mcp off, a project "+" turning it back on', async () => {
        writeJson(path.join(env.agentDirs.pi, 'settings.json'), { extensions: ['-builtin:mcp'] });
        expect(await loadMcpSettingsSnapshot(undefined, 'pi')).toMatchObject({ client: 'pi-builtin', clientMissing: 'builtin-disabled' });

        writeJson(path.join(env.cwd, '.pi', 'settings.json'), { extensions: ['+builtin:mcp'] });
        expect((await loadMcpSettingsSnapshot(undefined, 'pi')).clientMissing).toBeUndefined();
    });

    it('uses pi-mcp-adapter when installed, as a package object too, and asks for it on a pi without the built-in client', async () => {
        writeJson(path.join(env.cwd, '.pi', 'settings.json'), { packages: [{ source: 'npm:pi-mcp-adapter@2' }], extensions: ['-builtin:mcp'] });
        expect(await loadMcpSettingsSnapshot(undefined, 'pi')).toMatchObject({ client: 'pi-adapter', clientMissing: undefined });

        fs.rmSync(path.join(env.cwd, '.pi', 'settings.json'));
        fs.rmSync(path.join(env.piDist, 'extensions'), { recursive: true });
        expect(await loadMcpSettingsSnapshot(undefined, 'pi')).toMatchObject({ client: 'pi-adapter', clientMissing: 'adapter-missing' });
    });
});

describe('pi-mcp-adapter MCP config', () => {
    beforeEach(installAdapter);

    it('toggles "disabled" in place, keeping the rest of the file and its permissions', async () => {
        const file = path.join(env.cwd, '.mcp.json');
        const original = { settings: { toolPrefix: 'short' }, mcpServers: { a: { command: 'npx', args: ['-y', 'a'] } } };
        writeJson(file, original);
        fs.chmodSync(file, 0o600);

        await setMcpServerEnabled('project', 'a', false, 'pi');

        expect(readJson(file)).toEqual({ ...original, mcpServers: { a: { ...original.mcpServers.a, disabled: true } } });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(await server('a', 'pi')).toMatchObject({ enabled: false, status: 'disabled' });

        await setMcpServerEnabled('project', 'a', true, 'pi');

        expect(readJson(file)).toEqual(original);
        expect((await server('a', 'pi')).enabled).toBe(true);
    });

    it('treats an override-only entry as the owner and removes it on enable', async () => {
        writeJson(path.join(env.cwd, '.mcp.json'), { mcpServers: { a: { url: 'https://example.invalid/mcp' } } });
        const override = path.join(env.cwd, '.pi', 'mcp.json');
        writeJson(override, { mcpServers: { a: { disabled: true } } });

        expect(await server('a', 'pi')).toMatchObject({
            enabled: false,
            scope: 'projectAgent',
            transport: 'http',
            url: 'https://example.invalid/mcp',
        });

        await setMcpServerEnabled('projectAgent', 'a', true, 'pi');

        expect(readJson(override).mcpServers).toEqual({});
        expect(await server('a', 'pi')).toMatchObject({ enabled: true, scope: 'project' });
    });

    it('writes "disabled": false when a lower file would still disable the merged entry', async () => {
        writeJson(path.join(env.agentDirs.pi, 'mcp.json'), { mcpServers: { a: { command: 'x', disabled: true } } });
        const project = path.join(env.cwd, '.mcp.json');
        writeJson(project, { mcpServers: { a: { args: ['--flag'] } } });

        expect(await server('a', 'pi')).toMatchObject({ enabled: false, scope: 'project' });

        await setMcpServerEnabled('project', 'a', true, 'pi');

        expect(readJson(project).mcpServers.a).toEqual({ args: ['--flag'], disabled: false });
        expect((await server('a', 'pi')).enabled).toBe(true);
    });

    it('gives ~/.config/mcp servers their own scope and toggles them in that file', async () => {
        const shared = path.join(home, '.config', 'mcp', 'mcp.json');
        writeJson(shared, { mcpServers: { s: { command: 'x' } } });

        expect(await server('s', 'pi')).toMatchObject({ scope: 'sharedGlobal', canToggle: true, ownerPath: shared });

        await setMcpServerEnabled('sharedGlobal', 's', false, 'pi');
        expect(readJson(shared).mcpServers.s).toEqual({ command: 'x', disabled: true });
        expect(fs.existsSync(path.join(env.agentDirs.pi, 'mcp.json'))).toBe(false);

        await setMcpServerEnabled('sharedGlobal', 's', true, 'pi');
        expect(readJson(shared).mcpServers.s).toEqual({ command: 'x' });
    });

    it('lists legacy disabledMcpServers entries as disabled and restores them on enable', async () => {
        const file = path.join(env.agentDirs.pi, 'mcp.json');
        writeJson(file, { mcpServers: { live: { command: 'x' } }, disabledMcpServers: { old: { command: 'y' } } });

        expect(await server('old', 'pi')).toMatchObject({ enabled: false, canToggle: true, scope: 'global' });

        await setMcpServerEnabled('global', 'old', true, 'pi');
        expect(readJson(file)).toEqual({ mcpServers: { live: { command: 'x' }, old: { command: 'y' } } });

        await setMcpServerEnabled('global', 'old', false, 'pi');
        expect(readJson(file)).toEqual({ mcpServers: { live: { command: 'x' }, old: { command: 'y', disabled: true } } });
    });

    it('refuses to rewrite a config it cannot parse', async () => {
        const file = path.join(env.cwd, '.mcp.json');
        fs.writeFileSync(file, '{ // comment\n "mcpServers": {} }');

        await expect(setMcpServerEnabled('project', 'a', false, 'pi')).rejects.toThrow(/Cannot parse/);
        expect(fs.readFileSync(file, 'utf8')).toBe('{ // comment\n "mcpServers": {} }');
    });
});

describe('probeMcpServer', () => {
    it('returns on the status line and closes a streaming response', async () => {
        let socketClosed!: Promise<void>;
        const httpServer = http.createServer((req, res) => {
            if (req.url === '/auth') {
                res.writeHead(401).end();
                return;
            }
            const closed = Promise.withResolvers<void>();
            req.socket.once('close', () => closed.resolve());
            socketClosed = closed.promise;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(': stream open\n\n');
        });
        const listening = Promise.withResolvers<void>();
        httpServer.listen(0, '127.0.0.1', listening.resolve);
        await listening.promise;
        const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
        try {
            installAdapter();
            writeJson(path.join(env.cwd, '.mcp.json'), {
                mcpServers: { sse: { url: `${base}/sse` }, auth: { url: `${base}/auth` } },
            });

            expect(await probeMcpServer(await server('sse', 'pi'), 'pi')).toEqual({
                ok: true,
                message: 'HTTP 200 — reachable (MCP handshake not tested)',
            });
            // A probe that leaves the body open never closes this socket, and the test times out.
            await socketClosed;

            expect(await probeMcpServer(await server('auth', 'pi'), 'pi')).toEqual({
                ok: true,
                message: 'HTTP 401 — reachable, needs auth',
            });
        } finally {
            httpServer.closeAllConnections();
            httpServer.close();
        }
    }, 10_000);
});
