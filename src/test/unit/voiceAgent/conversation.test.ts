import { describe, it, expect } from 'vitest';
import { echoSource, floorFree, initialState, phaseOf, reduce, type ConvEvent, type ConvState, type Effect } from '../../../voiceAgent/conversation';

function run(events: ConvEvent[], from: ConvState = initialState()): { state: ConvState; effects: Effect[] } {
    let state = from;
    const effects: Effect[] = [];
    for (const ev of events) {
        const step = reduce(state, ev);
        state = step.state;
        effects.push(...step.effects);
    }
    return { state, effects };
}

const at = 0;

describe('conversation: user turns', () => {
    it('sends one prompt for an utterance split by a pause, once every transcript is in', () => {
        const partial = run([
            { type: 'userSpeechStart', at },
            { type: 'userSpeechEnd', at, silenceAt: at },
            { type: 'userSpeechStart', at },
            { type: 'userSpeechEnd', at, silenceAt: at },
            { type: 'transcript', text: '把测试', at },
        ]);
        expect(partial.effects).toEqual([]);
        const done = run([{ type: 'transcript', text: '跑一下', at }], partial.state);
        expect(done.effects).toEqual([{ type: 'prompt', turnId: 1, text: '把测试 跑一下', source: 'stt' }]);
    });

    it('frees the floor when the words transcribe to nothing', () => {
        const { state, effects } = run([
            { type: 'userSpeechStart', at },
            { type: 'userSpeechEnd', at, silenceAt: at },
            { type: 'transcript', text: '  ', at },
        ]);
        expect(effects).toEqual([]);
        expect(floorFree(state)).toBe(true);
    });

    it('keeps a typed message’s attachments until the words still transcribing join it', () => {
        const image = { type: 'image' as const, mimeType: 'image/png', data: 'AAAA' };
        const attachments = { names: ['pasted-image-1.png'], images: [image], files: '<file name="/p/pasted-image-1.png"></file>\n' };
        const waiting = run([
            { type: 'userSpeechStart', at },
            { type: 'userSpeechEnd', at, silenceAt: at },
            { type: 'typed', text: '', attachments, at },
        ]);
        expect(waiting.effects).toEqual([]);
        const done = run([{ type: 'transcript', text: '这张图里是什么', at }], waiting.state);
        expect(done.effects).toEqual([{ type: 'prompt', turnId: 1, text: '这张图里是什么', source: 'stt', attachments }]);
    });
});

describe('conversation: replies', () => {
    const prompted = run([
        { type: 'userSpeechStart', at },
        { type: 'userSpeechEnd', at, silenceAt: at },
        { type: 'transcript', text: '测试结果呢', at },
    ]).state;

    it('speaks the first piece at a comma, later ones only at a sentence end', () => {
        const { effects } = run(
            [
                { type: 'llmText', turnId: 1, delta: '测试跑完了四个里面有一个，', at },
                { type: 'llmText', turnId: 1, delta: 'average 那个，空列表会返回', at },
                { type: 'llmText', turnId: 1, delta: ' NaN。', at },
            ],
            prompted,
        );
        expect(effects).toEqual([
            { type: 'speak', turnId: 1, text: '测试跑完了四个里面有一个，' },
            { type: 'speak', turnId: 1, text: 'average 那个，空列表会返回 NaN。' },
        ]);
    });

    it('holds the floor until the reply is both generated and played', () => {
        const generated = run(
            [
                { type: 'llmText', turnId: 1, delta: '好的。', at },
                { type: 'llmEnd', turnId: 1, at },
            ],
            prompted,
        );
        expect(floorFree(generated.state)).toBe(false);
        const played = run([{ type: 'audioIdle', turnId: 1, at }], generated.state);
        expect(floorFree(played.state)).toBe(true);
        expect(echoSource(played.state)).toBe('好的。');
    });

    it('cuts the reply off when the user speaks, and tells the next prompt what they heard', () => {
        const speaking = run(
            [
                { type: 'llmText', turnId: 1, delta: '第一句说完了。第二句还在念。第三句', at },
                { type: 'sentencePlaying', turnId: 1, text: '第一句说完了。', durationMs: 1500, at },
                { type: 'sentencePlayed', turnId: 1, text: '第一句说完了。', at },
                { type: 'sentencePlaying', turnId: 1, text: '第二句还在念。', durationMs: 1500, at },
            ],
            prompted,
        );
        const cut = run([{ type: 'userSpeechStart', at }], speaking.state);
        expect(cut.effects).toMatchObject([{ type: 'cancelTurn', turnId: 1 }]);
        // Late events of the cut-off turn change nothing.
        const next = run(
            [
                { type: 'llmText', turnId: 1, delta: '没念出来的。', at },
                { type: 'userSpeechEnd', at, silenceAt: at },
                { type: 'transcript', text: '等一下', at },
            ],
            cut.state,
        );
        expect(next.effects).toHaveLength(1);
        const prompt = next.effects[0];
        expect(prompt).toMatchObject({ type: 'prompt', turnId: 2, text: '等一下' });
        expect(prompt.type === 'prompt' && prompt.interrupted).toBe(
            'The user interrupted you. They heard only: "第一句说完了。" (and only part of the next sentence, "第二句还在念。"). They did not hear the rest.',
        );
        // What an echo of the cut-off reply would repeat is still known.
        expect(echoSource(next.state)).toContain('第三句');
    });

    it('lets a typed message cut the reply off and go out at once', () => {
        const { effects } = run([{ type: 'typed', text: '停一下', at }], prompted);
        expect(effects).toMatchObject([
            { type: 'cancelTurn', turnId: 1 },
            {
                type: 'prompt',
                turnId: 2,
                text: '停一下',
                source: 'text',
                interrupted: 'The user spoke again before your previous reply was voiced; they heard none of it.',
            },
        ]);
    });

    it('hush cuts the reply off without a new turn, frees the floor, and tells the next prompt what was heard', () => {
        const speaking = run(
            [
                { type: 'llmText', turnId: 1, delta: '第一句说完了。第二句', at },
                { type: 'sentencePlaying', turnId: 1, text: '第一句说完了。', durationMs: 1500, at },
                { type: 'sentencePlayed', turnId: 1, text: '第一句说完了。', at },
            ],
            prompted,
        );
        const hushed = run([{ type: 'hush', at }], speaking.state);
        expect(hushed.effects).toMatchObject([{ type: 'cancelTurn', turnId: 1 }]);
        expect(floorFree(hushed.state)).toBe(true);
        expect(phaseOf(hushed.state)).toBe('listening');
        const next = run([{ type: 'typed', text: '继续', at }], hushed.state);
        expect(next.effects).toEqual([
            { type: 'prompt', turnId: 2, text: '继续', source: 'text', interrupted: 'The user interrupted you. They heard only: "第一句说完了。". They did not hear the rest.' },
        ]);
    });
});

