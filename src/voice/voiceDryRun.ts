/**
 * Recordings and dry runs from the settings page. STT records one sentence with the form's values
 * (saved or not) and shows its transcript; TTS synthesizes a text into a playable WAV. Voiceprint
 * runs record with the same capture: enrollment keeps one embedding per prompted sentence and saves
 * the voiceprint, the test compares each utterance with it.
 */
import * as vscode from 'vscode';
import type { SettingsServerMessage, SttDryRunEvent, VoiceSettings } from '../shared/protocol';
import { MIN_ENROLL_SECS, VOICEPRINT_PROMPTS, type VoiceprintRunEvent } from '../shared/voiceprint';
import { TtsClient, type TtsConfig } from '../voiceAgent/tts';
import { builtinVoiceEngineUrl } from './builtinEngine/engine';
import type { EngineFeature } from './builtinEngine/models';
import { DictationSession, dictationSegmenterParams, transcribeUtterance, type SegmentHandler } from './dictation';
import { SileroVad, VAD_SAMPLE_RATE } from './sileroVad';
import { describeError } from './modelsProbe';
import { SttClient, encodeWav } from './stt';
import { embedSpeech, readVoiceprintSettings, saveVoiceprint, speechGate, voiceprintTester } from './voiceprint';
import { readVoiceSettings, resolveSttConfig, resolveTtsConfig } from './voiceSettings';

const TTS_TIMEOUT_MS = 60_000;

/** What every recording reports, whatever it records for. */
type RecordingEvent = Extract<SttDryRunEvent, { kind: 'status' | 'level' | 'error' | 'ended' }>;

/** An enrollment recording: its embedding, or none when too short to keep. */
interface EnrollSample {
    seconds: number;
    embedding?: number[];
}

