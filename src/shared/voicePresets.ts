/**
 * Cloud services the custom STT / TTS engines can be pointed at in one pick (Settings → Voice,
 * "Cloud service"). A preset only fills the settings it lists; nothing records which one was
 * picked (the URL tells). Services that do not speak the OpenAI-compatible API would need an adapter
 * before they can be listed here.
 */

/** A cloud provider: presets with its `id` are its services; one API key serves them all. */
export interface CloudProvider {
    id: string;
    label: string;
    /** Where the user makes an API key (opened in the browser by the host). */
    apiKeyUrl: string;
}

export const CLOUD_PROVIDERS: readonly CloudProvider[] = [
    { id: 'openai', label: 'OpenAI', apiKeyUrl: 'https://platform.openai.com/api-keys' },
    { id: 'groq', label: 'Groq', apiKeyUrl: 'https://console.groq.com/keys' },
];

export interface VoicePreset {
    id: string;
    label: string;
    /** Settings field key (`voice.sttUrl`, `voiceAgent.tts.voice`, …) → the value the preset fills in. */
    fields: Readonly<Record<string, string>>;
    /** The service rejects requests without an API key. */
    needsApiKey: boolean;
    /** Shown while the preset's service is the one configured. */
    note?: string;
    /** Text-to-speech: the voices the service offers, for the Cloud card's Voice picker (the first is the default). */
    voices?: readonly string[];
    /** Text-to-speech: the most characters one request may carry; longer sentences are sent in pieces. */
    maxInputChars?: number;
}

/** The field whose value tells which preset's service is configured. */
export const PRESET_URL_FIELD = { stt: 'voice.sttUrl', tts: 'voiceAgent.tts.url' } as const;

export const VOICE_PRESETS: Readonly<Record<keyof typeof PRESET_URL_FIELD, readonly VoicePreset[]>> = {
    stt: [
        {
            id: 'openai',
            label: 'OpenAI',
            fields: { 'voice.sttUrl': 'https://api.openai.com/v1', 'voice.sttModel': 'gpt-4o-mini-transcribe' },
            needsApiKey: true,
            note: 'OpenAI also serves gpt-4o-transcribe and whisper-1.',
        },
        {
            id: 'groq',
            label: 'Groq',
            fields: { 'voice.sttUrl': 'https://api.groq.com/openai/v1', 'voice.sttModel': 'whisper-large-v3-turbo' },
            needsApiKey: true,
            note: 'Groq also serves whisper-large-v3.',
        },
    ],
    tts: [
        {
            id: 'openai',
            label: 'OpenAI',
            fields: {
                'voiceAgent.tts.url': 'https://api.openai.com/v1',
                'voiceAgent.tts.model': 'gpt-4o-mini-tts',
                'voiceAgent.tts.voice': 'marin',
                'voiceAgent.tts.languageField': 'none',
            },
            needsApiKey: true,
            note: 'OpenAI also serves tts-1 and tts-1-hd (which take fewer voices).',
            // developers.openai.com/api/docs/guides/text-to-speech: marin and cedar are its best-quality voices.
            voices: ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'],
        },
        {
            // console.groq.com/docs/text-to-speech/orpheus: English only, wav, at most 200 characters per
            // request (TtsClient splits longer sentences); the API reference takes `speed` 0.5–5.
            id: 'groq',
            label: 'Groq',
            fields: {
                'voiceAgent.tts.url': 'https://api.groq.com/openai/v1',
                'voiceAgent.tts.model': 'canopylabs/orpheus-v1-english',
                'voiceAgent.tts.voice': 'troy',
                'voiceAgent.tts.languageField': 'none',
            },
            needsApiKey: true,
            note: 'Groq speaks English only (Orpheus).',
            voices: ['troy', 'austin', 'daniel', 'autumn', 'diana', 'hannah'],
            maxInputChars: 200,
        },
    ],
};

/** The preset whose service `url` points at (trailing slashes aside), if any. */
export function presetForUrl(service: keyof typeof PRESET_URL_FIELD, url: string): VoicePreset | undefined {
    const normalized = url.trim().replace(/\/+$/, '');
    return normalized ? VOICE_PRESETS[service].find((p) => p.fields[PRESET_URL_FIELD[service]] === normalized) : undefined;
}
