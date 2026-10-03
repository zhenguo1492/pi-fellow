import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorHands } from '../../../voiceAgent/hostTools';
import { VoiceAgent, type VoiceTurnListener, type VoiceTurnResult } from '../../../voiceAgent/voiceAgent';
import type { VoiceTurnHandlers } from '../../../voiceAgent/voiceLlm';
import type { WorkerController, WorkerTask } from '../../../voiceAgent/workerController';

/** The voice process, faked: each prompt runs `script` against the turn's handlers until it returns. */
const omp = vi.hoisted(() => ({
    script: undefined as undefined | ((handlers: VoiceTurnHandlers) => Promise<void>),
    steered: [] as string[],
    /** A prompt is running: steering reaches it. */
    running: false,
    results: [] as Array<{ id: string; text: string; isError: boolean }>,
}));

vi.mock('../../../voiceAgent/voiceLlm', () => {
    const llm = {
        model: 'test/model',
        async newSession() {
            return '/voice/1.jsonl';
        },
        async switchSession() {},
        async prompt(_message: string, _signal: AbortSignal, handlers: VoiceTurnHandlers) {
            omp.running = true;
            try {
                await omp.script?.(handlers);
            } finally {
                omp.running = false;
            }
            return {};
        },
        steer(message: string) {
            if (!omp.running) {
                return false;
            }
            omp.steered.push(message);
            return true;
        },
        sendToolResult(id: string, text: string, isError: boolean) {
            omp.results.push({ id, text, isError });
        },
        async usage() {
            return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        },
        async stop() {},
    };
    return { VoiceLlm: { start: async () => llm } };
});

vi.mock('../../../voiceAgent/research', () => ({
    ResearchRunner: class {
        stopAll() {}
    },
}));

let agent: VoiceAgent | undefined;
let logged: string[];
/** How each edit preview ended. */
let previews: string[];
const task: WorkerTask = { tabId: 'tab-1', name: 'Fix average', backend: 'omp', sessionFile: '/w/a.jsonl', model: 'chat/model' };

function fakeWorker(): WorkerController {
    const none = () => ({ dispose() {} });
    const worker: Partial<WorkerController> = {
        activeTask: () => task,
        onActiveTaskChanged: none,
        onSessionResumed: none,
        onTabEvent: none,
        onRequestsChanged: none,
        status: () => ({ phase: 'idle', queued: 0 }),
        pendingRequests: () => [],
        recentTurns: () => [],
        permissionLevel: () => 'auto',
        lockedPaths: () => [],
    };
    return worker as WorkerController;
}

function startAgent(): VoiceAgent {
    const hands: Partial<EditorHands> = {
        finishTyping: () => {},
        takeLateResults: () => [],
        previewEdit: () => ({
            update: () => {},
            commit: async () => {
                previews.push('committed');
                return 'typed';
            },
            drop: () => previews.push('dropped'),
        }),
        editFile: async () => 'edited',
    };
    agent = new VoiceAgent({
        worker: fakeWorker(),
        cwd: '/w',
        sessionDir: '/voice',
        model: '',
        thinking: 'off',
        confirmBeforeDispatch: () => true,
        arbiter: () => ({ narration: 'off', minProactiveGapMs: 8000, narrationIntervalMs: 30000 }),
        hands: hands as EditorHands,
        log: (line) => logged.push(line),
    });
    return agent;
}

/** The edit_file call's arguments as the model writes them, up to `newText`'s first characters. */
const editJson = '{"path":"a.ts","oldText":"1","newText":"4';

beforeEach(() => {
    omp.script = undefined;
    omp.steered = [];
    omp.running = false;
    omp.results = [];
    logged = [];
    previews = [];
});

afterEach(async () => {
    await agent?.stop();
    agent = undefined;
});

describe('VoiceAgent: remarks steered into a running reply', () => {
    it('steers a remark into the user reply that runs, and refuses one when none runs', async () => {
        const voice = startAgent();
        const { promise: gate, resolve: release } = Promise.withResolvers<void>();
        omp.script = async (handlers) => {
            handlers.onText('Renaming it. ');
            await gate;
        };
        const reply = voice.say('rename the parser', 'stt');
        await vi.waitFor(() => expect(omp.running).toBe(true));
        expect(voice.steer('use camel case')).toBe(true);
        expect(omp.steered).toEqual(['<user source="stt" during-reply="true">use camel case</user>']);
        release();
        await reply;
        expect(voice.steer('too late')).toBe(false);
    });
});

describe('VoiceAgent: one way out of a turn', () => {
    it('answers every tool call and ends once, even when a listener throws', async () => {
        const voice = startAgent();
        omp.script = async (handlers) => {
            handlers.onToolStart({ id: 't1', toolName: 'edit_file' });
            handlers.onToolCall({ id: 'h1', toolCallId: 't1', toolName: 'edit_file', arguments: { path: 'a.ts', oldText: '1', newText: '42' } });
            await vi.waitFor(() => expect(omp.results).toHaveLength(1));
        };
        const ends: VoiceTurnResult[] = [];
        const listener: VoiceTurnListener = {
            onToolStart: () => {
                throw new Error('view gone');
            },
            onEnd: (result) => ends.push(result),
        };
        const result = await voice.say('change it', 'text', listener);
        expect(omp.results).toEqual([{ id: 'h1', text: 'edited', isError: false }]);
        expect([ends.length, ends[0] === result, result.error]).toEqual([1, true, undefined]);
        expect(logged.some((line) => line.includes('view gone'))).toBe(true);
    });

    it('undoes the preview of a call the model began but never sent, and lets a sent one adopt its own', async () => {
        const voice = startAgent();
        omp.script = async (handlers) => {
            handlers.onToolDelta({ id: 't1', toolName: 'edit_file', json: editJson });
            handlers.onToolDelta({ id: 't2', toolName: 'edit_file', json: editJson });
            handlers.onToolCall({ id: 'h2', toolCallId: 't2', toolName: 'edit_file', arguments: { path: 'a.ts', oldText: '1', newText: '42' } });
            await vi.waitFor(() => expect(omp.results).toHaveLength(1));
        };
        await voice.say('change it', 'text');
        expect(omp.results).toEqual([{ id: 'h2', text: 'typed', isError: false }]);
        expect(previews.sort()).toEqual(['committed', 'dropped']);
    });

    it('undoes the previews of a reply cut off by the next message', async () => {
        const voice = startAgent();
        const { promise: never } = Promise.withResolvers<void>();
        omp.script = async (handlers) => {
            handlers.onToolDelta({ id: 't1', toolName: 'edit_file', json: editJson });
            await never;
        };
        void voice.say('change it', 'text');
        await vi.waitFor(() => expect(omp.running).toBe(true));
        omp.script = async () => {};
        // The next message cuts the reply off: its call will never come.
        void voice.say('no, the other one', 'text');
        await vi.waitFor(() => expect(previews).toEqual(['dropped']));
    });
});
