import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import * as vscode from 'vscode';
import { ScreenReader, drawsScreen } from '../pi/terminalScreen';
import type { AgentCursor } from './agentCursor';
import type { CodeAnchor } from './codeAnchors';
import type { DebugDriver } from './debugDriver';
import { FileHands } from './fileHands';
import type { DebugAction, EditorHands } from './hostTools';
import { cleanTerminalOutput, insideFolder, locateEdit, pickName } from './pairText';
import { findViewers, languageOf, runPreviewCommand, settleWithin, type FileViewers, type Viewer } from './viewers';
import type { OutputReader } from './vscodeOutput';

/**
 * Typing speed while the user follows Pi: one character per CHAR_MS, like a fast typist; a long edit
 * types several characters per step so the whole edit takes at most MAX_TYPING_MS. Not followed, an
 * edit goes in at once.
 */
const CHAR_MS = 40;
const MAX_TYPING_MS = 8000;
/** A new terminal's shell integration normally arrives within a second or two. */
const SHELL_INTEGRATION_WAIT_MS = 5000;
/** Output kept while a command runs; only its tail goes to the model. */
const MAX_OUTPUT_CHARS = 200_000;
/** terminal_send returns once a program's output has been quiet this long. */
const QUIET_MS = 500;
const POLL_MS = 100;
/** run_in_terminal returns early once a command's output has been quiet this long: it may be waiting for input. */
const STALLED_MS = 5000;
/** A command's stream ends right after it; its last chunk may still be on the way. */
const LAST_CHUNK_MS = 500;
/** How long open_with waits for an editor to open or an extension's preview command to return. */
const OPEN_WITH_TIMEOUT_MS = 8000;
/** How long after a preview command returns its editor or panel may take to show up as a tab. */
const NEW_TAB_WAIT_MS = 1500;
/** A file just written may not be visible to stat yet: tries, this far apart. */
const STAT_ATTEMPTS = 5;
const STAT_RETRY_MS = 200;
/**
 * The emulator a screen-drawing program's output is replayed into. Extensions cannot learn a terminal's
 * size, so it is larger than most: a program drawing for a smaller terminal fits, with blank space left over.
 */
const SCREEN_COLS = 200;
const SCREEN_ROWS = 60;
const SCREEN_SCROLLBACK = 1000;
/** Enough of the previous chunk to catch an escape sequence split between two chunks. */
const SEQUENCE_TAIL = 16;

/**
 * The voice agent's hands in the user's VS Code (docs/voice-pair-agent-cursor.md §11-§13): it opens
 * code and reads VS Code's output, types edits into the editor character by character (at once when not followed) at Pi's
 * writing highlight, manages files, runs commands in a Pi terminal the user can see, and drives the debugger.
 */
