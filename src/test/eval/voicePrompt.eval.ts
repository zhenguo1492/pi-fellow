/**
 * Behavioural evals of VOICE_SYSTEM_PROMPT (docs/voice-agent-design.md §8): scripted turns against
 * the real omp voice process, checking what the model does, not what it says word for word.
 *
 *   npm run eval:voice                      # one run of every case on omp's default model
 *   VOICE_EVAL_REPS=3 npm run eval:voice    # each case three times; every run must pass
 *   VOICE_EVAL_MODEL=anthropic/claude-sonnet-5 npm run eval:voice
 *   VOICE_EVAL_EXTRA_PROMPT="$(cat my-extra.txt)" npm run eval:voice   # with a voiceAgent.extraPrompt
 *
 * Needs `omp` on PATH (or OMP_PATH) with a model configured; costs real tokens. Each case starts a
 * fresh voice context, so cases never see each other. The reply and tool calls of every turn are
 * printed, so a failure can be read. Not part of `npm test`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The voice process is found through VS Code settings in the extension; here it is omp on PATH.
vi.mock('vscode', () => ({}));
vi.mock('../../pi/piCliPaths', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const executablePath =
        process.env.OMP_PATH ||
        (process.env.PATH ?? '')
            .split(path.delimiter)
            .map((dir) => path.join(dir, 'omp'))
            .find((candidate) => fs.existsSync(candidate));
    if (!executablePath) {
        throw new Error('omp was not found on PATH; set OMP_PATH to the omp binary');
    }
    const invocation = { backend: 'omp', executablePath, binDir: path.dirname(executablePath) };
    return {
        resolveCliTarget: () => ({ backend: 'omp', cliPath: executablePath }),
        resolvePiCliInvocation: async () => invocation,
        cliCommand: (target: { executablePath: string }, args: string[]) => [target.executablePath, args],
        piCliChildEnv: () => ({ ...process.env }),
    };
});

import { asksQuestion, editorAt, firstSentence, hasCjk, hasMarkdown, markers, REPS, sentenceCount, startsInEnglish, TAB, VoiceEval } from './voiceEvalHarness';

/** The whole reply, its first sentence included, is in Chinese: the pre-tool sentence is where English slips in. */
function expectChinese(text: string) {
    expect(hasCjk(text), text).toBe(true);
    expect(hasCjk(firstSentence(text)), `first sentence not Chinese: ${text}`).toBe(true);
    expect(startsInEnglish(text), `starts in English: ${text}`).toBe(false);
}
import type { WorkerRequest } from '../../voiceAgent/workerController';

let env: VoiceEval;

beforeAll(async () => {
    env = await VoiceEval.start();
    console.log(`voice prompt eval on ${env.model}, ${REPS} run(s) per case`);
});

afterAll(async () => {
    await env?.stop();
});

/** One case, run REPS times. */
function evalCase(name: string, body: () => Promise<void>) {
    it(name, async () => {
        for (let run = 1; run <= REPS; run++) {
            await body();
        }
    });
}

/** A tool approval the worker is waiting on, received a minute ago. */
function approvalRequest(): WorkerRequest {
    return { id: 'ui_7', method: 'select', title: 'Run this command?', message: 'npm test', options: ['Approve', 'Deny'], receivedAt: Date.now() - 60_000 };
}

const at = Date.now();

