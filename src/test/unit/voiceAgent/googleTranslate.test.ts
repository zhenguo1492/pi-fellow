import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    TranslationError,
    Translator,
    googleTranslate,
    maskCode,
    parseRetryAfter,
    parseTranslation,
    unmaskCode,
} from '../../../voiceAgent/googleTranslate';

afterEach(() => vi.unstubAllGlobals());

describe('googleTranslate (ported from echo-read-edge)', () => {
    it('posts text only to the fixed Google endpoint and normalizes the result', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify([[['你好。', 'Hello.']], null, 'en']), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await googleTranslate('Hello.', 'zh-CN', new AbortController().signal);

        expect(result).toEqual({ translation: '你好。', detectedLanguage: 'en', segments: [{ translated: '你好。', source: 'Hello.' }] });
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toMatch(/^https:\/\/translate\.googleapis\.com\/translate_a\/single\?/);
        const params = new URL(String(url)).searchParams;
        // The public "gtx" client shares one heavily abused quota bucket; dict-chrome-ex answers when gtx returns 429.
        expect(params.get('client')).toBe('dict-chrome-ex');
        expect([params.get('sl'), params.get('tl'), params.get('dt')]).toEqual(['auto', 'zh-CN', 't']);
        expect(init.method).toBe('POST');
        expect(init.body).toBe('q=Hello.');
    });

    it('reports the status and Retry-After hint so a rate limit can be backed off', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Sorry...', { status: 429, headers: { 'Retry-After': '30' } })));

        const failure = await googleTranslate('Hello.', 'zh-CN', new AbortController().signal).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(TranslationError);
        expect((failure as TranslationError).status).toBe(429);
        expect((failure as TranslationError).retryAfterMs).toBe(30_000);
    });

    it('reads both the seconds and HTTP-date forms of Retry-After', () => {
        expect(parseRetryAfter(null)).toBeUndefined();
        expect(parseRetryAfter('12')).toBe(12_000);
        expect(parseRetryAfter('not-a-date')).toBeUndefined();
        expect(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(50_000);
    });

    it('rejects malformed or empty nested responses', () => {
        expect(parseTranslation(null)).toBeNull();
        expect(parseTranslation([[]])).toBeNull();
        expect(parseTranslation([[['One '], ['two']]])).toBe('One two');
    });

    it('lets an abort through as it is, not as a translation failure', async () => {
        vi.stubGlobal('fetch', (_url: string, init: RequestInit) => Promise.reject(init.signal?.reason));
        const ctl = new AbortController();
        ctl.abort();
        const failure = await googleTranslate('Hello.', 'zh-CN', ctl.signal).catch((error: unknown) => error);
        expect(failure).not.toBeInstanceOf(TranslationError);
    });
});

/**
 * The reply the user translated, as Google split it into sentences, with its translations from the
 * live service. `echoed` marks the sentences the failing response had left in English (the user's
 * screenshot: 2–4 and 7–9 came back as their source).
 */
