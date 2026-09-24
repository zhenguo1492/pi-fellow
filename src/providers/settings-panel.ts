import * as vscode from 'vscode';
import type { SettingsClientMessage, SettingsServerMessage, SettingsData, SkillInfo, AgentBackend } from '../shared/protocol';
import type { PiChatSession } from '../pi/slashCommands';
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
import { getAgentLayout, getAvailableBackends, clearCliTargetCache } from '../pi/piCliPaths';
import { rebuildAgentNativeModules } from '../pi/piExtensionCompat';
import { runPiLoginFlow, runPiLogoutFlow } from '../pi/slashCommands';
import { testSttConnectivity } from '../voice/stt';
import { readVoiceSettings, setSttValid } from '../voice/voiceSettings';

const API_KEY_PREFIX = 'oh-my-pi-chater.apiKey.';

export class SettingsPanel {
    private static _instance: SettingsPanel | undefined;
    private _panel: vscode.WebviewPanel;
    private _extensionUri: vscode.Uri;
    private _secrets: vscode.SecretStorage;
    private _piSession: PiChatSession | undefined;
    private _currentBackend: AgentBackend;
    private _extensionVersion: string;
    private _outputChannel: vscode.OutputChannel | undefined;
    private _disposables: vscode.Disposable[] = [];
    private _mcpProbeResults = new Map<string, { ok: boolean; message: string }>();

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        secrets: vscode.SecretStorage,
        extensionVersion: string,
        piSession?: PiChatSession,
        outputChannel?: vscode.OutputChannel,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._secrets = secrets;
        this._extensionVersion = extensionVersion;
        this._piSession = piSession;
        this._currentBackend = getAgentLayout().backend;
        this._outputChannel = outputChannel;

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
        this._disposables.push(configListener);

