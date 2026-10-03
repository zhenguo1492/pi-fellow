import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import * as vscode from 'vscode';
import { ScreenReader, drawsScreen } from '../pi/terminalScreen';
import type { AgentCursor } from './agentCursor';
import type { CodeAnchor } from './codeAnchors';
import type { DebugDriver } from './debugDriver';
import { FileHands } from './fileHands';
import type { DebugAction, EditPreview, EditorHands } from './hostTools';
import { cleanTerminalOutput, insideFolder, locateEdit, pickName, shiftOffset } from './pairText';
import { findViewers, languageOf, runPreviewCommand, settleWithin, type FileViewers, type Viewer } from './viewers';
import type { OutputReader } from './vscodeOutput';

/**
 * Typing speed while the user follows Pi: one character per CHAR_MS, like a fast typist; a long edit
 * types several characters per step so the whole edit takes at most MAX_TYPING_MS. Not followed, an
 * edit goes in at once. Either way edit_file returns before the typing, which goes on in the background.
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

/** One accepted edit_file; `hurry`: the rest goes in at once (the reply cut off, voice stopped, not followed any more, the user typing). */
interface TypingJob {
    hurry: boolean;
}

/**
 * The replacement text of an edit being typed: all of it, or for a preview (EditorHands.previewEdit)
 * as much as the model has written so far, until its call arrives (`done`) or will not run (`dropped`).
 */
class TypingSource {
    private _wake: (() => void) | undefined;

    constructor(
        public text = '',
        public done = false,
        public dropped = false,
    ) {}

    set(text: string, done: boolean): void {
        this.text = text;
        this.done = done;
        this._wake?.();
    }

    drop(): void {
        this.dropped = true;
        this._wake?.();
    }

    /** Resolves at the next `set` or `drop`. */
    next(): Promise<void> {
        const { promise, resolve } = Promise.withResolvers<void>();
        this._wake = () => {
            this._wake = undefined;
            resolve();
        };
        return promise;
    }
}

/** The edits accepted on one file and not yet typed and saved: each waits for the one before it. */
interface FileTyping {
    /** The file's text once they are all in, as known when the last was accepted: where the next edit is placed. Undefined while the last is a preview still being written. */
    expected: string | undefined;
    /** Resolves once `expected` is known: at once for an edit, when its call arrives or is dropped for a preview. */
    known: Promise<void>;
    /** Settles, never rejecting, once the last is typed and saved. */
    done: Promise<void>;
    /** Shared by the edits in a row: they save the file, unless it had the user's unsaved changes before them or the user typed in it meanwhile. */
    chain: { save: boolean };
}