export class PairHands implements EditorHands, vscode.Disposable {
    /** Pi terminals, oldest first; a busy one is running a command. */
    private readonly _terminals: vscode.Terminal[] = [];
    private readonly _busy = new Set<vscode.Terminal>();
    /** Commands run_in_terminal left running, oldest first, for terminal_send and terminal_read; one that ended stays until its end is reported. */
    private _leftRunning: TerminalRun[] = [];
    /** The last send queued per running command, so the next one waits for it. */
    private readonly _sending = new WeakMap<TerminalRun, Promise<unknown>>();
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
            this._leftRunning = this._leftRunning.filter((run) => run.terminal !== terminal);
        });
    }

    dispose(): void {
        this._subscription.dispose();
    }

    openFile(target: CodeAnchor): Promise<string> {
        return this._cursor.open(target);
    }

    async listViewers(target: string): Promise<FileViewers> {
        const { uri, relative } = await this._files.resolve(target);
        // A file create_file just made is open, even before stat sees it on disk.
        const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        if (!document) {
            let stat: vscode.FileStat | undefined;
            for (let attempt = 1; !stat && attempt <= STAT_ATTEMPTS; attempt++) {
                stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => undefined);
                if (!stat && attempt < STAT_ATTEMPTS) {
                    await sleep(STAT_RETRY_MS);
                }
            }
            if (!stat) {
                throw new Error(`${relative} does not exist.`);
            }
            if (stat.type & vscode.FileType.Directory) {
                throw new Error(`${relative} is a folder, not a file.`);
            }
        }
        const builtinRoot = path.join(vscode.env.appRoot, 'extensions');
        const extensions = vscode.extensions.all.map((e) => ({
            id: e.id,
            packageJSON: e.packageJSON,
            // `isBuiltin` is on the runtime description but not in the API typings: the install folder backs it up.
            builtin: (e.packageJSON as { isBuiltin?: unknown } | undefined)?.isBuiltin === true || insideFolder(builtinRoot, e.extensionPath),
        }));
        // An open document's language may have been set by the user; otherwise as VS Code would guess it.
        const languageId = document?.languageId ?? languageOf(extensions, uri.fsPath);
        const thirdPartyCommands = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent').get<boolean>('discoverPreviewCommands', false);
        return { path: relative, languageId, ...findViewers(extensions, uri.fsPath, languageId, { thirdPartyCommands }) };
    }

    async openWith(target: string, viewer: Viewer, toSide: boolean): Promise<string> {
        const { uri, relative } = await this._files.resolve(target);
        const column = toSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
        const where = toSide ? ' beside the current editor' : '';
        const waited = `${Math.round(OPEN_WITH_TIMEOUT_MS / 1000)}s`;
        if (viewer.kind === 'editor') {
            const run = await settleWithin(vscode.commands.executeCommand('vscode.openWith', uri, viewer.id, column), OPEN_WITH_TIMEOUT_MS);
            if (run.status === 'timeout') {
                return `Started opening ${relative} in ${viewer.label}${where}, but it had not finished after ${waited}; it may still appear. Ask the user whether they see it.`;
            }
            if (run.status === 'failed') {
                throw new Error(`VS Code could not open ${relative} in ${viewer.label}: ${run.error instanceof Error ? run.error.message : String(run.error)}`);
            }
            return `Opened ${relative} in ${viewer.label}${where}.`;
        }
        // Many preview commands ignore their argument and preview the active editor: make it this file.
        const shown = await settleWithin(vscode.window.showTextDocument(uri, { viewColumn: column, preview: false }), OPEN_WITH_TIMEOUT_MS);
        if (shown.status === 'timeout') {
            return `Started opening ${relative}${where}, but it had not opened after ${waited}, so ${viewer.label} was not run. Ask the user what they see.`;
        }
        // A file that is not text cannot be the active text editor; the command still gets its uri.
        const tabKeys = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map(tabKey));
        const activeTabKey = () => {
            const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
            return tab && tabKey(tab);
        };
        const before = new Set(tabKeys());
        const activeBefore = activeTabKey();
        const showedSomething = async () => {
            for (let waitedMs = 0; ; waitedMs += 100) {
                if (activeTabKey() !== activeBefore || tabKeys().some((key) => !before.has(key))) {
                    return true;
                }
                if (waitedMs >= NEW_TAB_WAIT_MS) {
                    return false;
                }
                await sleep(100);
            }
        };
        const run = await runPreviewCommand((...args) => vscode.commands.executeCommand(viewer.id, ...args), uri, showedSomething, OPEN_WITH_TIMEOUT_MS);
        switch (run.status) {
            case 'shown':
                return `Opened ${relative}${where} and ran ${viewer.label}${run.withUri ? '' : ' on it as the active editor'}.`;
            case 'unchanged':
                return `Opened ${relative}${where} and ran ${viewer.label}, but no new editor or panel appeared: the preview may already be open, or the command did nothing for this file. Ask the user what they see.`;
            case 'timeout':
                return `Opened ${relative}${where} and started ${viewer.label}, but it had not finished after ${waited}, so I stopped waiting; it may still appear. Ask the user whether they see it.`;
            case 'failed':
                throw new Error(`${viewer.label} failed on ${relative}: ${run.error}`);
        }
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
        const chunks = typingChunks(edit.newText, this._cursor.following);
        const removal = new vscode.Range(document.positionAt(place.start), document.positionAt(place.end));
        if (!(await this._cursor.selfEdit(editor.edit((b) => b.delete(removal), { undoStopBefore: true, undoStopAfter: chunks.length === 0 })))) {
            throw new Error(`Could not edit ${relative}: its editor was closed.`);
        }
        const pause = CHAR_MS;
        let offset = place.start;
        for (let i = 0; i < chunks.length; i++) {
            const version = document.version;
            const at = document.positionAt(offset);
            const last = i === chunks.length - 1;
            const typed = await this._cursor.selfEdit(editor.edit((b) => b.insert(at, chunks[i]), { undoStopBefore: false, undoStopAfter: last }));
            // Someone else changed the file meanwhile (the user typing): offsets no longer hold, so stop here.
            if (!typed || document.version !== version + 1) {
                const written = offset - place.start + (typed ? chunks[i].length : 0);
                throw new Error(
                    `Stopped after ${written} of ${edit.newText.length} characters of ${relative}: ${typed ? 'the file changed while I was typing' : 'its editor was closed'}. Read it again before going on.`,
                );
            }
            offset += chunks[i].length;
            this._cursor.writing(editor, new vscode.Range(startLine, 0, document.positionAt(offset).line, 0));
            if (!last) {
                await sleep(pause);
            }
        }
        const endLine = document.positionAt(Math.max(place.start, offset - 1)).line;
        this._cursor.writing(editor, new vscode.Range(startLine, 0, endLine, 0));
        // Saving would also save the user's own unsaved changes in this file: leave that to them.
        const saved = !hadUnsavedChanges && (await document.save());
        const where = chunks.length === 0 ? `removed text at line ${startLine + 1}` : `wrote lines ${startLine + 1}-${endLine + 1}`;
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
        // An earlier command there has ended: what it left unreported goes with it.
        this._leftRunning = this._leftRunning.filter((r) => r.terminal !== terminal);
        this._busy.add(terminal);
        const run = new TerminalRun(terminal, shell.executeCommand(command));
        const subscription = vscode.window.onDidEndTerminalShellExecution((e) => {
            if (e.execution === run.execution) {
                subscription.dispose();
                this._busy.delete(terminal);
                run.finish(e.exitCode);
            }
        });
        // A program asking a question (a prompt, a selection menu) goes quiet: return then, not at the timeout.
        const deadline = Date.now() + timeoutMs;
        while (!run.done && Date.now() < deadline && Date.now() - run.lastDataAt < STALLED_MS) {
            await sleep(POLL_MS);
        }
        if (!run.done) {
            this._leftRunning.push(run);
            const soFar = run.drawsScreen ? await run.screen().read() : cleanTerminalOutput(run.output);
            run.shown = run.received;
            const why =
                Date.now() < deadline
                    ? `Its output has been quiet for ${STALLED_MS / 1000}s, so it may be waiting for input, or just working silently`
                    : `Still running after ${Math.round(timeoutMs / 1000)}s`;
            return (
                `${why}, in the "${terminal.name}" terminal. It keeps running; if it waits for input, ` +
                `type a line into it with terminal_send, and see what it printed since with terminal_read (terminal "${terminal.name}"). ${run.drawsScreen ? 'Its screen' : 'Output so far'}:\n${soFar || '(none)'}`
            );
        }
        await Promise.race([run.reading, sleep(LAST_CHUNK_MS)]);
        const exit = run.exitCode === undefined ? 'unknown (the shell did not report it)' : String(run.exitCode);
        return `Exit code ${exit}.\n${cleanTerminalOutput(run.output) || '(no output)'}`;
    }

    /**
     * Sends to one terminal go one after another: a line typed while the previous one's output is still
     * coming in would have its output reported as the previous one's.
     */
    sendToTerminal(input: { terminal?: string; text: string; enter: boolean; waitMs: number }): Promise<string> {
        const run = this._leftRun(input.terminal);
        const previous = this._sending.get(run) ?? Promise.resolve();
        const next = previous.then(() => this._sendNow(run, input));
        this._sending.set(run, next.catch(() => undefined));
        return next;
    }

    private async _sendNow(run: TerminalRun, input: { text: string; enter: boolean; waitMs: number }): Promise<string> {
        if (run.done) {
            // Typing now would go to the shell as a new command, not to the program.
            return `Nothing was typed: ${await this._report(run)}`;
        }
        run.terminal.show(true);
        const before = run.received;
        run.terminal.sendText(input.text, input.enter);
        const deadline = Date.now() + input.waitMs;
        while (!run.done && Date.now() < deadline && !(run.received > before && Date.now() - run.lastDataAt >= QUIET_MS)) {
            await sleep(POLL_MS);
        }
        // The text itself is not repeated: it may be a secret.
        return `Typed ${input.enter ? 'a line' : 'text'} into "${run.terminal.name}". ${await this._report(run)}`;
    }

    async readTerminal(terminal: string | undefined, pagesBack: number): Promise<string> {
        const run = this._leftRun(terminal);
        if (!run.done && run.received === run.shown && !run.drawsScreen) {
            const last = cleanTerminalOutput(run.output, 20, 2000);
            return `"${run.terminal.name}" is still running, with no new output since you last looked. Its last lines:\n${last || '(none)'}`;
        }
        return this._report(run, pagesBack);
    }

    /** The left-running command in the Pi terminal named `name`, else the latest still running (else the latest). */
    private _leftRun(name: string | undefined): TerminalRun {
        const runs = this._leftRunning;
        if (runs.length === 0) {
            throw new Error('No command is left running in a Pi terminal: start one with run_in_terminal.');
        }
        if (name === undefined) {
            return runs.findLast((r) => !r.done) ?? runs[runs.length - 1];
        }
        const picked = pickName(
            runs.map((r) => r.terminal.name),
            name,
            'Pi terminal with a command left running',
        );
        if ('error' in picked) {
            throw new Error(picked.error);
        }
        return runs.find((r) => r.terminal.name === picked.name)!;
    }

    /**
     * The output not yet shown (once an ended command's last chunk is in), and whether it still runs;
     * an ended command is reported once, then forgotten. A program still drawing a screen is shown as
     * that screen, `pagesBack` screens up when asked: its raw stream is cursor moves, not lines.
     */
    private async _report(run: TerminalRun, pagesBack = 0): Promise<string> {
        if (run.done) {
            await Promise.race([run.reading, sleep(LAST_CHUNK_MS)]);
        }
        const name = `"${run.terminal.name}"`;
        if (!run.done && run.drawsScreen) {
            run.shown = run.received;
            return `${name} is still running. Its screen:\n${await run.screen().read(pagesBack)}`;
        }
        // Only what the buffer still holds of it.
        const unseen = run.received - run.shown;
        const fresh = cleanTerminalOutput(unseen >= run.output.length ? run.output : run.output.slice(run.output.length - unseen));
        run.shown = run.received;
        if (run.done) {
            this._leftRunning = this._leftRunning.filter((r) => r !== run);
            run.dispose();
            const exit = run.exitCode === undefined ? 'unknown (the shell did not report it)' : String(run.exitCode);
            return `The command in ${name} has ended, exit code ${exit}.${fresh ? ` Its last output:\n${fresh}` : ''}`;
        }
        return `${name} is still running. ${fresh ? `New output:\n${fresh}` : 'No new output yet: it may still be working; look again with terminal_read.'}`;
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

/** One command run in a Pi terminal: its output as it arrives, and how far the model has seen it. */
class TerminalRun {
    /** The last MAX_OUTPUT_CHARS of output. */
    output = '';
    /** Characters received in all, and how many of them the model has been shown. */
    received = 0;
    shown = 0;
    lastDataAt = Date.now();
    done = false;
    exitCode: number | undefined;
    /** The output moved the cursor or switched to the alternate screen: it is read as a screen, not as lines. */
    drawsScreen = false;
    readonly reading: Promise<void>;
    readonly ended: Promise<void>;
    private readonly _end: () => void;
    /** Made on the first screen read, from the output kept so far; fed every chunk after. */
    private _screen: { term: HeadlessTerminal; reader: ScreenReader } | undefined;

    constructor(
        readonly terminal: vscode.Terminal,
        readonly execution: vscode.TerminalShellExecution,
    ) {
        const { promise, resolve } = Promise.withResolvers<void>();
        this.ended = promise;
        this._end = resolve;
        this.reading = (async () => {
            let tail = '';
            for await (const data of execution.read()) {
                this.output = (this.output + data).slice(-MAX_OUTPUT_CHARS);
                this.received += data.length;
                this.lastDataAt = Date.now();
                this.drawsScreen ||= drawsScreen(tail + data);
                tail = data.slice(-SEQUENCE_TAIL);
                this._screen?.term.write(data);
            }
        })().catch(() => undefined);
    }

    /** The program's screen, replayed from its output; keys go to the terminal. */
    screen(): ScreenReader {
        if (!this._screen) {
            const term = new HeadlessTerminal({ cols: SCREEN_COLS, rows: SCREEN_ROWS, scrollback: SCREEN_SCROLLBACK, allowProposedApi: true });
            term.write(this.output);
            this._screen = { term, reader: new ScreenReader(term, (keys) => this.terminal.sendText(keys, false)) };
        }
        return this._screen.reader;
    }

    dispose(): void {
        this._screen?.reader.dispose();
        this._screen?.term.dispose();
        this._screen = undefined;
    }

    finish(exitCode: number | undefined): void {
        this.done = true;
        this.exitCode = exitCode;
        this._end();
    }
}

/** A tab by its group, title, and what it shows: a file, or a webview or custom editor's view type. */
function tabKey(tab: vscode.Tab): string {
    const input = tab.input as { uri?: vscode.Uri; viewType?: string } | undefined;
    return [tab.group.viewColumn, tab.label, input?.viewType ?? '', input?.uri?.toString() ?? ''].join('\u0000');
}

/**
 * The pieces an edit is typed in: followed, a character at a time (several when that would take over
 * MAX_TYPING_MS); not followed, all at once. Splits by code point, so no surrogate pair is cut.
 */
export function typingChunks(text: string, following: boolean): string[] {
    if (text.length === 0) {
        return [];
    }
    if (!following) {
        return [text];
    }
    const chars = Array.from(text);
    const size = Math.ceil(chars.length / Math.max(1, Math.floor(MAX_TYPING_MS / CHAR_MS)));
    const chunks: string[] = [];
    for (let i = 0; i < chars.length; i += size) {
        chunks.push(chars.slice(i, i + size).join(''));
    }
    return chunks;
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
