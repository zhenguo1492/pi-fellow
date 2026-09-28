import * as vscode from 'vscode';
import type { DictationStatus, ServerMessage } from '../shared/protocol';
import { SettingsPanel } from '../providers/settings-panel';
import { DictationSession, dictationSegmenterParams } from './dictation';
import { SileroVad } from './sileroVad';
import { SttClient } from './stt';
import { probeStt, readVoiceSettings, resolveSttConfig, sendsApiKey, sttCheck } from './voiceSettings';
import { explainVoiceError } from './voiceErrors';

/** Microphone dictation into the chat composer (mic button / `oh-my-pi-chater.toggleDictation`). */
export class VoiceInput implements vscode.Disposable {
    private current: DictationSession | undefined;
    /** Sessions still recording or still waiting on transcripts. */
    private readonly live = new Map<DictationSession, DictationStatus>();
    private vad: Promise<SileroVad> | undefined;
    private starting = false;
    /** Toggled off, or disposed, while `starting` still waits on the VAD model: that start never records. */
    private startCancelled = false;
    /** Voice mode owns the microphone; dictation stays off until it ends. */
    private blocked = false;
    /** A Bot view message is being replayed through the speakers: dictation drops what it hears. */
    private paused = false;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly post: (message: ServerMessage) => void,
        private readonly log: vscode.OutputChannel,
    ) {}

    get isRecording(): boolean {
        return this.current?.isRecording ?? false;
    }

    async toggle(): Promise<void> {
        if (this.current?.isRecording) {
            await this.current.stop();
            return;
        }
        if (this.starting) {
            // The second press of the mic while the model loads: the user no longer wants to record.
            this.startCancelled = true;
            return;
        }
        await this.start();
    }

    /** Stops dictation and refuses to start it while `blocked` (voice mode is on). */
    async setBlocked(blocked: boolean): Promise<void> {
        this.blocked = blocked;
        if (blocked && this.current?.isRecording) {
            await this.current.stop();
        }
    }

    /** While a Bot view message is replayed without voice mode, dictation drops what the microphone hears (it has no echo cancellation). */
    setPaused(paused: boolean): void {
        if (paused === this.paused) {
            return;
        }
        this.paused = paused;
        this.current?.setPaused(paused);
    }

    dispose(): void {
        this.startCancelled = true;
        void this.current?.stop();
    }

    private async start(): Promise<void> {
        if (this.starting) {
            return;
        }
        if (this.blocked) {
            this.post({ type: 'toast', message: 'Voice mode is using the microphone — dictation is off until voice mode ends.' });
            return;
        }
        this.starting = true;
        this.startCancelled = false;
        try {
            // A failed check may be out of date (the server started since, the built-in engine retried): check again first.
            if (!sttCheck().ok) {
                await probeStt();
            }
            const stt = sttCheck();
            if (!stt.ok) {
                this.post({ type: 'toast', variant: 'error', message: stt.reason ?? 'Speech-to-text is unavailable.' });
                SettingsPanel.showWithSection('voice');
                return;
            }
            const settings = readVoiceSettings();
            this.vad ??= SileroVad.load(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'vad', 'silero_vad.onnx').fsPath,
                vscode.Uri.joinPath(this.extensionUri, 'out', 'vad').fsPath,
            ).catch((err: unknown) => {
                this.vad = undefined;
                throw err;
            });
            const vad = await this.vad;
            // The built-in engine may download its models and start here.
            const sttConfig = await resolveSttConfig(settings);
            // Voice mode may have started, or the user changed their mind, while the VAD model or the engine was loading.
            if (this.blocked || this.startCancelled) {
                return;
            }
            const session: DictationSession = new DictationSession(
                vad,
                new SttClient(sttConfig),
                dictationSegmenterParams(settings),
                {
                    status: (status) => this.onStatus(session, status),
                    text: (text) => this.post({ type: 'dictationText', text }),
                    level: (level, wave) => this.post({ type: 'dictationLevel', level, wave }),
                    error: (message) => this.fail(message),
                },
                // Stop, then transcribe: the mic spins until the text lands.
                'onStop',
            );
            this.current = session;
            session.setPaused(this.paused);
            session.start();
            this.log.appendLine(`[voice] dictation started → ${sttConfig.url}`);
        } catch (err) {
            this.fail(err);
        } finally {
            this.starting = false;
        }
    }

    private onStatus(session: DictationSession, status: DictationStatus): void {
        if (status.recording || status.pending > 0) {
            this.live.set(session, status);
        } else {
            this.live.delete(session);
        }
        const all = [...this.live.values()];
        this.post({
            type: 'dictationStatus',
            status: {
                recording: all.some((s) => s.recording),
                speaking: all.some((s) => s.speaking),
                pending: all.reduce((sum, s) => sum + s.pending, 0),
            },
        });
    }

    /** Logs the failure as it is and shows it in plain language (see explainVoiceError). */
    private fail(err: unknown): void {
        const explained = explainVoiceError(err, { service: 'stt', hasKey: sendsApiKey('stt', readVoiceSettings().sttUrl) });
        this.log.appendLine(`[voice] ${explained.detail}`);
        this.post({ type: 'toast', variant: 'error', message: `Voice input: ${explained.message}` });
    }
}
