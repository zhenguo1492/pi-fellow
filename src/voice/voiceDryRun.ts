/**
 * Dry runs from the settings page, with the form's values (saved or not): STT records one
 * sentence and shows its transcript; TTS synthesizes a text into a playable WAV.
 */
import * as vscode from 'vscode';
import type { SettingsServerMessage, SttDryRunEvent, VoiceSettings } from '../shared/protocol';
import { TtsClient, type TtsConfig } from '../voiceAgent/tts';
import { DictationSession, dictationSegmenterParams } from './dictation';
import { SileroVad } from './sileroVad';
import { describeError } from './modelsProbe';
import { SttClient, encodeWav } from './stt';

const TTS_TIMEOUT_MS = 60_000;

export class VoiceDryRun implements vscode.Disposable {
    private _session: DictationSession | undefined;
    private _vad: Promise<SileroVad> | undefined;
    /** Bumped by every start, stop and dispose: a start that is no longer the latest never records. */
    private _generation = 0;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _post: (message: SettingsServerMessage) => void,
    ) {}

    /** Records until the first sentence is transcribed (or `stopStt`); events carry `run`. */
    async startStt(run: number, s: VoiceSettings): Promise<void> {
        // Messages are not serialized: a stop may arrive while this still waits on the VAD model.
        const generation = ++this._generation;
        await this._session?.stop();
        const emit = (event: SttDryRunEvent) => this._post({ type: 'sttDryRun', run, event });
        try {
            if (!s.sttUrl.trim()) {
                throw new Error('Enter a speech-to-text URL first.');
            }
            this._vad ??= SileroVad.load(
                vscode.Uri.joinPath(this._extensionUri, 'media', 'vad', 'silero_vad.onnx').fsPath,
                vscode.Uri.joinPath(this._extensionUri, 'out', 'vad').fsPath,
            ).catch((err: unknown) => {
                this._vad = undefined;
                throw err;
            });
            const vad = await this._vad;
            if (generation !== this._generation) {
                // Stopped, closed or started again while the model loaded: this run never records.
                emit({ kind: 'ended' });
                return;
            }
            const session: DictationSession = new DictationSession(
                vad,
                new SttClient({ url: s.sttUrl.trim(), model: s.sttModel.trim(), language: s.language.trim() }),
                dictationSegmenterParams(s),
                {
                    status: (status) => {
                        emit({ kind: 'status', status });
                        if (!status.recording && status.pending === 0 && this._session === session) {
                            this._session = undefined;
                            emit({ kind: 'ended' });
                        }
                    },
                    // One sentence is enough: stop listening; speech already cut still gets transcribed.
                    text: (text) => {
                        emit({ kind: 'text', text });
                        void session.stop();
                    },
                    level: (level) => emit({ kind: 'level', level }),
                    error: (message) => emit({ kind: 'error', message }),
                },
                // Transcribe each sentence as it ends: the first one ends the run.
                'asSpoken',
            );
            session.start();
            this._session = session;
        } catch (err: unknown) {
            emit({ kind: 'error', message: describeError(err) });
            emit({ kind: 'ended' });
        }
    }

    async stopStt(): Promise<void> {
        this._generation++;
        await this._session?.stop();
    }

    async synthesize(t: TtsConfig, text: string): Promise<void> {
        try {
            if (!t.url.trim()) {
                throw new Error('Enter a text-to-speech URL first.');
            }
            if (!text.trim()) {
                throw new Error('Enter some text to synthesize.');
            }
            const started = Date.now();
            const pcm = await new TtsClient({ ...t, url: t.url.trim(), model: t.model.trim(), voice: t.voice.trim() }).synthesize(
                text.trim(),
                AbortSignal.timeout(TTS_TIMEOUT_MS),
            );
            // Copy into a fresh buffer: an Int16Array view needs an even byte offset.
            const wav = encodeWav(new Int16Array(new Uint8Array(pcm.data).buffer), pcm.rate);
            this._post({
                type: 'ttsDryRunResult',
                ok: true,
                audio: `data:audio/wav;base64,${Buffer.from(wav).toString('base64')}`,
                seconds: pcm.data.length / 2 / pcm.rate,
                elapsedMs: Date.now() - started,
            });
        } catch (err: unknown) {
            this._post({ type: 'ttsDryRunResult', ok: false, message: describeError(err) });
        }
    }

    dispose(): void {
        this._generation++;
        void this._session?.stop();
    }
}
