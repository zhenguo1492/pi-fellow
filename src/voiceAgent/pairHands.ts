import { setTimeout as sleep } from 'node:timers/promises';
import * as vscode from 'vscode';
import type { AgentCursor } from './agentCursor';
import type { CodeAnchor } from './codeAnchors';
import type { DebugDriver } from './debugDriver';
import { FileHands } from './fileHands';
import type { DebugAction, EditorHands } from './hostTools';
import { cleanTerminalOutput, locateEdit } from './pairText';
import type { OutputReader } from './vscodeOutput';

/** Typing speed: one line per this long, or faster so the whole edit takes at most MAX_TYPING_MS. */
const LINE_MS = 90;
const MAX_TYPING_MS = 2000;
/** A new terminal's shell integration normally arrives within a second or two. */
const SHELL_INTEGRATION_WAIT_MS = 5000;
/** Output kept while a command runs; only its tail goes to the model. */
const MAX_OUTPUT_CHARS = 200_000;

/**
 * The voice agent's hands in the user's VS Code (docs/voice-pair-agent-cursor.md §11-§13): it opens
 * code and reads VS Code's output, and in pair mode types edits into the editor line by line at Pi's
 * writing highlight, manages files, runs commands in a Pi terminal the user can see, and drives the debugger.
 */
export class PairHands implements EditorHands, vscode.Disposable {
    /** Pi terminals, oldest first; a busy one is running a command. */
    private readonly _terminals: vscode.Terminal[] = [];
    private readonly _busy = new Set<vscode.Terminal>();
    private readonly _subscription: vscode.Disposable;
    /** Every path the pair tools touch goes through its workspace check. */
    private readonly _files: FileHands;

    constructor(
        /** Relative paths and Pi terminals start here. */
        private readonly _root: string,
        private readonly _cursor: AgentCursor,
        private readonly _debug: DebugDriver,
        private readonly _output: OutputReader,
    ) {
        this._files = new FileHands(_root, _cursor);
        this._subscription = vscode.window.onDidCloseTerminal((terminal) => {
            const i = this._terminals.indexOf(terminal);
            if (i >= 0) {
                this._terminals.splice(i, 1);
            }
            this._busy.delete(terminal);
        });
    }

    dispose(): void {
        this._subscription.dispose();
    }

    openFile(target: CodeAnchor): Promise<string> {
        return this._cursor.open(target);
    }

    readOutput(source: string | undefined, lines: number): Promise<string> {
        return source ? this._output.read(source, lines) : this._output.list();
    }

    startDebugging(configuration: string | undefined, noDebug: boolean, timeoutMs: number): Promise<string> {
        return this._debug.start(configuration, noDebug, timeoutMs);
    }

    controlDebugging(action: DebugAction, timeoutMs: number): Promise<string> {
        return this._debug.control(action, timeoutMs);
    }

    setBreakpoint(breakpoint: { path: string; line: number; condition?: string; remove: boolean }): Promise<string> {
        return this._debug.setBreakpoint(breakpoint);
    }

    inspectDebugging(expression: string | undefined): Promise<string> {
        return this._debug.inspect(expression);
    }

    createFile(target: string, content: string): Promise<string> {
        return this._files.createFile(target, content);
    }

    createFolder(target: string): Promise<string> {
        return this._files.createFolder(target);
    }

    renamePath(from: string, to: string): Promise<string> {
        return this._files.rename(from, to);
    }

    describeDeletion(target: string, recursive: boolean): Promise<string> {
        return this._files.describeDeletion(target, recursive);
    }

    deletePath(target: string, recursive: boolean): Promise<string> {
        return this._files.delete(target, recursive);
    }

    saveFiles(target: string | undefined): Promise<string> {
        return this._files.save(target);
    }

    closeEditor(target: string): Promise<string> {
        return this._files.close(target);
    }

