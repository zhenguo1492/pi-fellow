import * as vscode from 'vscode';
import type {
    SettingsClientMessage,
    SettingsServerMessage,
    SettingsData,
    AgentBackend,
    VoiceSettings,
} from '../shared/protocol';
import type { PiChatSession } from '../pi/slashCommands';
import { readDefaultPermissionLevel } from '../pi/permissionGate';
import {
    addPiExtensionPath,
    addPiPackage,
    addPiSkillPath,
    loadPiAgentConfigForSettings,
    openPiAgentFile,
    removePiExtensionPathAt,
    removePiPackageAt,
    removePiSkillPathAt,
    schedulePiSessionReload,
    setPiEnableSkillCommands,
    setPiFollowUpMode,
    setPiSteeringMode,
    updatePiDefaults,
} from '../pi/piAgentConfig';
import {
    getPiAgentDir,
    isSyncWithPiCli,
    readAgentSettingsSummary,
} from '../pi/piCliSync';
import { showPiPackageCatalogPicker } from '../pi/piPackageCatalogPicker';
import { loadMcpSettingsSnapshot, probeMcpServer, setMcpServerEnabled } from '../pi/mcpConfig';
import { getMissingRecommendedPackages } from '../pi/recommendedPackages';
import { getAgentLayout, getAvailableBackends, onDidChangeWindowBackend, setWindowBackend } from '../pi/piCliPaths';
import { runPiLoginFlow, runPiLogoutFlow } from '../pi/slashCommands';
import { builtinVoiceEngineUrl, builtinVoiceStatus } from '../voice/builtinEngine/engine';
import { STT_MODEL } from '../voice/builtinEngine/models';
import { describeError, type ModelsProbeResult } from '../voice/modelsProbe';
import { testSttConnectivity } from '../voice/stt';
import { explainVoiceError } from '../voice/voiceErrors';
import { VoiceDryRun } from '../voice/voiceDryRun';
import {
    onVoiceReadinessChange,
    readTtsSettings,
    readVoiceSettings,
    recordSttCheck,
    recordTtsCheck,
    resolveSttConfig,
    resolveTtsConfig,
    saveTtsSettings,
    saveVoiceSettings,
    sendsApiKey,
    setVoiceApiKey,
    ownVoiceServers,
    voiceApiKeysSet,
    voiceReadiness,
} from '../voice/voiceSettings';
import { testTtsConnectivity, type TtsConfig } from '../voiceAgent/tts';
import { CLOUD_PROVIDERS } from '../shared/voicePresets';
import { DEFAULT_TRANSLATION_LANGUAGE } from '../shared/translationLanguages';
import { DEFAULT_SPEAKER_NAMES, type VoiceSpeakerId } from '../shared/voiceSpeakers';
import { pickAvatar, resolveSpeakers } from '../voiceAgent/speakers';

type VoiceServiceId = 'stt' | 'tts';
const VOICE_SERVICE_NAMES: Record<VoiceServiceId, string> = { stt: 'speech-to-text', tts: 'text-to-speech' };

export class SettingsPanel {
    private static _instance: SettingsPanel | undefined;
    private _panel: vscode.WebviewPanel;
    private _extensionUri: vscode.Uri;
    /** The chat tab shown in the sidebar; asked on every use, so tab and backend switches are followed. */
    private _getSession: () => PiChatSession | undefined;
    private _currentBackend: AgentBackend;
    private _extensionVersion: string;
    private _outputChannel: vscode.OutputChannel | undefined;
    private _disposables: vscode.Disposable[] = [];
    private _mcpProbeResults = new Map<string, { ok: boolean; message: string }>();
    private _voiceDryRun: VoiceDryRun;
    /** The Voice tab has unsaved changes (the webview says so): closing the panel then warns. */
    private _voiceDirty = false;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        extensionVersion: string,
        getSession: () => PiChatSession | undefined,
        outputChannel?: vscode.OutputChannel,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._extensionVersion = extensionVersion;
        this._getSession = getSession;
        this._currentBackend = getAgentLayout().backend;
        this._outputChannel = outputChannel;
        this._voiceDryRun = new VoiceDryRun(extensionUri, (message) => this._post(message));
        this._disposables.push(this._voiceDryRun);

        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(
            (msg: SettingsClientMessage) => this._handleMessage(msg),
            undefined,
            this._disposables,
        );

