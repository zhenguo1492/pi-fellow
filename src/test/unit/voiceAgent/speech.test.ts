import { afterEach, describe, it, expect, vi } from 'vitest';
import { classifyBargeIn, isHallucination } from '../../../voiceAgent/echoFilter';
import { takeSentences } from '../../../voiceAgent/sentences';
import { TtsClient, parseWav, speechRuns } from '../../../voiceAgent/tts';

describe('echoFilter: barge-in', () => {
    // Samples from the voice-loop prototype's logs (prototype doc §4.4).
    it('rejects the bot heard back through the speaker, numbers and all', () => {
        expect(classifyBargeIn('这个顾设是4800万像', '主摄是四千八百万像素，拍照很清楚。').kind).toBe('reject');
        expect(classifyBargeIn('One day, Pip, found a lost puppy', 'One day, Pip found a lost puppy in the rain.').kind).toBe('reject');
    });

    it('accepts the user talking over the bot, including a bare stop word', () => {
        expect(classifyBargeIn('等等，我想问一下Pro版多少钱', '主摄是四千八百万像素，拍照很清楚。').kind).toBe('user');
        expect(classifyBargeIn('停', '测试跑完了，四个都过了。').kind).toBe('user');
        expect(classifyBargeIn('停', '先停一下，停在这里。').kind).toBe('reject');
    });

    it('drops Whisper filler without killing real sentences that contain it', () => {
        expect(isHallucination('请不吝点赞 订阅 转发')).toBe(true);
        expect(isHallucination('Thank you.')).toBe(true);
        expect(isHallucination('Thank you, that is enough')).toBe(false);
    });
});

describe('sentences', () => {
    it('does not cut a number at its decimal point', () => {
        expect(takeSentences('阈值是 0.3 秒。然后', false)).toEqual({ sentences: ['阈值是 0.3 秒。'], rest: '然后' });
    });

    it('strips Markdown and never reads a code block, even one spanning lines', () => {
        expect(takeSentences('**好的**。```\ncode\nmore\n```我改好了。', false).sentences).toEqual(['好的。', '我改好了。']);
        // An open fence holds everything back until it closes.
        expect(takeSentences('看这里：```\nconst a = 1;\n', false)).toEqual({ sentences: [], rest: '看这里：```\nconst a = 1;\n' });
    });
});

describe('tts', () => {
    afterEach(() => vi.unstubAllGlobals());

    /** Stubs the TTS server; each call returns 0.1 s of padding, 0.1 s of "speech", 0.1 s of padding at 1 kHz. */
    function stubServer(): Array<Record<string, unknown>> {
        const bodies: Array<Record<string, unknown>> = [];
        vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
            bodies.push(JSON.parse(init.body));
            const samples = [...Array(100).fill(0), ...Array(100).fill(8000), ...Array(100).fill(0)];
            return new Response(new Uint8Array(wav(1000, samples)));
        });
        return bodies;
    }

    it('splits mixed text by script for Kokoro only, keeping punctuation and digits in their run', () => {
        expect(speechRuns('我让 worker 跑了 npm test，4 个都过了。', 'kokoro')).toEqual([
            { text: '我让', chinese: true },
            { text: 'worker', chinese: false },
            { text: '跑了', chinese: true },
            { text: 'npm test，4', chinese: false },
            { text: '个都过了。', chinese: true },
        ]);
        expect(speechRuns('跑一下 npm test', 'chatterbox')).toEqual([{ text: '跑一下 npm test', chinese: true }]);
        expect(speechRuns('The tests passed.', 'openai')).toEqual([{ text: 'The tests passed.', chinese: false }]);
    });

    it('asks chatterbox for zh or en per sentence, with its own model and voice unless configured', async () => {
        const bodies = stubServer();
        const tts = new TtsClient({ provider: 'chatterbox', url: 'http://tts.local', model: '', voice: '', speed: 1 });
        const signal = new AbortController().signal;
        await tts.synthesize('跑一下 npm test', signal);
        await tts.synthesize('The tests passed.', signal);
        expect(bodies.map((b) => [b.input, b.language, b.model, b.voice])).toEqual([
            ['跑一下 npm test', 'zh', 'chatterbox-multilingual', 'default'],
            ['The tests passed.', 'en', 'chatterbox-multilingual', 'default'],
        ]);
        const other = new TtsClient({ provider: 'openai', url: 'http://tts.local', model: 'm', voice: 'v', speed: 1 });
        await other.synthesize('你好', signal);
        expect(bodies[2]).toEqual({ model: 'm', input: '你好', voice: 'v', response_format: 'wav', speed: 1 });
    });

    it('synthesizes each Kokoro run with its language and joins them without the padding', async () => {
        const bodies = stubServer();
        const tts = new TtsClient({ provider: 'kokoro', url: 'http://tts.local', model: '', voice: '', speed: 1 });
        const pcm = await tts.synthesize('跑一下 npm test', new AbortController().signal);
        expect(bodies.map((b) => [b.input, b.lang_code])).toEqual([
            ['跑一下', 'z'],
            ['npm test', undefined],
        ]);
        expect(bodies[0]).toMatchObject({ model: 'kokoro', voice: 'af_sarah', response_format: 'wav' });
        // Each run: 100 speech samples + 20 ms margin each side; plus a 50 ms gap after each.
        expect(pcm.data.length / 2).toBe(2 * (100 + 20 + 20 + 50));
    });

    it('rejects audio it cannot play', () => {
        expect(() => parseWav(Buffer.from('{"error":"bad voice"}'))).toThrow(/did not return WAV/);
    });
});

function wav(rate: number, samples: number[]): Buffer {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}
