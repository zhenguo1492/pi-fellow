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
    withVoiceSessions,
    type VoiceSessionSummary,
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

describe('voice sessions in the resume list', () => {
    const dir = '/tmp/agent/sessions/-proj';
    const voice = (file: string, over: Partial<VoiceSessionSummary> = {}): VoiceSessionSummary => ({
        sessionFile: `${dir}/${file}`,
        firstUtterance: '把 average 修好',
        turns: 3,
        startedAt: 500,
        updatedAt: 3000,
        ...over,
    });
    /** A worker session with no messages and no name: what a tab the user only talked to the voice agent about leaves. */
    const untouched = (id: string): SessionInfo => ({ id, name: id, path: `${dir}/2026-01-01_${id}.jsonl`, messageCount: 0, turnCount: 0, firstMessage: '(no messages)', lastModified: 100 });

    it('keeps an otherwise empty session that has a voice conversation, and still drops untouched ones', () => {
        const sessions = withVoiceSessions([untouched('talked'), untouched('empty')], [voice('2026-01-01_talked.jsonl')], dir);
        const rows = buildSessionListRows(sessions, '', undefined);
        expect(rows.map((r) => r.label)).toEqual(['把 average 修好']);
        expect(rows[0].meta).toMatch(/^3 voice turns · /);
    });

    it('lists a voice-only session pi never wrote to disk, under its voice name, and resolves its file path', () => {
        const rows = buildSessionListRows(withVoiceSessions([], [voice('2026-01-01_unwritten.jsonl', { title: '修复 average' })], dir), '', undefined);
        expect(rows).toEqual([expect.objectContaining({ sessionPath: `${dir}/2026-01-01_unwritten.jsonl`, label: '修复 average' })]);
    });

    it("never replaces the session's own name or first prompt, and ignores other folders' conversations", () => {
        const worked: SessionInfo = { ...untouched('worked'), name: 'Average bug', messageCount: 4, turnCount: 1, firstMessage: 'fix average' };
        const [merged, ...rest] = withVoiceSessions(
            [worked],
            [voice('2026-01-01_worked.jsonl', { title: 'Voice name' }), { ...voice('x.jsonl'), sessionFile: '/elsewhere/x.jsonl' }],
            dir,
        );
        expect(rest).toEqual([]);
        expect(getSessionDisplayTitle(merged)).toBe('Average bug');
        expect(merged.firstMessage).toBe('fix average');
        expect(buildSessionListRows([merged], '', undefined)[0].meta).toMatch(/^1 turn · 3 voice turns · /);
    });
});
