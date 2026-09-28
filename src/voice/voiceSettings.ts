import * as vscode from 'vscode';
import type { OwnVoiceServers, SttEngine, VoiceReadiness, VoiceServiceCheck, VoiceSettings } from '../shared/protocol';
import { TTS_LANGUAGE_FIELDS, testTtsConnectivity, type TtsConfig, type TtsEngine, type TtsLanguageField, type TtsRequestConfig } from '../voiceAgent/tts';
import { builtinVoiceEngineUrl } from './builtinEngine/engine';
import { STT_MODEL, TTS_MODEL_ID, TTS_VOICE } from './builtinEngine/models';
import { describeError, type ApiKeySource, type ServiceOutcome } from './modelsProbe';
import { testSttConnectivity, type SttConfig } from './stt';
import { explainVoiceError, type VoiceErrorKind } from './voiceErrors';
import { CLOUD_PROVIDERS, presetForUrl } from '../shared/voicePresets';

/**
 * A service's last result and the settings it was had with (`key`); another key means unchecked.
 * Results come from the `/models` probe (startup, settings changes, settings Test) and from every
 * real request (transcription, synthesis, the built-in engine starting).
 */
interface Verdict {
    key: string;
    ok: boolean;
    reason: string;
    /**
     * Failed in real use in a way the `/models` probe cannot see (the model, voice or format the
     * requests use): a later probe success does not clear it; real use that works, or other settings, do.
     */
    sticky?: boolean;
}

/** How a failure in use can go that a server answering `/models` does not rule out. */
const STICKY_KINDS: Partial<Record<VoiceErrorKind, true>> = { notFound: true, notSpeechService: true, other: true };

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

/**
 * The key of a service on the built-in engine. It counts as ready until using it fails (its models
 * failing to download, the engine not starting or answering); the probe does not check it, but
 * forgets such a failure, so the next use tries again.
 */
const BUILTIN = 'builtin';

/** What an STT result depends on: the server and the model asked for. Empty: no URL set. */
function sttKey(s: VoiceSettings = readVoiceSettings()): string {
    if (s.sttEngine === 'builtin') {
        return BUILTIN;
    }
    const url = s.sttUrl.trim();
    return url ? JSON.stringify([url, s.sttModel.trim()]) : '';
}

/** What a TTS result depends on: the server and what each request asks it for. Empty: no URL set. */
function ttsKey(tts: TtsConfig = readTtsSettings()): string {
    if (tts.engine === 'builtin') {
        return BUILTIN;
    }
    const url = tts.url.trim();
    return url ? JSON.stringify([url, tts.model.trim(), tts.voice.trim(), tts.languageField]) : '';
}

const SERVICE_LABELS: Record<keyof VoiceReadiness, string> = { stt: 'Speech-to-text', tts: 'Text-to-speech' };

function check(verdict: Verdict | undefined, key: string, service: keyof VoiceReadiness, url: string): VoiceServiceCheck {
    const label = SERVICE_LABELS[service];
    if (!key) {
        return { ok: false, reason: `${label} is not set up: choose Built-in, a cloud service or your server in Settings → Voice.` };
    }
    if (verdict?.key !== key) {
        return key === BUILTIN ? { ok: true } : { ok: false, checking: true, reason: `Checking the ${label.toLowerCase()} service…` };
    }
    if (verdict.ok) {
        return { ok: true };
    }
    if (key === BUILTIN) {
        return { ok: false, reason: `The built-in ${label.toLowerCase()} engine failed: ${verdict.reason}. It is tried again the next time it is used.` };
    }
    return { ok: false, reason: explainVoiceError(verdict.reason, { service, hasKey: sendsApiKey(service, url) }).message };
}

export function sttCheck(): VoiceServiceCheck {
    return check(_verdicts.stt, sttKey(), 'stt', readVoiceSettings().sttUrl);
}