        void this._sendSettings();
        void this._sendSkills();
    }

    static show(
        extensionUri: vscode.Uri,
        secrets: vscode.SecretStorage,
        piSession?: PiChatSession,
        extensionVersion?: string,
        outputChannel?: vscode.OutputChannel,
    ): void {
        SettingsPanel._open(extensionUri, secrets, piSession, extensionVersion, outputChannel);
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
        secrets: vscode.SecretStorage,
        piSession?: PiChatSession,
        extensionVersion?: string,
        outputChannel?: vscode.OutputChannel,
    ): void {
        if (SettingsPanel._instance) {
            SettingsPanel._instance._piSession = piSession;
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
            'Oh My Pi Chater Settings',
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
            secrets,
            extensionVersion ?? '0.0.0',
            piSession,
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
                case 'setApiKey':
                    if (isSyncWithPiCli()) {
                        this._post({
                            type: 'error',
                            message: 'API keys live in ~/.pi/agent/auth.json. Use Configure provider (/login) or Open auth.json.',
                        });
                        return;
                    }
                    await this._secrets.store(`${API_KEY_PREFIX}${msg.provider}`, msg.key);
                    await this._sendSettings();
                    break;
                case 'clearApiKey':
                    if (isSyncWithPiCli()) {
                        return;
                    }
                    await this._secrets.delete(`${API_KEY_PREFIX}${msg.provider}`);
                    await this._sendSettings();
                    break;
                case 'getSkills':
                    await this._sendSkills();
                    break;
                case 'setBackend':
                    if (msg.backend === 'omp' || msg.backend === 'pi') {
                        this._currentBackend = msg.backend;
                        const config = vscode.workspace.getConfiguration('oh-my-pi-chater');
                        await config.update('backend', msg.backend, vscode.ConfigurationTarget.Global);
                        clearCliTargetCache();
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
                case 'openExternalUrl':
                    await vscode.env.openExternal(vscode.Uri.parse(msg.url));
                    break;
                case 'addPiExtensionPath':
                    await addPiExtensionPath(msg.path, this._piSession);
                    await this._afterPiConfigChange('Extension path added');
                    break;
                case 'removePiExtensionPath':
                    await removePiExtensionPathAt(msg.index, this._piSession);
                    schedulePiSessionReload(this._piSession, this._outputChannel);
                    await this._afterPiConfigChange('Extension path removed');
                    break;
                case 'addPiSkillPath':
                    await addPiSkillPath(msg.path, this._piSession, this._currentBackend);
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
                    if (this._piSession) {
                        await this._piSession.reloadPiAgentResources();
                        this._mcpProbeResults.clear();
                        await this._afterPiConfigChange('Session reloaded from ~/.pi/agent');
                    } else {
                        this._post({ type: 'error', message: 'No active Pi session to reload' });
                    }
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
                case 'rebuildNativeModules':
                    await rebuildAgentNativeModules(this._outputChannel ?? vscode.window.createOutputChannel('Oh My Pi Chater'));
                    if (this._piSession) {
                        await this._piSession.reloadPiAgentResources();
                    }
                    await this._sendSettings();
                    break;
                case 'testStt':
                    await this._testStt(msg.url);
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
        await runPiLoginFlow(this._piSession);
        await this._sendSettings();
    }

    private async _runPiLogout(): Promise<void> {
        await runPiLogoutFlow(this._piSession);
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
                title: 'Testing MCP servers',
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
        this._post({ type: 'success', message: 'MCP connection tests finished' });
    }

    private async _updateSetting(key: string, value: unknown): Promise<void> {
        const config = vscode.workspace.getConfiguration('oh-my-pi-chater');
        if (key === 'voice.sttUrl') {
            setSttValid(false);
        }
        await config.update(key, value, vscode.ConfigurationTarget.Global);
    }

    private async _testStt(urlOverride?: string): Promise<void> {
        const { sttUrl, sttModel } = readVoiceSettings();
        const effectiveUrl = (urlOverride !== undefined ? urlOverride.trim() : sttUrl);
        if (!effectiveUrl) {
            setSttValid(false);
            this._post({
                type: 'sttTestResult',
                ok: false,
                message: 'Enter a Speech-to-text URL first.',
            });
            return;
        }
        try {
            const res = await testSttConnectivity(effectiveUrl, sttModel);
            if (res.ok && urlOverride !== undefined) {
                const config = vscode.workspace.getConfiguration('oh-my-pi-chater');
                await config.update('voice.sttUrl', effectiveUrl, vscode.ConfigurationTarget.Global);
            }
            setSttValid(res.ok);
            this._post({
                type: 'sttTestResult',
                ok: res.ok,
                message: res.ok
                    ? `STT connected (HTTP 200) — ${sttModel || res.models[0] || 'ready'}`
                    : `Connection failed: ${res.message}`,
            });
        } catch (err: unknown) {
            setSttValid(false);
            const message = err instanceof Error ? err.message : String(err);
            this._post({
                type: 'sttTestResult',
                ok: false,
                message: `Connection failed: ${message}`,
            });
        }
    }

    private async _sendSettings(): Promise<void> {
        const config = vscode.workspace.getConfiguration('oh-my-pi-chater');
        const backend = this._currentBackend;
        const sync = isSyncWithPiCli();
        const provider = config.get<string>('apiProvider', '');
        const agentDir = getPiAgentDir(backend);
        const piSummary = sync ? readAgentSettingsSummary(backend) : undefined;
        let piConfig: SettingsData['piConfig'];
        let piConfigLoadError: string | undefined;
        if (sync) {
            const loaded = await loadPiAgentConfigForSettings(this._piSession, backend);
            piConfig = loaded.config;
            piConfigLoadError = loaded.error;
        }

        let apiKeySet = false;
        if (!sync && provider) {
            const stored = await this._secrets.get(`${API_KEY_PREFIX}${provider}`);
            apiKeySet = !!stored;
        }

        const authMethod = this._detectAuthMethod(provider, apiKeySet, sync, piConfig?.authProviders, backend);

        const data: SettingsData = {
            backend,
            availableBackends: getAvailableBackends(),
            extensionVersion: this._extensionVersion,
            syncWithPiCli: sync,
            piAgentDir: agentDir,
            piConfigLoadError,
            piDefaultProvider: piSummary?.defaultProvider,
            piDefaultModel: piSummary?.defaultModel,
            piDefaultThinkingLevel: piSummary?.defaultThinkingLevel,
            piPackageCount: piSummary?.packageCount ?? piConfig?.packages.length ?? 0,
            piConfig,
            apiProvider: sync ? (piSummary?.defaultProvider ?? '') : provider,
            apiBaseUrl: config.get<string>('apiBaseUrl', ''),
            apiKeySet,
            authMethod,
            defaultModel: sync ? (piSummary?.defaultModel ?? '') : config.get<string>('defaultModel', ''),
            thinkingLevel: sync
                ? (piSummary?.defaultThinkingLevel ?? 'off')
                : config.get<string>('thinkingLevel', 'off'),
            autoApproveTools: config.get<boolean>('autoApproveTools', false),
            allowedTools: config.get<string[]>('allowedTools', []),
            autoSaveSessions: config.get<boolean>('autoSaveSessions', true),
            sessionStoragePath: config.get<string>('sessionStoragePath', ''),
            contextUsageWarningThreshold: config.get<number>('contextUsageWarningThreshold', 80),
            voice: readVoiceSettings(),
        };

        if (this._piSession && this._piSession.backend === backend) {
            data.extensionLoadIssues = this._piSession.getExtensionLoadIssues();
            data.loadedExtensionCount = this._piSession.getLoadedExtensionCount();
        }

        if (sync && piConfig) {
            data.mcpSnapshot = await loadMcpSettingsSnapshot(piConfig.packages, this._mcpProbeResults, backend);
            const slash = (this._piSession && this._piSession.backend === backend)
                ? (await this._piSession.listSlashCommands()).map((c) => c.name.replace(/^skill:/, ''))
                : [];
            const missing = getMissingRecommendedPackages(piConfig.packages, slash, backend);
            if (missing.length > 0) {
                data.recommendedPackagesMissing = missing.map((p) => p.source);
            }
        }

        if (this._currentBackend === backend) {
            this._post({ type: 'settings', data });
        }
    }

    private async _sendSkills(): Promise<void> {
        if (this._piSession) {
            const skills = await this._piSession.getSkillsAsync();
            this._post({ type: 'skills', skills });
            return;
        }
        this._post({ type: 'skills', skills: [] });
    }

    private _detectAuthMethod(
        provider: string,
        hasManualKey: boolean,
        sync: boolean,
        authProviders?: { id: string; configured: boolean }[],
        backend: AgentBackend = 'pi',
    ): SettingsData['authMethod'] {
        if (!sync && hasManualKey) {
            return 'manual';
        }

        if (sync && authProviders?.some((p) => p.configured)) {
            return 'pi-login';
        }

        const envVarMap: Record<string, string> = {
            anthropic: 'ANTHROPIC_API_KEY',
            openai: 'OPENAI_API_KEY',
            google: 'GEMINI_API_KEY',
            deepseek: 'DEEPSEEK_API_KEY',
            cursor: 'CURSOR_API_KEY',
        };

        if (provider && envVarMap[provider] && process.env[envVarMap[provider]]) {
            return 'env';
        }

        const fs = require('fs');
        const path = require('path');
        const authPath = path.join(
            require('os').homedir(),
            backend === 'omp' ? '.omp' : '.pi',
            'agent',
            backend === 'omp' ? 'agent.db' : 'auth.json',
        );
        if (fs.existsSync(authPath)) {
            return 'pi-login';
        }

        return 'none';
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
          content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>Oh My Pi Chater Settings</title>
</head>
<body>
    <div id="settings-app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
