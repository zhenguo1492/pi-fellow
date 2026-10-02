import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceAgent } from '../../../voiceAgent/voiceAgent';
import type { WorkerController, WorkerTask } from '../../../voiceAgent/workerController';

/** The voice process, faked: what it runs, and what was asked of it in order. */
const omp = vi.hoisted(() => ({
    model: '',
    /** Started with `--model`. */
    startedWith: [] as Array<string | undefined>,
    calls: [] as string[],
    /** The model a session file was last on: switching to it brings it back, as omp and pi do. */
    sessionModels: new Map<string, string>(),
    sessionFiles: 0,
    /** Set: the next prompt waits until the function it is given is called. */
    hold: undefined as undefined | ((release: () => void) => void),
    /** A held prompt has not ended. */
    replying: false,
    unknownModels: new Set<string>(),
}));

vi.mock('../../../voiceAgent/voiceLlm', () => {
    const llm = {
        get model() {
            return omp.model;
        },
        async setModel(model: string) {
            if (omp.unknownModels.has(model)) {
                throw new Error(`Model not found: ${model}`);
            }
            omp.calls.push(`set_model ${model}${omp.replying ? ' during a reply' : ''}`);
            omp.model = model;
        },
        async newSession() {
            omp.sessionFiles++;
            return `/voice/${omp.sessionFiles}.jsonl`;
        },
        async switchSession(file: string) {
            omp.calls.push(`switch ${file}`);
            omp.model = omp.sessionModels.get(file) ?? omp.model;
        },
        prompt(_message: string, _signal: AbortSignal, handlers: { onText(delta: string): void }) {
            omp.calls.push(`prompt on ${omp.model}`);
            handlers.onText('Sure.');
            const hold = omp.hold;
            omp.hold = undefined;
            if (!hold) {
                return Promise.resolve({});
            }
            const { promise, resolve } = Promise.withResolvers<{ error?: string }>();
            omp.replying = true;
            hold(() => {
                omp.replying = false;
                resolve({});
            });
            return promise;
        },
        sendToolResult() {},
        async usage() {
            return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        },
        async stop() {},
    };
    return {
        VoiceLlm: {
            start: async (options: { model?: string }) => {
                omp.startedWith.push(options.model);
                omp.model = options.model ?? 'default/model';
                return llm;
            },
        },
    };
});

vi.mock('../../../voiceAgent/research', () => ({
    ResearchRunner: class {
        stopAll() {}
    },
}));

let agent: VoiceAgent | undefined;
let changes: number;
/** The chat tab the voice agent talks about; its `model` is the worker's. */
let task: WorkerTask;

/** Only what a turn asks of the worker. */
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
    };
    // The rest is never called by these turns.
    return worker as WorkerController;
}

function startAgent(model: string): VoiceAgent {
    const started = new VoiceAgent({
        worker: fakeWorker(),
        cwd: '/w',
        sessionDir: '/voice',
        model,
        thinking: 'off',
        confirmBeforeDispatch: () => true,
        arbiter: () => ({ narration: 'off', minProactiveGapMs: 8000, narrationIntervalMs: 30000 }),
        onChange: () => changes++,
        log: () => {},
    });
    agent = started;
    return started;
}

/** What the process was asked, leaving out loading voice contexts. */
const turnCalls = () => omp.calls.filter((call) => !call.startsWith('switch'));

beforeEach(() => {
    omp.model = '';
    omp.startedWith = [];
    omp.calls = [];
    omp.sessionModels.clear();
    omp.sessionFiles = 0;
    omp.hold = undefined;
    omp.replying = false;
    omp.unknownModels.clear();
    changes = 0;
    task = { tabId: 'tab-1', name: 'Fix average', backend: 'omp', sessionFile: '/w/a.jsonl', model: 'chat/worker-model' };
});

afterEach(async () => {
    await agent?.stop();
    agent = undefined;
});

describe('VoiceAgent: its own model', () => {
    it('starts on the chat tab’s model when none is chosen, and on the chosen one otherwise', async () => {
        await startAgent('').say('hi', 'text');
        await agent!.stop();
        await startAgent('voice/fast').say('hi', 'text');

        expect(omp.startedWith).toEqual(['chat/worker-model', 'voice/fast']);
    });

    it('switches a running process at once while idle, without a restart; the chat tab keeps its model', async () => {
        const voice = startAgent('');
        await voice.say('hi', 'text');
        changes = 0;

        await voice.setModel('voice/fast');
        expect(voice.model).toBe('voice/fast');
        expect(changes).toBeGreaterThan(0);

        await voice.say('and now?', 'text');
        expect(omp.startedWith).toHaveLength(1);
        expect(turnCalls()).toEqual(['prompt on chat/worker-model', 'set_model voice/fast', 'prompt on voice/fast']);
        expect(task.model).toBe('chat/worker-model');
    });

    it('lets the reply in progress finish on its model, then switches before the next one', async () => {
        const voice = startAgent('');
        let release: (() => void) | undefined;
        omp.hold = (r) => (release = r);
        const first = voice.say('explain this', 'text');
        await vi.waitFor(() => expect(release).toBeDefined());

        const switched = voice.setModel('voice/fast');
        release!();
        await first;
        await switched;
        await voice.say('next', 'text');
        expect(turnCalls()).toEqual(['prompt on chat/worker-model', 'set_model voice/fast', 'prompt on voice/fast']);
    });

    it('keeps the chosen model when a voice context brings back the one it was last on', async () => {
        const voice = startAgent('voice/fast');
        await voice.say('hi', 'text');
        // The first task's voice context was last on another model.
        omp.sessionModels.set('/voice/1.jsonl', 'voice/old');
        task = { ...task, tabId: 'tab-2', sessionFile: '/w/b.jsonl' };
        await voice.say('and this one?', 'text');
        task = { ...task, tabId: 'tab-1', sessionFile: '/w/a.jsonl' };
        omp.calls = [];

        await voice.say('back again', 'text');
        expect(omp.calls).toEqual(['switch /voice/1.jsonl', 'set_model voice/fast', 'prompt on voice/fast']);
    });

    it('an empty choice (Settings: Same as the chat tab’s model) takes the chat tab’s model as it is then', async () => {
        const voice = startAgent('voice/fast');
        await voice.say('hi', 'text');
        task.model = 'chat/newer';

        await voice.setModel('');
        expect(voice.model).toBe('chat/newer');
    });

    it('rejects a model the agent does not have, and stays on the one it runs', async () => {
        const voice = startAgent('');
        await voice.say('hi', 'text');
        omp.unknownModels.add('voice/missing');

        await expect(voice.setModel('voice/missing')).rejects.toThrow('could not switch to voice/missing: Model not found');
        await voice.say('still there?', 'text');
        expect(omp.calls.at(-1)).toBe('prompt on chat/worker-model');
    });
});
