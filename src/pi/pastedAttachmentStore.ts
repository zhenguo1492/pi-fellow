import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SUBDIR = 'pasted-attachments';

export function pastedAttachmentsDir(globalStorageFsPath: string): string {
    return join(globalStorageFsPath, SUBDIR);
}

function sanitizeFileName(name: string): string {
    const base = basename(name).replace(/[^\w.\-()+ ]+/g, '_') || 'pasted-image.png';
    return base.slice(0, 120);
}

/** Write clipboard bytes to extension storage; returns an on-disk path safe for open-on-click. */
export async function savePastedFile(
    storageDir: string,
    displayName: string,
    bytes: Buffer,
): Promise<string> {
    await mkdir(storageDir, { recursive: true });
    const safe = sanitizeFileName(displayName);
    let absolutePath = join(storageDir, safe);
    try {
        await access(absolutePath);
        absolutePath = join(storageDir, `${randomUUID().slice(0, 8)}-${safe}`);
    } catch {
        // path free
    }
    await writeFile(absolutePath, bytes);
    return absolutePath;
}
