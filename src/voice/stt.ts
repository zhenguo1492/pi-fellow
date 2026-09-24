/**
 * OpenAI-compatible speech-to-text (`POST {base}/audio/transcriptions`), as
 * served by OpenAI, Groq, speaches / faster-whisper-server, whisper.cpp server…
 */

export interface SttConfig {
    /** Base URL (`http://127.0.0.1:8010/v1`; a bare host gets `/v1`) or the full `/audio/transcriptions` URL. */
    url: string;
    /** Model id; empty = first model the server lists at `{base}/models`. */
    model: string;
    /** ISO-639-1 hint (`zh`, `en`); empty = let the model detect it. */
    language: string;
}

const TRANSCRIPTIONS_PATH = '/audio/transcriptions';
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * `{base}` in front of `/models` and `/audio/transcriptions`. A bare host
 * (`http://127.0.0.1:8010`) means the OpenAI-standard `/v1` mount point.
 */
function sttBaseUrl(url: string): string {
    let base = url.trim().replace(/\/+$/, '');
    if (base.endsWith(TRANSCRIPTIONS_PATH)) {
        base = base.slice(0, -TRANSCRIPTIONS_PATH.length);
    }
    return new URL(base).pathname === '/' ? `${base}/v1` : base;
}

/** Lists the server's model ids; doubles as a connectivity check. */
export async function listSttModels(url: string): Promise<string[]> {
    const modelsUrl = `${sttBaseUrl(url)}/models`;
    const res = await fetch(modelsUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
        throw new Error(`GET ${modelsUrl} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
}

export interface SttConnectivityResult {
    ok: boolean;
    status?: number;
    message: string;
    models: string[];
}

/**
 * Tests whether the STT endpoint is reachable and returns HTTP 200.
 * Only HTTP 200 is considered valid.
 */
export async function testSttConnectivity(url: string, model?: string): Promise<SttConnectivityResult> {
    const trimmed = url.trim();
    if (!trimmed) {
        return { ok: false, message: 'Speech-to-text URL is empty', models: [] };
    }
    try {
        const modelsUrl = `${sttBaseUrl(trimmed)}/models`;
        const res = await fetch(modelsUrl, { signal: AbortSignal.timeout(8_000) });
        if (res.status === 200) {
            let body: { data?: { id?: unknown }[] };
            try {
                body = (await res.json()) as { data?: { id?: unknown }[] };
            } catch {
                return { ok: false, status: 200, message: 'The STT /models endpoint did not return JSON', models: [] };
            }
            if (!Array.isArray(body?.data)) {
                return { ok: false, status: 200, message: 'The STT /models endpoint did not return a model list', models: [] };
            }
            const models = body.data.map((m) => m?.id).filter((id): id is string => typeof id === 'string');
            if (model && model.trim() && models.length > 0 && !models.includes(model.trim())) {
                return {
                    ok: true,
                    status: 200,
                    message: `Connected (HTTP 200), but model "${model}" is not in server list (${models.join(', ') || 'none'})`,
                    models,
                };
            }
            return {
                ok: true,
                status: 200,
                message: `Connected (HTTP 200) — ${models.length > 0 ? `${models.length} model(s) available` : 'ready'}`,
                models,
            };
        }


        return {
            ok: false,
            status: res.status,
            message: `Server returned HTTP ${res.status}`,
            models: [],
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            message: msg,
            models: [],
        };
    }
}

/** 16-bit mono PCM → WAV container. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
    const dataBytes = pcm.length * 2;
    const out = new Uint8Array(44 + dataBytes);
    const view = new DataView(out.buffer);
    const ascii = (offset: number, s: string) => {
        for (let i = 0; i < s.length; i++) {
            out[offset + i] = s.charCodeAt(i);
        }
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, dataBytes, true);
    for (let i = 0; i < pcm.length; i++) {
        view.setInt16(44 + i * 2, pcm[i], true);
    }
    return out;
}

export class SttClient {
    private resolvedModel: Promise<string> | undefined;

    constructor(private readonly config: SttConfig) {}

    async transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
        const form = new FormData();
        form.append('file', new Blob([encodeWav(pcm, sampleRate)], { type: 'audio/wav' }), 'speech.wav');
        form.append('model', await this.model());
        if (this.config.language.trim()) {
            form.append('language', this.config.language.trim());
        }
        form.append('response_format', 'json');
        const endpoint = `${sttBaseUrl(this.config.url)}${TRANSCRIPTIONS_PATH}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
            throw new Error(`POST ${endpoint} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const body = (await res.json()) as { text?: unknown };
        return typeof body.text === 'string' ? body.text.trim() : '';
    }

    private model(): Promise<string> {
        const configured = this.config.model.trim();
        if (configured) {
            return Promise.resolve(configured);
        }
        this.resolvedModel ??= listSttModels(this.config.url).then((ids) => {
            if (ids.length === 0) {
                throw new Error('Speech-to-text server lists no models; set oh-my-pi-chater.voice.sttModel.');
            }
            return ids[0];
        });
        // A failed lookup must not stick for the rest of the session.
        this.resolvedModel.catch(() => {
            this.resolvedModel = undefined;
        });
        return this.resolvedModel;
    }
}
