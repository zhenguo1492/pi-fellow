import { describe, it, expect } from 'vitest';
import type { VoiceEntry } from '../../../shared/voiceViewProtocol';
import { VoiceTranscriptStore, type VoiceSessionRecord } from '../../../voiceAgent/transcriptStore';
import type { VoiceTurnResult } from '../../../voiceAgent/voiceAgent';

function memento(initial?: VoiceSessionRecord[]) {
    const data = new Map<string, unknown>(initial ? [['voiceAgent.transcripts', initial]] : []);
    return {
        get: <T>(key: string) => data.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
            data.set(key, JSON.parse(JSON.stringify(value)));
        },
        saved: () => data.get('voiceAgent.transcripts') as VoiceSessionRecord[] | undefined,
    };
}

function setup(options: { sessions?: number; entries?: number; initial?: VoiceSessionRecord[] } = {}) {
    const m = memento(options.initial);
    let task: { tabId: string; sessionFile?: string; name: string } | undefined = { tabId: 't1', name: 'Fix average' };
    const store = new VoiceTranscriptStore(m, { sessions: () => options.sessions ?? 20, entries: options.entries ?? 300 }, () => task);
    return {
        store,
        m,
        setTask: (next: typeof task) => (task = next),
    };
}

const result = (over: Partial<VoiceTurnResult> = {}): VoiceTurnResult => ({
    reply: '',
    silent: false,
    toolCalls: [],
    lookups: [],
    interrupted: false,
    ...over,
});

function assistant(entries: readonly VoiceEntry[]): Extract<VoiceEntry, { kind: 'assistant' }> {
    const found = entries.filter((e) => e.kind === 'assistant');
    return found[found.length - 1] as Extract<VoiceEntry, { kind: 'assistant' }>;
}

describe('VoiceTranscriptStore: spoken replies', () => {
    it('tracks each sentence from queued to played, and marks what the user never heard when cut off', () => {
        const { store } = setup();
        store.addUser('测试结果呢', 'stt');
        const { listener } = store.beginReply({ turnId: 1 });
        listener.onText?.('四个过了。一个失败。原因是');
        store.audio({ turnId: 1, type: 'speak', text: '四个过了。' });
        store.audio({ turnId: 1, type: 'speak', text: '一个失败。' });
        store.audio({ turnId: 1, type: 'playing', text: '四个过了。', at: 1000, durationMs: 900 });
        store.audio({ turnId: 1, type: 'played', text: '四个过了。' });
        store.audio({ turnId: 1, type: 'playing', text: '一个失败。', at: 1900, durationMs: 800 });
        // Only the playing sentence keeps its audio timing (for the spoken-word highlight).
        expect(assistant(store.current()!.entries).sentences).toEqual([
            { text: '四个过了。', state: 'played' },
            { text: '一个失败。', state: 'playing', playback: { at: 1900, durationMs: 800 } },
        ]);

        store.audio({ turnId: 1, type: 'cut', by: 'user' });
        listener.onEnd?.(result({ interrupted: true }));
        const reply = assistant(store.current()!.entries);
        expect(reply.sentences).toEqual([
            { text: '四个过了。', state: 'played' },
            { text: '一个失败。', state: 'cut' },
        ]);
        expect(reply.interrupted).toBe(true);
        // Late audio of the cut-off turn changes nothing.
        store.audio({ turnId: 1, type: 'played', text: '一个失败。' });
        expect(reply.sentences?.[1].state).toBe('cut');
    });

    it('marks the next user entry as barging in only when the user cut the reply off, not hush', () => {
        const { store } = setup();
        store.beginReply({ turnId: 1 });
        store.audio({ turnId: 1, type: 'speak', text: '好的。' });
        store.audio({ turnId: 1, type: 'cut', by: 'hush' });
        store.addUser('继续', 'text');
        store.beginReply({ turnId: 2 });
        store.audio({ turnId: 2, type: 'cut', by: 'user' });
        store.addUser('停一下', 'stt');
        const users = store.current()!.entries.filter((e) => e.kind === 'user');
        expect(users.map((u) => (u.kind === 'user' ? u.bargeIn ?? false : null))).toEqual([false, true]);
    });

    it('counts sentences whose audio never played as not heard once the reply goes idle', () => {
        const { store } = setup();
        const { listener } = store.beginReply({ turnId: 3 });
        store.audio({ turnId: 3, type: 'speak', text: 'TTS 挂了。' });
        listener.onEnd?.(result());
        store.audio({ turnId: 3, type: 'idle' });
        expect(assistant(store.current()!.entries).sentences).toEqual([{ text: 'TTS 挂了。', state: 'cut' }]);
    });

    it('drops a proactive reply that lost the floor before saying or doing anything', () => {
        const { store } = setup();
        const kept = store.beginReply({ proactive: 'done' });
        kept.listener.onText?.('测试跑完了。');
        kept.listener.onEnd?.(result());
        const lost = store.beginReply({ proactive: 'progress' });
        lost.listener.onEnd?.(result({ interrupted: true }));
        const silent = store.beginReply({ proactive: 'progress' });
        silent.listener.onEnd?.(result({ silent: true }));
        const entries = store.current()!.entries;
        expect(entries).toHaveLength(2);
        expect(entries.map((e) => (e.kind === 'assistant' ? [e.proactive, e.silent ?? false] : e.kind))).toEqual([
            ['done', false],
            ['progress', true],
        ]);
    });
});

