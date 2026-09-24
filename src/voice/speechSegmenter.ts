/**
 * Turns a stream of VAD-scored audio frames into speech segments.
 *
 * Same state machine as pipecat's `VADAnalyzer` (QUIET → STARTING → SPEAKING →
 * STOPPING): speech must persist `startSecs` before it counts, and a segment
 * ends after `stopSecs` of silence. Like Silero's reference segmenter, a segment
 * already open only needs `confidence - 0.15` to keep going, so soft word
 * endings and quiet syllables mid-sentence do not start the stop countdown.
 * Frames seen just before speech was confirmed are kept as pre-roll so the
 * first syllable is not clipped.
 */

export interface SegmenterParams {
    /** Silero probability at or above which a frame counts as speech. */
    confidence: number;
    /** Speech needed before a segment starts. */
    startSecs: number;
    /** Silence that ends a segment. */
    stopSecs: number;
    /** Audio kept from before speech was confirmed. */
    preRollSecs: number;
    /** Hard cut so one segment stays inside the STT model's window. */
    maxSegmentSecs: number;
}

/** Silero's `neg_threshold` offset: how far a frame may dip below the threshold inside speech. */
const END_HYSTERESIS = 0.15;

export type SegmenterEvent = { type: 'speechStart' } | { type: 'segment'; pcm: Int16Array };

type State = 'quiet' | 'starting' | 'speaking' | 'stopping';

export class SpeechSegmenter {
    private state: State = 'quiet';
    private startCount = 0;
    private stopCount = 0;
    /** Frames before speech is confirmed; includes the STARTING frames. */
    private preRoll: Int16Array[] = [];
    private segment: Int16Array[] = [];
    private readonly startFrames: number;
    private readonly stopFrames: number;
    private readonly preRollFrames: number;
    private readonly maxFrames: number;

    constructor(
        private readonly params: SegmenterParams,
        frameSamples: number,
        sampleRate: number,
    ) {
        const frameSecs = frameSamples / sampleRate;
        this.startFrames = Math.max(1, Math.round(params.startSecs / frameSecs));
        this.stopFrames = Math.max(1, Math.round(params.stopSecs / frameSecs));
        this.preRollFrames = Math.max(0, Math.round(params.preRollSecs / frameSecs));
        this.maxFrames = Math.max(this.startFrames + 1, Math.round(params.maxSegmentSecs / frameSecs));
    }

    /** True while a segment is open (speech confirmed and not yet ended). */
    get inSpeech(): boolean {
        return this.state === 'speaking' || this.state === 'stopping';
    }

    push(frame: Int16Array, confidence: number): SegmenterEvent[] {
        const speech = confidence >= (this.inSpeech ? this.params.confidence - END_HYSTERESIS : this.params.confidence);

        if (this.state === 'quiet' || this.state === 'starting') {
            this.preRoll.push(frame);
            if (this.preRoll.length > this.preRollFrames + this.startFrames) {
                this.preRoll.shift();
            }
            if (!speech) {
                this.state = 'quiet';
                this.startCount = 0;
                return [];
            }
            this.state = 'starting';
            this.startCount++;
            if (this.startCount < this.startFrames) {
                return [];
            }
            this.state = 'speaking';
            this.startCount = 0;
            this.segment = this.preRoll;
            this.preRoll = [];
            return [{ type: 'speechStart' }];
        }

        this.segment.push(frame);
        if (speech) {
            this.state = 'speaking';
            this.stopCount = 0;
        } else {
            this.state = 'stopping';
            this.stopCount++;
            if (this.stopCount >= this.stopFrames) {
                this.state = 'quiet';
                this.stopCount = 0;
                return [{ type: 'segment', pcm: this.takeSegment() }];
            }
        }
        if (this.segment.length >= this.maxFrames) {
            return [{ type: 'segment', pcm: this.takeSegment() }];
        }
        return [];
    }

    /** Ends the stream: speech still in progress becomes the final segment. */
    flush(): Int16Array | undefined {
        const open = this.inSpeech;
        this.state = 'quiet';
        this.startCount = 0;
        this.stopCount = 0;
        this.preRoll = [];
        if (!open || this.segment.length === 0) {
            this.segment = [];
            return undefined;
        }
        return this.takeSegment();
    }

    private takeSegment(): Int16Array {
        const frames = this.segment;
        this.segment = [];
        let length = 0;
        for (const f of frames) {
            length += f.length;
        }
        const pcm = new Int16Array(length);
        let offset = 0;
        for (const f of frames) {
            pcm.set(f, offset);
            offset += f.length;
        }
        return pcm;
    }
}
