/** A Cloud save overwrites the same settings as your own servers: those are remembered first. */
const { config } = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
    ConfigurationTarget: { Global: 1 },
    workspace: {
        getConfiguration: (section: string) => ({
            get: (key: string, def: unknown) => config[`${section}.${key}`] ?? def,
            inspect: (key: string) => ({ globalValue: config[`${section}.${key}`] }),
            update: async (key: string, value: unknown) => {
                config[`${section}.${key}`] = value;
            },
        }),
    },
}));

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { initVoiceMemory, ownVoiceServers, saveTtsSettings, saveVoiceSettings } from '../../../voice/voiceSettings';

describe('own voice servers', () => {
    it('are remembered when a cloud setup is saved over them, and not replaced by it', async () => {
        Object.assign(config, {
            'oh-my-pi-chater.voice.sttEngine': 'custom',
            'oh-my-pi-chater.voice.sttUrl': 'http://127.0.0.1:8010/v1',
            'oh-my-pi-chater.voice.sttModel': 'Systran/faster-whisper-large-v3',
            'oh-my-pi-chater.voiceAgent.tts.engine': 'custom',
            'oh-my-pi-chater.voiceAgent.tts.url': 'http://127.0.0.1:8881/v1',
            'oh-my-pi-chater.voiceAgent.tts.model': 'chatterbox-multilingual',
            'oh-my-pi-chater.voiceAgent.tts.voice': 'Justin.mp3',
            'oh-my-pi-chater.voiceAgent.tts.languageField': 'perSentence',
        });
        const state = new Map<string, unknown>();
        initVoiceMemory({ get: (key: string) => state.get(key), update: async (key: string, value: unknown) => void state.set(key, value) } as unknown as vscode.Memento);

        await saveVoiceSettings({ sttEngine: 'custom', sttUrl: 'https://api.openai.com/v1', sttModel: 'gpt-4o-mini-transcribe', language: '', vadConfidence: 0.5, vadStopSecs: 0.8 });
        await saveTtsSettings({ engine: 'custom', languageField: 'none', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy', speed: 1 });

        expect(config['oh-my-pi-chater.voice.sttUrl']).toBe('https://api.openai.com/v1');
        expect(ownVoiceServers()).toEqual({
            stt: { 'voice.sttUrl': 'http://127.0.0.1:8010/v1', 'voice.sttModel': 'Systran/faster-whisper-large-v3' },
            tts: {
                'voiceAgent.tts.url': 'http://127.0.0.1:8881/v1',
                'voiceAgent.tts.model': 'chatterbox-multilingual',
                'voiceAgent.tts.voice': 'Justin.mp3',
                'voiceAgent.tts.languageField': 'perSentence',
            },
        });

        // A new own server replaces the remembered one.
        await saveVoiceSettings({ sttEngine: 'custom', sttUrl: 'http://127.0.0.1:8000/v1', sttModel: 'small', language: '', vadConfidence: 0.5, vadStopSecs: 0.8 });
        expect(ownVoiceServers().stt).toEqual({ 'voice.sttUrl': 'http://127.0.0.1:8000/v1', 'voice.sttModel': 'small' });
    });
});
