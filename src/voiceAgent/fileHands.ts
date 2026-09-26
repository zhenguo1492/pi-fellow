import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentCursor } from './agentCursor';
import { insideFolder } from './pairText';

/** Where a deletion the trash would not take is backed up first: one folder per deletion, keeping its workspace path. */
const BACKUP_ROOT = path.join(os.tmpdir(), 'oh-my-pi-chater-deleted');

/** A path the voice agent may touch. */
export interface WorkspacePath {
    uri: vscode.Uri;
    /** Workspace-relative, with the folder name first in a multi-root workspace: for messages and the backup's layout. */
    relative: string;
    folder: vscode.WorkspaceFolder;
}

/**
 * The voice agent's file operations in pair mode (docs/voice-pair-agent-cursor.md §13): create files
 * and folders, rename, delete (to the trash, or after a backup when the trash fails), save and close.
 * Every path must lie in a workspace folder, also once symbolic links are followed. Deleting asks the
 * user first; that is HostToolRouter's job, this only checks and does it.
 */
export class FileHands {
    constructor(
        /** Relative paths are relative to it. */
        private readonly _root: string,
        private readonly _cursor: AgentCursor,
    ) {}

    async resolve(target: string): Promise<WorkspacePath> {
        const abs = path.resolve(this._root, target);
        const folders = vscode.workspace.workspaceFolders ?? [];
        const folder = folders.find((f) => f.uri.scheme === 'file' && insideFolder(f.uri.fsPath, abs));
        if (!folder) {
            throw new Error(`${target} is outside the workspace.`);
        }
        // The deepest part that exists, links followed, must still be in the folder: a link must not lead out.
        let existing = abs;
        let real = await fs.realpath(existing).catch(() => undefined);
        while (real === undefined && path.dirname(existing) !== existing) {
            existing = path.dirname(existing);
            real = await fs.realpath(existing).catch(() => undefined);
        }
        const realFolder = await fs.realpath(folder.uri.fsPath).catch(() => folder.uri.fsPath);
        if (real === undefined || !insideFolder(realFolder, real)) {
            throw new Error(`${target} leads outside the workspace through a link.`);
        }
        return { uri: vscode.Uri.file(abs), relative: vscode.workspace.asRelativePath(abs, folders.length > 1), folder };
    }

    async createFile(target: string, content: string): Promise<string> {
        const { uri, relative } = await this.resolve(target);
        if (await statOf(uri)) {
            throw new Error(`${relative} already exists: change it with edit_file.`);
        }
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(uri, { contents: new TextEncoder().encode(content) });
        if (!(await vscode.workspace.applyEdit(edit))) {
            throw new Error(`VS Code could not create ${relative}.`);
        }
        const lines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
        await this._cursor.write(uri, new vscode.Range(0, 0, Math.max(lines - 1, 0), 0));
        return `Created ${relative}${lines > 0 ? ` with ${lines} lines` : ', empty'}, and opened it. Change it further with edit_file.`;
    }

    async createFolder(target: string): Promise<string> {
        const { uri, relative } = await this.resolve(target);
        const stat = await statOf(uri);
        if (stat) {
            if (stat.type & vscode.FileType.Directory) {
                return `The folder ${relative} already exists.`;
            }
            throw new Error(`${relative} is a file.`);
        }
        await vscode.workspace.fs.createDirectory(uri);
        return `Created the folder ${relative}.`;
    }

    /** Renames or moves a file or folder; never over an existing one. */
    async rename(fromPath: string, toPath: string): Promise<string> {
        const from = await this.resolve(fromPath);
        const to = await this.resolve(toPath);
        if (from.uri.fsPath === from.folder.uri.fsPath) {
            throw new Error('That is the workspace folder itself.');
        }
        const stat = await statOf(from.uri);
        if (!stat) {
            throw new Error(`${from.relative} does not exist.`);
        }
        if (await statOf(to.uri)) {
            throw new Error(`${to.relative} already exists: pick another name; nothing is overwritten.`);
        }
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(from.uri, to.uri, { overwrite: false });
        if (!(await vscode.workspace.applyEdit(edit))) {
            throw new Error(`VS Code could not rename ${from.relative}.`);
        }
        if (!(stat.type & vscode.FileType.Directory)) {
            this._cursor.activity('writing', { path: to.uri.fsPath });
        }
        return `Renamed ${from.relative} to ${to.relative}.`;
    }