export function voiceReadiness(): VoiceReadiness {
    const tts = readTtsSettings();
    return { stt: sttCheck(), tts: check(_verdicts.tts, ttsKey(tts), 'tts', tts.url) };
}

/** Stores a result; listeners hear about it only when what readiness says changes. */
function store(service: keyof VoiceReadiness, next: Verdict): void {
    const prev = _verdicts[service];
    _verdicts[service] = next;
    const same = prev?.key === next.key && prev.ok === next.ok && (next.ok || prev.reason === next.reason) && prev.sticky === next.sticky;
    if (!same) {
        notify();
    }
}

/**
 * Records a result had with settings `key`; dropped when the configured service is another one by
 * now. A probe success does not clear a sticky failure of the same settings.
 */
function record(service: keyof VoiceReadiness, key: string, ok: boolean, reason: string, source: 'probe' | 'use'): void {
    if (!key || key !== (service === 'stt' ? sttKey() : ttsKey())) {
        return;
    }
    const prev = _verdicts[service];
    if (source === 'probe' && ok && prev?.key === key && prev.sticky) {
        return;
    }
    const sticky = source === 'use' && !ok && key !== BUILTIN && STICKY_KINDS[explainVoiceError(reason, { service }).kind] === true;
    store(service, { key, ok, reason, ...(sticky ? { sticky } : {}) });
}

/** Records a check (`/models` probe) of the STT settings `stt`; dropped unless they are the configured ones. */
export function recordSttCheck(stt: VoiceSettings, ok: boolean, reason: string): void {
    record('stt', sttKey(stt), ok, reason, 'probe');
}

/** Records a check of the TTS settings `tts`; dropped unless they are the configured ones. */
export function recordTtsCheck(tts: TtsConfig, ok: boolean, reason: string): void {
    record('tts', ttsKey(tts), ok, reason, 'probe');
}

/**
 * The outcome hook of a request config resolved from settings `key` for the server at `url` (''
 * on the built-in engine): how each real request went. A failure that does not name its address
 * ("fetch failed (ECONNREFUSED)") gets it, so the explanation can say where. A cancelled download
 * of the built-in engine's models (an AbortError) says nothing about the service.
 */
