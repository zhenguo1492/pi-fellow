/** The old `voiceAgent.tts.provider` (kinds of server, then builtin/custom) reads as, and moves to, `tts.engine` + language field. */
const { store } = vi.hoisted(() => ({
    /** `voiceAgent` settings by target: 1 = user (Global), 2 = workspace. */
    store: { 1: {} as Record<string, unknown>, 2: {} as Record<string, unknown> },
}));

vi.mock('vscode', () => ({
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
        getConfiguration: () => {
            // A snapshot, as VS Code's is: later updates show in the next getConfiguration.
            const snapshot = { 1: { ...store[1] }, 2: { ...store[2] } };
            return {
                get: (key: string, def: unknown) => snapshot[2][key] ?? snapshot[1][key] ?? def,
                inspect: (key: string) => ({ globalValue: snapshot[1][key], workspaceValue: snapshot[2][key] }),
                update: async (key: string, value: unknown, target: 1 | 2) => {
                    // Writing undefined removes the key, as in VS Code.
                    if (value === undefined) {
                        delete store[target][key];
                    } else {
                        store[target][key] = value;
                    }
                },
            };
        },
    },
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateTtsSettings, readTtsSettings } from '../../../voice/voiceSettings';

describe('TTS settings migration', () => {
    beforeEach(() => {
        store[1] = {};
        store[2] = {};
    });

    it('reads each old provider as the custom engine with its language field and old default model and voice', () => {
        const url = 'http://127.0.0.1:8881/v1';
        store[1] = { 'tts.provider': 'chatterbox', 'tts.url': url };
        expect(readTtsSettings()).toMatchObject({ engine: 'custom', languageField: 'perSentence', url, model: 'chatterbox-multilingual', voice: 'default' });

        store[1] = { 'tts.provider': 'kokoro', 'tts.url': url, 'tts.voice': 'zf_xiaobei' };
        expect(readTtsSettings()).toMatchObject({ engine: 'custom', languageField: 'chineseLangCode', model: 'kokoro', voice: 'zf_xiaobei' });

        // The old generic value never had defaults worth keeping: nothing is sent.
        store[1] = { 'tts.provider': 'openai', 'tts.url': url };
        expect(readTtsSettings()).toMatchObject({ engine: 'custom', languageField: 'none', model: '', voice: '' });
    });

    it('reads tts.engine first, then the old provider, then infers it from the URL like the STT engine', () => {
        expect(readTtsSettings()).toMatchObject({ engine: 'builtin', languageField: 'none' });
        store[1] = { 'tts.url': 'http://127.0.0.1:8881/v1' };
        expect(readTtsSettings().engine).toBe('custom');
        store[1] = { 'tts.url': 'http://127.0.0.1:8881/v1', 'tts.provider': 'builtin' };
        expect(readTtsSettings().engine).toBe('builtin');
        store[1] = { 'tts.provider': 'custom' };
        expect(readTtsSettings().engine).toBe('custom');
        // A stale old value implies nothing once the engine is set.
        store[1] = { 'tts.engine': 'builtin', 'tts.provider': 'chatterbox', 'tts.url': 'http://127.0.0.1:8881/v1' };
        expect(readTtsSettings()).toMatchObject({ engine: 'builtin', languageField: 'none', model: '', voice: '' });
    });

    it('moves the provider the previous migration left (custom) to tts.engine and removes it', async () => {
        store[1] = { 'tts.provider': 'custom', 'tts.url': 'http://127.0.0.1:8881/v1', 'tts.languageField': 'perSentence', 'tts.model': 'chatterbox-multilingual', 'tts.voice': 'Justin.mp3' };
        const before = readTtsSettings();
        await migrateTtsSettings();
        expect(store[1]).toEqual({ 'tts.engine': 'custom', 'tts.url': 'http://127.0.0.1:8881/v1', 'tts.languageField': 'perSentence', 'tts.model': 'chatterbox-multilingual', 'tts.voice': 'Justin.mp3' });
        expect(readTtsSettings()).toEqual(before);

        store[2] = { 'tts.provider': 'builtin' };
        await migrateTtsSettings();
        expect(store[2]).toEqual({ 'tts.engine': 'builtin' });
    });

    it('writes what the old value implied at its own target, then the engine, removes the provider, and reads the same after', async () => {
        store[1] = { 'tts.provider': 'chatterbox', 'tts.url': 'http://127.0.0.1:8881/v1' };
        store[2] = { 'tts.provider': 'kokoro', 'tts.model': 'kokoro-v1' };
        const before = readTtsSettings();

        await migrateTtsSettings();

        expect(store[1]).toEqual({
            'tts.engine': 'custom',
            'tts.url': 'http://127.0.0.1:8881/v1',
            'tts.languageField': 'perSentence',
            'tts.model': 'chatterbox-multilingual',
            'tts.voice': 'default',
        });
        // The workspace keeps its own model and gets the old default voice only.
        expect(store[2]).toEqual({ 'tts.engine': 'custom', 'tts.model': 'kokoro-v1', 'tts.voice': 'af_sarah', 'tts.languageField': 'chineseLangCode' });
        expect(readTtsSettings()).toEqual(before);

        // Once migrated there is nothing left to do.
        const migrated = structuredClone(store);
        await migrateTtsSettings();
        expect(store).toEqual(migrated);
    });

    it('leaves new values and an explicitly chosen language field alone', async () => {
        store[1] = { 'tts.provider': 'chatterbox', 'tts.languageField': 'none', 'tts.model': 'm', 'tts.voice': 'v' };
        await migrateTtsSettings();
        expect(store[1]).toEqual({ 'tts.engine': 'custom', 'tts.languageField': 'none', 'tts.model': 'm', 'tts.voice': 'v' });

        // An engine already set wins; the stale provider just goes.
        store[1] = { 'tts.engine': 'builtin', 'tts.provider': 'kokoro' };
        await migrateTtsSettings();
        expect(store[1]).toEqual({ 'tts.engine': 'builtin' });
    });
});
