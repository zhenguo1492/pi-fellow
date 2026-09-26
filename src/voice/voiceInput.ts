import * as vscode from 'vscode';
import type { DictationStatus, ServerMessage } from '../shared/protocol';
import { SettingsPanel } from '../providers/settings-panel';
import { DictationSession, dictationSegmenterParams } from './dictation';
import { SileroVad } from './sileroVad';
import { SttClient } from './stt';
import { readVoiceSettings, sttCheck } from './voiceSettings';

/** Microphone dictation into the chat composer (mic button / `oh-my-pi-chater.toggleDictation`). */
export class VoiceInput implements vscode.Disposable {
    private current: DictationSession | undefined;
    /** Sessions still recording or still waiting on transcripts. */
    private readonly live = new Map<DictationSession, DictationStatus>();
    private vad: Promise<SileroVad> | undefined;
    private starting = false;
    /** Voice mode owns the microphone; dictation stays off until it ends. */
    private blocked = false;

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
        await this.start();
    }

    /** Stops dictation and refuses to start it while `blocked` (voice mode is on). */
    async setBlocked(blocked: boolean): Promise<void> {
        this.blocked = blocked;
        if (blocked && this.current?.isRecording) {
            await this.current.stop();
        }
    }

    dispose(): void {
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
        const settings = readVoiceSettings();
        const stt = sttCheck();
        if (!stt.ok) {
            this.post({ type: 'toast', variant: 'error', message: stt.reason ?? 'Speech-to-text is unavailable.' });
            SettingsPanel.showWithSection('stt');
            return;
        }
        this.starting = true;
        try {
            this.vad ??= SileroVad.load(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'vad', 'silero_vad.onnx').fsPath,
                vscode.Uri.joinPath(this.extensionUri, 'out', 'vad').fsPath,
            ).catch((err: unknown) => {
                this.vad = undefined;
                throw err;
            });
            const vad = await this.vad;
            // Voice mode may have started while the VAD model was loading.
            if (this.blocked) {
                return;
            }
            const session: DictationSession = new DictationSession(
                vad,
                new SttClient({ url: settings.sttUrl, model: settings.sttModel, language: settings.language }),
                dictationSegmenterParams(settings),
                {
                    status: (status) => this.onStatus(session, status),
                    text: (text) => this.post({ type: 'dictationText', text }),
                    level: (level, bands) => this.post({ type: 'dictationLevel', level, bands }),
                    error: (message) => this.fail(message),
                },
                // Stop, then transcribe: the mic spins until the text lands.
                'onStop',
            );
            this.current = session;
            session.start();
            this.log.appendLine(`[voice] dictation started → ${settings.sttUrl}`);
        } catch (err) {
            this.fail(err instanceof Error ? err.message : String(err));
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

    private fail(message: string): void {
        this.log.appendLine(`[voice] ${message}`);
        this.post({ type: 'toast', variant: 'error', message: `Voice input: ${message}` });
    }
}
