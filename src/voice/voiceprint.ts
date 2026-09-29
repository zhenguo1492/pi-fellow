/**
 * The voiceprint: your voice, enrolled in Settings → Voice, so that voice input (dictation and the
 * voice agent) takes only you and not the people around you. Its vector lives in globalState (never
 * settings.json); the settings `voice.voiceprint.*` and `voice.denoise` say how it is used.
 *
 * `speechGate` is what speech input runs each utterance through: noise reduction when on, then the
 * voiceprint check. Both run on the built-in engine; when it fails they step aside (every voice gets
 * through, the audio unchanged) and `voiceprintStatus().warning` says so, rather than dropping
 * everything.
 */
import * as vscode from 'vscode';
import { DEFAULT_VOICEPRINT_THRESHOLD, type ShortSpeechPolicy, type VoiceprintStatus } from '../shared/voiceprint';
import { denoiseSpeech, speakerEmbedding } from './builtinEngine/client';
import { builtinVoiceEngineUrl } from './builtinEngine/engine';
import { SPEAKER_MODEL, type EngineFeature } from './builtinEngine/models';
import { describeError } from './modelsProbe';
import { ACCEPT_UNCHECKED, SpeakerGate, cosineSimilarity, describeVerdict, voiceprintCentroid, type SpeechGate } from './speakerGate';

export interface StoredVoiceprint {
    /** The speaker model that made it: another one's embeddings do not compare. */
    model: string;
    centroid: number[];
    /** The enrollment recordings' embeddings, kept to re-average or judge the voiceprint later. */
    embeddings: number[][];
    createdAt: number;
}

export interface VoiceprintSettings {
    enabled: boolean;
    threshold: number;
    shortSpeech: ShortSpeechPolicy;
    denoise: boolean;
}

const VOICEPRINT_KEY = 'oh-my-pi-chater.voice.voiceprint';

let _memory: vscode.Memento | undefined;
let _log: (line: string) => void = () => {};
/** Why the check / noise reduction is paused (the engine failed); cleared once it works again. */
const _warnings: { speaker?: string; denoise?: string } = {};
const _listeners = new Set<() => void>();

function notify(): void {
    for (const listener of _listeners) {
        try {
            listener();
        } catch {
            // Ignore listener exceptions
        }
    }
}

/** The voiceprint is kept in `memory` from now on; rejected utterances and paused checks go to `log`. */
export function initVoiceprint(memory: vscode.Memento, log: (line: string) => void): void {
    _memory = memory;
    _log = log;
}

export function onVoiceprintChange(listener: () => void): vscode.Disposable {
    _listeners.add(listener);
    return { dispose: () => void _listeners.delete(listener) };
}

/** `oh-my-pi-chater.voice.voiceprint.*` and `voice.denoise`; defaults mirror package.json. */
export function readVoiceprintSettings(): VoiceprintSettings {
    const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voice');
    const threshold = config.get<number>('voiceprint.threshold', DEFAULT_VOICEPRINT_THRESHOLD);
    return {
        enabled: config.get<boolean>('voiceprint.enabled', false),
        threshold: Number.isFinite(threshold) ? Math.min(0.95, Math.max(0.05, threshold)) : DEFAULT_VOICEPRINT_THRESHOLD,
        // Short words ("好了", "继续") score low even in your own voice: let them through unless asked not to.
        shortSpeech: config.get<string>('voiceprint.shortSpeech') === 'stricter' ? 'stricter' : 'accept',
        denoise: config.get<boolean>('denoise', false),
    };
}

/** The saved voiceprint, if any (whatever model made it). */
export function storedVoiceprint(): StoredVoiceprint | undefined {
    const stored: unknown = _memory?.get(VOICEPRINT_KEY);
    if (
        !stored ||
        typeof stored !== 'object' ||
        !('model' in stored) ||
        typeof stored.model !== 'string' ||
        !('centroid' in stored) ||
        !Array.isArray(stored.centroid) ||
        stored.centroid.length === 0 ||
        !stored.centroid.every((x) => typeof x === 'number' && Number.isFinite(x)) ||
        !('embeddings' in stored) ||
        !Array.isArray(stored.embeddings) ||
        !('createdAt' in stored) ||
        typeof stored.createdAt !== 'number'
    ) {
        return undefined;
    }
    return { model: stored.model, centroid: stored.centroid, embeddings: stored.embeddings, createdAt: stored.createdAt };
}

/** The saved voiceprint when the current speaker model made it. */
function usableVoiceprint(): StoredVoiceprint | undefined {
    const voiceprint = storedVoiceprint();
    return voiceprint?.model === SPEAKER_MODEL.id ? voiceprint : undefined;
}

/**
 * Saves the voiceprint of the enrollment `embeddings` (replacing any) and turns the check on.
 * `consistency`: the lowest similarity of a recording to it; low means one sounds unlike the others.
 */
