import * as fs from 'node:fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { getPiAgentDir, piCliChildEnv, type PiNodeInvocation, resolvePiCliInvocation } from './piCliPaths';

const execFileAsync = promisify(execFile);

function piNpmEnv(invocation: PiNodeInvocation, npmDir: string): NodeJS.ProcessEnv {
    return {
        ...piCliChildEnv(invocation),
        NODE_PATH: path.join(npmDir, 'node_modules'),
    };
}

/** True when better-sqlite3 loads under the pi CLI Node (not the VS Code extension host). */
export async function canLoadPiNativeModules(
    invocation: PiNodeInvocation,
    npmDir: string,
): Promise<boolean> {
    const sqliteDir = path.join(npmDir, 'node_modules', 'better-sqlite3');
    if (!fs.existsSync(sqliteDir)) {
        return true;
    }
    try {
        await execFileAsync(
            invocation.nodePath,
            ['-e', "require('better-sqlite3')"],
            { cwd: npmDir, timeout: 15_000, env: piNpmEnv(invocation, npmDir) },
        );
        return true;
    } catch {
        return false;
    }
}

async function findPythonForNodeGyp(): Promise<string | undefined> {
    const candidates = ['python3.12', 'python3.11', 'python3.10', 'python3'];
    for (const candidate of candidates) {
        try {
            const { stdout } = await execFileAsync('which', [candidate], { timeout: 3000 });
            if (stdout.trim()) {
                return candidate;
            }
        } catch {
            /* try next */
        }
    }
    return undefined;
}

function resolvePiNpmCommand(invocation: PiNodeInvocation): string {
    const npmBin = path.join(invocation.binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    return fs.existsSync(npmBin) ? npmBin : 'npm';
}

async function runNativeRebuild(
    npmCmd: string,
    npmDir: string,
    env: NodeJS.ProcessEnv,
    args: string[],
): Promise<void> {
    await execFileAsync(npmCmd, args, {
        cwd: npmDir,
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
        env,
    });
}

export async function rebuildAgentNativeModules(
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    let resolved;
    try {
        resolved = await resolvePiCliInvocation();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Cannot rebuild native modules: ${msg}`);
        outputChannel.appendLine(msg);
        return;
    }
    if (resolved.backend === 'omp') {
        const msg = 'omp is a self-contained binary; there are no Node native modules to rebuild.';
        outputChannel.appendLine(msg);
        vscode.window.showInformationMessage(msg);
        return;
    }
    const invocation = resolved;

    const agentDir = getPiAgentDir();
    const npmDir = path.join(agentDir, 'npm');
    if (!fs.existsSync(npmDir)) {
        const msg = `Pi npm dir not found: ${npmDir}`;
        vscode.window.showErrorMessage(msg);
        outputChannel.appendLine(msg);
        return;
    }

    const { stdout: nodeVer } = await execFileAsync(invocation.nodePath, ['--version'], { timeout: 8000 });
    const hostModules = process.versions.modules ?? '?';
    let piModules = '?';
    try {
        const { stdout } = await execFileAsync(
            invocation.nodePath,
            ['-p', 'process.versions.modules'],
            { timeout: 8000 },
        );
        piModules = stdout.trim();
    } catch {
        /* optional */
    }

    outputChannel.appendLine(
        `Native module check: pi Node ${nodeVer.trim()} (NODE_MODULE_VERSION ${piModules}); ` +
            `VS Code host NODE_MODULE_VERSION ${hostModules} (expected to differ — pi runs in a child process).`,
    );

    if (await canLoadPiNativeModules(invocation, npmDir)) {
        outputChannel.appendLine('better-sqlite3 already loads under pi Node — rebuild not required.');
        const reload = await vscode.window.showInformationMessage(
            'Pi native modules are OK under your global pi Node. If tools still fail, reload the session so pi is respawned with the correct Node.',
            'Reload Session',
            'Rebuild Anyway',
        );
        if (reload === 'Reload Session') {
            await vscode.commands.executeCommand('oh-my-pi-chater.reloadSession');
            return;
        }
        if (reload !== 'Rebuild Anyway') {
            return;
        }
    }

    const npmCmd = resolvePiNpmCommand(invocation);
    const baseEnv = piNpmEnv(invocation, npmDir);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Pi Fellow: rebuilding Pi native modules...',
            cancellable: false,
        },
        async () => {
            outputChannel.appendLine(`Rebuilding better-sqlite3 in ${npmDir} for pi Node ${nodeVer.trim()}…`);
            try {
                outputChannel.appendLine('[1/2] npm rebuild better-sqlite3 (prebuilt binary when available)…');
                await runNativeRebuild(npmCmd, npmDir, baseEnv, ['rebuild', 'better-sqlite3']);

                if (await canLoadPiNativeModules(invocation, npmDir)) {
                    outputChannel.appendLine('Native module rebuild succeeded (prebuilt binary).');
                    await offerReloadAfterRebuild();
                    return;
                }

                const python = await findPythonForNodeGyp();
                if (!python) {
                    throw new Error(
                        'better-sqlite3 still fails to load and no python3.12/3.11/3.10 found for source rebuild. ' +
                            'Install Python 3.12 (brew install python@3.12) or fix pi Node/npm.',
                    );
                }

                outputChannel.appendLine(
                    `[2/2] npm rebuild better-sqlite3 --build-from-source (PYTHON=${python})…`,
                );
                await runNativeRebuild(npmCmd, npmDir, { ...baseEnv, PYTHON: python }, [
                    'rebuild',
                    'better-sqlite3',
                    '--build-from-source',
                ]);

                if (!(await canLoadPiNativeModules(invocation, npmDir))) {
                    throw new Error('better-sqlite3 still fails to load after rebuild.');
                }

                outputChannel.appendLine('Native module rebuild finished for pi CLI Node.');
                await offerReloadAfterRebuild();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                outputChannel.appendLine(`Native rebuild failed: ${msg}`);
                vscode.window.showErrorMessage(
                    `Native rebuild failed. See Output → Pi Fellow. ${msg.slice(0, 240)}`,
                );
                throw err;
            }
        },
    );

    async function offerReloadAfterRebuild(): Promise<void> {
        const reload = await vscode.window.showInformationMessage(
            'Pi native modules rebuilt for your global pi Node. Reload session (/reload) or restart the extension.',
            'Reload Session',
        );
        if (reload === 'Reload Session') {
            await vscode.commands.executeCommand('oh-my-pi-chater.reloadSession');
        }
    }
}
