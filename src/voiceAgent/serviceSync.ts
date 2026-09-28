/**
 * Keeps a running voice mode's speech services in step with their readiness and settings
 * (docs/voice-agent-design.md §5.13), so nothing needs the voice agent restarted:
 * - a service voice mode runs without is picked up as soon as its readiness is ok (the settings
 *   fixed, the server started, the built-in engine retried);
 * - a service it uses gets the new settings as soon as they change; its requests' outcomes then
 *   keep readiness, and the tag, up to date;
 * - a service failing is left attached: it falls back to text request by request, and works again
 *   when the service does.
 */
import type { VoiceReadiness } from '../shared/protocol';
import type { SttConfig } from '../voice/stt';
import { describeError } from '../voice/modelsProbe';
import type { TtsRequestConfig } from './tts';

export type VoiceService = keyof VoiceReadiness;

/** What the sync drives: a running voice mode (VoiceMode). */
export interface SyncedVoiceMode {
    uses(service: VoiceService): boolean;
    useStt(config: SttConfig): Promise<void>;
    useTts(config: TtsRequestConfig): Promise<void>;
}

export interface VoiceServiceSyncDeps {
    readiness(): VoiceReadiness;
    /** The service's settings as configured now, comparable as a string. */
    settings(service: VoiceService): string;
    resolveStt(): Promise<SttConfig>;
    resolveTts(): Promise<TtsRequestConfig>;
    /** Voice mode picked the service up (`attached`) or took its new settings (`updated`): publish its status. */
    onChange(service: VoiceService, how: 'attached' | 'updated'): void;
    log(line: string): void;
}

const LABELS: Record<VoiceService, string> = { stt: 'speech-to-text', tts: 'text-to-speech' };

export class VoiceServiceSync {
    /** The settings each service of voice mode runs with; undefined while it runs without it. */
    private readonly _settings: Record<VoiceService, string | undefined>;
    private _running: Promise<void> | undefined;
    private _again = false;
    private _disposed = false;

    /** `started`: the settings voice mode started each service it uses with. */
    constructor(
        private readonly _mode: SyncedVoiceMode,
        started: Record<VoiceService, string | undefined>,
        private readonly _deps: VoiceServiceSyncDeps,
    ) {
        this._settings = {
            stt: _mode.uses('stt') ? started.stt : undefined,
            tts: _mode.uses('tts') ? started.tts : undefined,
        };
    }

    /**
     * Brings voice mode in step with readiness and settings now; call on every change of either.
     * Calls during a sync run it once more after it, with what has changed by then.
     */
    sync(): Promise<void> {
        if (this._running) {
            this._again = true;
            return this._running;
        }
        this._running = (async () => {
            do {
                this._again = false;
                for (const service of ['stt', 'tts'] as const) {
                    await this._syncOne(service);
                }
            } while (this._again && !this._disposed);
        })().finally(() => {
            this._running = undefined;
        });
        return this._running;
    }

    /** Voice mode stopped: nothing more is attached to it. */
    dispose(): void {
        this._disposed = true;
    }

    private async _syncOne(service: VoiceService): Promise<void> {
        if (this._disposed) {
            return;
        }
        const settings = this._deps.settings(service);
        const had = this._mode.uses(service);
        // Unchanged, or not attached and not ready: nothing to do. A service in use takes new
        // settings whatever their readiness: requests go where the user pointed them.
        if (settings === this._settings[service] || (!had && !this._deps.readiness()[service].ok)) {
            return;
        }
        try {
            if (service === 'stt') {
                await this._mode.useStt(await this._deps.resolveStt());
            } else {
                await this._mode.useTts(await this._deps.resolveTts());
            }
        } catch (err) {
            // Resolving or checking it recorded the failure: readiness says why, and a later change retries.
            this._deps.log(`Voice mode could not ${had ? 'switch to the new' : 'pick up'} ${LABELS[service]}${had ? ' settings' : ''}: ${describeError(err)}`);
            return;
        }
        if (this._disposed || !this._mode.uses(service)) {
            return;
        }
        this._settings[service] = settings;
        this._deps.onChange(service, had ? 'updated' : 'attached');
    }
}
