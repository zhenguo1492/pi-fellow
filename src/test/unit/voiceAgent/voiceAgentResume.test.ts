import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceEntry } from '../../../shared/voiceViewProtocol';
import { VoiceTranscriptStore, type TranscriptMemento, type VoiceSessionRecord } from '../../../voiceAgent/transcriptStore';
import { VoiceAgent } from '../../../voiceAgent/voiceAgent';
import type { WorkerController, WorkerEvent, WorkerStatus, WorkerTask } from '../../../voiceAgent/workerController';

/** The omp voice process, faked: session files are real files in `dir`. */
const omp = vi.hoisted(() => ({
    dir: '',
    prompts: [] as string[],
    created: [] as string[],
    switched: [] as string[],
    failSwitch: false,
    /** Set: VoiceLlm.start rejects with it, like pi exiting on an unknown model. */
    failStart: '',
}));

vi.mock('../../../voiceAgent/voiceLlm', async () => {
    // Hoisted above this file's imports, so the factory loads what it uses itself.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const llm = {
        model: 'test/voice',
        async newSession() {
            const file = path.join(omp.dir, `voice-${omp.created.length + 1}.jsonl`);
            fs.writeFileSync(file, '');
            omp.created.push(file);
            return file;
        },
        async switchSession(file: string) {
            if (omp.failSwitch) {
                throw new Error('corrupt session');
            }
            omp.switched.push(file);
        },
        prompt(message: string, _signal: AbortSignal, handlers: { onText(delta: string): void }) {
            omp.prompts.push(message);
            handlers.onText('Sure.');
            return Promise.resolve({});
        },
        sendToolResult() {},
        async usage() {
            return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        },
        async stop() {},
    };
    return {
        VoiceLlm: {
            start: async () => {
                if (omp.failStart) {
                    throw new Error(omp.failStart);
                }
                return llm;
            },
        },
    };
});

// Research runs omp itself (and reads VS Code settings to find it); these tests start none.
vi.mock('../../../voiceAgent/research', () => ({
    ResearchRunner: class {
        stopAll() {}
    },
}));

class FakeWorker implements WorkerController {
    task: WorkerTask | undefined = { tabId: 'tab-1', name: 'Fix average', backend: 'omp', sessionFile: '/w/a.jsonl' };
    private readonly _tabListeners = new Set<(event: { tabId: string; event: WorkerEvent }) => void>();

    activeTask() {
        return this.task;
    }
    onActiveTaskChanged() {
        return { dispose() {} };
    }
    onTabEvent(listener: (event: { tabId: string; event: WorkerEvent }) => void) {
        this._tabListeners.add(listener);
        return { dispose: () => this._tabListeners.delete(listener) };
    }
    emit(event: WorkerEvent) {
        for (const listener of this._tabListeners) {
            listener({ tabId: this.task!.tabId, event });
        }
    }
    onRequestsChanged() {
        return { dispose() {} };
    }
    async send() {
        return 'started' as const;
    }
    async abort() {}
    status(): WorkerStatus {
        return { phase: 'idle', queued: 0 };
    }
    pendingRequests() {
        return [];
    }
    answer() {
        return false;
    }
    recentTurns() {
        return [{ instruction: 'Make average handle empty lists', reply: 'Done' }];
    }
    async nameTask() {
        return false;
    }
}

