import type { WorkerEvent } from './workerController';

/**
 * Plain-language log of what one worker tab is doing, built from its raw agent events
 * (docs/voice-agent-design.md §5.8). The voice agent reads this instead of the worker's context:
 * one line per step, no file contents or diffs.
 */

export interface DigestEntry {
    seq: number;
    at: number;
    text: string;
}

const LIMIT = 60;

export class WorkerDigest {
    private readonly _entries: DigestEntry[] = [];
    private _seq = 0;
    /** Unset until the first agent_start this digest sees. */
    private _runStartedAt: number | undefined;
    private _runStartSeq = 0;

    /** Sequence number of the newest entry; 0 before any. */
    get lastSeq(): number {
        return this._seq;
    }

    /** Newest entry from before the latest run started: `since(runStartSeq)` is that run so far. */
    get runStartSeq(): number {
        return this._runStartSeq;
    }

    since(seq: number): DigestEntry[] {
        return this._entries.filter((entry) => entry.seq > seq);
    }

    recent(count: number): DigestEntry[] {
        return this._entries.slice(-count);
    }

    ingest(event: WorkerEvent, now = Date.now()): void {
        const line = this._describe(event, now);
        if (line) {
            this._entries.push({ seq: ++this._seq, at: now, text: line });
            if (this._entries.length > LIMIT) {
                this._entries.shift();
            }
        }
    }

    private _describe(event: WorkerEvent, now: number): string | undefined {
        switch (event.type) {
            case 'agent_start':
                this._runStartedAt = now;
                this._runStartSeq = this._seq;
                return undefined;
            case 'message_start': {
                const message = event.message as { role?: string; steering?: boolean; content?: unknown } | undefined;
                if (message?.role !== 'user') {
                    return undefined;
                }
                const text = textOf(message.content);
                return text ? `${message.steering ? 'Steer' : 'Instruction'}: ${clip(text, 160)}` : undefined;
            }
            case 'message_end': {
                const message = event.message as { role?: string; content?: unknown } | undefined;
                const text = message?.role === 'assistant' ? textOf(message.content) : '';
                return text ? `Worker said: ${clip(text, 240)}` : undefined;
            }
            case 'tool_execution_start':
                return describeToolStart(String(event.toolName ?? 'tool'), event.args, event.intent);
            case 'tool_execution_end':
                return describeToolEnd(String(event.toolName ?? 'tool'), event.result, event.isError === true);
            case 'auto_retry_start':
                return `Model error, retrying: ${clip(String(event.errorMessage ?? 'unknown'), 120)}`;
            case 'agent_end': {
                // omp: an agent_end with isTerminal === false means more work was scheduled.
                if (event.isTerminal === false) {
                    return undefined;
                }
                const messages = event.messages as Array<{ stopReason?: string; errorMessage?: string }> | undefined;
                const last = messages?.[messages.length - 1];
                const took =
                    this._runStartedAt === undefined ? '' : ` after ${Math.round((now - this._runStartedAt) / 1000)}s`;
                if (last?.stopReason === 'error') {
                    return `Stopped with an error${took}: ${clip(last.errorMessage ?? 'unknown', 160)}`;
                }
                if (last?.stopReason === 'aborted') {
                    return `Stopped by the user${took}`;
                }
                return `Finished${took}`;
            }
            default:
                return undefined;
        }
    }
}

export function formatDigest(entries: DigestEntry[]): string {
    return entries.map((entry) => `[${new Date(entry.at).toTimeString().slice(0, 8)}] ${entry.text}`).join('\n');
}

function describeToolStart(toolName: string, args: unknown, intent: unknown): string {
    // omp states each tool call's purpose ("Reading a.txt"); pi does not.
    if (typeof intent === 'string' && intent.trim()) {
        return clip(intent.trim(), 160);
    }
    const a = (args ?? {}) as Record<string, unknown>;
    if (toolName === 'bash' && typeof a.command === 'string') {
        return `Running: ${clip(a.command, 120)}`;
    }
    const target =
        stringArg(a.path) ??
        stringArg(a.file_path) ??
        stringArg(a.pattern) ??
        // omp edit/write patches name the file in a `[path#tag]` header
        (typeof a.input === 'string' ? /^\[([^#\]\n]+)#/.exec(a.input)?.[1] : undefined);
    return target ? `${toolName} ${clip(target, 120)}` : toolName;
}

function describeToolEnd(toolName: string, result: unknown, isError: boolean): string | undefined {
    const r = (result ?? {}) as { content?: unknown; details?: { exitCode?: unknown } };
    if (toolName === 'bash') {
        const exitCode = typeof r.details?.exitCode === 'number' ? r.details.exitCode : isError ? 'error' : 0;
        const tail = lastOutputLine(textOf(r.content));
        return `  → exit ${exitCode}${tail ? `: ${clip(tail, 120)}` : ''}`;
    }
    if (!isError) {
        return undefined;
    }
    const firstLine = textOf(r.content).split('\n').find((line) => line.trim()) ?? 'unknown error';
    return `  ✗ ${toolName} failed: ${clip(firstLine.trim(), 140)}`;
}

/** Last line a human would read, skipping omp's bash footer (wall time, exit code). */
function lastOutputLine(output: string): string {
    const lines = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^Wall time:/.test(line) && !/^Command exited with code/.test(line));
    return lines[lines.length - 1] ?? '';
}

function textOf(content: unknown): string {
    if (typeof content === 'string') {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter((part): part is { type: string; text: string } => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim();
}

function stringArg(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

/** One line, at most `max` characters. */
export function clip(text: string, max: number): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
