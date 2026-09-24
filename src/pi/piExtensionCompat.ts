import * as fs from 'node:fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { getPiAgentDir, piCliChildEnv, type PiNodeInvocation, resolvePiCliInvocation } from './piCliPaths';

const execFileAsync = promisify(execFile);

/** Minimal shape for legacy extension-load diagnostics (SDK no longer bundled). */
export interface LoadExtensionsResult {
    extensions?: unknown[];
    errors?: Array<{ path: string; error: unknown }>;
}

export interface ExtensionLoadIssue {
    path: string;
    message: string;
    category: 'native' | 'tui' | 'sdk' | 'other';
    hint: string;
}

const NATIVE_RE =
    /NODE_MODULE_VERSION|was compiled against a different|better-sqlite3|bindings\.node|dlopen|ERR_DLOPEN|native module|sqlite3/i;
const TUI_RE = /pi-tui|no TUI|terminal|overlay|stdin|TTY|raw mode/i;
const SDK_RE = /pi-coding-agent|theme|getMarkdownTheme|Cannot find module '@earendil-works/i;

export function classifyExtensionErrorMessage(message: string): ExtensionLoadIssue['category'] {
    if (NATIVE_RE.test(message)) {
        return 'native';
    }
    if (TUI_RE.test(message)) {
        return 'tui';
    }
    if (SDK_RE.test(message)) {
        return 'sdk';
    }
    return 'other';
}

export function hintForExtensionCategory(category: ExtensionLoadIssue['category']): string {
    switch (category) {
        case 'native':
            return 'Pi tools run in a separate pi Node process (not VS Code\'s embedded Node). Reload session (/reload). Rebuild only if "Rebuild Pi native modules" reports a load failure under pi Node.';
        case 'tui':
            return 'Package targets Pi terminal UI. In VS Code only tools using ctx.ui dialogs work; footers/overlays are CLI-only.';
        case 'sdk':
            return 'Update Oh My Pi Chater and Pi packages to matching versions, then reload session.';
        default:
            return 'See Output → Oh My Pi Chater. Fix or remove the package in ~/.pi/agent/settings.json.';
    }
}

export function buildExtensionLoadIssues(
    result: LoadExtensionsResult | undefined,
): ExtensionLoadIssue[] {
    if (!result?.errors?.length) {
        return [];
    }
    return result.errors.map((err) => {
        const message = err.error instanceof Error ? err.error.message : String(err.error);
        const category = classifyExtensionErrorMessage(message);
        return {
            path: err.path,
            message,
            category,
            hint: hintForExtensionCategory(category),
        };
    });
}

export function formatExtensionLoadSummary(
    result: LoadExtensionsResult | undefined,
): { loaded: number; issues: ExtensionLoadIssue[] } {
    const loaded = result?.extensions?.length ?? 0;
    const issues = buildExtensionLoadIssues(result);
    return { loaded, issues };
}

export async function notifyExtensionLoadIssues(
    result: LoadExtensionsResult | undefined,
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    const { issues } = formatExtensionLoadSummary(result);
    if (issues.length === 0) {
        return;
    }

    const nativeCount = issues.filter((i) => i.category === 'native').length;
    const headline =
        nativeCount > 0
            ? `${issues.length} Pi package(s) failed to load (${nativeCount} native module). Memory/search packages may be unavailable.`
            : `${issues.length} Pi package(s) failed to load. Some CLI features will not work in VS Code.`;

    outputChannel.appendLine(headline);
    for (const issue of issues) {
        outputChannel.appendLine(`  [${issue.category}] ${issue.path}`);
        outputChannel.appendLine(`    ${issue.message}`);
        outputChannel.appendLine(`    -> ${issue.hint}`);
    }

    const action = nativeCount > 0 ? 'Rebuild native modules' : 'Open Output';
    const pick = await vscode.window.showWarningMessage(headline, { modal: false }, action, 'Dismiss');
    if (pick === 'Rebuild native modules') {
        await vscode.commands.executeCommand('oh-my-pi-chater.rebuildNativeModules');
    } else if (pick === 'Open Output') {
        outputChannel.show(true);
    }
}

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
            title: 'Oh My Pi Chater: rebuilding Pi native modules...',
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
                    `Native rebuild failed. See Output → Oh My Pi Chater. ${msg.slice(0, 240)}`,
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
