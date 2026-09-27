import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readSessionJsonlEntries } from './sessionJsonl';
import { serializeJsonLine } from './jsonl';

export type DeleteSessionResult =
    | { ok: true; method: 'trash' | 'unlink' }
    | { ok: false; method: 'unlink'; error: string };

/** Delete a session file (trash CLI first, then unlink). Matches Pi TUI `/resume`. */
export async function deleteSessionFile(sessionPath: string): Promise<DeleteSessionResult> {
    const trashArgs = sessionPath.startsWith('-') ? ['--', sessionPath] : [sessionPath];
    const trashResult = spawnSync('trash', trashArgs, { encoding: 'utf-8' });

    const getTrashErrorHint = (): string | null => {
        const parts: string[] = [];
        if (trashResult.error) {
            parts.push(trashResult.error.message);
        }
        const stderr = trashResult.stderr?.trim();
        if (stderr) {
            parts.push(stderr.split('\n')[0] ?? stderr);
        }
        if (parts.length === 0) {
            return null;
        }
        return `trash: ${parts.join(' · ').slice(0, 200)}`;
    };

    if (trashResult.status === 0 || !existsSync(sessionPath)) {
        return { ok: true, method: 'trash' };
    }

    try {
        await unlink(sessionPath);
        return { ok: true, method: 'unlink' };
    } catch (err: unknown) {
        const unlinkError = err instanceof Error ? err.message : String(err);
        const trashErrorHint = getTrashErrorHint();
        const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
        return { ok: false, method: 'unlink', error };
    }
}

function generateEntryId(existingIds: Set<string>): string {
    for (let i = 0; i < 100; i++) {
        const id = randomUUID().slice(0, 8);
        if (!existingIds.has(id)) {
            return id;
        }
    }
    return randomUUID();
}

/** Append a `session_info` name entry (Pi SessionManager.appendSessionInfo). */
export function appendSessionDisplayName(sessionPath: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error('Session name cannot be empty');
    }
    if (!existsSync(sessionPath)) {
        throw new Error('Session file not found');
    }

    const entries = readSessionJsonlEntries(sessionPath);
    if (entries.length === 0) {
        throw new Error('Invalid session file');
    }

    const existingIds = new Set<string>();
    let leafId: string | null = null;
    for (const entry of entries) {
        if (entry.type === 'session') {
            continue;
        }
        const id = (entry as { id?: string }).id;
        if (typeof id === 'string') {
            existingIds.add(id);
            leafId = id;
        }
    }

    const line = serializeJsonLine({
        type: 'session_info',
        id: generateEntryId(existingIds),
        parentId: leafId,
        timestamp: new Date().toISOString(),
        name: trimmed,
    });
    appendFileSync(sessionPath, line, 'utf8');
}
