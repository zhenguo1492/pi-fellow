import * as path from 'node:path';
import * as vscode from 'vscode';
import { processFilePaths, processPastedImages, type PastedImageInput } from '../pi/fileAttachments';
import {
    type PendingAttachment,
    toPendingAttachment,
    toPendingTextFileAttachment,
} from '../pi/pendingAttachments';
import { buildEditorContextFragment, type EditorContextInfo } from '../shared/editorContext';
import { FileEditorTracker, selectedLineRange } from '../utils/fileEditor';
import type { SidebarHost } from './sidebarHost';
import type { MessageHandlers } from './sidebarMessageHandlers';

const EDITOR_CONTEXT_STATE_KEY = 'oh-my-pi-chater.includeEditorContext';

/** The active tab's pending attachments (drops, pastes, the picker) and the composer's editor context chip. */
export class SidebarAttachments {
    private _lastAttachKey = '';
    private _lastAttachMs = 0;
    /** Include the active editor's file/selection with each prompt (composer chip toggle). */
    private _editorContextEnabled: boolean;
    /** Last file-backed editor; survives focus moving into the chat view. */
    private readonly _fileEditor = new FileEditorTracker();
    private _editorContextTimer: NodeJS.Timeout | undefined;

    constructor(
        private readonly _host: SidebarHost,
        private readonly _pastedStorageDir: string,
    ) {
        this._editorContextEnabled = _host.workspaceState.get<boolean>(EDITOR_CONTEXT_STATE_KEY, true);
        this._fileEditor.onDidChange(() => this._scheduleEditorContextPost());
        this._scheduleEditorContextPost();
    }

    /** Attach local paths (Explorer tree drop or legacy webview path). */
    async attachPaths(paths: string[]): Promise<void> {
        const tab = this._host.activeTab;
        const unique = [...new Set(paths.filter((p) => p.trim().length > 0))];
        if (unique.length === 0) {
            return;
        }

        const key = unique.sort().join('\0');
        const now = Date.now();
        if (key === this._lastAttachKey && now - this._lastAttachMs < 400) {
            return;
        }
        this._lastAttachKey = key;
        this._lastAttachMs = now;

        const cwd =
            tab.session.session?.cwd ??
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
            process.cwd();
        const processed = await processFilePaths(unique, cwd);
        if (processed.length === 0) {
            vscode.window.showWarningMessage(
                'Oh My Pi Chater: dropped files could not be read or are unsupported.',
            );
            return;
        }
        const existing = new Set(tab.pendingAttachments.map((a) => a.displayName));
        for (const item of processed) {
            if (existing.has(item.displayName)) {
                continue;
            }
            existing.add(item.displayName);
            tab.pendingAttachments.push(toPendingAttachment(item));
        }
        this._host.sendStateSync();
    }

    private _scheduleEditorContextPost(): void {
        clearTimeout(this._editorContextTimer);
        this._editorContextTimer = setTimeout(() => this.postEditorContext(), 100);
    }

    postEditorContext(): void {
        const editor = this._fileEditor.editor;
        const context: EditorContextInfo | null = editor
            ? {
                  filePath: editor.document.uri.fsPath,
                  displayPath: vscode.workspace.asRelativePath(editor.document.uri, false),
                  ...selectedLineRange(editor.selection),
              }
            : null;
        this._host.post({ type: 'editorContext', context, enabled: this._editorContextEnabled });
    }

    /** Editor file/selection captured at send time; empty without a file editor, or when excluded unless `evenIfExcluded`. */
    editorContextAttachments(evenIfExcluded = false): PendingAttachment[] {
        const editor = this._fileEditor.editor;
        if (!editor || (!this._editorContextEnabled && !evenIfExcluded)) {
            return [];
        }
        const filePath = editor.document.uri.fsPath;
        const lines = selectedLineRange(editor.selection);
        return [
            {
                id: 'editor-context',
                displayName: vscode.workspace.asRelativePath(editor.document.uri, false),
                isImage: false,
                absolutePath: filePath,
                textFragment: buildEditorContextFragment(
                    filePath,
                    lines && { ...lines, text: editor.document.getText(editor.selection) },
                ),
            },
        ];
    }