describe('conversation: proactive turns', () => {
    it('get the floor only when nobody is talking and nothing is waiting', () => {
        const busy: ConvEvent[][] = [
            [{ type: 'userSpeechStart', at }],
            [
                { type: 'userSpeechStart', at },
                { type: 'userSpeechEnd', at, silenceAt: at },
            ],
        ];
        for (const events of busy) {
            expect(run([...events, { type: 'proactiveStart', at }]).effects).toEqual([]);
        }
        const free = run([{ type: 'proactiveStart', at }]);
        expect(free.effects).toEqual([{ type: 'adopt', turnId: 1 }]);
        expect(floorFree(free.state)).toBe(false);
    });

    it('are cut off by the user like any reply', () => {
        const { effects } = run([
            { type: 'proactiveStart', at },
            { type: 'llmText', turnId: 1, delta: 'worker 做完了。', at },
            { type: 'userSpeechStart', at },
        ]);
        expect(effects).toMatchObject([
            { type: 'adopt', turnId: 1 },
            { type: 'speak', turnId: 1, text: 'worker 做完了。' },
            { type: 'cancelTurn', turnId: 1 },
        ]);
    });
});

describe('conversation: bot status', () => {
    const prompted = run([
        { type: 'userSpeechStart', at },
        { type: 'userSpeechEnd', at, silenceAt: at },
        { type: 'transcript', text: '看一下日志', at },
    ]).state;

    it('is synthesizing from the first sentence sent to TTS until the page reports it playing', () => {
        const sent = run([{ type: 'llmText', turnId: 1, delta: '好的，我看一下。', at }], prompted);
        expect(phaseOf(sent.state)).toBe('synthesizing');
        const playing = run([{ type: 'sentencePlaying', turnId: 1, text: '好的，我看一下。', durationMs: 800, at }], sent.state);
        expect(phaseOf(playing.state)).toBe('speaking');
    });

    it('keeps speaking across a gap mid-reply, and goes back to thinking only on the silent fallback', () => {
        const firstPlayed = run(
            [
                { type: 'llmText', turnId: 1, delta: '我先看看。', at },
                { type: 'sentencePlaying', turnId: 1, text: '我先看看。', durationMs: 800, at },
                { type: 'sentencePlayed', turnId: 1, text: '我先看看。', at },
                // Everything sent so far has played; the reply is still being generated (a tool call).
                { type: 'audioIdle', turnId: 1, at },
            ],
            prompted,
        );
        expect(phaseOf(firstPlayed.state)).toBe('speaking');
        const silent = run([{ type: 'botStoppedSpeaking', turnId: 1, at }], firstPlayed.state);
        expect(phaseOf(silent.state)).toBe('thinking');
        const resumed = run([{ type: 'llmText', turnId: 1, delta: '找到了。', at }], silent.state);
        expect(phaseOf(resumed.state)).toBe('synthesizing');
    });

    it('cuts early at a comma only while nothing of the reply is with TTS', () => {
        const busy = run([{ type: 'llmText', turnId: 1, delta: '我先看看。', at }], prompted);
        const piece: ConvEvent = { type: 'llmText', turnId: 1, delta: '接下来是第二个文件，', at };
        expect(run([piece], busy.state).effects).toEqual([]);
        const dry = run(
            [
                { type: 'sentencePlaying', turnId: 1, text: '我先看看。', durationMs: 800, at },
                { type: 'sentencePlayed', turnId: 1, text: '我先看看。', at },
                { type: 'audioIdle', turnId: 1, at },
            ],
            busy.state,
        );
        expect(run([piece], dry.state).effects).toEqual([{ type: 'speak', turnId: 1, text: '接下来是第二个文件，' }]);
    });

    it('stops synthesizing and speaking when the reply is cut off', () => {
        for (const played of [false, true]) {
            const events: ConvEvent[] = [{ type: 'llmText', turnId: 1, delta: '第一句。第二句。', at }];
            if (played) {
                events.push({ type: 'sentencePlaying', turnId: 1, text: '第一句。', durationMs: 800, at });
            }
            const cut = run([...events, { type: 'userSpeechStart', at }, { type: 'userSpeechEnd', at, silenceAt: at }], prompted);
            expect(phaseOf(cut.state)).toBe('transcribing');
            expect(cut.state).toMatchObject({ ttsActive: false, botSpeaking: false });
        }
    });

    it('records each hop of the exchange once its audio is over', () => {
        const { state } = run([
            { type: 'userSpeechStart', at: 0 },
            { type: 'userSpeechEnd', at: 100, silenceAt: 50 },
            { type: 'transcript', text: '测试结果呢', at: 200 },
            { type: 'llmText', turnId: 1, delta: '全部', at: 300 },
            { type: 'llmText', turnId: 1, delta: '通过。', at: 350 },
            { type: 'llmEnd', turnId: 1, at: 400 },
            { type: 'sentencePlaying', turnId: 1, text: '全部通过。', durationMs: 900, at: 500 },
        ]);
        expect(state.lastMetrics).toBeUndefined();
        const done = run(
            [
                { type: 'sentencePlayed', turnId: 1, text: '全部通过。', at: 1400 },
                { type: 'audioIdle', turnId: 1, at: 1400 },
            ],
            state,
        );
        expect(done.state.lastMetrics).toEqual({
            silenceAt: 50,
            endDetectedAt: 100,
            sttDoneAt: 200,
            promptAt: 200,
            firstTextAt: 300,
            firstSpeakAt: 350,
            firstAudioAt: 500,
            llmDoneAt: 400,
        });
        expect(phaseOf(done.state)).toBe('listening');
    });

    it('records a cut-off exchange at the cut, and starts the next one afresh', () => {
        const { state } = run([
            { type: 'userSpeechStart', at: 0 },
            { type: 'userSpeechEnd', at: 100, silenceAt: 50 },
            { type: 'transcript', text: '讲个故事', at: 200 },
            { type: 'llmText', turnId: 1, delta: '从前有只猫。', at: 300 },
            { type: 'sentencePlaying', turnId: 1, text: '从前有只猫。', durationMs: 900, at: 500 },
        ]);
        const cut = run([{ type: 'typed', text: '换一个', at: 800 }], state);
        expect(cut.effects[0]).toEqual({
            type: 'cancelTurn',
            turnId: 1,
            metrics: { silenceAt: 50, endDetectedAt: 100, sttDoneAt: 200, promptAt: 200, firstTextAt: 300, firstSpeakAt: 300, firstAudioAt: 500, cutAt: 800 },
        });
        // The typed prompt's exchange does not inherit the cut-off reply's first text or sound.
        expect(cut.state.metrics).toEqual({ promptAt: 800 });
    });
});

