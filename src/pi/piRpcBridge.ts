import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentBackend } from './agentBackend';
import { attachJsonlLineReader, serializeJsonLine } from './jsonl';
import { cliCommand, piCliChildEnv, resolvePiCliInvocation } from './piCliPaths';
import { isVscodeOnlySlash } from './slashCommandRouter';
import type {
    PiAgentEvent,
    PiRpcOutbound,
    RpcCommand,
    RpcExtensionUIResponse,
    RpcImageContent,
    RpcResponse,
    RpcSessionState,
    RpcSlashCommand,
} from './rpcTypes';

export type PiRpcBridgeListener = (event: PiRpcOutbound) => void;

interface PendingRequest {
    resolve: (response: RpcResponse) => void;
    reject: (error: Error) => void;
}

/** omp RPC v2: frames over 1 MiB arrive as ordered base64 `rpc_chunk` lines (reassembled ≤ 64 MiB). */
interface RpcChunk {
    type: 'rpc_chunk';
    chunkId: string;
    index: number;
    count: number;
    byteLength: number;
    data: string;
}

interface ChunkAssembly {
    chunkId: string;
    count: number;
    byteLength: number;
    parts: Buffer[];
}

/** omp `get_available_commands` source → the pi command sources the UI understands. */
const OMP_COMMAND_SOURCE: Record<string, RpcSlashCommand['source']> = {
    builtin: 'builtin',
    skill: 'skill',
    extension: 'extension',
    custom: 'prompt',
    file: 'prompt',
};

export class PiRpcBridge {
    private _process: ChildProcessWithoutNullStreams | null = null;
    private _stopReading: (() => void) | null = null;
    private _listeners = new Set<PiRpcBridgeListener>();
    private _pending = new Map<string, PendingRequest>();
    private _requestId = 0;
    private _stderr = '';
    private _exitError: Error | null = null;
    /** omp renamed some RPC commands (commands list, fork → branch). */
    private _backend: AgentBackend = 'pi';
    private _chunkAssembly: ChunkAssembly | undefined;

    get backend(): AgentBackend {
        return this._backend;
    }

    on(listener: PiRpcBridgeListener): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    private _emit(event: PiRpcOutbound): void {
        for (const listener of this._listeners) {
            try {
                listener(event);
            } catch {
                /* listener error */
            }
        }
    }

    async start(cwd: string, extraArgs: string[] = [], preferredBackend?: AgentBackend): Promise<void> {
        if (this._process) {
            return;
        }

        const invocation = await resolvePiCliInvocation(preferredBackend);
        this._backend = invocation.backend;
        const args = ['--mode', 'rpc', ...extraArgs];

        this._exitError = null;
        this._stderr = '';
        const childEnv: NodeJS.ProcessEnv = {
            ...piCliChildEnv(invocation),
            PI_CURSOR_SETTING_SOURCES: 'none',
            PI_CURSOR_TOOL_MANIFEST: '0',
        };


        const [command, argv] = cliCommand(invocation, args);
        const child = spawn(command, argv, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: childEnv,
        });
        this._process = child;

        child.stderr.on('data', (data: Buffer) => {
            this._stderr += data.toString();
        });

        child.on('exit', (code, signal) => {
            if (code !== 0 && code !== null) {
                this._exitError = new Error(
                    `Pi RPC process exited (code=${code}, signal=${signal}). Stderr: ${this._stderr.slice(-2000)}`,
                );
            }
            this._rejectPending(this._exitError ?? new Error('Pi RPC process exited'));
        });

        child.on('error', (error) => {
            this._exitError = new Error(`Pi RPC process error: ${error.message}`);
            this._rejectPending(this._exitError);
        });

        child.stdin.on('error', (error) => {
            this._exitError = new Error(`Pi RPC stdin error: ${error.message}`);
            this._rejectPending(this._exitError);
        });

        this._stopReading = attachJsonlLineReader(child.stdout, (line) => {
            this._handleLine(line);
        });