    private async _pickAttachmentsDialog(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach',
            title: 'Attach files or images',
        });
        if (!uris?.length) {
            return;
        }
        await this.attachPaths(uris.map((u) => u.fsPath));
    }

    private async _attachPastedImages(items: PastedImageInput[]): Promise<void> {
        if (!items.length) {
            return;
        }
        const tab = this._host.activeTab;
        const processed = await processPastedImages(items, this._pastedStorageDir);
        for (const item of processed) {
            tab.pendingAttachments.push(toPendingAttachment(item));
        }
        this._host.sendStateSync();
    }

    private async _attachDroppedTextFiles(files: { name: string; text: string }[]): Promise<void> {
        const tab = this._host.activeTab;
        let added = false;
        for (const file of files) {
            if (!file.text?.trim()) {
                continue;
            }
            tab.pendingAttachments.push(toPendingTextFileAttachment(file.name, file.text));
            added = true;
        }
        if (added) {
            this._host.sendStateSync();
        }
    }

    handlers(): MessageHandlers {
        return {
            pickAttachments: async () => {
                await this._pickAttachmentsDialog();
            },
            addPastedImages: async (msg) => {
                await this._attachPastedImages(msg.items ?? []);
            },
            addDroppedTextFiles: async (msg) => {
                await this._attachDroppedTextFiles(msg.files ?? []);
            },
            dropFilePaths: async (msg) => {
                await this.attachPaths(msg.paths ?? []);
            },
            dropAttachFailed: (msg) => {
                const types = msg.mimeTypes ?? [];
                const fromExplorer =
                    types.includes('text/uri-list') ||
                    types.includes('application/vnd.code.uri-list');
                if (fromExplorer) {
                    void vscode.window.showInformationMessage(
                        'Oh My Pi Chater: From Explorer, hold Shift while dropping on the message box. Or right-click the file → Add to Chat.',
                    );
                }
            },
            searchWorkspaceFiles: async (msg) => {
                const { searchWorkspaceFiles } = await import('../pi/workspaceFileSearch');
                const files = await searchWorkspaceFiles(msg.query ?? '');
                this._host.post({
                    type: 'workspaceFiles',
                    requestId: msg.requestId,
                    files,
                });
            },
            removeAttachment: (msg, tab) => {
                tab.pendingAttachments = tab.pendingAttachments.filter((a) => a.id !== msg.id);
                this._host.sendStateSync();
            },
            openFile: async (msg, tab) => {
                const { openAttachmentFile } = await import('../pi/openAttachment');
                const cwd =
                    tab.session.session?.cwd ??
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
                    process.cwd();
                await openAttachmentFile(
                    msg.filePath,
                    cwd,
                    msg.startLine && msg.endLine
                        ? { startLine: msg.startLine, endLine: msg.endLine }
                        : undefined,
                );
            },
            setEditorContextEnabled: (msg) => {
                this._editorContextEnabled = msg.enabled;
                void this._host.workspaceState.update(EDITOR_CONTEXT_STATE_KEY, msg.enabled);
                this.postEditorContext();
            },
            readImageFile: async (msg) => {
                const { readFile } = await import('node:fs/promises');
                try {
                    const ext = path.extname(msg.filePath).toLowerCase();
                    const mimeMap: Record<string, string> = {
                        '.png': 'image/png',
                        '.jpg': 'image/jpeg',
                        '.jpeg': 'image/jpeg',
                        '.gif': 'image/gif',
                        '.webp': 'image/webp',
                        '.bmp': 'image/bmp',
                        '.svg': 'image/svg+xml',
                        '.ico': 'image/x-icon',
                    };
                    const mime = mimeMap[ext] || 'image/png';
                    const buffer = await readFile(msg.filePath);
                    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
                    this._host.post({
                        type: 'imageFileData',
                        requestId: msg.requestId,
                        filePath: msg.filePath,
                        dataUrl,
                    });
                } catch (err: unknown) {
                    // Errors carry `message`; whatever else was thrown is read the same way.
                    const thrown = err as { message?: string } | null | undefined;
                    this._host.post({
                        type: 'imageFileData',
                        requestId: msg.requestId,
                        filePath: msg.filePath,
                        error: thrown?.message || 'Failed to read image',
                    });
                }
            },
        };
    }
}