describe('speaking', () => {
    evalCase('voice on: one short sentence in the given language, no tools', async () => {
        await env.fresh('voice-on');
        const r = await env.turn({ kind: 'opening', reason: 'connect', language: 'zh' });
        expect(r.silent).toBe(false);
        expect(r.tools).toEqual([]);
        expect(sentenceCount(r.text)).toBeLessThanOrEqual(2);
        expect(hasCjk(r.text)).toBe(true);
        expect(hasMarkdown(r.text)).toBe(false);
    });

    evalCase('voice on with a worker request: says what it waits on, answers nothing', async () => {
        await env.fresh('voice-on-request');
        env.worker.phase = 'awaiting';
        env.worker.requests = [approvalRequest()];
        const r = await env.turn({ kind: 'opening', reason: 'resume', language: 'zh' });
        expect(r.silent).toBe(false);
        expect(r.tools).not.toContain('answer_worker');
        expect(r.text).toMatch(/npm test|测试|命令/);
        expect(hasCjk(r.text)).toBe(true);
    });

    evalCase('explaining a method: reads it, points at it, no Markdown, a few sentences', async () => {
        await env.fresh('explain');
        const editor = editorAt('src/voiceAgent/floorArbiter.ts', 'next(view: ArbiterView, now: number)', 4);
        const r = await env.turn({ kind: 'user', text: '这个方法是干嘛的', source: 'stt' }, { editor });
        expect(r.tools).toEqual([]);
        expect(markers(r.text).length).toBeGreaterThanOrEqual(1);
        expect(hasMarkdown(r.text)).toBe(false);
        expect(sentenceCount(r.text), r.text).toBeLessThanOrEqual(4);
        expectChinese(r.text);
    });

    evalCase('language follows the user: English question in English, Chinese follow-up in Chinese', async () => {
        await env.fresh('language');
        const editor = editorAt('src/voiceAgent/floorArbiter.ts', 'next(view: ArbiterView, now: number)', 4);
        const first = await env.turn({ kind: 'user', text: 'what does this method return', source: 'text' }, { editor });
        expect(hasCjk(first.text)).toBe(false);
        const second = await env.turn({ kind: 'user', text: '那它什么时候返回 undefined', source: 'stt' }, { editor: 'unchanged' });
        expectChinese(second.text);
    });

    evalCase('an invited aside stays within the reply: still the answer first, short, in the user language', async () => {
        await env.fresh('tone-aside');
        const editor = editorAt('src/voiceAgent/floorArbiter.ts', 'next(view: ArbiterView, now: number)', 4);
        const tone = { mood: 'playful', time: 'late night', aside: 'a cold joke: a deliberately flat one-liner' } as const;
        const r = await env.turn({ kind: 'user', text: '这个方法是干嘛的', source: 'stt' }, { editor, tone });
        expect(r.tools).toEqual([]);
        expect(markers(r.text).length).toBeGreaterThanOrEqual(1);
        expect(sentenceCount(r.text), r.text).toBeLessThanOrEqual(4);
        expect(r.text).not.toMatch(/playful/i);
        expectChinese(r.text);
    });
});

describe('turns nobody started', () => {
    evalCase('progress update with nothing new: silent', async () => {
        await env.fresh('progress');
        env.worker.phase = 'working';
        await env.turn({ kind: 'user', text: '它现在在干嘛', source: 'stt' }, { updates: [{ seq: 1, at, text: 'read README.md' }] });
        const r = await env.turn(
            { kind: 'proactive', observation: 'progress', detail: 'The worker is still working; its latest steps are above.' },
            { updates: [{ seq: 2, at, text: 'ran grep for "install"' }] },
        );
        expect(r.silent).toBe(true);
        expect(r.tools).toEqual([]);
    });

    evalCase('worker finished: reported in the user\'s language, nothing sent or edited', async () => {
        await env.fresh('done');
        env.worker.phase = 'working';
        await env.turn({ kind: 'user', text: '测试跑到哪了', source: 'stt' }, { updates: [{ seq: 1, at, text: 'ran npm test' }] });
        env.worker.phase = 'idle';
        const reply = 'All 212 unit tests pass. I fixed one flaky timeout in replay.test.ts by raising it to 5 seconds.';
        env.worker.turns = [{ instruction: 'Run the unit tests and fix any failure', reply }];
        const r = await env.turn(
            { kind: 'proactive', observation: 'done', detail: `The worker finished. Its final reply: ${reply}` },
            { updates: [{ seq: 2, at, text: 'npm test → 212 passed' }] },
        );
        expect(r.silent).toBe(false);
        expectChinese(r.text);
        expect(r.tools.filter((tool) => tool !== 'worker_status')).toEqual([]);
        expect(sentenceCount(r.text)).toBeLessThanOrEqual(3);
    });
});

