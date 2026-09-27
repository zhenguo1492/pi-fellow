import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictationStatus, SettingsServerMessage, VoiceSettings } from '../../../shared/protocol';
import { VoiceDryRun } from '../../../voice/voiceDryRun';
import { VoiceInput } from '../../../voice/voiceInput';

interface FakeSession {
    recording: boolean;
}

/** The VAD model load is settled by the test; every recording session made is kept. */
const fakes = vi.hoisted(() => ({
    /** Resolves once a start has asked for the model. */
    requested: undefined as unknown as PromiseWithResolvers<void>,
    settleLoad: () => {},
    sessions: [] as FakeSession[],
}));

vi.mock('vscode', () => ({
    Uri: { joinPath: (_base: unknown, ...parts: string[]) => ({ fsPath: parts.join('/') }) },
}));

vi.mock('../../../voice/sileroVad', () => ({
    SileroVad: {
        // Loading the ONNX model takes a while the first time: long enough for another message.
        load: () => {
            const { promise, resolve } = Promise.withResolvers<object>();
            fakes.settleLoad = () => resolve({});
            fakes.requested.resolve();
            return promise;
        },
    },
}));

vi.mock('../../../voice/dictation', () => ({
    dictationSegmenterParams: () => ({}),
    DictationSession: class {
        recording = false;
        constructor(
            _vad: unknown,
            _stt: unknown,
            _params: unknown,
            private readonly _events: { status(status: DictationStatus): void },
        ) {
            fakes.sessions.push(this);
        }
        get isRecording() {
            return this.recording;
        }
        start() {
            this.recording = true;
            this._events.status({ recording: true, speaking: false, pending: 0 });
        }
        async stop() {
            if (this.recording) {
                this.recording = false;
                this._events.status({ recording: false, speaking: false, pending: 0 });
            }
        }
    },
}));

const settings: VoiceSettings = { sttUrl: 'http://127.0.0.1:8010/v1', sttModel: '', language: '', vadConfidence: 0.5, vadStopSecs: 0.8 };

vi.mock('../../../voice/voiceSettings', () => ({
    readVoiceSettings: () => ({ sttUrl: 'http://127.0.0.1:8010/v1', sttModel: '', language: '', vadConfidence: 0.5, vadStopSecs: 0.8 }),
    sttCheck: () => ({ ok: true }),
}));

vi.mock('../../../providers/settings-panel', () => ({ SettingsPanel: { showWithSection: () => {} } }));

const recording = () => fakes.sessions.filter((s) => s.recording);

/** Finishes loading the VAD model, once a start has asked for it. */
async function vadLoaded(): Promise<void> {
    await fakes.requested.promise;
    fakes.settleLoad();
}

beforeEach(() => {
    fakes.requested = Promise.withResolvers<void>();
    fakes.sessions = [];
});

describe('settings STT dry run: a message arriving while the VAD model loads', () => {
    const events = (posted: SettingsServerMessage[], run: number) =>
        posted.flatMap((m) => (m.type === 'sttDryRun' && m.run === run ? [m.event.kind] : []));

    it('a stop (dialog closed) means the run never opens the microphone', async () => {
        const posted: SettingsServerMessage[] = [];
        const dryRun = new VoiceDryRun({} as never, (m) => posted.push(m));
        const starting = dryRun.startStt(1, settings);
        await dryRun.stopStt();
        await vadLoaded();
        await starting;
        expect(recording()).toHaveLength(0);
        expect(events(posted, 1)).toEqual(['ended']);
    });

    it('a newer start supersedes the one still loading: only it records', async () => {
        const posted: SettingsServerMessage[] = [];
        const dryRun = new VoiceDryRun({} as never, (m) => posted.push(m));
        const first = dryRun.startStt(1, settings);
        const second = dryRun.startStt(2, settings);
        await vadLoaded();
        await Promise.all([first, second]);
        expect(recording()).toHaveLength(1);
        expect(events(posted, 1)).toEqual(['ended']);
        expect(events(posted, 2)).toEqual(['status']);
        await dryRun.stopStt();
        expect(recording()).toHaveLength(0);
    });
});

describe('composer dictation: the mic pressed again while the VAD model loads', () => {
    const newInput = () => new VoiceInput({} as never, () => {}, { appendLine: () => {} } as never);

    it('cancels the start instead of being ignored', async () => {
        const input = newInput();
        const starting = input.toggle();
        await input.toggle();
        await vadLoaded();
        await starting;
        expect(recording()).toHaveLength(0);
        expect(input.isRecording).toBe(false);
    });

    it('does not carry the cancel over to the next start', async () => {
        const input = newInput();
        const starting = input.toggle();
        await input.toggle();
        await vadLoaded();
        await starting;
        // The model is cached now: this press starts recording at once.
        await input.toggle();
        expect(input.isRecording).toBe(true);
    });
});
