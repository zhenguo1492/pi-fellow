/**
 * Text-to-speech over the OpenAI-compatible `POST {base}/audio/speech`, one sentence per call,
 * 16-bit mono WAV back (docs/voice-agent-design.md §5.6). Servers differ in how they take the
 * language, so the provider decides what is sent.
 */
import { openAiBaseUrl, probeModels, type ModelsProbeResult } from '../voice/modelsProbe';

/**
 * - `chatterbox` (chatterbox-tts, multilingual): `language` per sentence, `zh` when it has Chinese,
 *   else `en`; one request reads mixed Chinese and English well.
 * - `kokoro` (Kokoro-FastAPI): Chinese runs with `lang_code: z`, the rest in the voice's own
 *   language, split and joined, because one `z` request mangles English words.
 * - `openai`: no language field.
 */
export type TtsProvider = 'chatterbox' | 'kokoro' | 'openai';

export interface TtsConfig {
    provider: TtsProvider;
    /** Base URL (`http://127.0.0.1:8881/v1`; a bare host gets `/v1`) or the full `/audio/speech` URL. */
    url: string;
    /** Empty: the provider's default. */
    model: string;
    /** Empty: the provider's default. */
    voice: string;
    speed: number;
}

export interface Pcm {
    rate: number;
    /** s16le mono. */
    data: Buffer;
}

export interface SpeechRun {
    text: string;
    chinese: boolean;
}

/** chatterbox-tts rejects any model but the one it loaded; Kokoro rejects voices it lacks. */
export const TTS_PROVIDER_DEFAULTS: Record<TtsProvider, { model: string; voice: string }> = {
    chatterbox: { model: 'chatterbox-multilingual', voice: 'default' },
    kokoro: { model: 'kokoro', voice: 'af_sarah' },
    openai: { model: 'tts-1', voice: 'alloy' },
};

/** How each provider is told the language (see `languageField`), in words for the Bot view. */
export const TTS_LANGUAGE_HANDLING: Record<TtsProvider, string> = {
    chatterbox: 'zh or en per sentence',
    kokoro: 'Chinese runs as lang_code z, the rest in the voice’s language',
    openai: 'not sent (the service detects it)',
};

const SPEECH_PATH = '/audio/speech';
const REQUEST_TIMEOUT_MS = 30_000;
/** Samples below this (≈ −40 dBFS) at the ends of a run are Kokoro's padding. */
const SILENCE_THRESHOLD = 300;
const RUN_MARGIN_SECS = 0.02;
const RUN_GAP_SECS = 0.05;

const HAN = /\p{Script=Han}/u;
const LETTER = /\p{L}/u;
const SPEAKABLE = /[\p{L}\p{N}]/u;

/**
 * How `text` is sent. Only Kokoro splits it, where it switches between Chinese and other letters;
 * digits, spaces and punctuation stay with the run they are in. Measured with af_sarah
 * (2026-09-25): a whole mixed sentence with `z` mangles the English words ("npm test" → "能试试");
 * split runs keep them, though a lone Chinese character between English words still comes out poorly.
 */
export function speechRuns(text: string, provider: TtsProvider): SpeechRun[] {
    if (provider !== 'kokoro') {
        return [{ text, chinese: HAN.test(text) }];
    }
    const runs: Array<{ text: string; han: boolean | undefined }> = [];
    for (const ch of text) {
        const han = HAN.test(ch) ? true : LETTER.test(ch) ? false : undefined;
        const last = runs[runs.length - 1];
        if (last && (han === undefined || last.han === undefined || last.han === han)) {
            last.text += ch;
            last.han ??= han;
        } else {
            runs.push({ text: ch, han });
        }
    }
    return runs.filter((run) => SPEAKABLE.test(run.text)).map((run) => ({ text: run.text.trim(), chinese: run.han === true }));
}

/** The request's language field. Measured on chatterbox-tts: without one, English comes out garbled. */
function languageField(provider: TtsProvider, chinese: boolean): Record<string, string> {
    switch (provider) {
        case 'chatterbox':
            return { language: chinese ? 'zh' : 'en' };
        case 'kokoro':
            return chinese ? { lang_code: 'z' } : {};
        case 'openai':
            return {};
    }
}