const HEAP_REPLY: Array<{ source: string; zh: string; echoed?: true }> = [
    { source: 'Good question. ', zh: '好问题。 ' },
    { source: "Go's heap package doesn't give you a ready-made heap. ", zh: 'Go 的堆包并没有给你一个现成的堆。', echoed: true },
    { source: 'It only knows the steps for keeping a heap in order, so you have to give it five small methods to work with. ', zh: '它只知道保持堆有序的步骤，因此您必须给它五个小方法来使用。', echoed: true },
    { source: "Here's our type: just a slice of pairs, each holding a number and its count. ", zh: '这是我们的类型：只是一个对的切片，每个对包含一个数字及其计数。 ', echoed: true },
    { source: 'Len tells the package how many items there are. ', zh: 'Len 告诉包裹有多少件物品。' },
    { source: 'Less is the important one. ', zh: '少一点才是重要的。' },
    { source: 'It compares two items by their count, and because smaller counts win, this becomes a min-heap. ', zh: '它根据两个项目的计数进行比较，并且由于较小的计数获胜，因此这成为最小堆。', echoed: true },
    { source: 'Swap lets the package trade two items when it moves them up or down. ', zh: '交换允许程序包在向上或向下移动两个项目时交换它们。 ', echoed: true },
    { source: 'Push just adds a new item to the end of the slice. ', zh: 'Push 只是将一个新项目添加到切片的末尾。 ', echoed: true },
    { source: 'Pop removes the last item and returns it. ', zh: 'Pop 删除最后一项并将其返回。' },
    { source: 'So you write these simple slice operations, and when you call heap dot Push or heap dot Pop, the package uses them to keep the smallest count on top.', zh: '因此，您编写这些简单的切片操作，当您调用堆点 Push 或堆点 Pop 时，该包使用它们将最小计数保留在顶部。' },
];
const heapText = HEAP_REPLY.map((s) => s.source).join('');
/** Google's response with every sentence translated, or with the `echoed` ones returned as their source. */
const heapPayload = (partial: boolean) => [HEAP_REPLY.map((s) => [partial && s.echoed ? s.source : s.zh, s.source, null, null, 3]), null, 'en'];
const payloadResponse = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
const zhOf = (source: string) => HEAP_REPLY.find((s) => s.source.trim() === source)?.zh.trim();
const englishLeft = (text: string) => HEAP_REPLY.filter((s) => text.includes(s.source.trim())).map((s) => s.source.trim());
const expectedHeapZh = HEAP_REPLY.map((s) => s.zh).join('').trim();
/** What each request to the endpoint was: its source language and text. */
type Asked = { sl: string | null; q: string | null };
function requestOf(url: string, init: RequestInit): Asked {
    return { sl: new URL(url).searchParams.get('sl'), q: new URLSearchParams(String(init.body)).get('q') };
}