describe('VoiceTranscriptStore: sessions', () => {
    it('keeps one conversation when the tab gets its session file partway through', () => {
        const { store, setTask } = setup();
        store.addUser('把 average 修好', 'stt');
        setTask({ tabId: 't1', sessionFile: '/s/a.jsonl', name: 'Fix average' });
        store.addUser('好', 'stt');
        expect(store.sessions()).toHaveLength(1);
        expect(store.current()?.entries.map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['把 average 修好', '好']);
        expect(store.current()?.taskKey).toBe('/s/a.jsonl');
    });

    it('starts a separate conversation per task and per run, newest first, within the history limit', () => {
        const { store, setTask } = setup({ sessions: 2 });
        store.addUser('one', 'text');
        setTask({ tabId: 't2', name: 'Other' });
        store.addUser('two', 'text');
        setTask({ tabId: 't1', name: 'Fix average' });
        expect(store.current()?.entries).toHaveLength(1);
        store.endRun();
        expect(store.current()).toBeUndefined();
        store.addUser('three', 'text');
        expect(store.sessions().map((s) => s.title)).toEqual(['Fix average', 'Other']);
        expect(store.sessions()[0].entries.map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['three']);
        expect(store.isLive(store.sessions()[1])).toBe(false);
    });

    it('drops the oldest entries past the per-session limit and restores saved sessions', () => {
        const { store, m } = setup({ entries: 2 });
        store.addUser('a', 'text');
        store.addUser('b', 'text');
        store.addUser('c', 'text');
        store.flush();
        const saved = m.saved()!;
        expect(saved[0].entries.map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['b', 'c']);

        const reopened = setup({ initial: saved }).store;
        expect(reopened.sessions()[0].entries).toHaveLength(2);
        expect(reopened.current()).toBeUndefined();
        expect(reopened.isLive(reopened.sessions()[0])).toBe(false);
    });

    it("lists only the bound task's conversations, following task switches, with every task kept in history", () => {
        const said = (s: VoiceSessionRecord | undefined) => s?.entries.map((e) => (e.kind === 'user' ? e.text : ''));
        const { store, setTask } = setup();
        setTask({ tabId: 't1', sessionFile: '/s/a.jsonl', name: 'A' });
        store.addUser('a1', 'text');
        setTask({ tabId: 't2', sessionFile: '/s/b.jsonl', name: 'B' });
        expect(store.current()).toBeUndefined();
        expect(store.taskSessions()).toEqual([]);
        store.addUser('b1', 'text');
        expect(store.taskSessions().map(said)).toEqual([['b1']]);
        store.endRun();

        setTask({ tabId: 't1', sessionFile: '/s/a.jsonl', name: 'A' });
        store.addUser('a2', 'text');
        expect(store.taskSessions().map(said)).toEqual([['a2'], ['a1']]);
        setTask({ tabId: 't2', sessionFile: '/s/b.jsonl', name: 'B' });
        expect(store.taskSessions().map(said)).toEqual([['b1']]);
        expect(store.sessions()).toHaveLength(3);
    });

    it('gives a tab its earlier conversations once it has a session file, but not a reused tab id from another window', () => {
        const old: VoiceSessionRecord = { id: 'old', taskKey: 'tab:t1', title: 'Earlier window', startedAt: 1, updatedAt: 1, entries: [] };
        const { store, m, setTask } = setup({ initial: [old] });
        expect(store.taskSessions()).toEqual([]);
        store.addUser('before the file', 'stt');
        store.endRun();
        expect(store.taskSessions().map((s) => s.title)).toEqual(['Fix average']);

        setTask({ tabId: 't1', sessionFile: '/s/a.jsonl', name: 'Fix average' });
        expect(store.taskSessions().map((s) => s.taskKey)).toEqual(['/s/a.jsonl']);
        store.flush();
        expect(m.saved()!.map((s) => s.taskKey)).toEqual(['/s/a.jsonl', 'tab:t1']);
    });
});
