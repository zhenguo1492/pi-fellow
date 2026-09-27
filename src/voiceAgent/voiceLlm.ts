import type { AgentBackend } from '../pi/agentBackend';
import { resolveCliTarget } from '../pi/piCliPaths';
import { PiRpcBridge } from '../pi/piRpcBridge';
import type { RpcHostToolDefinition } from '../pi/rpcTypes';
import type { ImageContent } from '../shared/piTypes';
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
    /** One of the voice agent's own lookup tools started; `description` is omp's intent line or name + target. */
    onBuiltinTool(description: string, call: { toolName: string; args: Record<string, unknown> }): void;
    /** One LLM call of the turn finished; reported even after the turn was cut off, since its tokens were spent. */
    onUsage(usage: VoiceCallUsage): void;
}

export interface VoiceLlmOptions {
    cwd: string;
    /** Voice contexts are session files here, one per worker task (design §2.3, §5.12). */
    sessionDir: string;
    systemPrompt: string;
    /** `provider/id`; the agent's default model when omitted. */
    model?: string;
    thinking: string;
    tools: RpcHostToolDefinition[];
}

/** extension_ui_request methods that block the run until answered. */
const BLOCKING_UI_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

/**
 * Built-ins the voice agent gets: read-only lookups in the project and on the web (design §5.4, §7.4).
 * Changes go to the worker. pi's glob is `find`. pi has no built-in web_search: a user's pi extension
 * may register one. pi skips allowlisted names nothing registers, so without one it just goes unlisted.
 */
const BUILTIN_TOOLS: Record<AgentBackend, string[]> = { omp: ['read', 'grep', 'glob', 'web_search'], pi: ['read', 'grep', 'find', 'web_search'] };

/** The voice system prompt names omp's tools. */
const PI_TOOL_NOTE = 'Here the glob tool is called find: it finds files by glob pattern.';

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
 * The voice agent's LLM: one hidden omp or pi RPC process (design §5.4), with the host tools
 * (native on omp, the bundled Pi extension on pi). One prompt at a time; the caller serializes turns.
 */
export class VoiceLlm {
    private _turn: RunningTurn | undefined;
    private _promptSeq = 0;
    private _exited = false;
    private _stopping = false;
    /** pi: the error of the run's last `agent_end`, reported once `agent_settled` arrives. */
    private _endError: string | undefined;

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
        const { backend } = resolveCliTarget();
        const builtins = BUILTIN_TOOLS[backend];
        const args: string[] = [];
        if (backend === 'omp') {
            args.push('--tools', builtins.join(','), '--no-skills', '--no-rules', '--no-extensions', '--no-lsp', '--no-title');
            // Its tools only read or go through HostToolRouter, which enforces its own rules. A project or
            // user approvalMode of always-ask would otherwise gate host tools behind a dialog nobody can answer.
            args.push('--approval-mode', 'yolo');
        } else {
            // pi's allowlist also filters extension tools, so it names the host tools too, and keeps the
            // user's extensions' tools out. The extensions still load: model providers can be pi packages
            // (e.g. pi-provider-antigravity), and without them `--model` fails with "Model not found".
            const tools = [...builtins, ...options.tools.map((tool) => tool.name)];
            // --no-context-files, like omp's --no-rules: AGENTS.md / CLAUDE.md instruct the coding agent
            // (e.g. a user's "reply with [英文没问题]" rule), not the voice agent, and would be read aloud.
            args.push('--tools', tools.join(','), '--no-skills', '--no-prompt-templates', '--no-context-files');
            args.push('--append-system-prompt', PI_TOOL_NOTE);
        }
        args.push('--thinking', options.thinking, '--session-dir', options.sessionDir);
        args.push('--system-prompt', options.systemPrompt);
        if (options.model) {
            args.push('--model', options.model);
        }
        await bridge.start(options.cwd, args, backend, { hostTools: true });
        try {
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
     * Resolves when the run settles (omp: `agent_end` with `isTerminal !== false`; pi: `agent_settled`),
     * with its error if any. Aborting `signal` aborts the run; text arriving after that is dropped.
     * `images` go with the message as image parts; a model without vision gets a placeholder from omp/pi.
     */
    prompt(message: string, signal: AbortSignal, handlers: VoiceTurnHandlers, images?: ImageContent[]): Promise<{ error?: string }> {
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
        this._write({ id: promptId, type: 'prompt', message, ...(images?.length ? { images } : {}) });
        return promise;
    }

    sendToolResult(callId: string, text: string, isError: boolean): void {
        if (!this._exited) {
            this._bridge.sendHostToolResult(callId, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
        }
    }

    /** Starts an empty voice context and returns its session file. Only while idle. */
    async newSession(): Promise<string> {
        await this._bridge.newSession();
        const { sessionFile } = await this._bridge.getState();
        if (!sessionFile) {
            throw new Error('The agent did not report a session file for the new voice context');
        }
        return sessionFile;
    }

    /** Only while idle. Throws when the agent cannot load it. */
    async switchSession(sessionFile: string): Promise<void> {
        const { cancelled } = await this._bridge.switchSession(sessionFile);
        if (cancelled) {
            throw new Error(`The agent did not switch to ${sessionFile}`);
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
                if (turn && !turn.signal.aborted && typeof event.toolName === 'string' && BUILTIN_TOOLS[this._bridge.backend].includes(event.toolName)) {
                    const args = (event.args ?? {}) as Record<string, unknown>;
                    turn.handlers.onBuiltinTool(
                        typeof event.intent === 'string'
                            ? event.intent
                            : `${event.toolName} ${String(args.path ?? args.pattern ?? args.query ?? '')}`.trim(),
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
                const error = last?.stopReason === 'error' ? (last.errorMessage ?? 'unknown error') : undefined;
                // pi may go on after agent_end (retry, compaction recovery); agent_settled is its last word.
                if (this._bridge.backend === 'pi') {
                    this._endError = error;
                } else {
                    turn.finish(error);
                }
                return;
            }
            case 'agent_settled':
                if (turn && this._bridge.backend === 'pi') {
                    const error = this._endError;
                    this._endError = undefined;
                    turn.finish(error);
                }
                return;
            case 'extension_ui_request':
                // Other extensions are not loaded (the bridge keeps pi's host-tools frames); never leave a blocking dialog hanging.
                if (typeof event.method === 'string' && BLOCKING_UI_METHODS[event.method]) {
                    this._write({ type: 'extension_ui_response', id: event.id, cancelled: true });
                }
                return;
        }
    }
}