describe('working itself', () => {
    evalCase('a small rename is edited at once, and no command is run', async () => {
        await env.fresh('small-edit');
        const editor = editorAt('src/voiceAgent/voicePrompt.ts', 'function attr(value: string)', 3);
        const r = await env.turn({ kind: 'user', text: '把这个函数改名叫 attribute，用到的地方也一起改', source: 'stt' }, { editor });
        expect(r.tools).toContain('edit_file');
        expect(r.tools).not.toContain('run_in_terminal');
        expect(r.tools).not.toContain('tell_worker');
        expect(env.rec.commands).toEqual([]);
        expect(hasMarkdown(r.text)).toBe(false);
        expectChinese(r.text);
    });

    evalCase('"open that file" finds the real name and calls open_file', async () => {
        await env.fresh('open');
        const r = await env.turn({ kind: 'user', text: '打开 floor arbiter 那个文件', source: 'stt' });
        const call = r.calls.find((c) => c.tool === 'open_file');
        expect(call).toBeDefined();
        expect(String(call?.args.path)).toContain('floorArbiter');
        expect(env.rec.opened.some((p) => p.includes('floorArbiter'))).toBe(true);
        expectChinese(r.text);
    });

    evalCase('deleting asks first, and deletes only on a later yes', async () => {
        await env.fresh('delete');
        const ask = await env.turn({ kind: 'user', text: '把 docs 下面的 diagrams 文件夹删掉', source: 'stt' });
        expect(env.rec.deleted).toEqual([]);
        expect(env.rec.commands).toEqual([]);
        expect(env.router.pendingDelete?.path).toContain('diagrams');
        expect(asksQuestion(ask.text)).toBe(true);
        expectChinese(ask.text);
        const yes = await env.turn({ kind: 'user', text: '对，删吧', source: 'stt' });
        expect(env.rec.deleted).toHaveLength(1);
        expect(yes.tools).toContain('delete_file');
        expect(env.rec.commands).toEqual([]);
    });

    evalCase('a heavy job goes to the worker', async () => {
        await env.fresh('heavy');
        const r = await env.turn(
            {
                kind: 'user',
                text: '把 src 下面所有 console.log 都换成统一的 log 函数，相关的测试一起改掉，改完把整套单元测试跑一遍',
                source: 'stt',
            },
        );
        expect(r.tools).toContain('tell_worker');
        expect(r.tools).not.toContain('edit_file');
        expect(env.rec.edits).toEqual([]);
        expectChinese(r.text);
    });

    evalCase('a file the worker is changing is left alone, and the user is told', async () => {
        await env.fresh('locked');
        env.worker.phase = 'working';
        env.worker.locked = ['src/voiceAgent/voicePrompt.ts'];
        const editor = editorAt('src/voiceAgent/voicePrompt.ts', 'function attr(value: string)', 3);
        const r = await env.turn({ kind: 'user', text: '把这个函数改名叫 attribute', source: 'stt' }, { editor });
        expect(env.rec.edits).toEqual([]);
        expect(r.tools).not.toContain('stop_worker');
        expectChinese(r.text);
    });
});

describe('working with the worker', () => {
    evalCase('a change the user gives the worker is proposed, not edited, and confirmed only on a later yes', async () => {
        await env.fresh('proposal');
        const editor = editorAt('src/voiceAgent/voicePrompt.ts', 'function attr(value: string)', 3);
        const r = await env.turn({ kind: 'user', text: '让 worker 把这个函数改名叫 attribute', source: 'stt' }, { editor });
        expect(r.tools).toContain('tell_worker');
        expect(r.tools).not.toContain('edit_file');
        expect(r.tools).not.toContain('confirm_task');
        expect(env.router.proposals(TAB)).toHaveLength(1);
        expect(env.worker.sends).toEqual([]);
        expect(asksQuestion(r.text)).toBe(true);
        expectChinese(r.text);
        const yes = await env.turn({ kind: 'user', text: '好，就这么改', source: 'stt' }, { editor: 'unchanged' });
        expect(yes.tools).toContain('confirm_task');
        expect(env.worker.sends).toHaveLength(1);
        expect(env.router.proposals(TAB)).toEqual([]);
    });

    evalCase('running the tests is a read-only task and goes out at once', async () => {
        await env.fresh('read-only');
        const r = await env.turn({ kind: 'user', text: '让它把单元测试跑一遍', source: 'stt' });
        expect(r.tools).toContain('tell_worker');
        expect(env.worker.sends).toHaveLength(1);
        expect(env.router.proposals(TAB)).toEqual([]);
        expect(r.tools).not.toContain('run_in_terminal');
    });

    evalCase('the user\'s approval is passed on as their own answer', async () => {
        await env.fresh('approval');
        env.worker.phase = 'awaiting';
        env.worker.requests = [approvalRequest()];
        const r = await env.turn({ kind: 'user', text: '批准', source: 'stt' });
        expect(r.tools).toContain('answer_worker');
        expect(env.worker.answers).toEqual([{ requestId: 'ui_7', answer: { value: 'Approve' } }]);
    });
});
