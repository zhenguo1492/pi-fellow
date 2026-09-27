import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatAnchor, type CodeAnchor } from './codeAnchors';
import { findName, type FocusKind, type FocusTarget } from './piFocus';

/** Where Pi is now, for scripts. Lines are 1-based; a whole-file focus has none. */
export interface AgentFocus {
    kind: FocusKind;
    path: string;
    startLine?: number;
    endLine?: number;
    /** The one name Pi points at on those lines (a variable, parameter, field). */
    name?: string;
    following: boolean;
}

interface Focus {
    kind: FocusKind;
    uri: vscode.Uri;
    /** Undefined: the whole file (a write that has just started). */
    range?: vscode.Range;
    /** A single name: it and its other uses in the file are marked instead of whole lines. */
    name?: { text: string; at: vscode.Range; uses: vscode.Range[] };
}

/** Declared symbols `#name` marks as a name rather than lines, when the declaration fits on one line. */
const NAME_KINDS: Partial<Record<vscode.SymbolKind, true>> = {
    [vscode.SymbolKind.Variable]: true,
    [vscode.SymbolKind.Constant]: true,
    [vscode.SymbolKind.Field]: true,
    [vscode.SymbolKind.Property]: true,
    [vscode.SymbolKind.EnumMember]: true,
};

/** A sentence about code keeps the focus this long: tool activity meanwhile waits, so the talk is not yanked away. */
const POINT_HOLD_MS = 6000;
/** Tool activity keeps the focus at least this long, so a burst of reads does not flick through files. */
const ACTIVITY_DWELL_MS = 1500;

const STYLE: Record<FocusKind, { color: string; background: string; label: string; verb: string }> = {
    pointing: { color: 'rgba(139, 92, 246, 0.95)', background: 'rgba(139, 92, 246, 0.16)', label: 'Pi', verb: 'is pointing at' },
    reading: { color: 'rgba(56, 139, 253, 0.9)', background: 'rgba(56, 139, 253, 0.10)', label: 'Pi · reading', verb: 'is reading' },
    writing: { color: 'rgba(46, 160, 67, 0.95)', background: 'rgba(46, 160, 67, 0.16)', label: 'Pi · writing', verb: 'is writing' },
};

/**
 * Pi's focus in the editor (docs/voice-pair-agent-cursor.md): the code the voice agent talks about,
 * and what it or the worker reads or writes. Highlighted wherever the file is visible, labelled Pi,
 * and shown in the status bar. While the user follows Pi (the follow button next to Voice agent above
 * the chat input), the editor opens and scrolls to it; the user's cursor, selection and keyboard focus
 * never move. Typing in the editor stops following.
 */
export class AgentCursor implements vscode.Disposable {
    private readonly _styles: Record<FocusKind, Decorations>;
    private readonly _status = vscode.window.createStatusBarItem('oh-my-pi-chater.piFocus', vscode.StatusBarAlignment.Right, 99.98);
    private _focus: Focus | undefined;
    private _following: boolean;
    private readonly _followingChanged = new vscode.EventEmitter<boolean>();
    /** Following was turned on or off: by the follow button, or by the user typing. */
    readonly onDidChangeFollowing = this._followingChanged.event;
    /** Pi's own edits in flight (pair mode): their document changes are not the user typing. */
    private _selfEdits = 0;
    /** Until then tool activity is deferred (`_deferred`), so the current focus stays put. */
    private _holdUntil = 0;
    private _deferred: (() => Promise<Focus | undefined>) | undefined;
    private _deferTimer: NodeJS.Timeout | undefined;
    /** Focus changes run in order: a later one must not be overtaken by an earlier one still opening its file. */
    private _chain: Promise<void> = Promise.resolve();
    private readonly _subscriptions: vscode.Disposable[];

    constructor(
        /** Relative paths are relative to it. */
        private readonly _root: string,
        /** The user's editor: files Pi opens go to its column. */
        private readonly _userEditor: () => vscode.TextEditor | undefined,
        private readonly _log: (line: string) => void,
        following: boolean,
    ) {
        this._following = following;
        this._styles = {
            pointing: decorations(STYLE.pointing),
            reading: decorations(STYLE.reading),
            writing: decorations(STYLE.writing),
        };
        this._status.name = 'Pi focus';
        this._subscriptions = [
            this._status,
            this._followingChanged,
            ...Object.values(this._styles).flatMap((s) => Object.values(s)),
            // Decorations belong to a TextEditor; switching tabs makes a new one without them.
            vscode.window.onDidChangeVisibleTextEditors(() => this._paint()),
            vscode.workspace.onDidChangeTextDocument((e) => {
                const { document } = e;
                if (!this._following || this._selfEdits > 0 || e.contentChanges.length === 0 || document !== vscode.window.activeTextEditor?.document) {
                    return;
                }
                // A disk write by the worker reloads the document clean; the user's typing leaves it dirty.
                // The first keystroke's event comes before the document is marked dirty, so look a moment later.
                setTimeout(() => {
                    if (this._following && document.isDirty) {
                        this.setFollowing(false);
                        vscode.window.setStatusBarMessage('Stopped following Pi while you type', 4000);
                    }
                }, 50);
            }),
        ];
        this._showState();
    }

