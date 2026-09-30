/**
 * Text-to-speech over the OpenAI-compatible `POST {base}/audio/speech`, one sentence per call,
 * 16-bit mono WAV back (docs/voice-agent-design.md §5.6). Servers differ in how they take the
 * language, so the `languageField` setting decides what is sent.
 */
import { authHeaders, openAiBaseUrl, probeModels, type ApiKeySource, type ModelsProbeResult, type ServiceOutcome } from '../voice/modelsProbe';

/** `builtin`: Piper in the built-in voice engine (src/voice/builtinEngine), English only; `custom`: the server at `url`. */
export type TtsEngine = 'builtin' | 'custom';

/**
 * How a custom server is told the language of what it reads:
 * - `none`: not at all (the server detects it, or the voice has one language).
 * - `perSentence`: `language` per sentence, `zh` when it has Chinese, else `en`. Measured on a
 *   multilingual server: without it, English comes out garbled; with it, one request reads mixed
 *   Chinese and English well.
 * - `chineseLangCode`: Chinese runs with `lang_code: z`, the rest in the voice's own language, split
 *   and joined, because one `z` request mangles English words (see `speechRuns`).
 */
export type TtsLanguageField = 'none' | 'perSentence' | 'chineseLangCode';

export const TTS_LANGUAGE_FIELDS: readonly TtsLanguageField[] = ['none', 'perSentence', 'chineseLangCode'];