        this._panel.onDidDispose(() => this._dispose(), undefined, this._disposables);

        const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('oh-my-pi-chater.backend') || e.affectsConfiguration('oh-my-pi-chater.cliPath')) {
                this._currentBackend = getAgentLayout().backend;
            }
            if (e.affectsConfiguration('oh-my-pi-chater')) {
                void this._sendSettings();
            }
        });
        this._disposables.push(
            configListener,
            onDidChangeWindowBackend((backend) => {
                this._currentBackend = backend;
                void this._sendSettings();
            }),
            // The STT check mark follows the automatic checks too, not only the Test button.
            onVoiceReadinessChange(() => void this._sendSettings()),
        );

        void this._sendSettings();
        void this._sendSkills();
    }

    static show(
        extensionUri: vscode.Uri,
        getSession: () => PiChatSession | undefined,
        extensionVersion?: string,
        outputChannel?: vscode.OutputChannel,
    ): void {
        SettingsPanel._open(extensionUri, getSession, extensionVersion, outputChannel);
    }

    /** The shown chat tab's session when it runs the backend this panel shows; actions never reach another backend's CLI. */
    private get _piSession(): PiChatSession | undefined {
        const session = this._getSession();
        return session?.backend === this._currentBackend ? session : undefined;
    }

    /** Open settings and scroll to a section (e.g. from /mcp in chat). */
    static showWithSection(section: string): void {
        const inst = SettingsPanel._instance;
        if (inst) {
            inst._panel.reveal(vscode.ViewColumn.One);
            void inst._sendSettings();
            inst._post({ type: 'scrollToSection', section });
            return;
        }
        vscode.commands.executeCommand('oh-my-pi-chater.openSettings').then(() => {
            const opened = SettingsPanel._instance;
            if (opened) {
                opened._post({ type: 'scrollToSection', section });
            }
        });
    }

    private static _open(
        extensionUri: vscode.Uri,
        getSession: () => PiChatSession | undefined,
        extensionVersion?: string,
        outputChannel?: vscode.OutputChannel,
    ): void {
        if (SettingsPanel._instance) {
            SettingsPanel._instance._getSession = getSession;
            SettingsPanel._instance._currentBackend = getAgentLayout().backend;
            if (outputChannel) {
                SettingsPanel._instance._outputChannel = outputChannel;
            }
            if (extensionVersion) {
                SettingsPanel._instance._extensionVersion = extensionVersion;
            }
            SettingsPanel._instance._panel.reveal(vscode.ViewColumn.One);
            void SettingsPanel._instance._sendSettings();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'oh-my-pi-chater.settings',
            'PI Buddy Settings',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            },
        );

        SettingsPanel._instance = new SettingsPanel(
            panel,
            extensionUri,
            extensionVersion ?? '0.0.0',
            getSession,
            outputChannel,
        );
    }

    private async _handleMessage(msg: SettingsClientMessage): Promise<void> {
        try {
            switch (msg.type) {
                case 'getSettings':
                    await this._sendSettings();
                    break;
                case 'updateSetting':
                    await this._updateSetting(msg.key, msg.value);
                    break;
                case 'getSkills':
                    await this._sendSkills();
                    break;
                case 'setBackend':
                    if (msg.backend === 'omp' || msg.backend === 'pi') {
                        setWindowBackend(msg.backend);
                        this._currentBackend = msg.backend;
                        await this._afterPiConfigChange(`Switched to ${msg.backend} backend`);
                    }
                    break;
                case 'updatePiDefaults':
                    await updatePiDefaults(
                        {
                            provider: msg.provider,
                            model: msg.model,
                            thinkingLevel: msg.thinkingLevel,
                        },
                        this._piSession,
                        this._currentBackend,
                    );
                    await this._afterPiConfigChange(
                        this._currentBackend === 'omp'
                            ? 'Defaults saved to ~/.omp/agent/config.yml'
                            : 'Defaults saved to ~/.pi/agent/settings.json',
                    );
                    break;
                case 'addPiPackage':
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: `Installing ${msg.source}`,
                            cancellable: false,
                        },
                        () => addPiPackage(msg.source, this._piSession, this._outputChannel),
                    );
                    await this._afterPiConfigChange('Package installed');
                    break;
                case 'removePiPackage':
                    await removePiPackageAt(msg.index, this._piSession, this._outputChannel);
                    await this._afterPiConfigChange(
                        'Package removed. Reload Pi session when you want changes in chat.',
                    );
                    break;
                case 'browsePiCatalog':
                    await showPiPackageCatalogPicker(this._piSession, this._outputChannel);
                    await this._sendSettings();
                    break;
                case 'pickAvatar':
                    await pickAvatar(msg.speaker);
                    break;
                case 'openExternalUrl':
                    await vscode.env.openExternal(vscode.Uri.parse(msg.url));
                    break;
                case 'addPiExtensionPath':
                    await addPiExtensionPath(msg.path, this._currentBackend);
                    schedulePiSessionReload(this._piSession, this._outputChannel);
                    await this._afterPiConfigChange('Extension path added');
                    break;
                case 'removePiExtensionPath':
                    await removePiExtensionPathAt(msg.index, this._currentBackend);
                    schedulePiSessionReload(this._piSession, this._outputChannel);
                    await this._afterPiConfigChange('Extension path removed');
                    break;
                case 'addPiSkillPath':
                    await addPiSkillPath(msg.path, this._piSession, this._currentBackend);
                    schedulePiSessionReload(this._piSession, this._outputChannel);
                    await this._afterPiConfigChange('Skill path added');
                    break;
                case 'removePiSkillPath':
                    await removePiSkillPathAt(msg.index, this._piSession, this._currentBackend);
                    schedulePiSessionReload(this._piSession, this._outputChannel);
                    await this._afterPiConfigChange('Skill path removed');
                    break;
                case 'setPiEnableSkillCommands':
                    await setPiEnableSkillCommands(msg.enabled, this._piSession, this._currentBackend);
                    await this._afterPiConfigChange('Skill commands setting updated');
                    break;
                case 'setPiSteeringMode':
                    await setPiSteeringMode(msg.mode, this._piSession, this._currentBackend);
                    await this._afterPiConfigChange('Steering mode updated');
                    break;
                case 'setPiFollowUpMode':
                    await setPiFollowUpMode(msg.mode, this._piSession, this._currentBackend);
                    await this._afterPiConfigChange('Follow-up mode updated');
                    break;
                case 'openPiAgentFile':
                    await openPiAgentFile(msg.file, this._currentBackend);
                    break;
                case 'reloadPiSession':
                    if (!this._piSession) {
                        this._post({ type: 'error', message: 'No active chat session to reload' });
                        break;
                    }
                    // The command also refreshes the chat view of the reloaded tab.
                    await vscode.commands.executeCommand('oh-my-pi-chater.reloadSession');
                    this._mcpProbeResults.clear();
                    await this._afterPiConfigChange(`Session reloaded from ${getPiAgentDir(this._currentBackend)}`);
                    break;
                case 'getMcpSnapshot':
                    await this._sendMcpSnapshot();
                    break;
                case 'setMcpServerEnabled':
                    await setMcpServerEnabled(msg.scope, msg.serverName, msg.enabled, this._currentBackend);
                    this._mcpProbeResults.delete(msg.serverName);
                    await this._afterPiConfigChange(
                        msg.enabled ? `MCP server "${msg.serverName}" enabled` : `MCP server "${msg.serverName}" disabled`,
                    );
                    break;
                case 'testMcpServer':
                    await this._testMcpServer(msg.serverName);
                    break;
                case 'testAllMcpServers':
                    await this._testAllMcpServers();
                    break;
                case 'runPiLogin':
                    await this._runPiLogin();
                    break;
                case 'runPiLogout':
                    await this._runPiLogout();
                    break;
                case 'testStt': {
                    const s = msg.settings;
                    await this._testVoiceService('stt', s.sttModel, s.sttEngine === 'custom', (model) => this._checkStt({ ...s, sttModel: model }));
                    break;
                }
                case 'testTts': {
                    const t = msg.settings;
                    await this._testVoiceService('tts', t.model, t.engine === 'custom', (model) => this._checkTts({ ...t, model }));
                    break;
                }
                case 'startSttDryRun':
                    await this._voiceDryRun.startStt(msg.run, msg.settings, msg.apiKey);
                    break;
                case 'stopSttDryRun':
                    await this._voiceDryRun.stopStt();
                    break;
                case 'ttsDryRun':
                    await this._voiceDryRun.synthesize(msg.settings, msg.text, msg.apiKey);
                    break;
                case 'saveVoice':
                    await this._saveVoice(msg.stt, msg.tts, msg.apiKeys, msg.test);
                    break;
                case 'removeVoiceApiKey': {
                    const label = CLOUD_PROVIDERS.find((p) => p.id === msg.provider)?.label ?? msg.provider;
                    await setVoiceApiKey(msg.provider, null);
                    this._post({ type: 'success', message: `${label} API key removed.` });
                    break;
                }
                case 'openVoiceKeyPage': {
                    // Only the known providers' pages: the webview names a provider, not a URL.
                    const provider = CLOUD_PROVIDERS.find((p) => p.id === msg.provider);
                    if (provider) {
                        await vscode.env.openExternal(vscode.Uri.parse(provider.apiKeyUrl));
                    }
                    break;
                }
                case 'getBuiltinVoiceStatus':
                    await this._sendBuiltinVoiceStatus(false);
                    break;
                case 'prepareBuiltinVoice':
                    await this._prepareBuiltinVoice();
                    break;
                case 'voiceDirty':
                    this._voiceDirty = msg.dirty;
                    break;
            }
        } catch (err: any) {
            this._post({ type: 'error', message: err.message ?? String(err) });
        }
    }

    private async _afterPiConfigChange(successMessage: string): Promise<void> {
        await this._sendSettings();
        await this._sendSkills();
        await this._sendMcpSnapshot();
        this._post({ type: 'piConfigUpdated' });
        this._post({ type: 'success', message: successMessage });
    }

    private async _runPiLogin(): Promise<void> {
        await runPiLoginFlow();
        await this._sendSettings();
    }

    private async _runPiLogout(): Promise<void> {
        await runPiLogoutFlow();
        await this._sendSettings();
    }

    private async _sendMcpSnapshot(): Promise<void> {
        if (!isSyncWithPiCli()) {
            return;
        }
        const loaded = await loadPiAgentConfigForSettings(this._piSession, this._currentBackend);
        const packages = loaded.config?.packages ?? [];
        const snapshot = await loadMcpSettingsSnapshot(packages, this._mcpProbeResults, this._currentBackend);
        this._post({ type: 'mcpSnapshot', snapshot });
    }

    private async _testMcpServer(serverName: string): Promise<void> {
        const loaded = await loadPiAgentConfigForSettings(this._piSession, this._currentBackend);
        const packages = loaded.config?.packages ?? [];
        const snapshot = await loadMcpSettingsSnapshot(packages, this._mcpProbeResults, this._currentBackend);
        const server = snapshot.servers.find((s) => s.name === serverName);
        if (!server) {
            this._post({ type: 'error', message: `Unknown MCP server: ${serverName}` });
            return;
        }
        const result = await probeMcpServer(server, this._currentBackend);
        this._mcpProbeResults.set(serverName, result);
        await this._sendMcpSnapshot();
        this._post({
            type: result.ok ? 'success' : 'error',
            message: `${serverName}: ${result.message}`,
        });
    }

    private async _testAllMcpServers(): Promise<void> {
        const loaded = await loadPiAgentConfigForSettings(this._piSession, this._currentBackend);
        const packages = loaded.config?.packages ?? [];
        const snapshot = await loadMcpSettingsSnapshot(packages, this._mcpProbeResults, this._currentBackend);
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Checking MCP server reachability',
                cancellable: false,
            },
            async () => {
                for (const server of snapshot.servers) {
                    if (!server.enabled) {
                        continue;
                    }
                    const result = await probeMcpServer(server, this._currentBackend);
                    this._mcpProbeResults.set(server.name, result);
                }
            },
        );
        await this._sendMcpSnapshot();
        this._post({ type: 'success', message: 'MCP reachability checks finished' });
    }

    private async _updateSetting(key: string, value: unknown): Promise<void> {
        const config = vscode.workspace.getConfiguration('oh-my-pi-chater');
        await config.update(key, value, vscode.ConfigurationTarget.Global);
    }

    /** A check's result in plain language; the raw failure goes to the log. */
    private _voiceCheckResult(service: VoiceServiceId, res: ModelsProbeResult, url: string, model: string | undefined): { ok: boolean; message: string } {
        if (res.ok) {
            // STT notes a configured model the server does not list, without failing.
            return { ok: true, message: res.message.includes(', but ') ? res.message : `Connected${model ? ` — ${model}` : ''}.` };
        }
        const explained = explainVoiceError(res.message, { service, hasKey: sendsApiKey(service, url) });
        this._outputChannel?.appendLine(`[voice] ${VOICE_SERVICE_NAMES[service]} check failed: ${explained.detail}`);
        return { ok: false, message: explained.message };
    }

    /**
     * Checks STT as given, nothing saved (a cloud service with its stored key). On the built-in engine
     * that starts it, downloading its models the first time. A check of the saved setup is recorded,
     * so the mic follows it; the engine failing to start records itself (resolveSttConfig).
     */
    private async _checkStt(settings: VoiceSettings): Promise<{ ok: boolean; message: string; models: string[] }> {
        const res = await resolveSttConfig(settings).then(
            async (stt) => {
                const probed = await testSttConnectivity(stt.url, stt.model, stt.apiKey);
                // Dropped unless these are the configured settings.
                recordSttCheck(settings, probed.ok, probed.message);
                return probed;
            },
            (err: unknown): ModelsProbeResult => ({ ok: false, message: describeError(err), models: [] }),
        );
        const model = settings.sttEngine === 'builtin' ? STT_MODEL.id : settings.sttModel || res.models[0];
        return { ...this._voiceCheckResult('stt', res, settings.sttUrl, model), models: res.models };
    }

    /** Checks TTS as `_checkStt` does STT. */
    private async _checkTts(settings: TtsConfig): Promise<{ ok: boolean; message: string; models: string[] }> {
        const res = await resolveTtsConfig(settings).then(
            async (tts) => {
                const probed = await testTtsConnectivity(tts);
                // Dropped unless this is the configured service.
                recordTtsCheck(settings, probed.ok, probed.message);
                return probed;
            },
            (err: unknown): ModelsProbeResult => ({ ok: false, message: describeError(err), models: [] }),
        );
        return { ...this._voiceCheckResult('tts', res, settings.url, settings.model || undefined), models: settings.engine === 'custom' ? res.models : [] };
    }

    /**
     * A section's Test on your own server: checks the values as shown, nothing saved. When the model
     * is empty or one the server does not list, the server's first model (for this task) is taken
     * instead, checked, and handed back for the Model field to fill in.
     */
    private async _testVoiceService(
        service: VoiceServiceId,
        configured: string,
        custom: boolean,
        checkWith: (model: string) => Promise<{ ok: boolean; message: string; models: string[] }>,
    ): Promise<void> {
        const model = configured.trim();
        let res = await checkWith(model);
        const detected = custom && res.models.length > 0 && !res.models.includes(model) ? res.models[0] : undefined;
        if (detected) {
            res = await checkWith(detected);
            if (res.ok) {
                res = { ...res, message: model ? `Connected. The server has no model "${model}": filled in "${detected}" instead.` : `Connected. Found model "${detected}" and filled it in.` };
            }
        }
        this._post({
            type: 'voiceTestResult',
            service,
            ok: res.ok,
            message: res.message,
            check: voiceReadiness()[service],
            models: res.models,
            detectedModel: detected,
        });
    }

    /**
     * Save (and "Save & test"): writes both sections and the typed keys, then with `test` checks each
     * custom service as saved. Built-in ones are not checked: that would download their models.
     */
    private async _saveVoice(stt: VoiceSettings, tts: TtsConfig, apiKeys: Record<string, string>, test: boolean): Promise<void> {
        try {
            await saveVoiceSettings(stt);
            await saveTtsSettings(tts);
            for (const [provider, key] of Object.entries(apiKeys)) {
                if (key.trim()) {
                    await setVoiceApiKey(provider, key);
                }
            }
        } catch (err: unknown) {
            this._post({ type: 'voiceSaved', saved: false, ok: false, message: `Could not save the voice settings: ${describeError(err)}`, tests: {} });
            return;
        }
        const tests: Partial<Record<VoiceServiceId, { ok: boolean; message: string }>> = {};
        if (test) {
            const savedStt = readVoiceSettings();
            const savedTts = readTtsSettings();
            const [sttRes, ttsRes] = await Promise.all([
                savedStt.sttEngine === 'custom' ? this._checkStt(savedStt) : undefined,
                savedTts.engine === 'custom' ? this._checkTts(savedTts) : undefined,
            ]);
            if (sttRes) {
                tests.stt = { ok: sttRes.ok, message: sttRes.message };
            }
            if (ttsRes) {
                tests.tts = { ok: ttsRes.ok, message: ttsRes.message };
            }
        }
        const checked = Object.entries(tests) as Array<[VoiceServiceId, { ok: boolean; message: string }]>;
        const failed = checked.find(([, res]) => !res.ok);
        const message = failed
            ? `Saved, but ${VOICE_SERVICE_NAMES[failed[0]]} isn't working: ${failed[1].message}`
            : checked.length > 0
              ? `Ready: ${checked.map(([service]) => VOICE_SERVICE_NAMES[service]).join(' and ')} answered. Voice is set up.`
              : 'Voice settings saved.';
        this._post({ type: 'voiceSaved', saved: true, ok: !failed, message, tests });
    }

    private async _sendBuiltinVoiceStatus(busy: boolean, error?: string): Promise<void> {
        const status = await builtinVoiceStatus().catch(() => undefined);
        this._post({ type: 'builtinVoiceStatus', status, busy, error });
    }

    /** "Download now": downloads the built-in models (with the usual progress notification) and starts the engine. */
    private async _prepareBuiltinVoice(): Promise<void> {
        await this._sendBuiltinVoiceStatus(true);
        try {
            await builtinVoiceEngineUrl();
            await this._sendBuiltinVoiceStatus(false);
        } catch (err: unknown) {
            await this._sendBuiltinVoiceStatus(false, explainVoiceError(err).message);
        }
    }

    private async _sendSettings(): Promise<void> {
        const config = vscode.workspace.getConfiguration('oh-my-pi-chater');
        const backend = this._currentBackend;
        const sync = isSyncWithPiCli();
        const piSummary = sync ? readAgentSettingsSummary(backend) : undefined;
        let piConfig: SettingsData['piConfig'];
        let piConfigLoadError: string | undefined;
        if (sync) {
            const loaded = await loadPiAgentConfigForSettings(this._piSession, backend);
            piConfig = loaded.config;
            piConfigLoadError = loaded.error;
        }

        const data: SettingsData = {
            backend,
            availableBackends: getAvailableBackends(),
            extensionVersion: this._extensionVersion,
            syncWithPiCli: sync,
            piAgentDir: getPiAgentDir(backend),
            piConfigLoadError,
            piDefaultProvider: piSummary?.defaultProvider,
            piDefaultModel: piSummary?.defaultModel,
            piDefaultThinkingLevel: piSummary?.defaultThinkingLevel,
            piConfig,
            authMethod: detectAuthMethod(piConfig?.authProviders),
            defaultPermissionLevel: readDefaultPermissionLevel(),
            allowedTools: config.get<string[]>('allowedTools', []),
            contextUsageWarningThreshold: config.get<number>('contextUsageWarningThreshold', 80),
            voice: readVoiceSettings(),
            tts: readTtsSettings(),
            voiceReadiness: voiceReadiness(),
            voiceApiKeys: voiceApiKeysSet(),
            voiceOwnServers: ownVoiceServers(),
            voiceSkills: config.get<string[]>('voiceAgent.skills', []),
            voiceMessageButtons: config.get<boolean>('voiceAgent.messageButtons', false),
            voiceTranslateTo: config.get<string>('voiceAgent.translateTo', DEFAULT_TRANSLATION_LANGUAGE),
            voiceSpeakers: await this._voiceSpeakers(config),
        };

        if (sync && piConfig) {
            data.mcpSnapshot = await loadMcpSettingsSnapshot(piConfig.packages, this._mcpProbeResults, backend);
            let slash: string[] = [];
            try {
                slash = (await this._piSession?.listSlashCommands() ?? []).map((c) => c.name.replace(/^skill:/, ''));
            } catch {
                // The tab's CLI is (re)starting: judge the recommended packages by settings alone.
            }
            const missing = getMissingRecommendedPackages(piConfig.packages, slash, backend);
            if (missing.length > 0) {
                data.recommendedPackagesMissing = missing.map((p) => p.source);
            }
        }

        if (this._currentBackend === backend) {
            this._post({ type: 'settings', data });
        }
    }

    private async _voiceSpeakers(config: vscode.WorkspaceConfiguration): Promise<SettingsData['voiceSpeakers']> {
        const { speakers, errors } = await resolveSpeakers();
        const setting = (id: VoiceSpeakerId) => ({
            name: config.get<string>(`voiceAgent.${id}Name`, DEFAULT_SPEAKER_NAMES[id]),
            avatar: config.get<string>(`voiceAgent.${id}Avatar`, ''),
            resolved: speakers[id].avatar,
            error: errors[id],
        });
        return { user: setting('user'), bot: setting('bot') };
    }

    private async _sendSkills(): Promise<void> {
        if (this._piSession) {
            const skills = await this._piSession.getSkillsAsync();
            this._post({ type: 'skills', skills });
            return;
        }
        this._post({ type: 'skills', skills: [] });
    }

    private _post(message: SettingsServerMessage): void {
        this._panel.webview.postMessage(message);
    }

    private _dispose(): void {
        SettingsPanel._instance = undefined;
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables = [];
        if (this._voiceDirty) {
            void vscode.window
                .showWarningMessage('Voice settings: your unsaved changes were discarded when Settings closed.', 'Open Voice Settings')
                .then((pick) => pick && SettingsPanel.showWithSection('voice'));
        }
    }

    private _getHtml(): string {
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'settings.js'),
        );
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'styles', 'settings.css'),
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; media-src data:;">
    <link rel="stylesheet" href="${styleUri}">
    <title>PI Buddy Settings</title>
</head>
<body>
    <div id="settings-app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

/** Credentials in the backend's login store (pi auth.json, omp agent.db / models.yml), else a provider API key env var. */
function detectAuthMethod(authProviders?: { configured: boolean }[]): SettingsData['authMethod'] {
    if (authProviders?.some((p) => p.configured)) {
        return 'login';
    }
    const envKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'CURSOR_API_KEY'];
    return envKeys.some((key) => process.env[key]) ? 'env' : 'none';
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