/** A preview's edit, once placed and queued: what edit_file's result and the expected text are made of. */
interface PlacedPreview {
    relative: string;
    /** The file as the edits before it leave it, and where the edit goes in it. */
    text: string;
    place: { start: number; end: number };
    crlf: boolean;
    chain: { save: boolean };
    queued: boolean;
    know(expected: string): void;
}

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
    private readonly _subscriptions: vscode.Disposable[];
    /** Every path the pair tools touch goes through its workspace check. */
    private readonly _files: FileHands;
    /** Edits edit_file accepted and not yet typed and saved, by file path. */
    private readonly _typing = new Map<string, FileTyping>();
    /** Accepted edits not yet in, for finishTyping. */
    private readonly _jobs = new Set<TypingJob>();
    /** What went wrong with an edit after edit_file returned, for the model's next tool result or turn. */
    private _late: string[] = [];

    constructor(
        /** Relative paths and Pi terminals start here. */
        private readonly _root: string,
        private readonly _cursor: AgentCursor,
        private readonly _debug: DebugDriver,
        private readonly _output: OutputReader,
    ) {
        this._files = new FileHands(_root, _cursor);
        this._subscriptions = [
            vscode.window.onDidCloseTerminal((terminal) => {
                const i = this._terminals.indexOf(terminal);
                if (i >= 0) {
                    this._terminals.splice(i, 1);
                }
                this._busy.delete(terminal);
                this._leftRunning = this._leftRunning.filter((run) => run.terminal !== terminal);
            }),
            // Not followed, an edit goes in at once: so does the rest of one being typed.
            _cursor.onDidChangeFollowing((following) => {
                if (!following) {
                    this.finishTyping();
                }
            }),
        ];
    }

    dispose(): void {
        this.finishTyping();
        for (const subscription of this._subscriptions) {
            subscription.dispose();
        }
    }

    finishTyping(): void {
        for (const job of this._jobs) {
            job.hurry = true;
        }
    }

    takeLateResults(): string[] {
        const late = this._late;
        this._late = [];
        return late;
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

    async startDebugging(configuration: string | undefined, noDebug: boolean, timeoutMs: number): Promise<string> {
        // The program runs what is saved: the edits being typed first.
        await this._typed(undefined);
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

    async renamePath(from: string, to: string): Promise<string> {
        await this._typed([from, to]);
        return this._files.rename(from, to);
    }

    describeDeletion(target: string, recursive: boolean): Promise<string> {
        return this._files.describeDeletion(target, recursive);
    }

    async deletePath(target: string, recursive: boolean): Promise<string> {
        await this._typed([target]);
        return this._files.delete(target, recursive);
    }

    async saveFiles(target: string | undefined): Promise<string> {
        await this._typed(target === undefined ? undefined : [target]);
        return this._files.save(target);
    }

    async closeEditor(target: string): Promise<string> {
        await this._typed([target]);
        return this._files.close(target);
    }

    /**
     * Places the edit and returns at once, so the model can go on talking; it is typed into the editor
     * and saved in the background, after the edits already accepted on the file. What goes wrong after
     * this returns comes back through takeLateResults.
     */
    async editFile(edit: { path: string; oldText: string; newText: string; nearLine?: number }): Promise<string> {
        const { uri, relative } = await this._files.resolve(edit.path);
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            throw new Error(`${relative} does not exist: create it with create_file.`);
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const key = uri.fsPath;
        let before = this._typing.get(key);
        // Behind a preview still being written, it waits for that call to say what it leaves.
        while (before && before.expected === undefined) {
            await before.known;
            before = this._typing.get(key);
        }
        // Behind edits still being typed, it is placed in the text they leave.
        const text = before?.expected ?? document.getText();
        const place = locateEdit(text, edit.oldText, edit.nearLine);
        if ('error' in place) {
            throw new Error(place.error);
        }
        // As the editor will store it.
        const newText = document.eol === vscode.EndOfLine.CRLF ? edit.newText.replace(/\r?\n/g, '\r\n') : edit.newText;
        const chain = before?.chain ?? { save: !document.isDirty };
        this._queue(uri, relative, before, edit, new TypingSource(edit.newText, true), chain)(text.slice(0, place.start) + newText + text.slice(place.end));
        return this._acceptedText(relative, text, place, newText, chain, before !== undefined);
    }

    /**
     * Types an edit_file call's replacement while the model still writes it, when Pi is followed and
     * its place is found; otherwise it does nothing and the call runs as any other when it arrives.
     */
    previewEdit(edit: { path: string; oldText: string; nearLine?: number }): EditPreview {
        const source = new TypingSource();
        /** The call arrived or was dropped: a start still on its way does not queue anything. */
        let settled = false;
        const started: Promise<PlacedPreview | undefined> = this._cursor.following
            ? this._startPreview(edit, source, () => settled).catch(() => undefined)
            : Promise.resolve(undefined);
        return {
            update: (newText) => {
                if (!settled) {
                    source.set(newText, false);
                }
            },
            commit: async (final) => {
                settled = true;
                const placed = await started;
                if (!placed) {
                    return undefined;
                }
                const same =
                    final.path === edit.path &&
                    final.oldText === edit.oldText &&
                    (final.nearLine === undefined || edit.nearLine === undefined || final.nearLine === edit.nearLine) &&
                    final.newText.startsWith(source.text);
                if (!same) {
                    // The final arguments win: what was typed of other ones is undone first, in the file's queue.
                    source.drop();
                    placed.know(placed.text);
                    return undefined;
                }
                source.set(final.newText, true);
                const newText = placed.crlf ? final.newText.replace(/\r?\n/g, '\r\n') : final.newText;
                placed.know(placed.text.slice(0, placed.place.start) + newText + placed.text.slice(placed.place.end));
                return this._acceptedText(placed.relative, placed.text, placed.place, newText, placed.chain, placed.queued);
            },
            drop: () => {
                settled = true;
                source.drop();
                void started.then((placed) => placed?.know(placed.text));
            },
        };
    }

    /** Places a preview's edit and queues its typing; undefined when it cannot be placed now (the call then runs as usual). */
    private async _startPreview(edit: { path: string; oldText: string; nearLine?: number }, source: TypingSource, settled: () => boolean): Promise<PlacedPreview | undefined> {
        const { uri, relative } = await this._files.resolve(edit.path);
        await vscode.workspace.fs.stat(uri);
        const document = await vscode.workspace.openTextDocument(uri);
        const before = this._typing.get(uri.fsPath);
        // Another preview of this file is still being written: its text is not known yet.
        if (settled() || (before && before.expected === undefined)) {
            return undefined;
        }
        const text = before?.expected ?? document.getText();
        const place = locateEdit(text, edit.oldText, edit.nearLine);
        if ('error' in place) {
            return undefined;
        }
        const chain = before?.chain ?? { save: !document.isDirty };
        const know = this._queue(uri, relative, before, edit, source, chain);
        return { relative, text, place, crlf: document.eol === vscode.EndOfLine.CRLF, chain, queued: before !== undefined, know };
    }

    /**
     * Queues typing `source` into the file behind the edits accepted on it before; returns how to
     * say the text the file has once it is in, which the next edit is placed in.
     */
    private _queue(
        uri: vscode.Uri,
        relative: string,
        before: FileTyping | undefined,
        edit: { oldText: string; nearLine?: number },
        source: TypingSource,
        chain: { save: boolean },
    ): (expected: string) => void {
        const key = uri.fsPath;
        const job: TypingJob = { hurry: false };
        this._jobs.add(job);
        const known = Promise.withResolvers<void>();
        const typing: FileTyping = {
            expected: undefined,
            known: known.promise,
            chain,
            done: (before?.done ?? Promise.resolve())
                .then(() => this._type(uri, edit, source, chain, job))
                .catch((err: unknown) => {
                    this._late.push(`edit_file on ${relative}: ${err instanceof Error ? err.message : String(err)}`);
                })
                .finally(() => {
                    this._jobs.delete(job);
                    if (this._typing.get(key) === typing) {
                        this._typing.delete(key);
                    }
                }),
        };
        this._typing.set(key, typing);
        return (expected) => {
            typing.expected = expected;
            known.resolve();
        };
    }

    /** edit_file's result for `newText` placed at `place` in `text`, the file as the edits before it leave it. */
    private _acceptedText(relative: string, text: string, place: { start: number; end: number }, newText: string, chain: { save: boolean }, queued: boolean): string {
        const startLine = text.slice(0, place.start).split('\n').length;
        const endLine = (text.slice(0, place.start) + newText).slice(0, Math.max(place.start, place.start + newText.length - 1)).split('\n').length;
        const where = newText === '' ? `removes the text at line ${startLine}` : `becomes lines ${startLine}-${endLine}`;
        const how = queued
            ? "is typed into the user's editor after your earlier edits to this file"
            : this._cursor.following
              ? "is being typed into the user's editor now"
              : 'goes into the editor at once';
        const save = chain.save ? 'and saved when done' : "and left unsaved, because the file already had the user's unsaved changes";
        return (
            `Edit of ${relative} accepted: it ${where} and ${how}, ${save}. One Ctrl+Z in the editor undoes it. ` +
            'Go on without waiting for it; a problem with it comes later as <late-result>.'
        );
    }

    /**
     * Types an accepted edit into the user's editor and saves the file; throws what the model should
     * hear later. A preview's text streams in through `source`; dropped, what was typed is undone.
     */
    private async _type(uri: vscode.Uri, edit: { oldText: string; nearLine?: number }, source: TypingSource, chain: { save: boolean }, job: TypingJob): Promise<void> {
        if (source.dropped) {
            return;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const place = locateEdit(document.getText(), edit.oldText, edit.nearLine);
        if ('error' in place) {
            if (source.dropped) {
                return;
            }
            throw new Error(`Not applied, because the file changed before it could be typed: ${place.error} Read the file again before going on.`);
        }
        const original = document.getText().slice(place.start, place.end);
        // Offsets in the document as it changes: the replaced text until removed, the typed text, and where the next piece goes.
        let start = place.start;
        let end = place.end;
        let at = place.start;
        let typed = 0;
        let userChanged = false;
        /** Pi's own change in flight, as its change event shows it (the editor may store line breaks as CRLF). */
        let own: { offset: number; length: number; text: string } | undefined;
        const subscription = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.toString() !== uri.toString()) {
                return;
            }
            for (const change of e.contentChanges) {
                if (own && change.rangeOffset === own.offset && change.rangeLength === own.length && change.text.replace(/\r\n/g, '\n') === own.text.replace(/\r\n/g, '\n')) {
                    at = change.rangeOffset + change.text.length;
                    own = undefined;
                    continue;
                }
                // The user typing: the rest goes in at once, where it belongs now.
                userChanged = true;
                job.hurry = true;
                start = shiftOffset(start, change);
                end = shiftOffset(end, change);
                at = shiftOffset(at, change);
            }
        });
        /** Puts `text` over [from, to) with a workspace edit, which needs no open editor and no unchanged document. */
        const atOnce = async (from: number, to: number, text: string): Promise<boolean> => {
            const replace = new vscode.WorkspaceEdit();
            replace.replace(uri, new vscode.Range(document.positionAt(from), document.positionAt(to)), text);
            own = { offset: from, length: to - from, text };
            const done = await this._cursor.selfEdit(vscode.workspace.applyEdit(replace));
            own = undefined;
            return done;
        };
        let dropped = false;
        try {
            const editor = await this._cursor.write(uri, new vscode.Range(document.positionAt(start).line, 0, document.positionAt(end).line, 0));
            // A whole replacement is cut into its pieces at once; one still streaming is typed as it comes.
            let pieces = source.done ? typingChunks(source.text, this._cursor.following && !job.hurry) : undefined;
            let next = 0;
            // The removal and every typed piece form one undo step: only the first edit opens it, only the last closes it.
            const removal = new vscode.Range(document.positionAt(start), document.positionAt(end));
            own = { offset: start, length: end - start, text: '' };
            const removed = await this._cursor.selfEdit(editor.edit((b) => b.delete(removal), { undoStopBefore: true, undoStopAfter: source.done && source.text === '' }));
            own = undefined;
            if (!removed) {
                // Its editor was closed, or the user changed the file just then: the whole edit at once, placed again.
                while (!source.done && !source.dropped) {
                    await source.next();
                }
                if (source.dropped) {
                    return;
                }
                const again = locateEdit(document.getText(), edit.oldText, edit.nearLine);
                if ('error' in again) {
                    throw new Error(`Not applied, because the file changed before it could be typed: ${again.error} Read the file again before going on.`);
                }
                start = again.start;
                if (!(await atOnce(again.start, again.end, source.text))) {
                    throw new Error('Not applied: VS Code would not change the file. Read it again before going on.');
                }
                typed = source.text.length;
            }
            for (;;) {
                if (source.dropped) {
                    // The call will not run: what was typed of it goes, the replaced text comes back.
                    dropped = true;
                    const span = new vscode.Range(document.positionAt(start), document.positionAt(at));
                    own = { offset: start, length: at - start, text: original };
                    const undone = (await this._cursor.selfEdit(editor.edit((b) => b.replace(span, original), { undoStopBefore: false, undoStopAfter: true }))) || (await atOnce(start, at, original));
                    own = undefined;
                    if (!undone) {
                        throw new Error('That call did not run, but VS Code would not take back what was typed of it. Read the file again before going on.');
                    }
                    break;
                }
                const rest = source.text.slice(typed);
                if (!rest) {
                    if (source.done) {
                        break;
                    }
                    await source.next();
                    continue;
                }
                if (source.done && !pieces) {
                    pieces = typingChunks(rest, this._cursor.following && !job.hurry);
                    next = 0;
                }
                let piece: string;
                if (job.hurry) {
                    piece = rest;
                } else if (pieces) {
                    piece = pieces[next++];
                } else {
                    // Streaming: an eighth of what waits per step, so typing keeps up with the model.
                    const chars = Array.from(rest);
                    piece = chars.slice(0, Math.ceil(chars.length / 8)).join('');
                }
                const last = source.done && typed + piece.length === source.text.length;
                const position = document.positionAt(at);
                own = { offset: at, length: 0, text: piece };
                let inserted = await this._cursor.selfEdit(editor.edit((b) => b.insert(position, piece), { undoStopBefore: false, undoStopAfter: last }));
                own = undefined;
                if (!inserted) {
                    // Its editor was closed, or the user changed the file just then: the rest at once.
                    job.hurry = true;
                    inserted = await atOnce(at, at, piece);
                }
                if (!inserted) {
                    throw new Error(`Stopped after ${typed} of ${source.text.length} characters: VS Code would not take the rest. Read the file again before going on.`);
                }
                typed += piece.length;
                this._cursor.writing(editor, new vscode.Range(document.positionAt(start).line, 0, document.positionAt(at).line, 0));
                if (!last && !job.hurry) {
                    await sleep(CHAR_MS);
                }
            }
            if (!dropped) {
                this._cursor.writing(editor, new vscode.Range(document.positionAt(start).line, 0, document.positionAt(Math.max(start, at - 1)).line, 0));
            }
        } finally {
            subscription.dispose();
        }
        if (userChanged && chain.save) {
            // Saving would also save the user's own changes in this file: leave that to them, for this edit and the ones after it.
            chain.save = false;
            if (!dropped) {
                throw new Error('Typed in, but not saved: the user changed the file while it was being typed, so saving it is left to them.');
            }
        }
        // Dropped, the file is back as it was on disk: saving clears its unsaved mark.
        if (chain.save && !(await document.save())) {
            throw new Error(dropped ? 'That call did not run; what was typed of it is undone, but VS Code could not save the file.' : 'Typed in, but VS Code could not save the file; it is left unsaved.');
        }
    }

    /**
     * Settles once the edits accepted on `targets` are typed and saved: files, or folders with every file
     * in them; undefined: every file. A path that does not resolve waits for nothing (the call then fails on it).
     */
    private async _typed(targets: readonly string[] | undefined): Promise<void> {
        if (this._typing.size === 0) {
            return;
        }
        const paths = targets && (await Promise.all(targets.map((target) => this._files.resolve(target).then((r) => r.uri.fsPath, () => undefined))));
        const pending = [...this._typing].filter(([file]) => !paths || paths.some((p) => p !== undefined && insideFolder(p, file)));
        await Promise.all(pending.map(([, typing]) => typing.done));
    }

    async runInTerminal(command: string, timeoutMs: number): Promise<string> {
        // The command sees what is saved: the edits being typed first.
        await this._typed(undefined);
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
