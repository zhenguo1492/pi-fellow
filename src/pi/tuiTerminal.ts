import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import * as vscode from 'vscode';
import { ScreenReader, watchScreenText, type TerminalScreen } from './terminalScreen';
import { cliCommand, piCliChildEnv, resolvePiCliInvocation } from './piCliPaths';
import type { AgentBackend } from './agentBackend';

/** Matches the webview terminals, so a snapshot carries the same history the view had. */
const SCROLLBACK_LINES = 5000;

/**
 * The CLI enables bracketed paste once its editor is up, but still drops keys for a few ms after
 * that (omp: ~50ms). Wait past both before typing; fall back to typing anyway if the mode never shows.
 */
const INPUT_SETTLE_MS = 300;
const INPUT_READY_TIMEOUT_MS = 8000;

/** Subset of node-pty's API used here (VS Code ships node-pty; we do not bundle our own). */
interface Pty {
    readonly pid: number;
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
}

interface NodePty {
    spawn(
        file: string,
        args: string[],
        options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
    ): Pty;
}

let nodePty: NodePty | undefined;

/**
 * node-pty from the running editor install: same Electron ABI as the extension host, so no native
 * module has to be built or shipped in the VSIX.
 */
function loadNodePty(): NodePty {
    if (nodePty) {
        return nodePty;
    }
    // Current VS Code: JS inside node_modules.asar (Electron reads asar transparently), native
    // binary in node_modules.asar.unpacked. Older builds and some forks ship a plain node_modules.
    for (const rel of ['node_modules.asar/node-pty', 'node_modules/node-pty']) {
        const dir = path.join(vscode.env.appRoot, rel);
        if (fs.existsSync(dir)) {
            // Path is inside the host editor install and only known at runtime — cannot be a static import.
            nodePty = require(dir) as NodePty;
            return nodePty;
        }
    }
    throw new Error(`node-pty not found under ${vscode.env.appRoot}; TUI mode needs the editor's bundled node-pty.`);
}

export interface TuiProcessOptions {
    cwd: string;
    /** Session to resume; the TUI writes to this exact file even if it does not exist yet. */
    sessionFile?: string;
    backend?: AgentBackend;
    cols: number;
    rows: number;
    onData: (data: string) => void;
    /** The output changed the screen's text (not only its colors): the TUI drew something new. */
    onScreenChange: () => void;
    /** The TUI set its terminal title (OSC 0/2); omp's `π ! …` says it waits on the user. */
    onTitleChange: () => void;
    onExit: (exitCode: number) => void;
}

/**
 * The agent CLI's interactive TUI (`omp` / `pi` without --mode) running in a pseudo-terminal.
 * All output is also parsed into a headless terminal: webviews lose their xterm when disposed and
 * drop messages while hidden, so a view re-attaches from `snapshot()` instead of the raw stream.
 */
export class TuiProcess {
    private _exitCode: number | undefined;
    /** Output held back while a snapshot is being taken; delivered right after it. */
    private _held: string | undefined;
    /** The screen as the voice agent and the dialog cards see it, made on first use. */
    private _screen: ScreenReader | undefined;
    /** Resolves once the CLI enabled bracketed paste, i.e. its editor is reading keys. */
    private readonly _inputReady = Promise.withResolvers<void>();
    /** The terminal title the TUI last set. */
    private _title = '';

    private constructor(
        private readonly _pty: Pty,
        private readonly _mirror: HeadlessTerminal,
        private readonly _serializer: SerializeAddon,
        private _cols: number,
        private _rows: number,
        /** Folder the TUI runs in; its `/resume` "current folder" scope. */
        readonly cwd: string,
        /** CLI actually launched (owns the session store). */
        readonly backend: AgentBackend,
        /** Session passed via `--session` at launch (the TUI may switch later). */
        readonly sessionFile: string | undefined,
    ) {}

