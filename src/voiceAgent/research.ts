import { spawn, type ChildProcess } from 'node:child_process';
import { cliCommand, piCliChildEnv, resolvePiCliInvocation } from '../pi/piCliPaths';

/** One background reading task: a one-off, read-only omp run (design §7.4). */
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

const RESEARCH_PROMPT = `You answer one question about the codebase in the current directory by reading files. Never modify anything. Your answer goes to a voice assistant who relays it aloud, so lead with the answer, then give the key facts and the files they come from. Plain text, no code blocks, under 250 words. Say what you could not find rather than guess.`;

/**
 * Runs `omp -p` with only read, grep and glob, so reading many files never lands in the voice
 * agent's context or the worker's. One process per question; it exits when it has answered.
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
        const invocation = await resolvePiCliInvocation('omp');
        if (invocation.backend !== 'omp') {
            throw new Error('Research needs omp; only pi was found.');
        }
        const args = ['-p', '--no-session', '--tools', 'read,grep,glob', '--no-skills', '--no-rules', '--no-extensions'];
        args.push('--no-lsp', '--no-title', '--approval-mode', 'yolo', '--thinking', 'off', '--max-time', '5m');
        args.push('--system-prompt', RESEARCH_PROMPT);
        if (model) {
            args.push('--model', model);
        }
        const [command, argv] = cliCommand(invocation, args);
        const child = spawn(command, argv, { cwd: this._cwd, env: piCliChildEnv(invocation), stdio: ['pipe', 'pipe', 'pipe'] });
        this._running.set(job.id, child);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        // The question goes over stdin, so text starting with "-" is never read as a flag.
        child.stdin.end(job.question);
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        child.on('error', reject);
        child.on('close', (code, signal) => {
            const answer = stdout.trim();
            if (code === 0 && answer) {
                resolve(answer);
            } else {
                reject(new Error(signal ? `stopped (${signal})` : `omp exited with code ${code}: ${stderr.trim().slice(-300)}`));
            }
        });
        return promise;
    }
}
