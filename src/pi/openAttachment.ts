import { stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const IMAGE_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.bmp',
    '.svg',
    '.ico',
]);

export function isImageFilePath(filePath: string): boolean {
    return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Open a file in the editor (text) or default app (images, binary); reveal
 * directories in the explorer. Relative and `~/` paths resolve against
 * `baseDir` (the agent session cwd), since tool arguments are cwd-relative.
 * `lines` (1-based, inclusive) selects and reveals that range in text files.
 */
export async function openAttachmentFile(
    filePath: string,
    baseDir: string,
    lines?: { startLine: number; endLine: number },
): Promise<void> {
    const trimmed = filePath.trim();
    if (!trimmed) {
        return;
    }
    const expanded =
        trimmed === '~' || trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
    const normalized = path.resolve(baseDir, expanded);

    let isDirectory: boolean;
    try {
        isDirectory = (await stat(normalized)).isDirectory();
    } catch {
        void vscode.window.showErrorMessage(`File not found: ${trimmed}`);
        return;
    }

    const uri = vscode.Uri.file(normalized);
    if (isDirectory) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
        return;
    }
    if (isImageFilePath(normalized)) {
        await vscode.commands.executeCommand('vscode.open', uri);
        return;
    }

    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const selection = lines
            ? doc.validateRange(
                  new vscode.Range(lines.startLine - 1, 0, lines.endLine - 1, Number.MAX_SAFE_INTEGER),
              )
            : undefined;
        await vscode.window.showTextDocument(doc, { preview: false, selection });
    } catch {
        await vscode.commands.executeCommand('vscode.open', uri);
    }
}
