import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildSessionDisplayList,
    buildSessionInfoFromFile,
    buildSessionListRows,
    encodeSessionCwd,
    getSessionDirForCwd,
    getSessionDisplayTitle,
} from '../../../pi/sessionCatalog';
import type { SessionInfo } from '../../../shared/protocol';

function session(id: string, path: string, lastModified = 1000): SessionInfo {
    return {
        id,
        name: id,
        path,
        lastModified,
        messageCount: 1,
        firstMessage: `message ${id}`,
    };
}

describe('encodeSessionCwd', () => {
    it('matches Pi CLI session directory encoding', () => {
        const cwd = '/Users/modernambalaj/Desktop/pi-vscode-extension';
        expect(encodeSessionCwd(cwd, 'pi')).toBe('--Users-modernambalaj-Desktop-pi-vscode-extension--');
        expect(getSessionDirForCwd(cwd, { backend: 'pi', agentDir: '/tmp/agent' })).toBe(
            '/tmp/agent/sessions/--Users-modernambalaj-Desktop-pi-vscode-extension--',
        );
    });

    it('matches omp home-, tmp- and absolute-relative encoding', () => {
        const home = '/home/u';
        const tmp = '/var/tmpx';
        expect(encodeSessionCwd('/home/u/source/vs-pi-agent', 'omp', home, tmp)).toBe('-source-vs-pi-agent');
        expect(encodeSessionCwd('/home/u', 'omp', home, tmp)).toBe('-');
        expect(encodeSessionCwd('/var/tmpx/scratch/a', 'omp', home, tmp)).toBe('-tmp-scratch-a');
        expect(encodeSessionCwd('/var/tmpx', 'omp', home, tmp)).toBe('-tmp');
        expect(encodeSessionCwd('/opt/work', 'omp', home, tmp)).toBe('--opt-work--');
        expect(encodeSessionCwd('/home/user2/x', 'omp', home, tmp)).toBe('--home-user2-x--');
    });
});

describe('session display title', () => {
    it('uses the first prompt for an unnamed restored session', () => {
        expect(getSessionDisplayTitle(session('session-id', '/tmp/session.jsonl'))).toBe(
            'message session-id',
        );
    });

    it('prefers a custom session name', () => {
        const named = session('session-id', '/tmp/session.jsonl');
        named.name = 'Architecture review';
        expect(getSessionDisplayTitle(named)).toBe('Architecture review');
    });
});

describe('session list', () => {
    it('lists newest activity first', () => {
        const sessions = [session('old', '/tmp/old.jsonl', 100), session('new', '/tmp/new.jsonl', 200)];
        expect(buildSessionDisplayList(sessions).map((s) => s.id)).toEqual(['new', 'old']);
    });

    it('counts user prompts as turns and reports the file size', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-'));
        const file = path.join(dir, '2026-01-01_abc.jsonl');
        const message = (role: string, text: string) =>
            JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }] } });
        fs.writeFileSync(
            file,
            [
                JSON.stringify({ type: 'session', id: 'abc', timestamp: '2026-01-01T00:00:00Z' }),
                message('user', 'first'),
                message('assistant', 'reply'),
                message('toolResult', 'output'),
                message('user', 'second'),
                message('assistant', 'reply'),
            ].join('\n'),
        );
        try {
            const info = buildSessionInfoFromFile(file)!;
            expect(info.turnCount).toBe(2);
            expect(info.sizeBytes).toBe(fs.statSync(file).size);

            const [row] = buildSessionListRows([{ ...info, sizeBytes: 1536 }], '', undefined);
            expect(row.meta).toMatch(/^2 turns · 1\.5 KB · /);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