function memento() {
    const data = new Map<string, unknown>();
    return {
        get: <T>(key: string) => data.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
            data.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
}

/** One VS Code window: the store lives as long as it, a voice agent per voice run. */
function openWindow(worker: FakeWorker, state: TranscriptMemento) {
    const store = new VoiceTranscriptStore(state, { sessions: () => 20, entries: 300 }, () => worker.activeTask());
    let agent: VoiceAgent | undefined;
    /** Voice starts: the agent watches the worker from now on. */
    const startVoice = () =>
        (agent ??= new VoiceAgent({
            worker,
            cwd: omp.dir,
            sessionDir: omp.dir,
            contexts: store,
            model: '',
            thinking: 'off',
            confirmBeforeDispatch: () => true,
            arbiter: () => ({ narration: 'off', minProactiveGapMs: 8000, narrationIntervalMs: 30000 }),
            log: () => {},
        }));
    return {
        store,
        startVoice,
        /** Like voice mode's user turn: recorded, then sent. */
        async say(text: string) {
            store.addUser(text, 'text');
            await startVoice().say(text, 'text', store.beginReply().listener);
        },
        async stopVoice() {
            store.endRun();
            await agent?.stop();
            agent = undefined;
        },
    };
}

const said = (session: VoiceSessionRecord | undefined) =>
    session?.entries.map((e: VoiceEntry) => (e.kind === 'user' || e.kind === 'system' ? e.text : e.kind === 'assistant' ? `> ${e.text}` : ''));

beforeEach(() => {
    omp.dir = mkdtempSync(path.join(os.tmpdir(), 'voice-resume-'));
    omp.prompts = [];
    omp.created = [];
    omp.switched = [];
    omp.failSwitch = false;
    omp.failStart = '';
});

afterEach(() => {
    rmSync(omp.dir, { recursive: true, force: true });
});

describe('VoiceAgent: resuming a task’s voice conversation', () => {
    it('resumes it in a new window, with task history and the worker steps the new agent saw', async () => {
        const worker = new FakeWorker();
        const state = memento();
        const first = openWindow(worker, state);
        await first.say('What is it doing?');
        await first.stopVoice();

        const second = openWindow(worker, state);
        second.startVoice();
        worker.emit({ type: 'tool_execution_start', toolName: 'read', args: { path: 'a.txt' }, intent: 'Reading a.txt' });
        await second.say('And now?');

        expect(omp.switched).toEqual([omp.created[0]]);
        expect(omp.created).toHaveLength(1);
        expect(omp.prompts[1]).toContain('<task-history');
        expect(omp.prompts[1]).toContain('Reading a.txt');
        expect(second.store.sessions()).toHaveLength(1);
        expect(said(second.store.current())).toEqual(['What is it doing?', '> Sure.', 'And now?', '> Sure.']);
        await second.stopVoice();
    });

    it('starts a new conversation when the saved voice session file is gone, keeping the old transcript', async () => {
        const worker = new FakeWorker();
        const state = memento();
        const first = openWindow(worker, state);
        await first.say('What is it doing?');
        await first.stopVoice();
        rmSync(omp.created[0]);

        const second = openWindow(worker, state);
        expect(second.store.resumable()).toBeUndefined();
        await second.say('And now?');

        expect(omp.switched).toEqual([]);
        expect(omp.created).toHaveLength(2);
        expect(second.store.sessions().map(said)).toEqual([['And now?', '> Sure.'], ['What is it doing?', '> Sure.']]);
        expect(second.store.current()?.voiceSessionFile).toBe(omp.created[1]);
        await second.stopVoice();
    });

    it('starts over, and says so in the transcript, when omp cannot load the saved session', async () => {
        const worker = new FakeWorker();
        const state = memento();
        const first = openWindow(worker, state);
        await first.say('What is it doing?');
        await first.stopVoice();

        omp.failSwitch = true;
        const second = openWindow(worker, state);
        await second.say('And now?');

        expect(omp.created).toHaveLength(2);
        expect(omp.prompts[1]).toContain('<task-history');
        const session = second.store.current();
        expect(session?.voiceSessionFile).toBe(omp.created[1]);
        expect(said(session)).toEqual([
            'What is it doing?',
            '> Sure.',
            'And now?',
            'The earlier conversation could not be restored; the voice agent starts over from here.',
            '> Sure.',
        ]);
        await second.stopVoice();
    });

    it('keeps a conversation begun before the tab had a session file once it has one, but not a tab id from another window', async () => {
        const worker = new FakeWorker();
        worker.task = { tabId: 'tab-1', name: 'Fix average', backend: 'omp' };
        const state = memento();
        const window = openWindow(worker, state);
        await window.say('Start on average');
        await window.stopVoice();

        worker.task = { ...worker.task, sessionFile: '/w/a.jsonl' };
        await window.say('How is it going?');
        expect(omp.switched).toEqual([omp.created[0]]);
        expect(window.store.current()?.taskKey).toBe('/w/a.jsonl');
        expect(said(window.store.current())).toEqual(['Start on average', '> Sure.', 'How is it going?', '> Sure.']);
        await window.stopVoice();

        // Tab ids restart with the extension host: a saved `tab:tab-1` is some other task.
        const stale = path.join(omp.dir, 'stale.jsonl');
        writeFileSync(stale, '');
        const other = memento();
        await other.update('voiceAgent.transcripts', [
            { id: 'old', taskKey: 'tab:tab-1', title: 'Other', startedAt: 1, updatedAt: 1, entries: [], voiceSessionFile: stale },
        ]);
        worker.task = { tabId: 'tab-1', name: 'New tab', backend: 'omp' };
        const next = openWindow(worker, other);
        await next.say('Hello');
        expect(omp.switched).toEqual([omp.created[0]]);
        expect(next.store.current()?.id).not.toBe('old');
        await next.stopVoice();
    });

    it('deletes voice session files no conversation names any more', async () => {
        const worker = new FakeWorker();
        const window = openWindow(worker, memento());
        await window.say('What is it doing?');
        await window.stopVoice();
        const unused = path.join(omp.dir, 'startup.jsonl');
        writeFileSync(unused, '');

        await window.store.pruneContexts(omp.dir);
        expect(existsSync(omp.created[0])).toBe(true);
        expect(existsSync(unused)).toBe(false);
    });
});

describe('VoiceAgent: a turn that cannot run', () => {
    it('ends the reply with the error instead of leaving it pending when the agent fails to start', async () => {
        omp.failStart = 'Pi RPC process exited (code=1). Error: Model "antigravity/gemini-3.8-flash" not found.';
        const window = openWindow(new FakeWorker(), memento());
        await window.say('Hello');
        expect(window.store.current()?.entries.at(-1)).toMatchObject({
            kind: 'assistant',
            done: true,
            error: expect.stringContaining('Model "antigravity/gemini-3.8-flash" not found'),
        });
        await window.stopVoice();
    });
});