    /** What deleting `target` would remove, as a phrase; throws when it may not be deleted. */
    async describeDeletion(target: string, recursive: boolean): Promise<string> {
        const { uri, relative, folder } = await this.resolve(target);
        if (uri.fsPath === folder.uri.fsPath) {
            throw new Error('That is the workspace folder itself: it is never deleted.');
        }
        if (path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).includes('.git')) {
            throw new Error(`${relative} is Git's own data: it is never deleted.`);
        }
        const stat = await statOf(uri);
        if (!stat) {
            throw new Error(`${relative} does not exist.`);
        }
        const unsaved = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file' && insideFolder(uri.fsPath, d.uri.fsPath));
        if (unsaved.length > 0) {
            const names = unsaved.map((d) => vscode.workspace.asRelativePath(d.uri, false)).join(', ');
            throw new Error(`${names} ${unsaved.length === 1 ? 'has' : 'have'} unsaved changes: ask the user to save or discard them first.`);
        }
        if (!(stat.type & vscode.FileType.Directory)) {
            return `the file ${relative}`;
        }
        if (!recursive) {
            throw new Error(`${relative} is a folder: pass recursive true to delete it with everything in it.`);
        }
        const entries = await fs.readdir(uri.fsPath, { recursive: true, withFileTypes: true });
        const files = entries.filter((e) => !e.isDirectory()).length;
        return `the folder ${relative} with ${files} ${files === 1 ? 'file' : 'files'}`;
    }

    /**
     * Deletes to the trash. When the trash cannot take it, copies it to a backup under the system temp
     * folder first, keeping its workspace path, and only then deletes it for good.
     */
    async delete(target: string, recursive: boolean): Promise<string> {
        const what = await this.describeDeletion(target, recursive);
        const { uri, relative } = await this.resolve(target);
        try {
            await vscode.workspace.fs.delete(uri, { recursive, useTrash: true });
            await closeTabsInside(uri);
            return `Deleted ${what}: it is in the trash.`;
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (!(await statOf(uri))) {
                throw new Error(`Deleting ${relative} failed partway (${reason}); it is gone now, and may be in the trash.`);
            }
            const backup = path.join(BACKUP_ROOT, new Date().toISOString().replace(/[:.]/g, '-'), relative);
            await fs.mkdir(path.dirname(backup), { recursive: true });
            // Links are copied as links, so the backup never pulls in what they point at.
            await fs.cp(uri.fsPath, backup, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
            await vscode.workspace.fs.delete(uri, { recursive, useTrash: false });
            await closeTabsInside(uri);
            return `The trash could not take it (${reason}), so ${what} was first backed up to ${backup} and then deleted. The backup is in the system temp folder, which may be cleared on restart.`;
        }
    }

    /** One file, or with no path every open workspace file with unsaved changes. */
    async save(target: string | undefined): Promise<string> {
        if (target === undefined) {
            const folders = vscode.workspace.workspaceFolders ?? [];
            const unsaved = vscode.workspace.textDocuments.filter(
                (d) => d.isDirty && d.uri.scheme === 'file' && folders.some((f) => insideFolder(f.uri.fsPath, d.uri.fsPath)),
            );
            if (unsaved.length === 0) {
                return 'No workspace file had unsaved changes.';
            }
            const saved = await Promise.all(unsaved.map((d) => d.save()));
            const name = (d: vscode.TextDocument) => vscode.workspace.asRelativePath(d.uri, folders.length > 1);
            const failed = unsaved.filter((_, i) => !saved[i]).map(name);
            const done = unsaved.filter((_, i) => saved[i]).map(name);
            return `Saved ${done.join(', ') || 'nothing'}.${failed.length > 0 ? ` Could not save ${failed.join(', ')}.` : ''}`;
        }
        const { uri, relative } = await this.resolve(target);
        const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
        if (!document) {
            return `${relative} is not open, so there is nothing to save.`;
        }
        if (!document.isDirty) {
            return `${relative} had no unsaved changes.`;
        }
        if (!(await document.save())) {
            throw new Error(`Could not save ${relative}.`);
        }
        return `Saved ${relative}.`;
    }

    /** Closes a file's tabs in every editor group; refuses when it has unsaved changes. */
    async close(target: string): Promise<string> {
        const { uri, relative } = await this.resolve(target);
        const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => tabUri(t)?.fsPath === uri.fsPath);
        if (tabs.length === 0) {
            return `${relative} is not open.`;
        }
        if (tabs.some((t) => t.isDirty)) {
            throw new Error(`${relative} has unsaved changes: save it first, or ask the user.`);
        }
        await vscode.window.tabGroups.close(tabs, true);
        return `Closed ${relative}.`;
    }
}

async function statOf(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
    try {
        return await vscode.workspace.fs.stat(uri);
    } catch {
        return undefined;
    }
}

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
    const input = tab.input;
    return input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook ? input.uri : undefined;
}

/** Tabs of what was deleted would stay open as "(deleted)": they had no unsaved changes, so close them. */
async function closeTabsInside(uri: vscode.Uri): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => {
        const at = tabUri(t);
        return at?.scheme === 'file' && insideFolder(uri.fsPath, at.fsPath);
    });
    if (tabs.length > 0) {
        await vscode.window.tabGroups.close(tabs, true);
    }
}
