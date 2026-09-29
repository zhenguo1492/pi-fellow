const { config } = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
    ConfigurationTarget: { Global: 1 },
    EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
    },
    workspace: {
        getConfiguration: (section: string) => ({
            get: (key: string, def: unknown) => config[`${section}.${key}`] ?? def,
            update: async () => {},
        }),
    },
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readVoiceprintSettings } from '../../../voice/voiceprint';

describe('voiceprint settings', () => {
    beforeEach(() => {
        for (const key of Object.keys(config)) {
            delete config[key];
        }
    });

    it('lets short speech through unchecked by default: your own "好了" scores low', () => {
        expect(readVoiceprintSettings().shortSpeech).toBe('accept');
        config['oh-my-pi-chater.voice.voiceprint.shortSpeech'] = 'something else';
        expect(readVoiceprintSettings().shortSpeech).toBe('accept');
    });

    it('checks short speech more strictly only when asked to', () => {
        config['oh-my-pi-chater.voice.voiceprint.shortSpeech'] = 'stricter';
        expect(readVoiceprintSettings().shortSpeech).toBe('stricter');
    });
});
