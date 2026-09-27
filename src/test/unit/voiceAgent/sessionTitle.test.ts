import { describe, expect, it, vi } from 'vitest';
import { SessionTitler, cleanTitle, fallbackTitle } from '../../../voiceAgent/sessionTitle';
import { VoiceTranscriptStore } from '../../../voiceAgent/transcriptStore';
import type { WorkerController, WorkerTask } from '../../../voiceAgent/workerController';

// The CLI runner reads VS Code settings; these tests pass their own generator.
vi.mock('../../../pi/piCliPaths', () => ({}));

describe('session titles', () => {
    it("takes the model's first line without a label, quotes or closing punctuation", () => {
        expect(cleanTitle('Title: "Fix the average helper."\nBecause the user asked')).toBe('Fix the average helper');
        expect(cleanTitle('标题：《修复空列表的平均值》。')).toBe('修复空列表的平均值');
        expect(cleanTitle('\n  \n')).toBeUndefined();
    });

    it('falls back to the first thing said, cut at a word boundary', () => {
        expect(fallbackTitle(['  ', 'fix average'])).toBe('fix average');
        expect(fallbackTitle(['please make the average helper handle empty lists without throwing'])).toBe('please make the average helper handle…');
        const long = '把平均值函数改成在空列表时返回零而不是抛出异常并且补上对应的单元测试和文档说明以及更新变更日志';
        // No spaces to cut at: the first 40 characters.
        expect(fallbackTitle([long])).toBe(`${[...long].slice(0, 40).join('')}…`);
        expect(fallbackTitle([])).toBeUndefined();
    });
});

describe('SessionTitler', () => {
    function setup(task: WorkerTask) {
        const data = new Map<string, unknown>();
        const store = new VoiceTranscriptStore(
            { get: <T>(key: string) => data.get(key) as T | undefined, update: async (key, value) => void data.set(key, value) },
            { sessions: () => 20, entries: 300 },
            () => task,
        );
        const named: Array<{ tabId: string; sessionFile: string; name: string }> = [];
        const firstNamed = Promise.withResolvers<void>();
        const worker = {
            nameTask: async (tabId: string, sessionFile: string, name: string) => {
                named.push({ tabId, sessionFile, name });
                firstNamed.resolve();
                return true;
            },
        } as Partial<WorkerController> as WorkerController;
        return { store, worker, named, workerNamed: firstNamed.promise };
    }

    it('names the session once the user said enough, after the first thing said when the model fails', async () => {
        const task: WorkerTask = { tabId: 't1', name: 'New Agent', backend: 'pi', sessionFile: '/s/a.jsonl' };
        const { store, worker, named, workerNamed } = setup(task);
        const generate = vi.fn(async () => {
            throw new Error('no model');
        });
        const titler = new SessionTitler(store, worker, generate, () => {});

        store.addUser('fix average for empty lists', 'stt');
        titler.noteTurn(task);
        expect(generate).not.toHaveBeenCalled();
        store.addUser('and add a test', 'stt');
        titler.noteTurn(task);
        await workerNamed;

        expect(generate).toHaveBeenCalledWith(['fix average for empty lists', 'and add a test']);
        expect(named).toEqual([{ tabId: 't1', sessionFile: '/s/a.jsonl', name: 'fix average for empty lists' }]);
        expect(store.voiceSessions()[0].title).toBe('fix average for empty lists');

        // Named now: no second model run.
        store.addUser('thanks', 'stt');
        titler.noteTurn(task);
        expect(generate).toHaveBeenCalledTimes(1);
    });

    it('leaves a session that already has a name alone', () => {
        const task: WorkerTask = { tabId: 't1', name: 'Average bug', sessionName: 'Average bug', backend: 'omp', sessionFile: '/s/a.jsonl' };
        const { store, worker, named } = setup(task);
        const generate = vi.fn(async () => 'Fix average');
        const titler = new SessionTitler(store, worker, generate, () => {});
        store.addUser('fix average', 'stt');
        store.addUser('and add a test', 'stt');
        titler.noteTurn(task);
        expect(generate).not.toHaveBeenCalled();
        expect(named).toEqual([]);
    });
});
