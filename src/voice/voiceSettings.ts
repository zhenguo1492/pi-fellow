import * as vscode from 'vscode';
import type { VoiceReadiness, VoiceServiceCheck, VoiceSettings } from '../shared/protocol';
import { testTtsConnectivity, type TtsConfig, type TtsProvider } from '../voiceAgent/tts';
import { testSttConnectivity } from './stt';

/** A service's last check and the settings it was made with (`key`); another key means unchecked. */
interface Verdict {
    key: string;
    ok: boolean;
    reason: string;
}

const _verdicts: Partial<Record<keyof VoiceReadiness, Verdict>> = {};
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

function configuredSttUrl(): string {
    return vscode.workspace.getConfiguration('oh-my-pi-chater.voice').get<string>('sttUrl', '').trim();
}

/** What a TTS check depends on: the server and the model it must list. Empty: no URL set. */
function ttsKey(tts: TtsConfig): string {
    return tts.url ? JSON.stringify([tts.provider, tts.url, tts.model]) : '';
}

function check(verdict: Verdict | undefined, key: string, service: string): VoiceServiceCheck {
    if (!key) {
        return { ok: false, reason: `${service} is not configured: set its URL in Settings → Voice.` };
    }
    if (verdict?.key !== key) {
        return { ok: false, checking: true, reason: `Checking the ${service.toLowerCase()} service…` };
    }
    return verdict.ok ? { ok: true } : { ok: false, reason: `${service} is unavailable: ${verdict.reason}. Check Settings → Voice.` };
}

export function sttCheck(): VoiceServiceCheck {
    return check(_verdicts.stt, configuredSttUrl(), 'Speech-to-text');
}

export function voiceReadiness(): VoiceReadiness {
    return { stt: sttCheck(), tts: check(_verdicts.tts, ttsKey(readTtsSettings()), 'Text-to-speech') };
}

/** Stores a check; listeners hear about it unless it repeats the last one. */
function store(service: keyof VoiceReadiness, next: Verdict): void {
    const prev = _verdicts[service];
    _verdicts[service] = next;
    if (prev?.key !== next.key || prev.ok !== next.ok || prev.reason !== next.reason) {
        notify();
    }
}

/** Records a check of `url`; dropped when the configured STT URL is another one by now. */
export function recordSttCheck(url: string, ok: boolean, reason: string): void {
    const key = url.trim();
    if (key === configuredSttUrl()) {
        store('stt', { key, ok, reason });
    }
}

/** Records a check of `tts`; dropped when the configured TTS service is another one by now. */
export function recordTtsCheck(tts: TtsConfig, ok: boolean, reason: string): void {
    const key = ttsKey(tts);
    if (key === ttsKey(readTtsSettings())) {
        store('tts', { key, ok, reason });
    }
}

export function onVoiceReadinessChange(listener: () => void): vscode.Disposable {
    _listeners.add(listener);
    return {
        dispose: () => {
            _listeners.delete(listener);
        },
    };
}

/**
 * Checks the configured STT server (`GET {base}/models` → 200) and records the result, so the
 * composer mic is enabled without a manual "Test" in settings.
 */
export async function probeStt(): Promise<void> {
    const url = configuredSttUrl();
    // The settings changed: listeners show "checking" (or "not configured") until the result lands.
    notify();
    if (!url) return;
    const res = await testSttConnectivity(url);
    recordSttCheck(url, res.ok, res.message);
}

/** Checks the configured TTS server the same way; its model must be among those it lists. */
export async function probeTts(): Promise<void> {
    const tts = readTtsSettings();
    notify();
    if (!tts.url) return;
    const res = await testTtsConnectivity(tts);
    recordTtsCheck(tts, res.ok, res.message);
}

/** `oh-my-pi-chater.voice.*` — defaults mirror package.json. */
export function readVoiceSettings(): VoiceSettings {
    const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voice');
    return {
        sttUrl: config.get<string>('sttUrl', '').trim(),
        sttModel: config.get<string>('sttModel', '').trim(),
        language: config.get<string>('language', '').trim(),
        vadConfidence: config.get<number>('vadConfidence', 0.5),
        vadStopSecs: config.get<number>('vadStopSecs', 0.8),
    };
}

/** `oh-my-pi-chater.voiceAgent.tts.*` as configured; empty model/voice mean the provider's default. */
export function readTtsSettings(): TtsConfig {
    const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent');
    return {
        provider: config.get<TtsProvider>('tts.provider', 'openai'),
        url: config.get<string>('tts.url', '').trim(),
        model: config.get<string>('tts.model', '').trim(),
        voice: config.get<string>('tts.voice', '').trim(),
        speed: config.get<number>('tts.speed', 1),
    };
}

async function write(section: string, values: Record<string, unknown>): Promise<void> {
    const config = vscode.workspace.getConfiguration(section);
    for (const [key, value] of Object.entries(values)) {
        if (config.get(key) !== value) {
            await config.update(key, value, vscode.ConfigurationTarget.Global);
        }
    }
}

/** Writes the STT section of the settings page, as typed (the Test button saves before it checks). */
export async function saveVoiceSettings(s: VoiceSettings): Promise<void> {
    await write('oh-my-pi-chater.voice', {
        sttUrl: s.sttUrl.trim(),
        sttModel: s.sttModel.trim(),
        language: s.language.trim(),
        vadConfidence: s.vadConfidence,
        vadStopSecs: s.vadStopSecs,
    });
}

/** Writes the TTS section of the settings page, as typed. */
export async function saveTtsSettings(t: TtsConfig): Promise<void> {
    await write('oh-my-pi-chater.voiceAgent', {
        'tts.provider': t.provider,
        'tts.url': t.url.trim(),
        'tts.model': t.model.trim(),
        'tts.voice': t.voice.trim(),
        'tts.speed': t.speed,
    });
}
