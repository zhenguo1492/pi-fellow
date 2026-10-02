/**
 * The voice model, scripted: the integration bundle swaps it in for src/voiceAgent/voiceLlm.ts (see
 * esbuild.js), so VoiceAgent, its host tools and its turn messages run for real without omp or pi.
 * Session files are real files in the session dir, so resuming works as with omp.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HostToolCall, VoiceLlmOptions, VoiceTurnHandlers } from '../../../voiceAgent/voiceLlm';

export type { VoiceSkill } from '../../../voiceAgent/voiceLlm';

/** One scripted reply: speak text (markers included) and call host tools, awaiting their results. */
export interface ScriptedTurn {
    say(text: string): void;
    call(toolName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export const fakeLlm = {
    /** Every turn message the agent sent, in order. */
    prompts: [] as string[],
    /** The replies still to come, one per prompt; an empty queue answers "Sure." */
    script: [] as ((turn: ScriptedTurn) => Promise<void>)[],
    reset(): void {
        this.prompts = [];
        this.script = [];
    },
};

export class VoiceLlm {
    readonly model = 'test/voice';
    readonly alive = true;
    private readonly _pending = new Map<string, (result: { text: string; isError: boolean }) => void>();
    private _nextCall = 0;
    private _sessions = 0;

    private constructor(private readonly _sessionDir: string) {}

    static async start(options: VoiceLlmOptions): Promise<VoiceLlm> {
        await fs.promises.mkdir(options.sessionDir, { recursive: true });
        return new VoiceLlm(options.sessionDir);
    }

    async prompt(message: string, _signal: AbortSignal, handlers: VoiceTurnHandlers): Promise<{ error?: string }> {
        fakeLlm.prompts.push(message);
        const reply = fakeLlm.script.shift() ?? (async (turn: ScriptedTurn) => turn.say('Sure.'));
        await reply({
            say: (text) => handlers.onText(text),
            call: (toolName, args) => {
                const n = ++this._nextCall;
                const call: HostToolCall = { id: `call-${n}`, toolCallId: `tool-${n}`, toolName, arguments: args };
                const { promise, resolve } = Promise.withResolvers<{ text: string; isError: boolean }>();
                this._pending.set(call.id, resolve);
                // As a model streams it: the call begins, then arrives written.
                handlers.onToolStart({ id: call.toolCallId, toolName });
                handlers.onToolCall(call);
                return promise;
            },
        });
        return {};
    }

    sendToolResult(callId: string, text: string, isError: boolean): void {
        this._pending.get(callId)?.({ text, isError });
        this._pending.delete(callId);
    }

    async newSession(): Promise<string> {
        const file = path.join(this._sessionDir, `voice-${process.pid}-${Date.now()}-${++this._sessions}.jsonl`);
        await fs.promises.writeFile(file, '');
        return file;
    }

    async switchSession(sessionFile: string): Promise<void> {
        await fs.promises.access(sessionFile);
    }

    async usage() {
        return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    }

    async stop(): Promise<void> {}
}
