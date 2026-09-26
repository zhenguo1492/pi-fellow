import { PiRpcBridge } from '../pi/piRpcBridge';
import type { RpcHostToolDefinition } from '../pi/rpcTypes';
import type { VoiceCallUsage, VoiceUsageTotals } from '../shared/voiceViewProtocol';

export interface HostToolCall {
    /** Correlates `host_tool_result`/`host_tool_cancel`; not the model's toolCallId. */
    id: string;
    toolName: string;
    arguments: Record<string, unknown>;
}

export interface VoiceTurnHandlers {
    onText(delta: string): void;
    onToolCall(call: HostToolCall): void;
    onToolCancel(callId: string): void;
    /** One of the voice agent's own read-only tools started; `description` is omp's intent line or name + target. */
    onBuiltinTool(description: string, call: { toolName: string; args: Record<string, unknown> }): void;
    /** One LLM call of the turn finished; reported even after the turn was cut off, since its tokens were spent. */
    onUsage(usage: VoiceCallUsage): void;
}

export interface VoiceLlmOptions {
    cwd: string;
    /** Voice contexts are session files here, one per worker task (design §2.3, §5.12). */
    sessionDir: string;
    systemPrompt: string;
    /** `provider/id`; omp's default model when omitted. */
    model?: string;
    thinking: string;
    tools: RpcHostToolDefinition[];
}

/** extension_ui_request methods that block the run until answered. */
const BLOCKING_UI_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

/** omp built-ins the voice agent gets: read-only lookups (design §5.4, §7.4). Changes go to the worker. */
const BUILTIN_TOOLS: Record<string, true> = { read: true, grep: true, glob: true };

interface RunningTurn {
    promptId: string;
    signal: AbortSignal;
    handlers: VoiceTurnHandlers;
    finish(error?: string): void;
}

/** The omp RPC frame fields VoiceLlm reads (omp docs rpc.md). */
interface OmpFrame {
    type: string;
    id?: unknown;
    success?: unknown;
    error?: unknown;
    assistantMessageEvent?: { type?: string; delta?: unknown };
    toolName?: unknown;
    arguments?: unknown;
    targetId?: unknown;
    isTerminal?: unknown;
    messages?: unknown;
    method?: unknown;
    intent?: unknown;
    args?: unknown;
    message?: { role?: unknown; usage?: OmpUsage };
}

/** `usage` of an assistant message in omp's `message_end` frame. */
interface OmpUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
}

/**
 * The voice agent's LLM: one hidden omp RPC process (design §5.4). Always omp, because host tools
 * are an omp RPC extension. One prompt at a time; the caller serializes turns.
 */
export class VoiceLlm {
    private _turn: RunningTurn | undefined;
    private _promptSeq = 0;
    private _exited = false;
    private _stopping = false;

    private constructor(
        private readonly _bridge: PiRpcBridge,
        readonly model: string,
        private readonly _onExit: (error: Error | null) => void,
    ) {
        // Outbound omp frames; each case below reads only the fields it checks.
        _bridge.on((event) => this._onEvent(event as unknown as OmpFrame));
        _bridge.onExit((error) => {
            this._exited = true;
            this._turn?.finish(error?.message ?? 'The voice agent process exited');
            if (!this._stopping) {
                this._onExit(error);
            }
        });
    }

    static async start(options: VoiceLlmOptions, onExit: (error: Error | null) => void): Promise<VoiceLlm> {
        const bridge = new PiRpcBridge();
        const tools = Object.keys(BUILTIN_TOOLS).join(',');
        const args = ['--tools', tools, '--no-skills', '--no-rules', '--no-extensions', '--no-lsp', '--no-title'];
        // Its tools only read or go through HostToolRouter, which enforces its own rules. A project or
        // user approvalMode of always-ask would otherwise gate host tools behind a dialog nobody can answer.
        args.push('--approval-mode', 'yolo');
        args.push('--thinking', options.thinking, '--session-dir', options.sessionDir);
        args.push('--system-prompt', options.systemPrompt);
        if (options.model) {
            args.push('--model', options.model);
        }
        await bridge.start(options.cwd, args, 'omp');
        try {
            if (bridge.backend !== 'omp') {
                throw new Error('The voice agent needs omp (host tools are an omp RPC feature); only pi was found.');
            }
            await bridge.setHostTools(options.tools);
            const state = await bridge.getState();
            const model = state.model ? `${state.model.provider}/${state.model.id}` : 'unknown';
            return new VoiceLlm(bridge, model, onExit);
        } catch (err) {
            await bridge.stop();
            throw err;
        }
    }

    get alive(): boolean {
        return !this._exited;
    }

