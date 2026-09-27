import type { ChildProcess } from 'node:child_process';
import { resolvePiCliInvocation, runPrintMode } from '../pi/piCliPaths';

/** One background reading task: a one-off, read-only agent run (design §7.4). */
export interface ResearchJob {
    id: string;
    question: string;
    startedAt: number;
    status: 'running' | 'done' | 'failed';
    finishedAt?: number;
    /** Findings when done; the error when failed. */
    result?: string;
}

const MAX_RUNNING = 3;
/** omp enforces it with --max-time; pi has no such flag, so the job is killed. */
const MAX_TIME_MS = 5 * 60_000;

const RESEARCH_PROMPT = `You answer one question about the codebase in the current directory by reading files. Never modify anything. Your answer goes to a voice assistant who relays it aloud, so lead with the answer, then give the key facts and the files they come from. Plain text, no code blocks, under 250 words. Say what you could not find rather than guess.`;

/**
 * Runs `omp -p` (or `pi -p`) with only read-only lookup tools, so reading many files never lands in
 * the voice agent's context or the worker's. One process per question; it exits when it has answered.
 */
export class ResearchRunner {
    private readonly _running = new Map<string, ChildProcess>();
    private _next = 1;

    constructor(private readonly _cwd: string) {}

    /** Throws when MAX_RUNNING jobs are already running. `onDone` fires once, when the job settles. */
    start(question: string, model: string | undefined, onDone: (job: ResearchJob) => void): ResearchJob {
        if (this._running.size >= MAX_RUNNING) {
            throw new Error(`${MAX_RUNNING} research jobs are already running; wait for one to finish.`);
        }
        const job: ResearchJob = { id: `r${this._next++}`, question, startedAt: Date.now(), status: 'running' };
        void this._run(job, model).then(
            (answer) => {
                job.status = 'done';
                job.result = answer;
            },
            (err: unknown) => {
                job.status = 'failed';
                job.result = err instanceof Error ? err.message : String(err);
            },
        ).finally(() => {
            job.finishedAt = Date.now();
            this._running.delete(job.id);
            onDone(job);
        });
        return job;
    }

    stopAll(): void {
        for (const child of this._running.values()) {
            child.kill('SIGTERM');
        }
    }

    private async _run(job: ResearchJob, model: string | undefined): Promise<string> {
        const invocation = await resolvePiCliInvocation();
        const args = ['-p', '--no-session', '--no-skills'];
        if (invocation.backend === 'omp') {
            args.push('--tools', 'read,grep,glob', '--no-extensions', '--no-rules', '--no-lsp', '--no-title', '--approval-mode', 'yolo', '--max-time', '5m');
        } else {
            // Extensions stay on: a pi package may provide the model; the allowlist keeps their tools out.
            // No AGENTS.md / CLAUDE.md, like omp's --no-rules: they instruct the coding agent, not this reader.
            args.push('--tools', 'read,grep,find,ls', '--no-prompt-templates', '--no-context-files');
        }
        args.push('--thinking', 'off', '--system-prompt', RESEARCH_PROMPT);
        if (model) {
            args.push('--model', model);
        }
        return runPrintMode(invocation, args, job.question, this._cwd, {
            timeoutMs: invocation.backend === 'pi' ? MAX_TIME_MS : undefined,
            onSpawn: (child) => this._running.set(job.id, child),
        });
    }
}
