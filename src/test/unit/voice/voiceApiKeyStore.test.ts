/** Cloud API keys are stored per provider; the old per-service keys move to the provider their URL points at. */
const { config } = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: (section: string) => ({
            get: (key: string, def: unknown) => config[`${section}.${key}`] ?? def,
            inspect: (key: string) => ({ globalValue: config[`${section}.${key}`] }),
        }),
    },
}));

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { initVoiceApiKeys, resolveSttConfig, resolveTtsConfig, sendsApiKey, setVoiceApiKey, voiceApiKeysSet } from '../../../voice/voiceSettings';

function fakeSecrets(initial: Record<string, string>): { secrets: vscode.SecretStorage; store: Map<string, string> } {
    const store = new Map(Object.entries(initial));
    const secrets = {
        get: async (key: string) => store.get(key),
        store: async (key: string, value: string) => void store.set(key, value),
        delete: async (key: string) => void store.delete(key),
        onDidChange: () => ({ dispose: () => {} }),
    } as unknown as vscode.SecretStorage;
    return { secrets, store };
}

const stt = { sttEngine: 'custom' as const, sttUrl: '', sttModel: '', language: '', vadConfidence: 0.5, vadStopSecs: 0.8 };
const tts = { engine: 'custom' as const, languageField: 'none' as const, url: '', model: '', voice: '', speed: 1 };

describe('voice API keys per provider', () => {
    it("moves the old per-service key to its URL's provider, then sends each provider only its own key", async () => {
        config['oh-my-pi-chater.voice.sttUrl'] = 'https://api.groq.com/openai/v1';
        config['oh-my-pi-chater.voiceAgent.tts.url'] = 'http://127.0.0.1:8881/v1';
        const { secrets, store } = fakeSecrets({ 'oh-my-pi-chater.voice.sttApiKey': 'sk-groq', 'oh-my-pi-chater.voiceAgent.tts.apiKey': 'sk-unused' });
        initVoiceApiKeys(secrets);
        await vi.waitFor(() => expect(voiceApiKeysSet()).toEqual({ openai: false, groq: true }));
        // The TTS key pointed at your own server: no provider to move it to, so it stays unused.
        expect(Object.fromEntries(store)).toEqual({ 'oh-my-pi-chater.voice.apiKey.groq': 'sk-groq', 'oh-my-pi-chater.voiceAgent.tts.apiKey': 'sk-unused' });

        await setVoiceApiKey('openai', 'sk-openai');
        expect(await (await resolveSttConfig({ ...stt, sttUrl: 'https://api.groq.com/openai/v1' })).apiKey?.()).toBe('sk-groq');
        expect(await (await resolveSttConfig({ ...stt, sttUrl: 'https://api.openai.com/v1' })).apiKey?.()).toBe('sk-openai');
        expect(await (await resolveTtsConfig({ ...tts, url: 'https://api.openai.com/v1' })).apiKey?.()).toBe('sk-openai');
        expect((await resolveTtsConfig({ ...tts, url: 'http://127.0.0.1:8881/v1' })).apiKey).toBeUndefined();

        await setVoiceApiKey('groq', null);
        expect([sendsApiKey('stt', 'https://api.groq.com/openai/v1'), sendsApiKey('stt', 'https://api.openai.com/v1')]).toEqual([false, true]);
        await expect(setVoiceApiKey('elsewhere', 'sk')).rejects.toThrow(/Unknown voice provider/);
    });
});