describe('Translator: a response with sentences left untranslated', () => {
    it('asks again for each sentence Google returned as its source, so the whole reply ends up in Chinese', async () => {
        const asked: Asked[] = [];
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            const request = requestOf(url, init);
            asked.push(request);
            if (request.q === heapText) {
                return payloadResponse(heapPayload(true));
            }
            // A single sentence, asked from the detected language: Google translates it.
            return payloadResponse([[[zhOf(request.q ?? ''), request.q, null, null, 3]], null, 'en']);
        });

        const result = await new Translator().translate(heapText, 'zh-CN', new AbortController().signal);
        const text = 'text' in result ? result.text : '';

        // Word for word the fully translated reply; only the spaces between sentences may differ.
        expect(text.replace(/\s+/g, '')).toBe(expectedHeapZh.replace(/\s+/g, ''));
        expect(englishLeft(text)).toEqual([]);
        // A repaired sentence is not followed by the space that separated the English ones.
        expect(text).toContain('现成的堆。它只知道');
        expect(asked.slice(1)).toEqual(HEAP_REPLY.filter((s) => s.echoed).map((s) => ({ sl: 'en', q: s.source.trim() })));
    });

    it('makes no second request when every sentence came back translated', async () => {
        const fetchMock = vi.fn(async () => payloadResponse(heapPayload(false)));
        vi.stubGlobal('fetch', fetchMock);
        expect(await new Translator().translate(heapText, 'zh-CN', new AbortController().signal)).toEqual({ text: expectedHeapZh });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('keeps a sentence that is the same in Chinese (a name) after asking once more', async () => {
        const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
            const { q } = requestOf(url, init);
            return payloadResponse(q === 'Go. Run it.' ? [[['Go. ', 'Go. '], ['运行它。', 'Run it.']], null, 'en'] : [[['Go.', 'Go.']], null, 'en']);
        });
        vi.stubGlobal('fetch', fetchMock);
        expect(await new Translator().translate('Go. Run it.', 'zh-CN', new AbortController().signal)).toEqual({ text: 'Go. 运行它。' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
describe('Translator', () => {
    /** Stands in for Google: records each request and "translates" by a lookup. */
    function fakeGoogle(answers: Record<string, string>, detectedLanguage = 'en') {
        const asked: string[] = [];
        const targets: string[] = [];
        const translate = vi.fn(async (text: string, target: string) => {
            asked.push(text);
            targets.push(target);
            return { translation: answers[text] ?? `译:${text}`, detectedLanguage };
        });
        return { asked, targets, translator: new Translator(translate) };
    }

    it('never sends code: inline and fenced spans go as placeholders and come back verbatim', async () => {
        const text = 'Run `npm test` first.\n```ts\nconst a = 1;\n```\nThen check ⟦src/a.ts:3⟧ it.';
        const { asked, translator } = fakeGoogle({
            'Run ⟪0⟫ first.\n⟪1⟫\nThen check it.': '先运行⟪0⟫。\n⟪1⟫\n然后检查一下。',
        });

        const result = await translator.translate(text, 'zh-CN', new AbortController().signal);

        expect(asked).toEqual(['Run ⟪0⟫ first.\n⟪1⟫\nThen check it.']);
        expect(result).toEqual({ text: '先运行`npm test`。\n```ts\nconst a = 1;\n```\n然后检查一下。' });
    });

    it('translates the prose between code spans one by one when a placeholder comes back mangled', async () => {
        const { asked, translator } = fakeGoogle({
            'Run ⟪0⟫ to check ⟪1⟫.': '运行 ⟪0⟫ 检查。', // ⟪1⟫ lost
            Run: '运行',
            'to check': '检查',
        });

        const result = await translator.translate('Run `a` to check `b`.', 'zh-CN', new AbortController().signal);

        expect(asked.slice(1)).toEqual(['Run', 'to check']);
        expect(result).toEqual({ text: '运行 `a` 检查 `b`.' });
    });

    it('reports a text Google detects as already in the target language, instead of a copy of it', async () => {
        const signal = new AbortController().signal;
        expect(await fakeGoogle({}, 'zh-CN').translator.translate('测试都过了', 'zh-CN', signal)).toEqual({ alreadyInTarget: true });
        expect(await fakeGoogle({}, 'ja').translator.translate('テストは通りました', 'ja', signal)).toEqual({ alreadyInTarget: true });
        // Simplified into Traditional Chinese is a translation: Google converts between them.
        const { targets, translator } = fakeGoogle({ 测试都过了: '測試都過了' }, 'zh-CN');
        expect(await translator.translate('测试都过了', 'zh-TW', signal)).toEqual({ text: '測試都過了' });
        expect(targets).toEqual(['zh-TW']);
    });

    it('asks nothing for a message that is only code', async () => {
        const { asked, translator } = fakeGoogle({});
        expect(await translator.translate('```\nls -la\n```', 'zh-CN', new AbortController().signal)).toEqual({ text: '```\nls -la\n```' });
        expect(asked).toEqual([]);
    });

    it('after a 429 fails at once until Retry-After has passed', async () => {
        vi.useFakeTimers();
        try {
            const translate = vi
                .fn()
                .mockRejectedValueOnce(new TranslationError('limited', { status: 429, retryAfterMs: 10_000 }))
                .mockResolvedValue({ translation: '你好', detectedLanguage: 'en' });
            const translator = new Translator(translate);
            const signal = new AbortController().signal;

            await expect(translator.translate('Hello', 'zh-CN', signal)).rejects.toThrow('limited');
            await expect(translator.translate('Hello', 'zh-CN', signal)).rejects.toThrow(/try again in 10 s/);
            expect(translate).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(10_001);
            expect(await translator.translate('Hello', 'zh-CN', signal)).toEqual({ text: '你好' });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('code placeholders', () => {
    it('restore only when each placeholder came back exactly once', () => {
        const { masked, code } = maskCode('a `x` b `y`');
        expect(masked).toBe('a ⟪0⟫ b ⟪1⟫');
        expect(unmaskCode('甲 ⟪ 0 ⟫ 乙 ⟪1⟫', code)).toBe('甲 `x` 乙 `y`');
        expect(unmaskCode('甲 ⟪0⟫ 乙', code)).toBeUndefined();
        expect(unmaskCode('⟪0⟫ ⟪0⟫ ⟪1⟫', code)).toBeUndefined();
    });
});