export class TtsClient {
    constructor(private readonly _config: TtsConfig) {}

    /** One sentence; mixed-language text is synthesized run by run and joined. */
    async synthesize(text: string, signal: AbortSignal): Promise<Pcm> {
        const runs = speechRuns(text, this._config.provider);
        const clips = await Promise.all(runs.map((run) => this._request(run, signal)));
        if (clips.length === 1) {
            return clips[0];
        }
        const rate = clips[0].rate;
        if (clips.some((clip) => clip.rate !== rate)) {
            throw new Error('TTS returned different sample rates for one sentence');
        }
        const gap = Buffer.alloc(Math.round(rate * RUN_GAP_SECS) * 2);
        return { rate, data: Buffer.concat(clips.flatMap((clip) => [trimSilence(clip), gap])) };
    }

    private async _request(run: SpeechRun, signal: AbortSignal): Promise<Pcm> {
        const { provider, model, voice, speed } = this._config;
        const endpoint = `${openAiBaseUrl(this._config.url, SPEECH_PATH)}${SPEECH_PATH}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: model || TTS_PROVIDER_DEFAULTS[provider].model,
                input: run.text,
                voice: voice || TTS_PROVIDER_DEFAULTS[provider].voice,
                response_format: 'wav',
                speed,
                ...languageField(provider, run.chinese),
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (!res.ok) {
            throw new Error(`POST ${endpoint} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        return parseWav(Buffer.from(await res.arrayBuffer()));
    }
}

/**
 * Reachable (HTTP 200 with a model list) and serving the model requests will name. Unlike STT, a
 * missing model fails: chatterbox-tts rejects any model but the one it loaded.
 */
export async function testTtsConnectivity(config: TtsConfig): Promise<ModelsProbeResult> {
    if (!config.url.trim()) {
        return { ok: false, message: 'Text-to-speech URL is empty', models: [] };
    }
    const res = await probeModels(config.url, SPEECH_PATH, 'TTS');
    const model = config.model || TTS_PROVIDER_DEFAULTS[config.provider].model;
    if (res.ok && res.models.length > 0 && !res.models.includes(model)) {
        return { ...res, ok: false, message: `the server does not serve model "${model}" (it lists ${res.models.join(', ')}); set Model to one of them` };
    }
    return res;
}

/** 16-bit mono WAV → raw PCM and its sample rate. */
export function parseWav(buf: Buffer): Pcm {
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error(`TTS did not return WAV: ${buf.subarray(0, 80).toString()}`);
    }
    let rate = 0;
    let bits = 0;
    let channels = 0;
    for (let off = 12; off + 8 <= buf.length; ) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') {
            channels = buf.readUInt16LE(off + 10);
            rate = buf.readUInt32LE(off + 12);
            bits = buf.readUInt16LE(off + 22);
        } else if (id === 'data') {
            if (bits !== 16 || channels !== 1) {
                throw new Error(`TTS must return 16-bit mono WAV, got ${bits}-bit ${channels}-channel`);
            }
            // Streaming servers write a placeholder size; the data runs to the end of the body.
            const end = Math.min(buf.length, off + 8 + size);
            return { rate, data: buf.subarray(off + 8, end - ((end - off - 8) % 2)) };
        }
        off += 8 + size + (size % 2);
    }
    throw new Error('WAV has no data chunk');
}

/** Drops the padding at both ends of one run, so joined runs sound like one sentence. */
function trimSilence({ rate, data }: Pcm): Buffer {
    const samples = data.length / 2;
    let first = 0;
    while (first < samples && Math.abs(data.readInt16LE(first * 2)) < SILENCE_THRESHOLD) {
        first++;
    }
    let last = samples - 1;
    while (last > first && Math.abs(data.readInt16LE(last * 2)) < SILENCE_THRESHOLD) {
        last--;
    }
    if (first >= samples) {
        return Buffer.alloc(0);
    }
    const margin = Math.round(rate * RUN_MARGIN_SECS);
    return data.subarray(Math.max(0, first - margin) * 2, Math.min(samples, last + 1 + margin) * 2);
}