    static async start(options: TuiProcessOptions): Promise<TuiProcess> {
        const invocation = await resolvePiCliInvocation(options.backend);
        const args: string[] = [];
        if (options.sessionFile) {
            args.push('--session', options.sessionFile);
        }
        const [command, argv] = cliCommand(invocation, args);
        const pty = loadNodePty().spawn(command, argv, {
            name: 'xterm-256color',
            cols: options.cols,
            rows: options.rows,
            cwd: options.cwd,
            env: { ...piCliChildEnv(invocation), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        });
        const mirror = new HeadlessTerminal({
            cols: options.cols,
            rows: options.rows,
            scrollback: SCROLLBACK_LINES,
            allowProposedApi: true,
        });
        const serializer = new SerializeAddon();
        mirror.loadAddon(serializer);
        const proc = new TuiProcess(
            pty,
            mirror,
            serializer,
            options.cols,
            options.rows,
            options.cwd,
            invocation.backend,
            options.sessionFile,
        );
        // Disposed with the mirror when the TUI exits.
        watchScreenText(mirror, options.onScreenChange);
        mirror.onTitleChange((title) => {
            proc._title = title;
            options.onTitleChange();
        });
        pty.onData((data) => {
            mirror.write(data, () => {
                if (mirror.modes.bracketedPasteMode) {
                    proc._inputReady.resolve();
                }
            });
            if (proc._held !== undefined) {
                proc._held += data;
            } else {
                options.onData(data);
            }
        });
        pty.onExit(({ exitCode }) => {
            proc._exitCode = exitCode;
            mirror.dispose();
            options.onExit(exitCode);
        });
        return proc;
    }

    get exited(): boolean {
        return this._exitCode !== undefined;
    }

    get title(): string {
        return this._title;
    }

    write(data: string): void {
        if (!this.exited) {
            this._pty.write(data);
        }
    }

    /** Type `text` as soon as the TUI's editor accepts input (keys sent earlier are lost). */
    async typeWhenReady(text: string): Promise<void> {
        await Promise.race([this._inputReady.promise, sleep(INPUT_READY_TIMEOUT_MS)]);
        await sleep(INPUT_SETTLE_MS);
        this.write(text);
    }

    resize(cols: number, rows: number): void {
        if (this.exited || cols < 2 || rows < 2 || (cols === this._cols && rows === this._rows)) {
            return;
        }
        this._cols = cols;
        this._rows = rows;
        this._pty.resize(cols, rows);
        this._mirror.resize(cols, rows);
    }

    /** The voice agent's view of the TUI's screen (the mirror); throws once the TUI has exited and the mirror is gone. */
    screen(): TerminalScreen {
        if (this.exited) {
            throw new Error('The TUI has exited.');
        }
        this._screen ??= new ScreenReader(this._mirror, (keys) => this.write(keys));
        return this._screen;
    }

    /**
     * Escape-sequence stream that rebuilds the current screen + scrollback in an empty terminal.
     * Output arriving while the mirror catches up is held and appended, so nothing is lost or
     * duplicated as long as callers stop forwarding earlier output before relying on this.
     */
    snapshot(): Promise<string> {
        this._held ??= '';
        const { promise, resolve } = Promise.withResolvers<string>();
        // Empty write = barrier: its callback runs once all earlier output has been parsed.
        this._mirror.write('', () => {
            const after = this._held ?? '';
            this._held = undefined;
            resolve(this._serializer.serialize({ scrollback: SCROLLBACK_LINES }) + after);
        });
        return promise;
    }

    /** Stop the TUI; resolves once the process is gone (every message is already on disk). */
    async dispose(): Promise<void> {
        if (this.exited) {
            return;
        }
        const { promise: exited, resolve } = Promise.withResolvers<void>();
        this._pty.onExit(() => resolve());
        this._pty.kill('SIGTERM');
        await Promise.race([exited, sleep(2000)]);
        if (!this.exited) {
            this._pty.kill('SIGKILL');
        }
    }
}
