import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceTurnHandlers } from '../../../voiceAgent/voiceLlm';

/** The RPC bridge VoiceLlm talks to: the test plays omp's frames into it and reads what was written. */
interface FakeBridge {
    backend: 'omp';
    written: Array<Record<string, unknown>>;
    results: Array<{ id: string; content: Array<{ text: string }>; isError?: boolean }>;
    stopped: boolean;
    emit(frame: Record<string, unknown>): void;
}

const fake = vi.hoisted(() => ({ bridge: undefined as FakeBridge | undefined }));

vi.mock('../../../pi/piCliPaths', () => ({ resolveCliTarget: () => ({ backend: 'omp' }) }));
vi.mock('../../../pi/piRpcBridge', () => ({
    PiRpcBridge: class {
        backend = 'omp';
        written: Array<Record<string, unknown>> = [];
        results: FakeBridge['results'] = [];
        stopped = false;
        private _listener: ((frame: Record<string, unknown>) => void) | undefined;
        async start() {
            fake.bridge = this as unknown as FakeBridge;
        }
        async setHostTools() {}
        async getState() {
            return { model: { provider: 'test', id: 'model' } };
        }
        on(listener: (frame: Record<string, unknown>) => void) {
            this._listener = listener;
            return () => {};
        }
        onExit() {
            return () => {};
        }
        emit(frame: Record<string, unknown>) {
            this._listener?.(frame);
        }
        writeLine(frame: Record<string, unknown>) {
            this.written.push(frame);
        }
        sendHostToolResult(id: string, result: { content: Array<{ text: string }>; isError?: boolean }) {
            this.results.push({ id, ...result });
        }
        async stop() {
            this.stopped = true;
        }
    },
}));

import { VoiceLlm } from '../../../voiceAgent/voiceLlm';

/** Everything the turn's handlers were told, in order. */
let heard: string[];
let exits: string[];

function handlers(): VoiceTurnHandlers {
    return {
        onText: (delta) => heard.push(`text ${delta}`),
        onToolStart: (call) => heard.push(`start ${call.id} ${call.toolName}`),
        onToolDelta: (call) => heard.push(`delta ${call.id} ${call.json}`),
        onToolDropped: (id) => heard.push(`dropped ${id}`),
        onToolCall: (call) => heard.push(`call ${call.toolCallId}`),
        onToolCancel: () => {},
        onBuiltinTool: () => {},
        onBuiltinToolEnd: () => {},
        onUsage: () => {},
    };
}

async function start(): Promise<{ llm: VoiceLlm; bridge: FakeBridge }> {
    const llm = await VoiceLlm.start({ cwd: '/w', sessionDir: '/s', systemPrompt: '', thinking: 'off', tools: [], skills: [] }, (error) => exits.push(error?.message ?? 'exit'));
    return { llm, bridge: fake.bridge! };
}

/** omp's frames for a tool call the model writes at content index `index`: its start, then its arguments in pieces. */
function writeCall(bridge: FakeBridge, index: number, id: string, name: string, pieces: string[]): void {
    const content = [];
    content[index] = { type: 'toolCall', id, name, arguments: {} };
    bridge.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: index }, message: { content } });
    for (const delta of pieces) {
        bridge.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: index, delta }, message: { content } });
    }
}

beforeEach(() => {
    heard = [];
    exits = [];
});

afterEach(() => {
    vi.useRealTimers();
});

describe('VoiceLlm: tool calls as the model writes them', () => {
    it('passes on the arguments streamed so far of host tool calls, not of its own lookups', async () => {
        const { llm, bridge } = await start();
        void llm.prompt('hi', new AbortController().signal, handlers());
        writeCall(bridge, 0, 't0', 'read', ['{"path":', '"a.ts"}']);
        writeCall(bridge, 1, 't1', 'edit_file', ['{"path":"a', '.ts","newText":"x']);
        expect(heard).toEqual(['start t1 edit_file', 'delta t1 {"path":"a', 'delta t1 {"path":"a.ts","newText":"x']);
    });

    it('drops the calls of a message cut off at the token limit, and answers one that arrives anyway with an error instead of running it', async () => {
        const { llm, bridge } = await start();
        void llm.prompt('hi', new AbortController().signal, handlers());
        writeCall(bridge, 0, 't1', 'show_me', ['{"markdown":"# Lo']);
        bridge.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'length' } });
        expect(heard.at(-1)).toBe('dropped t1');

        bridge.emit({ type: 'host_tool_call', id: 'h1', toolCallId: 't1', toolName: 'show_me', arguments: { markdown: '# Lo' } });
        expect(heard).not.toContain('call t1');
        expect(bridge.results).toEqual([{ id: 'h1', content: [{ type: 'text', text: expect.stringMatching(/^Not run: your message was cut off at the output token limit/) }], isError: true }]);

        // A message that ended normally runs its calls.
        writeCall(bridge, 0, 't2', 'show_me', ['{"markdown":"# Login"}']);
        bridge.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
        bridge.emit({ type: 'host_tool_call', id: 'h2', toolCallId: 't2', toolName: 'show_me', arguments: { markdown: '# Login' } });
        expect(heard.at(-1)).toBe('call t2');
    });
});

describe('VoiceLlm: steering and ending', () => {
    it('steers a message into the running prompt, and refuses once the run has ended', async () => {
        const { llm, bridge } = await start();
        const reply = llm.prompt('hi', new AbortController().signal, handlers());
        expect(llm.steer('<user>also the tests</user>')).toBe(true);
        expect(bridge.written.at(-1)).toEqual({ type: 'steer', message: '<user>also the tests</user>' });
        bridge.emit({ type: 'agent_end', messages: [{ stopReason: 'stop' }] });
        expect(await reply).toEqual({ error: undefined });
        expect(llm.steer('late')).toBe(false);
    });

    it('ends an aborted prompt that never settles with an error, and gives the process up', async () => {
        vi.useFakeTimers();
        const { llm, bridge } = await start();
        const ctl = new AbortController();
        const reply = llm.prompt('hi', ctl.signal, handlers());
        ctl.abort();
        expect(bridge.written.at(-1)).toEqual({ type: 'abort' });
        await vi.advanceTimersByTimeAsync(5000);
        expect(await reply).toEqual({ error: expect.stringMatching(/did not stop when interrupted/) });
        expect([exits, bridge.stopped, llm.alive]).toEqual([['it did not stop when interrupted'], true, false]);
        // The next turn learns it at once instead of waiting on a dead process.
        expect(await llm.prompt('again', new AbortController().signal, handlers())).toEqual({ error: 'The voice agent process exited' });
    });

    it('answers a second prompt while one runs with an error, not an exception', async () => {
        const { llm } = await start();
        void llm.prompt('hi', new AbortController().signal, handlers());
        expect(await llm.prompt('again', new AbortController().signal, handlers())).toEqual({ error: 'The voice agent is already answering' });
    });
});
