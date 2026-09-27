import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendSessionDisplayName, deleteSessionFile } from '../../../pi/sessionFileOps';
import { readSessionJsonlEntries } from '../../../pi/sessionJsonl';

describe('sessionFileOps', () => {
    let tmpDir: string;
    let sessionFile: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-ops-'));
        sessionFile = path.join(tmpDir, 'test_sess.jsonl');
        fs.writeFileSync(
            sessionFile,
            [
                JSON.stringify({
                    type: 'session',
                    version: 3,
                    id: 'sess1',
                    timestamp: new Date().toISOString(),
                    cwd: tmpDir,
                }),
                JSON.stringify({
                    type: 'message',
                    id: 'msg00001',
                    parentId: null,
                    timestamp: new Date().toISOString(),
                    message: { role: 'user', content: 'hello', timestamp: Date.now() },
                }),
            ].join('\n') + '\n',
            'utf8',
        );
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('appendSessionDisplayName adds session_info entry', () => {
        appendSessionDisplayName(sessionFile, 'Renamed');
        const entries = readSessionJsonlEntries(sessionFile);
        const info = entries.filter((e) => e.type === 'session_info');
        expect(info.length).toBe(1);
        expect(info[0].name).toBe('Renamed');
    });

    it('appendSessionDisplayName rejects empty name', () => {
        expect(() => appendSessionDisplayName(sessionFile, '   ')).toThrow(/empty/i);
    });

    it('deleteSessionFile unlinks the file when no trash CLI is available', async () => {
        const originalPath = process.env.PATH;
        process.env.PATH = tmpDir;
        try {
            await expect(deleteSessionFile(sessionFile)).resolves.toEqual({ ok: true, method: 'unlink' });
        } finally {
            process.env.PATH = originalPath;
        }
        expect(fs.existsSync(sessionFile)).toBe(false);
    });
});