function useRecorder(service: keyof VoiceReadiness, key: string, url: string): ServiceOutcome {
    return (error) => {
        if (error instanceof Error && error.name === 'AbortError') {
            return;
        }
        const message = error === undefined ? 'ok' : describeError(error);
        record(service, key, error === undefined, url && !message.includes('://') ? `${url}: ${message}` : message, 'use');
    };
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
 * SecretStorage id of a cloud provider's API key (voicePresets.ts `CLOUD_PROVIDERS`): one key per
 * provider, whichever of its services use it. Never in settings.json, never sent to a webview.
 */
const apiKeySecret = (provider: string) => `oh-my-pi-chater.voice.apiKey.${provider}`;
/** The keys before they were per provider: one per service, whatever service its URL pointed at. */
const LEGACY_KEY_SECRETS: Record<keyof VoiceReadiness, string> = {
    stt: 'oh-my-pi-chater.voice.sttApiKey',
    tts: 'oh-my-pi-chater.voiceAgent.tts.apiKey',
};

let _secrets: vscode.SecretStorage | undefined;
/** Which providers have a key stored, as last read: the settings page shows it without waiting on the store. */
const _keysSet: Record<string, boolean> = {};

async function refreshKeySet(provider: string): Promise<void> {
    const set = (await voiceApiKey(provider)) !== undefined;
    if (_keysSet[provider] !== set) {
        _keysSet[provider] = set;
        notify();
    }
}

/**
 * Moves a key stored per service to the provider its service's URL points at, unless that provider
 * has one already. A key whose URL is no cloud service's stays where it is: it is used by nothing.
 */
async function migrateLegacyApiKeys(secrets: vscode.SecretStorage): Promise<void> {
    const urls: Record<keyof VoiceReadiness, string> = { stt: readVoiceSettings().sttUrl, tts: readTtsSettings().url };
    for (const service of ['stt', 'tts'] as const) {
        const legacy = (await secrets.get(LEGACY_KEY_SECRETS[service]))?.trim();
        const provider = presetForUrl(service, urls[service])?.id;
        if (!legacy || !provider) {
            continue;
        }
        if (!(await secrets.get(apiKeySecret(provider)))?.trim()) {
            await secrets.store(apiKeySecret(provider), legacy);
        }
        await secrets.delete(LEGACY_KEY_SECRETS[service]);
    }
}

/** Keys come from `secrets` from now on; a changed key re-checks the services (other windows' changes too). */
export function initVoiceApiKeys(secrets: vscode.SecretStorage): vscode.Disposable {
    _secrets = secrets;
    void migrateLegacyApiKeys(secrets)
        .catch(() => undefined)
        .then(() => Promise.all(CLOUD_PROVIDERS.map((p) => refreshKeySet(p.id))));
    return secrets.onDidChange((e) => {
        const provider = CLOUD_PROVIDERS.find((p) => e.key === apiKeySecret(p.id));
        if (provider) {
            void refreshKeySet(provider.id);
            void probeStt();
            void probeTts();
        }
    });
}

/** The stored API key of a cloud provider; undefined when none is set. */
export async function voiceApiKey(provider: string): Promise<string | undefined> {
    return (await _secrets?.get(apiKeySecret(provider)))?.trim() || undefined;
}

/** Stores a cloud provider's API key; empty or null removes it. */
export async function setVoiceApiKey(provider: string, key: string | null): Promise<void> {
    if (!_secrets) {
        throw new Error('The secret storage is not available');
    }
    if (!CLOUD_PROVIDERS.some((p) => p.id === provider)) {
        throw new Error(`Unknown voice provider "${provider}"`);
    }
    const trimmed = key?.trim();
    await (trimmed ? _secrets.store(apiKeySecret(provider), trimmed) : _secrets.delete(apiKeySecret(provider)));
    await refreshKeySet(provider);
}

/** Which cloud providers have a key stored, for the settings page (it never gets the keys). */
export function voiceApiKeysSet(): Record<string, boolean> {
    return Object.fromEntries(CLOUD_PROVIDERS.map((p) => [p.id, _keysSet[p.id] === true]));
}

/** Requests to `url` carry a stored key: it is a cloud provider's address and that provider has a key. */
export function sendsApiKey(service: keyof VoiceReadiness, url: string): boolean {
    const provider = presetForUrl(service, url)?.id;
    return provider !== undefined && _keysSet[provider] === true;
}

/**
 * The API key sent to `url`: only a cloud provider's address (voicePresets.ts) gets one, the key typed
 * but not stored (Dry run) when there is one, else that provider's stored key, read at each request.
 * Your own server never does, and one provider's key never goes to another.
 */
function apiKeySource(service: keyof VoiceReadiness, url: string, draft: string | undefined): ApiKeySource | undefined {
    const provider = presetForUrl(service, url)?.id;
    if (!provider) {
        return undefined;
    }
    const typed = draft?.trim();
    return typed ? async () => typed : () => voiceApiKey(provider);
}

/**
 * Checks the configured STT server (`GET {base}/models` → 200) and records the result, so the
 * composer mic is enabled without a manual "Test" in settings. The built-in engine is not started
 * here; a failure of it is forgotten instead, so its next use tries again.
 */
export async function probeStt(): Promise<void> {
    const s = readVoiceSettings();
    const key = sttKey(s);
    if (key === BUILTIN && _verdicts.stt?.key === BUILTIN) {
        delete _verdicts.stt;
    }
    // The settings changed: listeners show "checking" (or "not configured") until the result lands.
    notify();
    if (!key || key === BUILTIN) return;
    const res = await testSttConnectivity(s.sttUrl, undefined, apiKeySource('stt', s.sttUrl, undefined));
    recordSttCheck(s, res.ok, res.message);
}

/** Checks the configured TTS server the same way; a configured model must be among those it lists. */
export async function probeTts(): Promise<void> {
    const tts = readTtsSettings();
    if (tts.engine === 'builtin' && _verdicts.tts?.key === BUILTIN) {
        delete _verdicts.tts;
    }
    notify();
    if (!tts.url || tts.engine === 'builtin') return;
    const res = await testTtsConnectivity({ ...tts, apiKey: apiKeySource('tts', tts.url, undefined) });
    recordTtsCheck(tts, res.ok, res.message);
}

/** The explicitly set value (folder, workspace or user); undefined when only the default applies. */
function explicitValue<T>(config: vscode.WorkspaceConfiguration, key: string): T | undefined {
    const set = config.inspect<T>(key);
    return set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue;
}

/** `oh-my-pi-chater.voice.*` — defaults mirror package.json; an unset engine is `custom` when a URL is set. */
export function readVoiceSettings(): VoiceSettings {
    const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voice');
    const sttUrl = config.get<string>('sttUrl', '').trim();
    const engine = explicitValue<SttEngine>(config, 'sttEngine') ?? (sttUrl ? 'custom' : 'builtin');
    return {
        sttEngine: engine === 'custom' ? 'custom' : 'builtin',
        sttUrl,
        sttModel: config.get<string>('sttModel', '').trim(),
        language: config.get<string>('language', '').trim(),
        vadConfidence: config.get<number>('vadConfidence', 0.5),
        vadStopSecs: config.get<number>('vadStopSecs', 0.8),
    };
}

/**
 * What `voiceAgent.tts.provider`, the setting before `tts.engine`, meant. Its first values named the
 * kind of server: each is the custom engine with a `languageField`, plus the model and voice that used
 * to be sent when none was set (none now means none is sent). Its later values are the engine's own.
 * Read as such while `tts.engine` is unset, until `migrateTtsSettings` has moved it.
 */
const LEGACY_TTS_PROVIDERS: ReadonlyMap<string, { engine: TtsEngine; languageField?: TtsLanguageField; model?: string; voice?: string }> = new Map([
    ['builtin', { engine: 'builtin' }],
    ['custom', { engine: 'custom' }],
    ['openai', { engine: 'custom', languageField: 'none' }],
    ['chatterbox', { engine: 'custom', languageField: 'perSentence', model: 'chatterbox-multilingual', voice: 'default' }],
    ['kokoro', { engine: 'custom', languageField: 'chineseLangCode', model: 'kokoro', voice: 'af_sarah' }],
]);

/**
 * `oh-my-pi-chater.voiceAgent.tts.*` as configured; empty model/voice are not sent. An unset engine
 * is the old `tts.provider`'s (see `LEGACY_TTS_PROVIDERS`), else `custom` when a URL is set.
 */
export function readTtsSettings(): TtsConfig {
    const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent');
    const url = config.get<string>('tts.url', '').trim();
    const engine = explicitValue<string>(config, 'tts.engine');
    const legacy = engine === undefined ? LEGACY_TTS_PROVIDERS.get(explicitValue<string>(config, 'tts.provider') ?? '') : undefined;
    const languageField = explicitValue<string>(config, 'tts.languageField') ?? legacy?.languageField;
    return {
        engine: engine === 'builtin' || engine === 'custom' ? engine : (legacy?.engine ?? (url ? 'custom' : 'builtin')),
        languageField: TTS_LANGUAGE_FIELDS.find((field) => field === languageField) ?? 'none',
        url,
        model: config.get<string>('tts.model', '').trim() || legacy?.model || '',
        voice: config.get<string>('tts.voice', '').trim() || legacy?.voice || '',
        speed: config.get<number>('tts.speed', 1),
    };
}

/**
 * Moves the old `tts.provider` (see `LEGACY_TTS_PROVIDERS`) to `tts.engine` where it is set: first the
 * language field, model and voice it implied, then the engine, then it goes; the setup sounds as
 * before. An engine already set there wins and the old value just goes. Stopped halfway, what is
 * left reads as before.
 */
export async function migrateTtsSettings(): Promise<void> {
    const section = 'oh-my-pi-chater.voiceAgent';
    // Folder values need a resource; this window-scoped setting has none.
    // Workspace first: it must see the user settings as they were, before their implied values land.
    for (const target of [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.Global]) {
        // Each update changes what a new snapshot reads.
        const config = vscode.workspace.getConfiguration(section);
        const at = (key: string): string | undefined => {
            const set = config.inspect<string>(key);
            return target === vscode.ConfigurationTarget.Global ? set?.globalValue : set?.workspaceValue;
        };
        // A key as the old value saw it: user settings alone (windows without this workspace), or the workspace's over them.
        const seen = (key: string): string | undefined => at(key) ?? (target === vscode.ConfigurationTarget.Workspace ? config.inspect<string>(key)?.globalValue : undefined);
        const provider = at('tts.provider');
        if (provider === undefined) {
            continue;
        }
        const legacy = LEGACY_TTS_PROVIDERS.get(provider);
        if (legacy && at('tts.engine') === undefined) {
            for (const [key, implied] of [['tts.model', legacy.model], ['tts.voice', legacy.voice]] as const) {
                if (implied && !seen(key)?.trim()) {
                    await config.update(key, implied, target);
                }
            }
            if (legacy.languageField && legacy.languageField !== 'none' && seen('tts.languageField') === undefined) {
                await config.update('tts.languageField', legacy.languageField, target);
            }
            await config.update('tts.engine', legacy.engine, target);
        }
        await config.update('tts.provider', undefined, target);
    }
}

/** The built-in engine's URL, the engine started first; its failing to (models not downloading, say) goes to `outcome`. */
async function builtinUrl(outcome: ServiceOutcome): Promise<string> {
    try {
        return await builtinVoiceEngineUrl();
    } catch (err) {
        outcome(err);
        throw err;
    }
}

/**
 * The STT service to call: the built-in engine (started, its models downloaded, on first use) or the
 * configured server, with the API key of a cloud service (`draftKey`, typed in the settings, else the stored one).
 * How each request goes is recorded for readiness when these are the configured settings, unless a
 * typed key is what it sends.
 */
export async function resolveSttConfig(s: VoiceSettings, draftKey?: string): Promise<SttConfig> {
    const onOutcome = useRecorder('stt', sttKey(s), s.sttEngine === 'builtin' ? '' : s.sttUrl.trim());
    if (s.sttEngine === 'builtin') {
        return { url: await builtinUrl(onOutcome), model: STT_MODEL.id, language: s.language, onOutcome };
    }
    const typedKey = Boolean(draftKey?.trim() && presetForUrl('stt', s.sttUrl));
    return { url: s.sttUrl, model: s.sttModel, language: s.language, apiKey: apiKeySource('stt', s.sttUrl, draftKey), ...(typedKey ? {} : { onOutcome }) };
}

/**
 * The TTS service to call; the built-in engine takes its own model and voice, no language field and
 * no key; a custom server gets its API key, and its outcomes are recorded, as `resolveSttConfig` does.
 */
export async function resolveTtsConfig(t: TtsConfig, draftKey?: string): Promise<TtsRequestConfig> {
    const onOutcome = useRecorder('tts', ttsKey(t), t.engine === 'builtin' ? '' : t.url.trim());
    if (t.engine === 'builtin') {
        return { ...t, url: await builtinUrl(onOutcome), model: TTS_MODEL_ID, voice: TTS_VOICE.id, languageField: 'none', onOutcome };
    }
    const typedKey = Boolean(draftKey?.trim() && presetForUrl('tts', t.url));
    return { ...t, apiKey: apiKeySource('tts', t.url, draftKey), maxInputChars: presetForUrl('tts', t.url)?.maxInputChars, ...(typedKey ? {} : { onOutcome }) };
}

async function write(section: string, values: Record<string, unknown>): Promise<void> {
    const config = vscode.workspace.getConfiguration(section);
    for (const [key, value] of Object.entries(values)) {
        if (config.get(key) !== value) {
            await config.update(key, value, vscode.ConfigurationTarget.Global);
        }
    }
}

/** globalState key of your own servers' settings as last configured: the Cloud and Built-in cards overwrite the same settings. */
const OWN_SERVERS_KEY = 'oh-my-pi-chater.voice.ownServers';
let _memory: vscode.Memento | undefined;

/** Your own servers are remembered in `memory` from now on, starting with the ones configured now. */
export function initVoiceMemory(memory: vscode.Memento): void {
    _memory = memory;
    void rememberOwnServers();
}

/** Your own servers' fields as last configured, by settings field key, for "My own server" to bring back. */
export function ownVoiceServers(): OwnVoiceServers {
    return _memory?.get<OwnVoiceServers>(OWN_SERVERS_KEY) ?? {};
}

/** Remembers each part configured now as your own server: the custom engine at an address no cloud provider has. */
async function rememberOwnServers(): Promise<void> {
    if (!_memory) {
        return;
    }
    const stt = readVoiceSettings();
    const tts = readTtsSettings();
    const next = { ...ownVoiceServers() };
    if (stt.sttEngine === 'custom' && stt.sttUrl && !presetForUrl('stt', stt.sttUrl)) {
        next.stt = { 'voice.sttUrl': stt.sttUrl, 'voice.sttModel': stt.sttModel };
    }
    if (tts.engine === 'custom' && tts.url && !presetForUrl('tts', tts.url)) {
        next.tts = { 'voiceAgent.tts.url': tts.url, 'voiceAgent.tts.model': tts.model, 'voiceAgent.tts.voice': tts.voice, 'voiceAgent.tts.languageField': tts.languageField };
    }
    if (JSON.stringify(next) !== JSON.stringify(ownVoiceServers())) {
        await _memory.update(OWN_SERVERS_KEY, next);
    }
}

/** Writes the STT section of the settings page, as typed; your own server there is remembered before and after. */
export async function saveVoiceSettings(s: VoiceSettings): Promise<void> {
    await rememberOwnServers();
    const section = 'oh-my-pi-chater.voice';
    await write(section, {
        sttUrl: s.sttUrl.trim(),
        sttModel: s.sttModel.trim(),
        language: s.language.trim(),
        vadConfidence: s.vadConfidence,
        vadStopSecs: s.vadStopSecs,
    });
    // Compared with the effective engine, which an unset setting infers from the URL just written.
    if (readVoiceSettings().sttEngine !== s.sttEngine) {
        await vscode.workspace.getConfiguration(section).update('sttEngine', s.sttEngine, vscode.ConfigurationTarget.Global);
    }
    await rememberOwnServers();
}

/** Writes the TTS section of the settings page, as typed; your own server there is remembered before and after. */
export async function saveTtsSettings(t: TtsConfig): Promise<void> {
    await rememberOwnServers();
    const section = 'oh-my-pi-chater.voiceAgent';
    await write(section, {
        'tts.url': t.url.trim(),
        'tts.languageField': t.languageField,
        'tts.model': t.model.trim(),
        'tts.voice': t.voice.trim(),
        'tts.speed': t.speed,
    });
    // Compared with the effective engine, which an unset setting infers from the URL just written.
    if (readTtsSettings().engine !== t.engine) {
        await vscode.workspace.getConfiguration(section).update('tts.engine', t.engine, vscode.ConfigurationTarget.Global);
    }
    await rememberOwnServers();
}
