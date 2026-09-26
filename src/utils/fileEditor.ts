import * as vscode from 'vscode';

/** 1-based inclusive lines of a non-empty selection; a selection ending at column 0 excludes that line. */
export function selectedLineRange(selection: vscode.Selection): { startLine: number; endLine: number } | undefined {
    if (selection.isEmpty) {
        return undefined;
    }
    const { start, end } = selection;
    const lastLine = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
    return { startLine: start.line + 1, endLine: lastLine + 1 };
}

/**
 * The last file-backed text editor: it survives focus moving into a webview (the chat, the voice
 * panel) and is dropped once it is no longer visible.
 */
export class FileEditorTracker implements vscode.Disposable {
    private _editor: vscode.TextEditor | undefined;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    /** The tracked editor changed, or its selection did. */
    readonly onDidChange = this._onDidChange.event;
    private readonly _subscriptions: vscode.Disposable[];

    constructor() {
        this._subscriptions = [
            this._onDidChange,
            vscode.window.onDidChangeActiveTextEditor(() => this._track()),
            vscode.window.onDidChangeVisibleTextEditors(() => this._track()),
            vscode.window.onDidChangeTextEditorSelection((e) => {
                if (e.textEditor === this._editor) {
                    this._onDidChange.fire();
                }
            }),
        ];
        this._track();
    }

    get editor(): vscode.TextEditor | undefined {
        return this._editor;
    }

    dispose(): void {
        for (const subscription of this._subscriptions) {
            subscription.dispose();
        }
    }

    private _track(): void {
        const active = vscode.window.activeTextEditor;
        if (active?.document.uri.scheme === 'file') {
            this._editor = active;
        } else if (this._editor && !vscode.window.visibleTextEditors.includes(this._editor)) {
            this._editor = undefined;
        }
        this._onDidChange.fire();
    }
}
