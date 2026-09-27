import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResearchRunner, type ResearchJob } from '../../../voiceAgent/research';

interface FakeChild {
    killed: boolean;
    kill(): void;
    finish(answer: string): void;
}

/** The CLI, faked: resolving it and each run's process are settled by the test. */
const cli = vi.hoisted(() => ({
    resolving: [] as Array<() => void>,
    spawned: [] as FakeChild[],
    onSpawn: undefined as ((child: FakeChild) => void) | undefined,
}));

vi.mock('../../../pi/piCliPaths', () => ({
    // pi resolves its cli.js asynchronously: the process spawns only after this settles.
    resolvePiCliInvocation: () => {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        cli.resolving.push(() => resolve({ backend: 'omp', executablePath: 'omp', binDir: '/bin' }));
        return promise;
    },
    runPrintMode: (_invocation: unknown, _args: string[], _input: string, _cwd: string, options: { onSpawn?: (child: unknown) => void }) => {
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        const child: FakeChild = {
            killed: false,
            kill() {
                child.killed = true;
                reject(new Error('stopped (SIGTERM)'));
            },
            finish: resolve,
        };
        cli.spawned.push(child);
        options.onSpawn?.(child);
        cli.onSpawn?.(child);
        return promise;
    },
}));

/** Resolves the next pending CLI lookup and waits for the process it spawns. */
function resolveAndSpawn(): Promise<FakeChild> {
    const { promise, resolve } = Promise.withResolvers<FakeChild>();
    cli.onSpawn = resolve;
    cli.resolving.shift()!();
    return promise;
}

/** A job's onDone, as a promise. */
function settles(): { onDone: (job: ResearchJob) => void; done: Promise<ResearchJob> } {
    const { promise, resolve } = Promise.withResolvers<ResearchJob>();
    return { onDone: resolve, done: promise };
}

beforeEach(() => {
    cli.resolving = [];
    cli.spawned = [];
    cli.onSpawn = undefined;
});

describe('ResearchRunner', () => {
    it('counts a job toward the limit before its process has spawned', () => {
        const runner = new ResearchRunner('/w');
        // One model reply can ask for several lookups at once, all before the CLI resolves.
        runner.start('q1', undefined, () => {});
        runner.start('q2', undefined, () => {});
        runner.start('q3', undefined, () => {});
        expect(() => runner.start('q4', undefined, () => {})).toThrow('3 research jobs are already running');
        expect(cli.spawned).toHaveLength(0);
    });

    it('frees a slot once a job settles', async () => {
        const runner = new ResearchRunner('/w');
        const first = settles();
        runner.start('q1', undefined, first.onDone);
        runner.start('q2', undefined, () => {});
        runner.start('q3', undefined, () => {});
        (await resolveAndSpawn()).finish('found it');
        const job = await first.done;
        expect([job.id, job.status, job.result]).toEqual(['r1', 'done', 'found it']);
        expect(() => runner.start('q4', undefined, () => {})).not.toThrow();
    });

    it('never spawns a job stopped while its CLI was still resolving', async () => {
        const runner = new ResearchRunner('/w');
        const first = settles();
        runner.start('q1', undefined, first.onDone);
        runner.stopAll();
        // Whichever comes first: the job settling, or a process spawning for it.
        const outcome = await Promise.race([first.done, resolveAndSpawn()]);
        expect(cli.spawned).toHaveLength(0);
        expect(outcome).toMatchObject({ id: 'r1', status: 'failed' });
        expect(() => runner.start('q2', undefined, () => {})).not.toThrow();
    });

    it('kills a job that has spawned', async () => {
        const runner = new ResearchRunner('/w');
        const first = settles();
        runner.start('q1', undefined, first.onDone);
        const child = await resolveAndSpawn();
        runner.stopAll();
        const job = await first.done;
        expect(child.killed).toBe(true);
        expect(job.status).toBe('failed');
    });
});