export interface TtsConfig {
    /** Setting `voiceAgent.tts.engine`. */
    engine: TtsEngine;
    /** Custom engine only; the built-in one takes `none`. */
    languageField: TtsLanguageField;
    /** Base URL (`http://127.0.0.1:8881/v1`; a bare host gets `/v1`) or the full `/audio/speech` URL. */
    url: string;
    /** Empty: not sent, the server picks. */
    model: string;
    /** Empty: not sent, the server picks. */
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

/** How each `languageField` sends the language, in words for the Bot view. */
export const TTS_LANGUAGE_HANDLING: Record<TtsLanguageField, string> = {
    none: 'not sent',
    perSentence: 'zh or en per sentence',
    chineseLangCode: 'Chinese runs as lang_code z, the rest in the voice’s language',
};

const SPEECH_PATH = '/audio/speech';
const REQUEST_TIMEOUT_MS = 30_000;
/** Samples below this (≈ −40 dBFS) at the ends of a run are the server's padding. */
const SILENCE_THRESHOLD = 300;
const RUN_MARGIN_SECS = 0.02;
const RUN_GAP_SECS = 0.05;

const HAN = /\p{Script=Han}/u;
const LETTER = /\p{L}/u;
const SPEAKABLE = /[\p{L}\p{N}]/u;

/**
 * How `text` is sent. Only `chineseLangCode` splits it, where it switches between Chinese and other
 * letters; digits, spaces and punctuation stay with the run they are in. Measured with an English
 * voice (2026-09-25): a whole mixed sentence with `z` mangles the English words ("npm test" → "能试试");
 * split runs keep them, though a lone Chinese character between English words still comes out poorly.
 */
export function speechRuns(text: string, languageField: TtsLanguageField): SpeechRun[] {
    if (languageField !== 'chineseLangCode') {
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

/** The request's language parameters. */
function languageParams(languageField: TtsLanguageField, chinese: boolean): Record<string, string> {
    switch (languageField) {
        case 'perSentence':
            return { language: chinese ? 'zh' : 'en' };
        case 'chineseLangCode':
            return chinese ? { lang_code: 'z' } : {};
        case 'none':
            return {};
    }
}

/** A `TtsConfig` ready for requests: with the API key of a custom server, if it needs one. */
export interface TtsRequestConfig extends TtsConfig {
    /** Sent as a Bearer token on every request when it gives a key. */
    apiKey?: ApiKeySource;
    /** The most characters the service reads per request (Groq's Orpheus: 200); longer text is sent in pieces. */
    maxInputChars?: number;
    /** Each synthesis's outcome: a WAV parsed, or the failure (not when the caller cut it off). */
    onOutcome?: ServiceOutcome;
}

/**
 * `run` in pieces of at most `max` characters, cut after the last sentence or clause punctuation in
 * reach, else the last space, else hard at `max`.
 */
function limitRunLength(run: SpeechRun, max: number | undefined): SpeechRun[] {
    const pieces: SpeechRun[] = [];
    let rest = run.text.trim();
    while (max && rest.length > max) {
        const head = rest.slice(0, max + 1);
        const punct = Math.max(...[...head.matchAll(/[.!?;:,。！？；：，、]/g)].map((m) => m.index + 1), 0);
        const cut = punct > max / 3 ? punct : head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : max;
        pieces.push({ text: rest.slice(0, cut).trim(), chinese: run.chinese });
        rest = rest.slice(cut).trim();
    }
    return rest ? [...pieces, { text: rest, chinese: run.chinese }] : pieces;
}

/** One speech request's use: the characters sent and the audio back. */
export interface TtsUsage {
    chars: number;
    audioMs: number;
}

export class TtsClient {
    constructor(
        private readonly _config: TtsRequestConfig,
        /** Each request that returned audio; a mixed-language sentence takes one per run. */
        private readonly _onUsage?: (usage: TtsUsage) => void,
    ) {}

    /** One sentence; mixed-language text is synthesized run by run and joined. */
    async synthesize(text: string, signal: AbortSignal): Promise<Pcm> {
        const runs = speechRuns(text, this._config.languageField).flatMap((run) => limitRunLength(run, this._config.maxInputChars));
        try {
            const clips = await Promise.all(runs.map((run) => this._request(run, signal)));
            const pcm = joinRuns(clips);
            this._config.onOutcome?.();
            return pcm;
        } catch (err) {
            // Cut off by the caller (a reply interrupted, a replay stopped): nothing learnt about the service.
            // A caller's own deadline running out is the service being too slow, like the request timeout.
            const cutOff = signal.aborted && (signal.reason as Error | undefined)?.name !== 'TimeoutError';
            if (runs.length > 0 && !cutOff) {
                this._config.onOutcome?.(err);
            }
            throw err;
        }
    }

    private async _request(run: SpeechRun, signal: AbortSignal): Promise<Pcm> {
        const { languageField, model, voice, speed } = this._config;
        const endpoint = `${openAiBaseUrl(this._config.url, SPEECH_PATH)}${SPEECH_PATH}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(await authHeaders(this._config.apiKey)) },
            body: JSON.stringify({
                ...(model ? { model } : {}),
                input: run.text,
                ...(voice ? { voice } : {}),
                response_format: 'wav',
                speed,
                ...languageParams(languageField, run.chinese),
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (!res.ok) {
            throw new Error(`POST ${endpoint} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const pcm = parseWav(Buffer.from(await res.arrayBuffer()));
        this._onUsage?.({ chars: run.text.length, audioMs: (pcm.data.length / 2 / pcm.rate) * 1000 });
        return pcm;
    }
}

/** The clips of one sentence's runs as one clip, each run's padding trimmed and a short gap between them. */
function joinRuns(clips: Pcm[]): Pcm {
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

/**
 * Reachable (HTTP 200 with a model list) and, when a model is set, serving it: unlike STT a missing
 * model fails, as some servers reject any model but the one they loaded. The list comes back either
 * way, for the settings page to offer.
 */
export async function testTtsConnectivity(config: TtsRequestConfig): Promise<ModelsProbeResult> {
    if (!config.url.trim()) {
        return { ok: false, message: 'Text-to-speech URL is empty', models: [] };
    }
    const res = await probeModels(config.url, SPEECH_PATH, 'TTS', config.apiKey);
    const model = config.model.trim();
    if (res.ok && model && res.models.length > 0 && !res.models.includes(model)) {
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
