import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { cleanTerminalOutput, pickName } from './pairText';

/** Of a long log file only its end is read. */
const TAIL_BYTES = 256 * 1024;
/** Output kept per terminal command, and commands kept per terminal. */
const MAX_COMMAND_CHARS = 100_000;
const COMMANDS_PER_TERMINAL = 5;
/** What one read_output call returns at most. */
const MAX_READ_CHARS = 16_000;

/** Log files the Output panel lists under another name; the rest go by their file name. */
const CHANNEL_NAMES: Record<string, string> = {
    renderer: 'Window',
    exthost: 'Extension Host',
    main: 'Main',
    sharedprocess: 'Shared',
    ptyhost: 'Pty Host',
    tasks: 'Tasks',
};

interface Source {
    name: string;
    /** For the list: size, or the last command. */
    note: string;
    group: 'Output panel' | 'Debug Console' | 'Terminals';
    text(): Promise<string>;
}

interface TerminalCommand {
    command: string;
    output: string;
    exitCode?: number;
    done: boolean;
}

/**
 * Everything VS Code prints that the voice agent may read (docs/voice-pair-agent-cursor.md §12): the
 * Output panel's channels, the Debug Console, and the commands run in any terminal.
 *
 * VS Code has no API to read another extension's output channel, but it writes every channel to a
 * log file in the window's log folder, next to this extension's own `logUri`; those files are read.
 * Terminal commands are recorded from shell integration as they run, so only commands started
 * while the extension runs, in terminals with shell integration, are there.
 */
export class OutputReader implements vscode.Disposable {
    private readonly _terminals = new Map<vscode.Terminal, TerminalCommand[]>();
    private readonly _running = new Map<vscode.TerminalShellExecution, TerminalCommand>();
    private readonly _subscriptions: vscode.Disposable[];

    constructor(
        /** `<logs>/<session>/window<N>/exthost/<extension id>`. */
        private readonly _logUri: vscode.Uri,
        /** Debug Console text per debug run, newest first. */
        private readonly _debugConsoles: () => Array<{ name: string; text: string }>,
    ) {
        this._subscriptions = [
            vscode.window.onDidStartTerminalShellExecution((e) => {
                const record: TerminalCommand = { command: e.execution.commandLine.value, output: '', done: false };
                const commands = this._terminals.get(e.terminal) ?? [];
                commands.push(record);
                if (commands.length > COMMANDS_PER_TERMINAL) {
                    commands.shift();
                }
                this._terminals.set(e.terminal, commands);
                this._running.set(e.execution, record);
                // read() only sees what comes after its first call: it must start right here.
                void (async () => {
                    for await (const data of e.execution.read()) {
                        record.output = (record.output + data).slice(-MAX_COMMAND_CHARS);
                    }
                })().catch(() => undefined);
            }),
            vscode.window.onDidEndTerminalShellExecution((e) => {
                const record = this._running.get(e.execution);
                if (record) {
                    record.exitCode = e.exitCode;
                    record.done = true;
                    this._running.delete(e.execution);
                }
            }),
            vscode.window.onDidCloseTerminal((terminal) => {
                const commands = this._terminals.get(terminal) ?? [];
                for (const [execution, record] of this._running) {
                    if (commands.includes(record)) {
                        this._running.delete(execution);
                    }
                }
                this._terminals.delete(terminal);
            }),
        ];
    }

    dispose(): void {
        for (const subscription of this._subscriptions) {
            subscription.dispose();
        }
    }

    /** What there is to read, by group. */
    async list(): Promise<string> {
        const sources = await this._sources();
        const lines: string[] = [];
        for (const group of ['Output panel', 'Debug Console', 'Terminals'] as const) {
            const mine = sources.filter((s) => s.group === group);
            lines.push(`${group}: ${mine.length === 0 ? '(none)' : mine.map((s) => `${s.name} (${s.note})`).join(', ')}`);
        }
        lines.push('Pass one of these names as source.');
        return lines.join('\n');
    }

    /** The last `lines` lines of the source `query` names. */
    async read(query: string, lines: number): Promise<string> {
        const sources = await this._sources();
        const picked = pickName(
            sources.map((s) => s.name),
            query,
            'output',
        );
        if ('error' in picked) {
            throw new Error(picked.error);
        }
        const source = sources.find((s) => s.name === picked.name);
        const text = source ? cleanTerminalOutput(await source.text(), lines, MAX_READ_CHARS) : '';
        return `${picked.name}:\n${text || '(empty)'}`;
    }

