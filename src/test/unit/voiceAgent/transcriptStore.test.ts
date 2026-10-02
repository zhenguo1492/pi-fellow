import { describe, it, expect } from 'vitest';
import type { VoiceEntry } from '../../../shared/voiceViewProtocol';
import type { ResearchJob } from '../../../voiceAgent/research';
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
        store.audio({ turnId: 1, type: 'playing', text: '四个过了。' });
        store.audio({ turnId: 1, type: 'played', text: '四个过了。' });
        store.audio({ turnId: 1, type: 'playing', text: '一个失败。' });
        expect(assistant(store.current()!.entries).sentences).toEqual([
            { text: '四个过了。', state: 'played' },
            { text: '一个失败。', state: 'playing' },
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

describe('VoiceTranscriptStore: voice sessions for the resume list', () => {
    it('sums each worker session over its conversations and leaves out tabs without a session file', () => {
        const { store, setTask } = setup();
        store.addUser('no file yet', 'stt');
        store.endRun();
        setTask({ tabId: 't2', sessionFile: '/s/a.jsonl', name: 'A' });
        store.addUser('把 average 修好', 'stt');
        store.addUser('Confirmed the proposed task: fix it', 'panel');
        store.endRun();
        // Its voice context is gone, so the next run starts a second conversation for the same task.
        store.addUser('还有空列表', 'text');

        expect(store.voiceSessions()).toEqual([
            expect.objectContaining({ sessionFile: '/s/a.jsonl', firstUtterance: '把 average 修好', turns: 2, title: undefined }),
        ]);
        expect(store.userUtterances('/s/a.jsonl')).toEqual(['把 average 修好', '还有空列表']);
    });

    it("keeps a task's name for its later conversations, and a generated name never replaces the user's", () => {
        const { store, setTask } = setup();
        setTask({ tabId: 't1', sessionFile: '/s/a.jsonl', name: 'New Agent' });
        store.addUser('fix average', 'stt');
        expect(store.nameTask('/s/a.jsonl', 'Fix average', 'auto')).toBe(true);
        store.endRun();
        store.addUser('and the empty list', 'stt');
        expect(store.sessions().map((s) => s.title)).toEqual(['Fix average', 'Fix average']);

        expect(store.nameTask('/s/a.jsonl', 'Average bug', 'user')).toBe(true);
        expect(store.nameTask('/s/a.jsonl', 'Something else', 'auto')).toBe(false);
        expect(store.voiceSessions()[0].title).toBe('Average bug');
        expect(store.nameTask('/s/none.jsonl', 'Nobody', 'user')).toBe(false);
    });
});

describe('VoiceTranscriptStore: tool cards', () => {
    it("fills a research call's entry with the findings once its job settles", () => {
        const { store, m } = setup();
        const { listener } = store.beginReply();
        const job: ResearchJob = { id: 'r1', question: 'How does replay work?', startedAt: 1000, status: 'running' };
        listener.onToolCall?.('t1', 'research', { question: job.question }, { text: 'Started research r1', isError: false, research: job });
        listener.onEnd?.(result());
        expect(assistant(store.current()!.entries).tools[0].research).toEqual({ status: 'running', startedAt: 1000 });

        Object.assign(job, { status: 'done', finishedAt: 5000, result: 'ReplayPlayer reads it aloud.' });
        store.researchSettled(job);
        expect(assistant(store.current()!.entries).tools[0].research).toEqual({
            status: 'done',
            startedAt: 1000,
            finishedAt: 5000,
            result: 'ReplayPlayer reads it aloud.',
        });

        // A job still running when the window closed shows as stopped after a reload, not running forever.
        store.beginReply().listener.onToolCall?.('t2', 'research', { question: 'q2' }, { text: 'Started research r2', isError: false, research: { id: 'r2', question: 'q2', startedAt: 2000, status: 'running' } });
        store.flush();
        const reloaded = setup({ initial: m.saved() }).store;
        const tools = reloaded.sessions()[0].entries.flatMap((e) => (e.kind === 'assistant' ? e.tools : []));
        expect(tools.map((t) => t.research?.status)).toEqual(['done', 'failed']);
    });

    it('records a lookup as it starts and its result when it ends; a cut-off one stops running', () => {
        const { store } = setup();
        const { listener } = store.beginReply();
        listener.onLookup?.({ id: 'c1', name: 'read', args: { path: 'a.ts' }, description: 'read a.ts' });
        listener.onLookup?.({ id: 'c2', name: 'grep', args: { pattern: 'x' }, description: 'grep x' });
        listener.onLookupEnd?.('c1', { text: 'x'.repeat(9000), isError: false });
        const [read, grep] = assistant(store.current()!.entries).tools;
        expect(read.running).toBeUndefined();
        expect(read.result.startsWith('x'.repeat(8000))).toBe(true);
        expect(read.result.length).toBeLessThan(8100);
        expect(grep.running).toBe(true);
        listener.onEnd?.(result({ interrupted: true }));
        expect(grep.running).toBeUndefined();
    });

    it('records a host tool call running from when the model starts writing it, settled into that one entry', () => {
        const { store, m } = setup();
        const { listener } = store.beginReply();
        listener.onToolStart?.('t1', 'show_me');
        expect(assistant(store.current()!.entries).tools).toEqual([{ name: 'show_me', args: {}, result: '', isError: false, running: true }]);
        const args = { markdown: '# Plan\n\n```mermaid\ngraph TD\nA-->B\n```' };
        listener.onToolStart?.('t1', 'show_me', args);
        expect(assistant(store.current()!.entries).tools).toEqual([{ name: 'show_me', args, result: '', isError: false, running: true }]);
        listener.onToolCall?.('t1', 'show_me', args, { text: 'Board b1 written', isError: false });
        listener.onEnd?.(result());
        expect(assistant(store.current()!.entries).tools).toEqual([{ name: 'show_me', args, result: 'Board b1 written', isError: false }]);

        // A call the cut-off model never finished writing did nothing: gone at the reply's end, and after a reload.
        const cut = store.beginReply().listener;
        cut.onToolStart?.('t2', 'show_me');
        cut.onEnd?.(result({ interrupted: true }));
        expect(assistant(store.current()!.entries).tools).toEqual([]);
        store.beginReply().listener.onToolStart?.('t3', 'show_me');
        store.flush();
        const reloaded = setup({ initial: m.saved() }).store;
        expect(reloaded.sessions()[0].entries.flatMap((e) => (e.kind === 'assistant' ? e.tools : [])).map((t) => t.result)).toEqual(['Board b1 written']);
    });

    it('turns lookups saved as descriptions into tool entries', () => {
        const saved = { kind: 'assistant', id: 'e1', at: 1, text: 'Hi', tools: [], lookups: ['Reading a.ts'], done: true };
        const { store } = setup({ initial: [{ id: 's1', taskKey: 'tab:t1', title: 'T', startedAt: 1, updatedAt: 1, entries: [saved as VoiceEntry] }] });
        const entry = assistant(store.sessions()[0].entries);
        expect(entry.tools).toEqual([{ name: 'lookup', args: { description: 'Reading a.ts' }, result: '', isError: false }]);
        expect('lookups' in entry).toBe(false);
    });
});