        await new Promise<void>((resolve, reject) => {
            if (child.exitCode !== null) {
                reject(this._exitError ?? new Error(`Pi RPC exited immediately (code=${child.exitCode})`));
                return;
            }
            let settled = false;
            const cleanup = () => {
                child.removeListener('error', onError);
                child.removeListener('exit', onExit);
                child.removeListener('spawn', onSpawn);
            };
            const onError = (err: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };
            const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(this._exitError ?? new Error(`Pi RPC exited immediately (code=${code}, signal=${signal})`));
            };
            const onSpawn = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };
            child.once('error', onError);
            child.once('exit', onExit);
            if (child.pid) {
                onSpawn();
            } else {
                child.once('spawn', onSpawn);
            }
        });

        if (this._backend === 'omp') {
            // v1 caps every frame at 1 MiB: large sessions fail `get_messages` / `get_tree` outright and
            // oversized stream events get elided. v2 splits big frames into `rpc_chunk`s instead.
            // Older omp without v2 answers with an error and stays on v1.
            await this._send({ type: 'negotiate_protocol', protocolVersion: 2 }).catch(() => undefined);
        }
    }

    get isStarted(): boolean {
        return this._process !== null;
    }

    getStderr(): string {
        return this._stderr;
    }

    writeLine(obj: unknown): void {
        const stdin = this._process?.stdin;
        if (!stdin?.writable) {
            throw new Error('Pi RPC stdin is not writable');
        }
        stdin.write(serializeJsonLine(obj));
    }

    sendExtensionUiResponse(response: RpcExtensionUIResponse): void {
        this.writeLine(response);
    }

    async stop(): Promise<void> {
        this._stopReading?.();
        this._stopReading = null;

        if (this._process) {
            try {
                this._process.stdin.end();
            } catch {
                /* ignore */
            }
            this._process.kill('SIGTERM');
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    this._process?.kill('SIGKILL');
                    resolve();
                }, 2000);
                this._process?.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
            this._process = null;
        }

        this._pending.clear();
        this._listeners.clear();
    }

    private _handleLine(line: string): void {
        let data: RpcResponse | PiAgentEvent | PiRpcOutbound | RpcChunk;
        try {
            data = JSON.parse(line);
        } catch {
            return; /* ignore non-JSON */
        }
        if (data.type === 'rpc_chunk') {
            const frame = this._pushChunk(data as RpcChunk);
            if (!frame) return;
            data = frame;
        }

        if (data.type === 'response' && data.id && this._pending.has(data.id)) {
            const pending = this._pending.get(data.id)!;
            this._pending.delete(data.id);
            pending.resolve(data as RpcResponse);
            return;
        }

        this._emit(data as PiRpcOutbound);
    }

    /** Collect one chunk; returns the decoded frame once its last chunk arrived. */
    private _pushChunk(chunk: RpcChunk): RpcResponse | PiRpcOutbound | undefined {
        let asm = this._chunkAssembly;
        if (chunk.index === 0) {
            asm = { chunkId: chunk.chunkId, count: chunk.count, byteLength: chunk.byteLength, parts: [] };
            this._chunkAssembly = asm;
        }
        if (!asm || asm.chunkId !== chunk.chunkId || asm.parts.length !== chunk.index) {
            // Out-of-sequence chunk: the frame is lost; drop it rather than decode garbage.
            this._chunkAssembly = undefined;
            return undefined;
        }
        asm.parts.push(Buffer.from(chunk.data, 'base64'));
        if (asm.parts.length < asm.count) return undefined;
        this._chunkAssembly = undefined;
        const bytes = Buffer.concat(asm.parts);
        if (bytes.byteLength !== asm.byteLength) return undefined;
        try {
            return JSON.parse(bytes.toString('utf8'));
        } catch {
            return undefined;
        }
    }

    private _rejectPending(error: Error): void {
        for (const pending of this._pending.values()) {
            pending.reject(error);
        }
        this._pending.clear();
    }

    private async _send(command: RpcCommand): Promise<RpcResponse> {
        if (!this._process?.stdin) {
            throw new Error('Pi RPC bridge not started');
        }
        if (this._exitError) {
            throw this._exitError;
        }
        if (this._process.exitCode !== null) {
            throw this._exitError ?? new Error('Pi RPC process exited');
        }

        const id = `req_${++this._requestId}`;
        const fullCommand = { ...command, id };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this._pending.has(id)) {
                    this._pending.delete(id);
                    reject(new Error(`Timeout waiting for ${command.type}`));
                }
            }, 60_000);

            this._pending.set(id, {
                resolve: (response) => {
                    clearTimeout(timeout);
                    resolve(response);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            });

            try {
                this.writeLine(fullCommand);
            } catch (err: unknown) {
                this._pending.delete(id);
                clearTimeout(timeout);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    private _data<T>(response: RpcResponse): T {
        if (!response.success) {
            throw new Error(response.error ?? 'RPC command failed');
        }
        return response.data as T;
    }

    async prompt(
        message: string,
        images?: RpcImageContent[],
        streamingBehavior?: 'steer' | 'followUp',
    ): Promise<void> {
        if (isVscodeOnlySlash(message)) {
            return;
        }
        await this._send({ type: 'prompt', message, images, streamingBehavior });
    }

    async steer(message: string, images?: RpcImageContent[]): Promise<void> {
        if (isVscodeOnlySlash(message)) {
            return;
        }
        await this._send({ type: 'steer', message, images });
    }

    async followUp(message: string, images?: RpcImageContent[]): Promise<void> {
        if (isVscodeOnlySlash(message)) {
            return;
        }
        await this._send({ type: 'follow_up', message, images });
    }

    async abort(): Promise<void> {
        await this._send({ type: 'abort' });
    }

    async newSession(): Promise<{ cancelled: boolean }> {
        return this._data(await this._send({ type: 'new_session' }));
    }

    async getState(): Promise<RpcSessionState> {
        return this._data(await this._send({ type: 'get_state' }));
    }

    async setModel(provider: string, modelId: string): Promise<void> {
        this._data(await this._send({ type: 'set_model', provider, modelId }));
    }

    async cycleModel(): Promise<{ model: { provider: string; id: string }; thinkingLevel: string } | null> {
        return this._data(await this._send({ type: 'cycle_model' }));
    }

    async getAvailableModels(): Promise<Array<{ provider: string; id: string; contextWindow?: number }>> {
        const data = this._data<{ models: Array<{ provider: string; id: string; contextWindow?: number }> }>(
            await this._send({ type: 'get_available_models' }),
        );
        return data.models;
    }

    /** omp only: login-capable providers and whether each has usable credentials. */
    async getLoginProviders(): Promise<Array<{ id: string; authenticated: boolean }>> {
        const data = this._data<{ providers: Array<{ id: string; authenticated: boolean }> }>(
            await this._send({ type: 'get_login_providers' }),
        );
        return data.providers;
    }

    async setThinkingLevel(level: string): Promise<void> {
        await this._send({ type: 'set_thinking_level', level });
    }

    async cycleThinkingLevel(): Promise<{ level: string } | null> {
        return this._data(await this._send({ type: 'cycle_thinking_level' }));
    }

    async compact(customInstructions?: string): Promise<{ tokensBefore?: number; tokensAfter?: number }> {
        return this._data(await this._send({ type: 'compact', customInstructions }));
    }

    async bash(command: string, excludeFromContext?: boolean): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return this._data(await this._send({ type: 'bash', command, excludeFromContext }));
    }

    async abortBash(): Promise<void> {
        await this._send({ type: 'abort_bash' });
    }

    async getSessionStats(): Promise<import('./rpcTypes').RpcSessionStats> {
        return this._data(await this._send({ type: 'get_session_stats' }));
    }

    async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
        return this._data(await this._send({ type: 'switch_session', sessionPath }));
    }

    async getMessages(): Promise<unknown[]> {
        const data = this._data<{ messages: unknown[] }>(await this._send({ type: 'get_messages' }));
        return data.messages;
    }

    async getCommands(): Promise<RpcSlashCommand[]> {
        if (this._backend === 'omp') {
            const data = this._data<{ commands: Array<{ name: string; description?: string; source?: string }> }>(
                await this._send({ type: 'get_available_commands' }),
            );
            return data.commands.map((c) => ({
                name: c.name,
                description: c.description,
                source: OMP_COMMAND_SOURCE[c.source ?? ''] ?? 'extension',
            }));
        }
        const data = this._data<{ commands: RpcSlashCommand[] }>(await this._send({ type: 'get_commands' }));
        return data.commands;
    }

    async setSessionName(name: string): Promise<void> {
        await this._send({ type: 'set_session_name', name });
    }

    async exportHtml(outputPath?: string): Promise<{ path: string }> {
        return this._data(await this._send({ type: 'export_html', outputPath }));
    }

    async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
        await this._send({ type: 'set_steering_mode', mode });
    }

    async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
        await this._send({ type: 'set_follow_up_mode', mode });
    }

    async setAutoCompaction(enabled: boolean): Promise<void> {
        await this._send({ type: 'set_auto_compaction', enabled });
    }

    async setAutoRetry(enabled: boolean): Promise<void> {
        await this._send({ type: 'set_auto_retry', enabled });
    }

    async abortRetry(): Promise<void> {
        await this._send({ type: 'abort_retry' });
    }

    async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
        const type = this._backend === 'omp' ? 'branch' : 'fork';
        return this._data(await this._send({ type, entryId }));
    }

    async clone(): Promise<{ cancelled: boolean }> {
        if (this._backend === 'omp') {
            throw new Error('Clone session is not available with the omp backend.');
        }
        return this._data(await this._send({ type: 'clone' }));
    }

    async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
        const data = this._data<{ messages: Array<{ entryId: string; text: string }> }>(
            await this._send({ type: this._backend === 'omp' ? 'get_branch_messages' : 'get_fork_messages' }),
        );
        return data.messages;
    }

    async getLastAssistantText(): Promise<string | null> {
        const data = this._data<{ text: string | null }>(
            await this._send({ type: 'get_last_assistant_text' }),
        );
        return data.text;
    }

    async getTree(): Promise<{ tree: any[]; leafId: string | null }> {
        const data = this._data<{ tree: any[]; leafId: string | null }>(
            await this._send({ type: 'get_tree' }),
        );
        return data;
    }
}