export async function saveVoiceprint(embeddings: number[][]): Promise<{ voiceprint: StoredVoiceprint; consistency: number }> {
    if (!_memory) {
        throw new Error('The voiceprint store is not available');
    }
    const centroid = voiceprintCentroid(embeddings);
    const voiceprint: StoredVoiceprint = { model: SPEAKER_MODEL.id, centroid: Array.from(centroid), embeddings, createdAt: Date.now() };
    await _memory.update(VOICEPRINT_KEY, voiceprint);
    delete _warnings.speaker;
    if (!readVoiceprintSettings().enabled) {
        await vscode.workspace.getConfiguration('oh-my-pi-chater.voice').update('voiceprint.enabled', true, vscode.ConfigurationTarget.Global);
    }
    notify();
    return { voiceprint, consistency: Math.min(...embeddings.map((e) => cosineSimilarity(centroid, e))) };
}

export async function deleteVoiceprint(): Promise<void> {
    await _memory?.update(VOICEPRINT_KEY, undefined);
    delete _warnings.speaker;
    notify();
}

/** What Settings → Voice shows of the voiceprint. */
export function voiceprintStatus(): VoiceprintStatus {
    const settings = readVoiceprintSettings();
    const voiceprint = storedVoiceprint();
    const warning = [settings.enabled && voiceprint ? _warnings.speaker : undefined, settings.denoise ? _warnings.denoise : undefined].filter(Boolean).join(' ');
    return {
        ...settings,
        ...(voiceprint ? { enrolled: { samples: voiceprint.embeddings.length, at: voiceprint.createdAt, stale: voiceprint.model !== SPEAKER_MODEL.id } } : {}),
        ...(warning ? { warning } : {}),
    };
}

/** The built-in engine features the voiceprint settings use now (the engine loads them with the rest). */
export function voiceprintFeatures(): EngineFeature[] {
    const settings = readVoiceprintSettings();
    return [...(settings.enabled && usableVoiceprint() ? (['speaker'] as const) : []), ...(settings.denoise ? (['denoise'] as const) : [])];
}

/** The speaker embedding of `pcm`, from the built-in engine (started, the model downloaded, if needed). */
export async function embedSpeech(pcm: Int16Array, sampleRate: number): Promise<number[]> {
    const { model, embedding } = await speakerEmbedding(await builtinVoiceEngineUrl(['speaker']), pcm, sampleRate);
    if (model !== SPEAKER_MODEL.id) {
        throw new Error(`The engine's speaker model is ${model}, not ${SPEAKER_MODEL.id}`);
    }
    return embedding;
}

/** Records whether the check / noise reduction works; the settings page hears of a change. */
function setWarning(which: keyof typeof _warnings, warning: string | undefined): void {
    if (_warnings[which] === warning) {
        return;
    }
    if (warning) {
        _warnings[which] = warning;
        _log(`[voiceprint] ${warning}`);
    } else {
        delete _warnings[which];
        _log(`[voiceprint] The ${which === 'speaker' ? 'voiceprint check' : 'noise reduction'} works again.`);
    }
    notify();
}

/** The check with the saved voiceprint and the current threshold, whether or not it is turned on (Settings → Voice, Test). */
export function voiceprintTester(): SpeakerGate | undefined {
    const voiceprint = usableVoiceprint();
    if (!voiceprint) {
        return undefined;
    }
    const { threshold, shortSpeech } = readVoiceprintSettings();
    return new SpeakerGate({ centroid: voiceprint.centroid, threshold, shortSpeech, embed: embedSpeech });
}

/** Speech input's gate, following the settings and the saved voiceprint as they are at each utterance. */
export const speechGate: SpeechGate = {
    get active(): boolean {
        return readVoiceprintSettings().enabled && usableVoiceprint() !== undefined;
    },

    async prepare(pcm, sampleRate) {
        if (!readVoiceprintSettings().denoise) {
            return pcm;
        }
        try {
            const clean = await denoiseSpeech(await builtinVoiceEngineUrl(['denoise']), pcm, sampleRate);
            setWarning('denoise', undefined);
            return clean;
        } catch (err) {
            setWarning('denoise', `Noise reduction is paused: the built-in voice engine could not run it (${describeError(err)}).`);
            return pcm;
        }
    },

    async accept(pcm, sampleRate, compareShort) {
        const settings = readVoiceprintSettings();
        if (!settings.enabled) {
            return ACCEPT_UNCHECKED;
        }
        const tester = voiceprintTester();
        if (!tester) {
            return ACCEPT_UNCHECKED;
        }
        const verdict = await tester.check(pcm, sampleRate, compareShort);
        if (verdict.reason === 'unavailable') {
            setWarning('speaker', `The voiceprint check is paused: the built-in voice engine could not run it (${verdict.error}). Voice input takes every voice until it works again.`);
        } else if (verdict.reason === 'compared') {
            setWarning('speaker', undefined);
        }
        if (!verdict.accepted) {
            _log(`[voiceprint] Dropped an utterance: ${describeVerdict(verdict)}.`);
        }
        return verdict;
    },
};
