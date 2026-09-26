/**
 * Reachability check shared by the OpenAI-compatible speech services: `GET {base}/models`.
 */

export interface ModelsProbeResult {
    ok: boolean;
    status?: number;
    message: string;
    models: string[];
}

/**
 * `{base}` in front of `/models` and `endpointPath`: `url` may be the base or the full endpoint
 * URL, and a bare host (`http://127.0.0.1:8010`) means the OpenAI-standard `/v1` mount point.
 */
export function openAiBaseUrl(url: string, endpointPath: string): string {
    let base = url.trim().replace(/\/+$/, '');
    if (base.endsWith(endpointPath)) {
        base = base.slice(0, -endpointPath.length);
    }
    return new URL(base).pathname === '/' ? `${base}/v1` : base;
}

/** Valid only on HTTP 200 with a JSON model list; `label` names the service in messages. */
export async function probeModels(url: string, endpointPath: string, label: string): Promise<ModelsProbeResult> {
    let modelsUrl = url;
    try {
        modelsUrl = `${openAiBaseUrl(url, endpointPath)}/models`;
        const res = await fetch(modelsUrl, { signal: AbortSignal.timeout(8_000) });
        if (res.status !== 200) {
            return { ok: false, status: res.status, message: `GET ${modelsUrl} returned HTTP ${res.status}`, models: [] };
        }
        let body: unknown;
        try {
            body = await res.json();
        } catch {
            return { ok: false, status: 200, message: `The ${label} /models endpoint did not return JSON`, models: [] };
        }
        if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) {
            return { ok: false, status: 200, message: `The ${label} /models endpoint did not return a model list`, models: [] };
        }
        const models = body.data.flatMap((m: unknown) =>
            m && typeof m === 'object' && 'id' in m && typeof m.id === 'string' ? [m.id] : [],
        );
        return {
            ok: true,
            status: 200,
            message: `Connected (HTTP 200) — ${models.length > 0 ? `${models.length} model(s) available` : 'ready'}`,
            models,
        };
    } catch (err: unknown) {
        return { ok: false, message: `GET ${modelsUrl} failed: ${describeError(err)}`, models: [] };
    }
}

/** The error's message; Node's fetch says only "fetch failed", so its cause's code (ECONNREFUSED, …) is added. */
export function describeError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error ? err.cause : undefined;
    if (!cause || typeof cause !== 'object') {
        return msg;
    }
    if ('code' in cause && typeof cause.code === 'string') {
        return `${msg} (${cause.code})`;
    }
    return cause instanceof Error ? `${msg} (${cause.message})` : msg;
}