    async editFile(edit: { path: string; oldText: string; newText: string; nearLine?: number }): Promise<string> {
        const { uri, relative } = await this._files.resolve(edit.path);
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            throw new Error(`${relative} does not exist: create it with create_file.`);
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const place = locateEdit(document.getText(), edit.oldText, edit.nearLine);
        if ('error' in place) {
            throw new Error(place.error);
        }
        const hadUnsavedChanges = document.isDirty;
        const startLine = document.positionAt(place.start).line;
        const editor = await this._cursor.write(uri, new vscode.Range(startLine, 0, document.positionAt(place.end).line, 0));

        // The removal and every typed line form one undo step: only the first edit opens it, only the last closes it.
        const lines = edit.newText.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const removal = new vscode.Range(document.positionAt(place.start), document.positionAt(place.end));
        if (!(await this._cursor.selfEdit(editor.edit((b) => b.delete(removal), { undoStopBefore: true, undoStopAfter: lines.length === 0 })))) {
            throw new Error(`Could not edit ${relative}: its editor was closed.`);
        }
        const pause = Math.min(LINE_MS, MAX_TYPING_MS / Math.max(lines.length, 1));
        let offset = place.start;
        for (let i = 0; i < lines.length; i++) {
            const version = document.version;
            const at = document.positionAt(offset);
            const last = i === lines.length - 1;
            const typed = await this._cursor.selfEdit(editor.edit((b) => b.insert(at, lines[i]), { undoStopBefore: false, undoStopAfter: last }));
            // Someone else changed the file meanwhile (the user typing): offsets no longer hold, so stop here.
            if (!typed || document.version !== version + 1) {
                const done = typed ? i + 1 : i;
                throw new Error(
                    `Stopped after ${done} of ${lines.length} lines of ${relative}: ${typed ? 'the file changed while I was typing' : 'its editor was closed'}. Read it again before going on.`,
                );
            }
            offset += lines[i].length;
            this._cursor.writing(editor, new vscode.Range(startLine, 0, document.positionAt(offset).line, 0));
            if (!last) {
                await sleep(pause);
            }
        }
        const endLine = document.positionAt(Math.max(place.start, offset - 1)).line;
        this._cursor.writing(editor, new vscode.Range(startLine, 0, endLine, 0));
        // Saving would also save the user's own unsaved changes in this file: leave that to them.
        const saved = !hadUnsavedChanges && (await document.save());
        const where = lines.length === 0 ? `removed text at line ${startLine + 1}` : `wrote lines ${startLine + 1}-${endLine + 1}`;
        const state = saved ? 'saved' : 'not saved, because the file already had the user\'s unsaved changes';
        return `Edited ${relative}: ${where} (${state}). One Ctrl+Z in the editor undoes it.`;
    }

    async runInTerminal(command: string, timeoutMs: number): Promise<string> {
        const terminal = this._terminal();
        terminal.show(true);
        const shell = terminal.shellIntegration ?? (await shellIntegration(terminal));
        if (!shell) {
            terminal.sendText(command);
            return `Typed into the ${terminal.name} terminal, but its shell reports no shell integration, so the output and exit code are not visible to you: ask the user what happened.`;
        }
        this._busy.add(terminal);
        const execution = shell.executeCommand(command);
        let output = '';
        const reading = (async () => {
            for await (const data of execution.read()) {
                output = (output + data).slice(-MAX_OUTPUT_CHARS);
            }
        })().catch(() => undefined);
        const { promise: ended, resolve: end } = Promise.withResolvers<number | undefined>();
        const subscription = vscode.window.onDidEndTerminalShellExecution((e) => {
            if (e.execution === execution) {
                subscription.dispose();
                this._busy.delete(terminal);
                end(e.exitCode);
            }
        });
        const timeout = new AbortController();
        const outcome = await Promise.race([
            ended.then((exitCode) => ({ done: true as const, exitCode })),
            sleep(timeoutMs, { done: false as const }, { signal: timeout.signal }).catch(() => ({ done: false as const })),
        ]);
        timeout.abort();
        if (!outcome.done) {
            const soFar = cleanTerminalOutput(output);
            return `Still running after ${Math.round(timeoutMs / 1000)}s; it keeps running in the ${terminal.name} terminal. Output so far:\n${soFar || '(none)'}`;
        }
        // The stream ends right after the command; wait briefly for its last chunk.
        await Promise.race([reading, sleep(500)]);
        const text = cleanTerminalOutput(output);
        const exit = outcome.exitCode === undefined ? 'unknown (the shell did not report it)' : String(outcome.exitCode);
        return `Exit code ${exit}.\n${text || '(no output)'}`;
    }

    /** An idle Pi terminal, or a new one: a command never goes into a program still running. */
    private _terminal(): vscode.Terminal {
        const idle = this._terminals.find((t) => !this._busy.has(t) && t.exitStatus === undefined);
        if (idle) {
            return idle;
        }
        const name = this._terminals.length === 0 ? 'Pi' : `Pi (${this._terminals.length + 1})`;
        const terminal = vscode.window.createTerminal({ name, cwd: this._root, iconPath: new vscode.ThemeIcon('pass-filled') });
        this._terminals.push(terminal);
        return terminal;
    }
}

function shellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
    const { promise, resolve } = Promise.withResolvers<vscode.TerminalShellIntegration | undefined>();
    const timer = setTimeout(() => {
        subscription.dispose();
        resolve(undefined);
    }, SHELL_INTEGRATION_WAIT_MS);
    const subscription = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) {
            clearTimeout(timer);
            subscription.dispose();
            resolve(e.shellIntegration);
        }
    });
    return promise;
}
