/** The voiceprint (only your voice reaches voice input): what the host and the settings page share. */
import type { DictationStatus } from './protocol';

/** Utterances under ~1 s: `accept` them unchecked, or check them against a `stricter` threshold. */
export type ShortSpeechPolicy = 'accept' | 'stricter';

export const DEFAULT_VOICEPRINT_THRESHOLD = 0.5;

/** Enrollment reads these aloud, one recording each; any language works as well. */
export const VOICEPRINT_PROMPTS: readonly string[] = [
    'The quick brown fox jumps over the lazy dog by the river.',
    'Please open the settings file and show me the last three commits.',
    'Yesterday we fixed seven bugs, wrote twelve tests, and shipped the release.',
    'Could you explain how this function handles an empty list?',
];

/** An enrollment recording shorter than this is asked for again: too little voice for a good voiceprint. */
export const MIN_ENROLL_SECS = 1.5;

/** Settings → Voice, Voiceprint: the settings, the saved voiceprint, and whether the check works. */
export interface VoiceprintStatus {
    enabled: boolean;
    threshold: number;
    shortSpeech: ShortSpeechPolicy;
    denoise: boolean;
    /** The saved voiceprint; absent until you enroll. `stale`: made with another speaker model, enroll again. */
    enrolled?: { samples: number; at: number; stale: boolean };
    /** The check or noise reduction is paused because the built-in engine failed (plain words). */
    warning?: string;
}

/** One voiceprint recording in the settings (enrollment or test), as it happens. */
export type VoiceprintRunEvent =
    | { kind: 'status'; status: DictationStatus }
    /** Microphone level 0..1. */
    | { kind: 'level'; level: number }
    /** Enrollment: a recording was kept (`ok`, `count` kept so far) or asked for again (too short). */
    | { kind: 'sample'; ok: boolean; seconds: number; count: number }
    /** Enrollment done: the voiceprint is saved and turned on; `consistency` is the lowest similarity of a recording to it. */
    | { kind: 'saved'; samples: number; consistency: number }
    /** Test: an utterance compared with the voiceprint; no `threshold` when it was too short to check. */
    | { kind: 'match'; seconds: number; similarity?: number; threshold?: number; accepted: boolean }
    | { kind: 'error'; message: string }
    /** Microphone off and every recording handled. */
    | { kind: 'ended' };
