/**
 * Plain-language explanations of the ways a speech service fails (settings Test, readiness, dictation,
 * voice mode): what went wrong and what to do next, instead of "fetch failed (ECONNREFUSED)".
 */
import { describeError } from './modelsProbe';

export type VoiceErrorKind = 'notRunning' | 'badHost' | 'needsKey' | 'badKey' | 'notFound' | 'rateLimited' | 'serverError' | 'timeout' | 'notSpeechService' | 'other';

export interface VoiceErrorExplanation {
    kind: VoiceErrorKind;
    /** What went wrong and the next step, for people. */
    message: string;
    /** The original error, for the log and a tooltip. */
    detail: string;
    /** Settings → Voice is where it gets fixed. */
    openSettings: boolean;
}

export interface VoiceErrorContext {
    /** Which service failed; unknown: "the voice service". */
    service?: 'stt' | 'tts';
    /** An API key was sent. */
    hasKey?: boolean;
}

const SERVICE_NAMES = { stt: 'speech-to-text service', tts: 'text-to-speech service' } as const;

/** The first `code` in the error's cause chain (ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, …). */
function causeCode(err: unknown): string | undefined {
    for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
        if ('code' in e && typeof e.code === 'string') {
            return e.code;
        }
        e = 'cause' in e ? e.cause : undefined;
    }
    return undefined;
}

/** A failure of a known service, so its explanation can name it: `message` keeps the cause's code. */
export class VoiceServiceError extends Error {
    constructor(
        readonly service: 'stt' | 'tts',
        cause: unknown,
        readonly hasKey?: boolean,
    ) {
        super(describeError(cause), { cause });
        this.name = 'VoiceServiceError';
    }
}

export function explainVoiceError(err: unknown, context: VoiceErrorContext = {}): VoiceErrorExplanation {
    if (err instanceof VoiceServiceError) {
        context = { service: err.service, hasKey: err.hasKey, ...context };
    }
    const detail = typeof err === 'string' ? err : err instanceof VoiceServiceError ? err.message : describeError(err);
    const name = context.service ? SERVICE_NAMES[context.service] : 'voice service';
    const host = /https?:\/\/([^/\s:]+(?::\d+)?)/.exec(detail)?.[1];
    const at = host ? ` at ${host}` : '';
    // Messages carry the code in parentheses (describeError) when it is not on the error itself.
    const code = causeCode(err) ?? /\((E[A-Z]+|UND_ERR_[A-Z_]+)\)/.exec(detail)?.[1];
    const status = Number(/\bHTTP (\d{3})\b/.exec(detail)?.[1] ?? 0);
    const timedOut =
        (err instanceof Error && err.name === 'TimeoutError') || /timed? ?out|aborted due to timeout/i.test(detail) || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT';
    const explain = (kind: VoiceErrorKind, message: string, openSettings = true): VoiceErrorExplanation => ({ kind, message, detail, openSettings });

    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
        return explain('notRunning', `The ${name} isn't running${at}. Start it (see "How to set up voice" in Settings → Voice), or switch to Built-in.`);
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return explain('badHost', `Can't find ${host ?? 'the server'}. Check the URL for typos, and your internet connection.`);
    }
    if (timedOut) {
        return explain('timeout', `The ${name}${at} didn't answer in time. Check that it's running and reachable, then try again.`);
    }
    if (status === 401 || status === 403) {
        return context.hasKey
            ? explain('badKey', `The ${name} rejected the API key. Check the key (use "Get API key" to make a new one) and save it again.`)
            : explain('needsKey', `The ${name}${at} needs an API key. Paste it in Settings → Voice and save.`);
    }
    if (status === 404) {
        return explain('notFound', `Nothing found at this address${at}. Check the URL (it usually ends in /v1) and the model name.`);
    }
    if (status === 429) {
        return explain('rateLimited', `The ${name} is refusing more requests right now (rate limit or used-up quota). Wait a moment, or check your plan.`, false);
    }
    if (status >= 500) {
        return explain('serverError', `The ${name}${at} had an internal error (HTTP ${status}). Try again; if it keeps happening, check the server's logs.`, false);
    }
    if (/did not return (JSON|a model list)|did not return WAV/.test(detail)) {
        return explain('notSpeechService', `Something answered${at}, but it isn't an OpenAI-compatible speech service. Check the URL.`);
    }
    return explain('other', detail, false);
}
