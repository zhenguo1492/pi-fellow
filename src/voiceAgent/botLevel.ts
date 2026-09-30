import { frameDb, wavePoints } from '../voice/micLevel';
import type { Pcm } from './tts';

/** One bot level report per this much played audio (≈16 Hz, like the microphone's). */
const BOT_LEVEL_MS = 64;
/** dBFS mapped to bot level 0 and 1: TTS output is normalized loud, speech sits around -25..-10. */
const BOT_FLOOR_DB = -45;
const BOT_CEIL_DB = -15;

/**
 * The level (0..1) and waveform of the bot's audio as it plays, one report per {@link BOT_LEVEL_MS}:
 * the voice bar's wave and the talking avatar (src/webview/avatarMotion.ts). Voice mode's replies
 * and sentences read aloud (Alt+click) both report through one. A clip's levels are worked out
 * up front and reported against the time it was heard to start, so a late tick skips ahead rather
 * than replaying what was heard.
 */
export class ClipLevelMeter {
    private _timer: NodeJS.Timeout | undefined;

    constructor(private readonly _report: (level: number, wave?: number[]) => void) {}

    /** Reports `pcm`, heard to start at `at` (ms since the epoch), in place of any clip before it. */
    start(pcm: Pcm, at: number): void {
        clearInterval(this._timer);
        const window = Math.max(1, Math.round((pcm.rate * BOT_LEVEL_MS) / 1000));
        const samples = new Int16Array(pcm.data.length >> 1);
        for (let i = 0; i < samples.length; i++) {
            samples[i] = pcm.data.readInt16LE(i * 2);
        }
        const windows: Array<{ level: number; wave: number[] }> = [];
        for (let start = 0; start < samples.length; start += window) {
            const end = Math.min(samples.length, start + window);
            const db = frameDb(samples.subarray(start, end));
            windows.push({
                level: Math.min(1, Math.max(0, (db - BOT_FLOOR_DB) / (BOT_CEIL_DB - BOT_FLOOR_DB))),
                wave: wavePoints(samples, start, end, BOT_CEIL_DB),
            });
        }
        this._timer = setInterval(() => {
            const i = Math.floor((Date.now() - at) / BOT_LEVEL_MS);
            if (i >= windows.length) {
                this.stop();
                return;
            }
            const { level, wave } = windows[Math.max(0, i)];
            this._report(level, wave);
        }, BOT_LEVEL_MS);
    }

    /** The clip stopped or ended: reports silence once. */
    stop(): void {
        if (this._timer !== undefined) {
            clearInterval(this._timer);
            this._timer = undefined;
            this._report(0);
        }
    }
}