    get following(): boolean {
        return this._following;
    }

    /** Following again goes straight to where Pi is. */
    setFollowing(following: boolean): void {
        if (following === this._following) {
            return;
        }
        this._following = following;
        this._showState();
        this._followingChanged.fire(following);
        const focus = this._focus;
        if (following && focus) {
            this._enqueue(async () => void (await this._reveal(focus)));
        }
    }

    /** The voice agent talks about this code: the first anchor that resolves wins. */
    point(anchors: readonly CodeAnchor[]): void {
        this._enqueue(async () => {
            for (const anchor of anchors) {
                try {
                    const focus = await this._resolveAnchor(anchor);
                    if (focus) {
                        await this._apply(focus);
                        return;
                    }
                } catch (err) {
                    this._log(`Could not point at ${formatAnchor(anchor)}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        });
    }

    /** The user asked to see this code: it opens even when they are not following Pi. */
    open(target: CodeAnchor): Promise<string> {
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        this._enqueue(async () => {
            try {
                const focus = await this._resolveAnchor(target);
                if (!focus) {
                    reject(new Error(`Not found: ${formatAnchor(target)}. Check the path or name with glob or grep.`));
                    return;
                }
                await this._apply(focus);
                if (!this._following) {
                    await this._reveal(focus);
                }
                resolve(`Opened ${formatAnchor(target)} in the user's editor and highlighted it.`);
            } catch (err) {
                reject(err);
            }
        });
        return promise;
    }

    /** The voice agent or the worker reads or writes this file. Waits while Pi is still on its previous focus. */
    activity(kind: Exclude<FocusKind, 'pointing'>, target: FocusTarget): void {
        const resolve = async (): Promise<Focus | undefined> => {
            const uri = await this._resolvePath(target.path);
            if (!uri) {
                return undefined;
            }
            const range = target.startLine === undefined ? undefined : new vscode.Range(target.startLine - 1, 0, (target.endLine ?? target.startLine) - 1, 0);
            return { kind, uri, range };
        };
        if (Date.now() < this._holdUntil) {
            // Only the latest waiting activity matters.
            this._deferred = resolve;
            this._scheduleDeferred();
            return;
        }
        this._enqueue(async () => {
            const focus = await resolve();
            if (focus) {
                await this._apply(focus);
            }
        });
    }

    /**
     * Pi is about to write `range` of `uri` itself (pair mode): shown and revealed whether or not the
     * user follows Pi. Resolves with the editor to type into.
     */
    write(uri: vscode.Uri, range: vscode.Range): Promise<vscode.TextEditor> {
        const { promise, resolve, reject } = Promise.withResolvers<vscode.TextEditor>();
        this._enqueue(async () => {
            try {
                const focus: Focus = { kind: 'writing', uri, range };
                this._focus = focus;
                this._holdUntil = Date.now() + POINT_HOLD_MS;
                this._showState();
                resolve(await this._reveal(focus));
            } catch (err) {
                reject(err);
            }
        });
        return promise;
    }

    /** Pi's own edit in progress: moves the writing highlight along and keeps it on screen. */
    writing(editor: vscode.TextEditor, range: vscode.Range): void {
        this._focus = { kind: 'writing', uri: editor.document.uri, range };
        this._holdUntil = Date.now() + POINT_HOLD_MS;
        this._showState();
        this._paint();
        editor.revealRange(new vscode.Range(range.end, range.end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    /** Runs Pi's own edit without it counting as the user typing (which would stop following). */
    async selfEdit<T>(edit: Thenable<T>): Promise<T> {
        this._selfEdits++;
        try {
            return await edit;
        } finally {
            this._selfEdits--;
        }
    }

    current(): AgentFocus | undefined {
        const focus = this._focus;
        if (!focus) {
            return undefined;
        }
        return {
            kind: focus.kind,
            path: vscode.workspace.asRelativePath(focus.uri, false),
            startLine: focus.range && focus.range.start.line + 1,
            endLine: focus.range && focus.range.end.line + 1,
            ...(focus.name ? { name: focus.name.text } : {}),
            following: this._following,
        };
    }

    clear(): void {
        this._focus = undefined;
        this._deferred = undefined;
        this._holdUntil = 0;
        this._paint();
        this._showState();
    }

    dispose(): void {
        clearTimeout(this._deferTimer);
        for (const subscription of this._subscriptions) {
            subscription.dispose();
        }
    }

    private _enqueue(work: () => Promise<void>): void {
        this._chain = this._chain.then(work).catch((err: unknown) => this._log(`Pi focus: ${err instanceof Error ? err.message : String(err)}`));
    }

    private _scheduleDeferred(): void {
        clearTimeout(this._deferTimer);
        this._deferTimer = setTimeout(() => {
            if (Date.now() < this._holdUntil) {
                this._scheduleDeferred();
                return;
            }
            const resolve = this._deferred;
            this._deferred = undefined;
            if (resolve) {
                this._enqueue(async () => {
                    const focus = await resolve();
                    if (focus) {
                        await this._apply(focus);
                    }
                });
            }
        }, Math.max(0, this._holdUntil - Date.now()));
    }

    private async _apply(focus: Focus): Promise<void> {
        this._focus = focus;
        this._holdUntil = Date.now() + (focus.kind === 'pointing' ? POINT_HOLD_MS : ACTIVITY_DWELL_MS);
        this._showState();
        this._paint();
        if (this._following) {
            await this._reveal(focus);
        }
    }

    /** Opens the file in the user's column without taking the keyboard, and scrolls only when the code is off screen. */
    private async _reveal(focus: Focus): Promise<vscode.TextEditor> {
        const shown = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === focus.uri.toString());
        const editor =
            shown ??
            (await vscode.window.showTextDocument(focus.uri, {
                preview: true,
                preserveFocus: true,
                viewColumn: this._userEditor()?.viewColumn ?? vscode.ViewColumn.Active,
            }));
        if (focus.range) {
            editor.revealRange(focus.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        this._paint();
        return editor;
    }

    private async _resolveAnchor(anchor: CodeAnchor): Promise<Focus | undefined> {
        const uri = await this._resolvePath(anchor.path);
        if (!uri) {
            this._log(`Could not point at ${formatAnchor(anchor)}: no such file.`);
            return undefined;
        }
        const document = anchor.symbol ? await vscode.workspace.openTextDocument(uri) : undefined;
        if (document && anchor.symbol && anchor.startLine !== undefined) {
            const found = findName(
                (line) => (line >= 1 && line <= document.lineCount ? document.lineAt(line - 1).text : undefined),
                anchor.symbol,
                anchor.startLine,
                anchor.endLine ?? anchor.startLine,
            );
            if (found) {
                return this._nameFocus(document, new vscode.Range(found.line - 1, found.start, found.line - 1, found.end));
            }
            this._log(`Could not find ${anchor.symbol} near ${formatAnchor({ ...anchor, symbol: undefined })}: pointing at the lines.`);
        } else if (document && anchor.symbol) {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>('vscode.executeDocumentSymbolProvider', document.uri);
            const symbol = findSymbol(symbols ?? [], anchor.symbol.split('.'));
            if (!symbol) {
                this._log(`Could not point at ${formatAnchor(anchor)}: no symbol by that name.`);
                return undefined;
            }
            if (NAME_KINDS[symbol.kind] && symbol.range.isSingleLine) {
                return this._nameFocus(document, symbol.selectionRange);
            }
            return { kind: 'pointing', uri, range: new vscode.Range(symbol.range.start.line, 0, symbol.range.end.line, 0) };
        }
        if (anchor.startLine === undefined) {
            return { kind: 'pointing', uri, range: new vscode.Range(0, 0, 0, 0) };
        }
        return { kind: 'pointing', uri, range: new vscode.Range(anchor.startLine - 1, 0, (anchor.endLine ?? anchor.startLine) - 1, 0) };
    }

    /** One name: marked where it is written, and lightly wherever else the language server says it is used. */
    private async _nameFocus(document: vscode.TextDocument, at: vscode.Range): Promise<Focus> {
        const text = document.getText(at);
        // For `a.b` the uses are those of `b`.
        const lookup = at.end.translate(0, -(text.length - text.lastIndexOf('.') - 1));
        let uses: vscode.Range[] = [];
        try {
            const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[] | undefined>('vscode.executeDocumentHighlights', document.uri, lookup);
            uses = (highlights ?? []).map((h) => h.range).filter((r) => !at.contains(r));
        } catch (err) {
            this._log(`No other uses of ${text}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { kind: 'pointing', uri: document.uri, range: new vscode.Range(at.start.line, 0, at.end.line, 0), name: { text, at, uses } };
    }

    /** A workspace file; a path the model got partly wrong resolves when exactly one file ends with it. */
    private async _resolvePath(target: string): Promise<vscode.Uri | undefined> {
        const direct = vscode.Uri.file(path.isAbsolute(target) ? target : path.join(this._root, target));
        try {
            await vscode.workspace.fs.stat(direct);
            return direct;
        } catch {
            const tail = target.replace(/^[./\\]+/, '');
            const found = tail ? await vscode.workspace.findFiles(`**/${tail}`, '**/node_modules/**', 2) : [];
            return found.length === 1 ? found[0] : undefined;
        }
    }

    private _paint(): void {
        const focus = this._focus;
        for (const editor of vscode.window.visibleTextEditors) {
            const here = focus && editor.document.uri.toString() === focus.uri.toString() ? focus : undefined;
            const last = editor.document.lineCount - 1;
            for (const [kind, style] of Object.entries(this._styles) as Array<[FocusKind, Decorations]>) {
                const mine = here?.kind === kind ? here : undefined;
                // Lines the file no longer has (it shrank since) are clamped away.
                const range = mine?.range && new vscode.Range(Math.min(mine.range.start.line, last), 0, Math.min(mine.range.end.line, last), 0);
                // A name is marked on its own, not its whole line.
                editor.setDecorations(style.highlight, range && !mine.name ? [range] : []);
                editor.setDecorations(style.name, mine?.name ? [editor.document.validateRange(mine.name.at)] : []);
                editor.setDecorations(style.uses, mine?.name ? mine.name.uses.map((r) => editor.document.validateRange(r)) : []);
                // The label goes after the code on the first line, like a collaborator's name tag; line 1 for a whole file.
                const end = mine ? editor.document.lineAt(range?.start.line ?? 0).range.end : undefined;
                editor.setDecorations(style.label, end ? [new vscode.Range(end, end)] : []);
            }
        }
    }

    private _showState(): void {
        const focus = this.current();
        if (!focus) {
            this._status.hide();
            return;
        }
        const lines = focus.startLine === undefined ? '' : focus.startLine === focus.endLine ? `:${focus.startLine}` : `:${focus.startLine}-${focus.endLine}`;
        const where = `${focus.path}${lines}${focus.name ? ` · ${focus.name}` : ''}`;
        const doing = focus.kind === 'pointing' ? '' : `${focus.kind} `;
        this._status.text = `$(${this._following ? 'eye' : 'eye-closed'}) Pi: ${doing}${where}`;
        this._status.tooltip = `Pi ${STYLE[focus.kind].verb} ${where}.\n${this._following ? 'Following Pi.' : 'Not following Pi.'} The follow button next to Voice agent above the chat input switches it.`;
        this._status.show();
    }
}

interface Decorations {
    /** Whole lines. */
    highlight: vscode.TextEditorDecorationType;
    /** The name tag after the first line. */
    label: vscode.TextEditorDecorationType;
    /** One name instead of lines, */
    name: vscode.TextEditorDecorationType;
    /** and its other uses in the file. */
    uses: vscode.TextEditorDecorationType;
}

function decorations(style: (typeof STYLE)[FocusKind]): Decorations {
    return {
        highlight: vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: style.background,
            borderColor: style.color,
            borderStyle: 'solid',
            borderWidth: '0 0 0 3px',
            overviewRulerColor: style.color,
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        }),
        label: vscode.window.createTextEditorDecorationType({
            after: {
                contentText: style.label,
                color: '#ffffff',
                backgroundColor: style.color,
                fontWeight: 'bold',
                margin: '0 0 0 1.5em',
                // Decoration options have no padding or radius; the CSS rides on textDecoration.
                textDecoration: 'none; padding: 0 5px; border-radius: 3px; font-size: 0.85em',
            },
        }),
        name: vscode.window.createTextEditorDecorationType({
            backgroundColor: style.background,
            border: `2px solid ${style.color}`,
            borderRadius: '3px',
            overviewRulerColor: style.color,
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        }),
        uses: vscode.window.createTextEditorDecorationType({
            backgroundColor: style.background,
            border: `1px dashed ${style.color}`,
            borderRadius: '3px',
            overviewRulerColor: style.background,
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        }),
    };
}

/** `Class.method` walks down the tree; a bare name matches at any depth, the outermost first. */
function findSymbol(symbols: readonly vscode.DocumentSymbol[], names: string[]): vscode.DocumentSymbol | undefined {
    const [name, ...rest] = names;
    for (const symbol of symbols) {
        if (symbol.name === name) {
            const inner = rest.length > 0 ? findSymbol(symbol.children, rest) : symbol;
            if (inner) {
                return inner;
            }
        }
    }
    if (names.length === 1) {
        for (const symbol of symbols) {
            const inner = findSymbol(symbol.children, names);
            if (inner) {
                return inner;
            }
        }
    }
    return undefined;
}