export class VoiceDryRun implements vscode.Disposable {
    private _session: DictationSession<unknown> | undefined;
    private _vad: Promise<SileroVad> | undefined;
    /** Bumped by every start, stop and dispose: a start that is no longer the latest never records. */
    private _generation = 0;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _post: (message: SettingsServerMessage) => void,
    ) {}

    /** Records until the first sentence is transcribed (or `stopStt`); events carry `run`. `apiKey`: typed, not stored. */
    async startStt(run: number, s: VoiceSettings, apiKey?: string): Promise<void> {
        const emit = (event: SttDryRunEvent) => this._post({ type: 'sttDryRun', run, event });
        await this._record<string>(s, emit, async (session) => {
            if (s.sttEngine === 'custom' && !s.sttUrl.trim()) {
                throw new Error('Enter a speech-to-text URL first.');
            }
            // The built-in engine may download its models and start here.
            const stt = await resolveSttConfig({ ...s, sttUrl: s.sttUrl.trim(), sttModel: s.sttModel.trim(), language: s.language.trim() }, apiKey);
            return {
                // What the service hears, not what the voiceprint lets through: the voiceprint has its own test.
                handle: transcribeUtterance(new SttClient(stt), undefined),
                // One sentence is enough: stop listening; speech already cut still gets transcribed.
                result: (text) => {
                    emit({ kind: 'text', text });
                    void session().stop();
                },
            };
        });
    }

    async stopStt(): Promise<void> {
        this._generation++;
        await this._session?.stop();
    }

    /**
     * Voiceprint recording with the saved listening settings; events carry `run`. `enroll`: one
     * recording per prompted sentence (too short ones asked for again), then the voiceprint is saved
     * and turned on. `test`: each utterance compared with the saved voiceprint, until `stopStt`.
     */
    async startVoiceprint(run: number, mode: 'enroll' | 'test'): Promise<void> {
        const emit = (event: VoiceprintRunEvent) => this._post({ type: 'voiceprintRun', run, event });
        // The speaker model (and noise reduction's, when on) is downloaded and loaded before the microphone opens, not mid-recording.
        const features: EngineFeature[] = readVoiceprintSettings().denoise ? ['speaker', 'denoise'] : ['speaker'];
        if (mode === 'test') {
            await this._record<VoiceprintRunEvent>(readVoiceSettings(), emit, async () => {
                await builtinVoiceEngineUrl(features);
                const tester = voiceprintTester();
                if (!tester) {
                    throw new Error('Record your voiceprint first.');
                }
                return {
                    handle: async (pcm) => {
                        const verdict = await tester.check(await speechGate.prepare(pcm, VAD_SAMPLE_RATE), VAD_SAMPLE_RATE);
                        switch (verdict.reason) {
                            case 'unavailable':
                                throw new Error(`The voiceprint check failed: ${verdict.error}`);
                            case 'compared':
                                return { kind: 'match', seconds: verdict.seconds, similarity: verdict.similarity, threshold: verdict.threshold, accepted: verdict.accepted };
                            default:
                                return { kind: 'match', seconds: pcm.length / VAD_SAMPLE_RATE, accepted: true };
                        }
                    },
                    result: emit,
                };
            });
            return;
        }
        await this._record<EnrollSample>(readVoiceSettings(), emit, async (session) => {
            await builtinVoiceEngineUrl(features);
            const embeddings: number[][] = [];
            let saving = false;
            return {
                handle: async (pcm) => {
                    const seconds = pcm.length / VAD_SAMPLE_RATE;
                    // Prepared as the check prepares what it compares: the same noise reduction, or none.
                    return seconds < MIN_ENROLL_SECS ? { seconds } : { seconds, embedding: await embedSpeech(await speechGate.prepare(pcm, VAD_SAMPLE_RATE), VAD_SAMPLE_RATE) };
                },
                result: (sample) => {
                    if (saving) {
                        return; // heard after the last prompt
                    }
                    if (sample.embedding) {
                        embeddings.push(sample.embedding);
                    }
                    emit({ kind: 'sample', ok: sample.embedding !== undefined, seconds: sample.seconds, count: embeddings.length });
                    if (embeddings.length < VOICEPRINT_PROMPTS.length) {
                        return;
                    }
                    saving = true;
                    void session().stop();
                    void saveVoiceprint(embeddings).then(
                        ({ consistency }) => emit({ kind: 'saved', samples: embeddings.length, consistency }),
                        (err: unknown) => emit({ kind: 'error', message: describeError(err) }),
                    );
                },
            };
        });
    }

    async synthesize(t: TtsConfig, text: string, apiKey?: string): Promise<void> {
        try {
            if (t.engine !== 'builtin' && !t.url.trim()) {
                throw new Error('Enter a text-to-speech URL first.');
            }
            if (!text.trim()) {
                throw new Error('Enter some text to synthesize.');
            }
            const config = await resolveTtsConfig({ ...t, url: t.url.trim(), model: t.model.trim(), voice: t.voice.trim() }, apiKey);
            const started = Date.now();
            const pcm = await new TtsClient(config).synthesize(text.trim(), AbortSignal.timeout(TTS_TIMEOUT_MS));
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

    /**
     * Opens the microphone for one recording (stopping any other), with the handler `prepare` sets up
     * once the VAD has loaded; `session` is the recording, for its handler to stop. Events carry the run.
     */
    private async _record<T>(
        s: VoiceSettings,
        emit: (event: RecordingEvent) => void,
        prepare: (session: () => DictationSession<T>) => Promise<{ handle: SegmentHandler<T>; result(value: T): void }>,
    ): Promise<void> {
        // Messages are not serialized: a stop may arrive while this still waits on the VAD model.
        const generation = ++this._generation;
        await this._session?.stop();
        try {
            this._vad ??= SileroVad.load(
                vscode.Uri.joinPath(this._extensionUri, 'media', 'vad', 'silero_vad.onnx').fsPath,
                vscode.Uri.joinPath(this._extensionUri, 'out', 'vad').fsPath,
            ).catch((err: unknown) => {
                this._vad = undefined;
                throw err;
            });
            const vad = await this._vad;
            let session: DictationSession<T> | undefined;
            const { handle, result } = await prepare(() => session!);
            if (generation !== this._generation) {
                // Stopped, closed or started again while the models loaded: this run never records.
                emit({ kind: 'ended' });
                return;
            }
            const recording: DictationSession<T> = new DictationSession<T>(
                vad,
                handle,
                dictationSegmenterParams(s),
                {
                    status: (status) => {
                        emit({ kind: 'status', status });
                        if (!status.recording && status.pending === 0 && this._session === recording) {
                            this._session = undefined;
                            emit({ kind: 'ended' });
                        }
                    },
                    result,
                    level: (level) => emit({ kind: 'level', level }),
                    error: (message) => emit({ kind: 'error', message }),
                },
                // Each utterance is handled as it ends.
                'asSpoken',
            );
            session = recording;
            recording.start();
            this._session = recording as DictationSession<unknown>;
        } catch (err: unknown) {
            emit({ kind: 'error', message: describeError(err) });
            emit({ kind: 'ended' });
        }
    }
}
