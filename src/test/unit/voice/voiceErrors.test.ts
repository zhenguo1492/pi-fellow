import { describe, expect, it } from 'vitest';
import { VoiceServiceError, explainVoiceError } from '../../../voice/voiceErrors';

const refused = () => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });

describe('explainVoiceError', () => {
    it('says the service is not running when the connection is refused, naming where', () => {
        const res = explainVoiceError('GET http://127.0.0.1:8010/v1/models failed: fetch failed (ECONNREFUSED)', { service: 'stt' });
        expect(res).toMatchObject({ kind: 'notRunning', openSettings: true });
        expect(res.message).toContain("speech-to-text service isn't running at 127.0.0.1:8010");
        expect(res.detail).toContain('ECONNREFUSED');
    });

    it('names the service of an error from voice mode, whose code is on the cause', () => {
        const res = explainVoiceError(new VoiceServiceError('stt', refused()));
        expect(res.kind).toBe('notRunning');
        expect(res.message).toContain('speech-to-text service');
    });

    it('tells a rejected key from a missing one', () => {
        const unauthorized = 'GET https://api.openai.com/v1/models returned HTTP 401';
        expect(explainVoiceError(unauthorized, { service: 'tts', hasKey: true })).toMatchObject({ kind: 'badKey', message: expect.stringContaining('rejected the API key') });
        expect(explainVoiceError(unauthorized, { service: 'tts', hasKey: false })).toMatchObject({ kind: 'needsKey', message: expect.stringContaining('needs an API key') });
        expect(explainVoiceError('POST https://api.groq.com/openai/v1/audio/transcriptions → HTTP 403: forbidden', { hasKey: true }).kind).toBe('badKey');
    });

    it('explains a wrong address, an unknown host, a timeout, limits and server errors', () => {
        expect(explainVoiceError('GET http://localhost:8000/models returned HTTP 404').message).toContain('usually ends in /v1');
        expect(explainVoiceError('GET https://api.opnai.com/v1/models failed: fetch failed (ENOTFOUND)').message).toContain("Can't find api.opnai.com");
        expect(explainVoiceError('GET http://10.0.0.5:8010/v1/models failed: The operation was aborted due to timeout', { service: 'stt' }).kind).toBe('timeout');
        expect(explainVoiceError('POST https://api.openai.com/v1/audio/speech → HTTP 429: quota', { service: 'tts' })).toMatchObject({ kind: 'rateLimited', openSettings: false });
        expect(explainVoiceError('POST http://127.0.0.1:8881/v1/audio/speech → HTTP 503: busy').kind).toBe('serverError');
        expect(explainVoiceError('The TTS /models endpoint did not return JSON').kind).toBe('notSpeechService');
    });

    it('passes anything else through as it is', () => {
        const res = explainVoiceError(new Error('arecord: spawn arecord ENOENT'));
        expect(res).toEqual({ kind: 'other', message: 'arecord: spawn arecord ENOENT', detail: 'arecord: spawn arecord ENOENT', openSettings: false });
    });
});