    /**
     * Resolves when omp settles the run (`agent_end` with `isTerminal !== false`), with its error if any.
     * Aborting `signal` aborts the run; text arriving after that is dropped.
     */
    prompt(message: string, signal: AbortSignal, handlers: VoiceTurnHandlers): Promise<{ error?: string }> {
        if (this._turn) {
            throw new Error('The voice agent is already answering');
        }
        if (this._exited) {
            return Promise.resolve({ error: 'The voice agent process exited' });
        }
        const promptId = `voice_prompt_${++this._promptSeq}`;
        const { promise, resolve } = Promise.withResolvers<{ error?: string }>();
        const onAbort = () => this._write({ type: 'abort' });
        this._turn = {
            promptId,
            signal,
            handlers,
            finish: (error) => {
                signal.removeEventListener('abort', onAbort);
                this._turn = undefined;
                resolve({ error });
            },
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // Written raw (not bridge.prompt) so a failed `prompt` response reaches _onEvent.
        this._write({ id: promptId, type: 'prompt', message });
        return promise;
    }

    sendToolResult(callId: string, text: string, isError: boolean): void {
        this._write({
            type: 'host_tool_result',
            id: callId,
            result: { content: [{ type: 'text', text }] },
            ...(isError ? { isError: true } : {}),
        });
    }

    /** Starts an empty voice context and returns its session file. Only while idle. */
    async newSession(): Promise<string> {
        await this._bridge.newSession();
        const { sessionFile } = await this._bridge.getState();
        if (!sessionFile) {
            throw new Error('omp did not report a session file for the new voice context');
        }
        return sessionFile;
    }

    /** Only while idle. Throws when omp cannot load it. */
    async switchSession(sessionFile: string): Promise<void> {
        const { cancelled } = await this._bridge.switchSession(sessionFile);
        if (cancelled) {
            throw new Error(`omp did not switch to ${sessionFile}`);
        }
    }

    /** Token totals and context window use of the loaded voice context. */
    async usage(): Promise<VoiceUsageTotals> {
        const stats = await this._bridge.getSessionStats();
        const context = stats.contextUsage;
        return {
            input: stats.tokens.input,
            output: stats.tokens.output,
            cacheRead: stats.tokens.cacheRead,
            cacheWrite: stats.tokens.cacheWrite,
            cost: stats.cost,
            ...(context ? { context: { tokens: context.tokens ?? null, contextWindow: context.contextWindow, percent: context.percent ?? null } } : {}),
        };
    }

    async stop(): Promise<void> {
        this._stopping = true;
        await this._bridge.stop();
    }

    private _write(frame: object): void {
        if (!this._exited) {
            this._bridge.writeLine(frame);
        }
    }

    private _onEvent(event: OmpFrame): void {
        const turn = this._turn;
        switch (event.type) {
            case 'message_update':
                if (turn && !turn.signal.aborted && event.assistantMessageEvent?.type === 'text_delta') {
                    turn.handlers.onText(String(event.assistantMessageEvent.delta ?? ''));
                }
                return;
            case 'message_end': {
                const usage = event.message?.role === 'assistant' ? event.message.usage : undefined;
                if (turn && usage) {
                    turn.handlers.onUsage({
                        at: Date.now(),
                        input: usage.input ?? 0,
                        output: usage.output ?? 0,
                        cacheRead: usage.cacheRead ?? 0,
                        cacheWrite: usage.cacheWrite ?? 0,
                        cost: usage.cost?.total ?? 0,
                    });
                }
                return;
            }
            case 'tool_execution_start':
                // Host tools also report here; they surface through host_tool_call instead.
                if (turn && !turn.signal.aborted && typeof event.toolName === 'string' && BUILTIN_TOOLS[event.toolName]) {
                    const args = (event.args ?? {}) as Record<string, unknown>;
                    turn.handlers.onBuiltinTool(
                        typeof event.intent === 'string'
                            ? event.intent
                            : `${event.toolName} ${String(args.path ?? args.pattern ?? '')}`.trim(),
                        { toolName: event.toolName, args },
                    );
                }
                return;
            case 'host_tool_call':
                if (turn) {
                    turn.handlers.onToolCall({
                        id: String(event.id),
                        toolName: String(event.toolName),
                        arguments: (event.arguments ?? {}) as Record<string, unknown>,
                    });
                } else {
                    this.sendToolResult(String(event.id), 'No voice turn is active.', true);
                }
                return;
            case 'host_tool_cancel':
                turn?.handlers.onToolCancel(String(event.targetId));
                return;
            case 'response':
                if (turn && event.id === turn.promptId && event.success === false) {
                    turn.finish(String(event.error ?? 'prompt failed'));
                }
                return;
            case 'agent_end': {
                if (!turn || event.isTerminal === false) {
                    return;
                }
                const messages = event.messages as Array<{ stopReason?: string; errorMessage?: string }> | undefined;
                const last = messages?.[messages.length - 1];
                turn.finish(last?.stopReason === 'error' ? (last.errorMessage ?? 'unknown error') : undefined);
                return;
            }
            case 'extension_ui_request':
                // No extensions are loaded; never leave a blocking dialog hanging.
                if (typeof event.method === 'string' && BLOCKING_UI_METHODS[event.method]) {
                    this._write({ type: 'extension_ui_response', id: event.id, cancelled: true });
                }
                return;
        }
    }
}