describe('conversation: another window has the voice', () => {
    it('stops talking and drops half-heard speech when the voice moves away', () => {
        const speaking = run([
            { type: 'userSpeechStart', at },
            { type: 'userSpeechEnd', at, silenceAt: at },
            { type: 'transcript', text: '讲个故事', at },
            { type: 'llmText', turnId: 1, delta: '从前有只猫。', at },
            { type: 'userSpeechStart', at },
        ]);
        const away = run([{ type: 'active', active: false, at }], speaking.state);
        expect(away.state).toMatchObject({ active: false, userSpeaking: false, userBuffer: [], bot: undefined });
        expect(phaseOf(away.state)).toBe('standby');
        // Speech that was already on its way to STT is not answered here.
        const late = run(
            [
                { type: 'userSpeechEnd', at, silenceAt: at },
                { type: 'transcript', text: '换一个', at },
            ],
            away.state,
        );
        expect(late.effects).toEqual([]);
    });

    it('cuts off a reply in progress and holds proactive turns until the voice is back', () => {
        const replying = run([{ type: 'proactiveStart', at }]);
        const away = run([{ type: 'active', active: false, at }], replying.state);
        expect(away.effects).toMatchObject([{ type: 'cancelTurn', turnId: 1 }]);
        expect(floorFree(away.state)).toBe(false);
        expect(run([{ type: 'proactiveStart', at }], away.state).effects).toEqual([]);
        const back = run([{ type: 'active', active: true, at }], away.state);
        expect(floorFree(back.state)).toBe(true);
        expect(run([{ type: 'proactiveStart', at }], back.state).effects).toEqual([{ type: 'adopt', turnId: 2 }]);
    });
});