    private async _sources(): Promise<Source[]> {
        const sources: Source[] = [];
        const taken: Record<string, number> = {};
        const add = (source: Source) => {
            const n = (taken[source.name] = (taken[source.name] ?? 0) + 1);
            sources.push(n === 1 ? source : { ...source, name: `${source.name} (${n})` });
        };
        for (const file of await this._logFiles()) {
            add({ name: file.name, note: `${Math.max(1, Math.round(file.size / 1024))} KB`, group: 'Output panel', text: () => tail(file.path) });
        }
        this._debugConsoles().forEach(({ name, text }, i) => {
            add({
                // The latest is plain "Debug Console", so asking for that gets it.
                name: i === 0 ? 'Debug Console' : `Earlier debug console: ${name}`,
                note: i === 0 ? name : `${Math.max(1, Math.round(text.length / 1024))} KB`,
                group: 'Debug Console',
                text: async () => text,
            });
        });
        for (const terminal of vscode.window.terminals) {
            const commands = this._terminals.get(terminal) ?? [];
            const last = commands.at(-1);
            const note = last
                ? `last: ${last.command.slice(0, 60)}, ${last.done ? `exit code ${last.exitCode ?? 'unknown'}` : 'running'}`
                : terminal.shellIntegration
                  ? 'no commands seen yet'
                  : 'no shell integration: its output cannot be read';
            add({
                name: `Terminal: ${terminal.name}`,
                note,
                group: 'Terminals',
                text: async () =>
                    commands
                        .map((c) => `$ ${c.command}\n${cleanTerminalOutput(c.output, 400, MAX_READ_CHARS)}\n(${c.done ? `exit code ${c.exitCode ?? 'unknown'}` : 'still running'})`)
                        .join('\n\n') || `(${note})`,
            });
        }
        return sources;
    }

    /** The Output panel's channels as this window's log files, non-empty ones only. */
    private async _logFiles(): Promise<Array<{ name: string; path: string; size: number }>> {
        const exthost = path.dirname(this._logUri.fsPath);
        const window = path.dirname(exthost);
        const session = path.dirname(window);
        const found: Array<{ name: string; path: string; size: number }> = [];
        const scan = async (dir: string, name: (file: string) => string | undefined) => {
            for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
                const channel = entry.isFile() && entry.name.endsWith('.log') ? name(entry.name.slice(0, -'.log'.length)) : undefined;
                const size = channel ? await fs.stat(path.join(dir, entry.name)).then((s) => s.size, () => 0) : 0;
                if (channel && size > 0) {
                    found.push({ name: channel, path: path.join(dir, entry.name), size });
                }
            }
        };
        const dirs = async (dir: string) => (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
        const known = (base: string) => CHANNEL_NAMES[base] ?? base;
        const extDirs = await dirs(exthost);
        // Extensions' plain channels, `<n>-<name>.log`, in one folder per extension host start: the newest is this one.
        const plain = extDirs.filter((d) => d.startsWith('output_logging_')).sort().at(-1);
        if (plain) {
            await scan(path.join(exthost, plain), (base) => base.replace(/^\d+-/, ''));
        }
        // Log channels, one folder per extension.
        for (const dir of extDirs.filter((d) => !d.startsWith('output_logging_'))) {
            await scan(path.join(exthost, dir), (base) => base);
        }
        await scan(exthost, known);
        const tasks = (await dirs(window)).filter((d) => d.startsWith('output_')).sort().at(-1);
        if (tasks) {
            await scan(path.join(window, tasks), known);
        }
        await scan(window, known);
        await scan(session, known);
        return found;
    }
}

/** The end of a file, from a line start. */
async function tail(file: string): Promise<string> {
    const handle = await fs.open(file, 'r');
    try {
        const { size } = await handle.stat();
        const start = Math.max(0, size - TAIL_BYTES);
        const buffer = Buffer.alloc(size - start);
        await handle.read(buffer, 0, buffer.length, start);
        const text = buffer.toString('utf8');
        return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
        await handle.close();
    }
}
