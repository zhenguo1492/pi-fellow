import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { ImageContent } from '../shared/piTypes';
import type {
    ContextBreakdownInfo,
    ContextUsageInfo,
    ModelInfo,
    PlanModeInfo,
    SerializedAgentState,
    SessionTokenStats,
    SkillInfo,
    SlashCommandListItem,
} from '../shared/protocol';
import { EventRouter } from './events';
import type { AgentBackend } from './agentBackend';
import { getAgentLayout, getPiAgentDir, describeCliInvocation, resolvePiCliInvocation } from './piCliPaths';
import { readLoggedInProviders } from './loggedInProviders';
import { applyPiCliDefaultModel } from './piCliSync';
import { PiRpcBridge } from './piRpcBridge';
import { parseContextReport } from './contextReport';
import { PiExtensionChrome } from './piExtensionChrome';
import { RpcExtensionUiHandler } from './rpcExtensionUi';
import type { PiAgentEvent, RpcExtensionUIRequest, RpcSessionStats } from './rpcTypes';
import { readPlanModeInfoFromContext } from './planModeState';
import { tryHandleBashPrefix } from './slashCommands';
import { isVscodeOnlySlash, tryHandleSlashCommand } from './slashCommandRouter';
import { buildImplementPlanPrompt } from './planModeState';
import { readAllowedTools, readDefaultPermissionLevel } from './permissionGate';
import type { PermissionGateState } from './permissionPolicy';
import {
    enrichUserMessagesWithForkEntryIds,
    findPrecedingUserMessageIndex,
    userMessagePlainText,
} from './messageForkIds';
import { readSessionDisplayName, readSessionJsonlEntries } from './sessionJsonl';
import { readPiSettingsJson } from './piSettingsJson';
import { readOmpConfig } from './ompAgentConfig';
import { readFavoriteModels, toggleFavoriteModel } from './favoriteModels';

/** Plan mode drives the pi-plan-mode extension; omp's RPC mode exposes no plan-mode control. */
const PLAN_MODE_PI_ONLY = 'Plan mode is only available with the pi backend.';

const RPC_BUILTIN_SLASH: ReadonlyArray<{ name: string; description: string }> = [
    { name: 'login', description: 'Configure provider authentication' },
    { name: 'logout', description: 'Remove stored credentials' },
    { name: 'model', description: 'Select model' },
    { name: 'new', description: 'Start a new session' },
    { name: 'reload', description: 'Reload extensions, skills, packages' },
    { name: 'settings', description: 'Open Pi settings' },
    { name: 'compact', description: 'Compact session context' },
    { name: 'resume', description: 'Resume another session' },
    { name: 'session', description: 'Show session info' },
];

/** Last model/skill list per backend + folder: a new worker shows it until its own list has loaded. */
const catalogByWorkspace = new Map<string, { models: ModelInfo[]; skills: SkillInfo[] }>();

export class RpcSessionShim {
    isStreaming = false;
    isBashRunning = false;
    isRetrying = false;
    retryAttempt = 0;
    sessionId = '';
    sessionName?: string;
    sessionFile?: string;
    thinkingLevel = 'off';
    model?: { provider: string; id: string; name?: string };
    cwd: string;
    contextUsage?: ContextUsageInfo;
    activeToolNames: string[] = [];

    constructor(cwd: string) {
        this.cwd = cwd;
    }

    getContextUsage(): ContextUsageInfo | undefined {
        return this.contextUsage;
    }

    getActiveToolNames(): string[] {
        return this.activeToolNames;
    }
}

export class PiRpcSessionManager {
    readonly events = new EventRouter();
    private readonly _outputChannel: vscode.OutputChannel;
    private readonly _bridge = new PiRpcBridge();
    private readonly _rpcUi = new RpcExtensionUiHandler(this._bridge);
    readonly extensionChrome = new PiExtensionChrome();
    private _shim: RpcSessionShim | undefined;
    private _unsubscribe: (() => void) | undefined;
    private _messages: any[] = [];
    private _cachedModels: ModelInfo[] = [];
    private _cachedSkills: SkillInfo[] = [];
    /** `_cachedModels` + `_cachedSkills` as last announced to `onDidChangeCatalog` listeners. */
    private _catalogSnapshot = '';
    private readonly _catalogListeners = new Set<() => void>();
    /** Backend + folder: workers sharing it list the same models and skills (`catalogByWorkspace`). */
    private _catalogKey = '';
    private _sessionStats: SessionTokenStats | undefined;
    private _postChatError: ((message: string) => void) | undefined;
    private _onOpenSessionTree: (() => Promise<void> | void) | undefined;
    /** What the permission gate enforces in this worker; survives CLI restarts. */
    private _permission: PermissionGateState = { level: readDefaultPermissionLevel(), allowedTools: readAllowedTools() };

    constructor(outputChannel: vscode.OutputChannel) {
        this._outputChannel = outputChannel;
        this._rpcUi.autoApproveTools = this._permission.level === 'auto';
    }

    /** The tab's permission level, applied from the worker's next tool call on. */
    setPermission(state: PermissionGateState): void {
        this._permission = state;
        this._bridge.setPermission(state);
        // Auto also answers omp's own approval prompts (tools.approvalMode other than yolo).
        this._rpcUi.autoApproveTools = state.level === 'auto';
    }

    get session(): RpcSessionShim | undefined {
        return this._shim;
    }

    private _readyPromise: Promise<void> | null = null;
    private _isInitialized = false;

    getSessionTokenStats(): SessionTokenStats | undefined {
        return this._sessionStats;
    }

    /** omp's `/context` breakdown of the context window (rejects on pi). */
    async getContextBreakdown(): Promise<ContextBreakdownInfo> {
        return parseContextReport(await this._bridge.contextReport());
    }

    get isReady(): boolean {
        return this._isInitialized && this._bridge.isStarted;
    }

    async waitUntilReady(): Promise<void> {
        if (this._readyPromise) {
            await this._readyPromise;
        }
    }

    get rpcExtensionUi(): RpcExtensionUiHandler {
        return this._rpcUi;
    }

    setPostChatError(fn: (message: string) => void): void {
        this._postChatError = fn;
    }

    setOnOpenSessionTree(fn: (() => Promise<void> | void) | undefined): void {
        this._onOpenSessionTree = fn;
    }

    async getSessionTree(): Promise<{ tree: any[]; leafId: string | null }> {
        return this._bridge.getTree();
    }

    async showSessionTree(): Promise<void> {
        if (this._onOpenSessionTree) {
            await this._onOpenSessionTree();
        } else {
            await this.showForkPicker();
        }
    }

    postChatError(message: string): void {
        this._postChatError?.(message);
    }

    get backend(): AgentBackend {
        return this._bridge.backend;
    }

    async initialize(preferredBackend?: AgentBackend, targetCwd?: string): Promise<void> {
        this._isInitialized = false;
        const promise = this._doInitialize(preferredBackend, targetCwd);
        this._readyPromise = promise;
        await promise;
    }

    private async _doInitialize(preferredBackend?: AgentBackend, targetCwd?: string): Promise<void> {
        const cwd = targetCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        this._shim = new RpcSessionShim(cwd);

        const config = vscode.workspace.getConfiguration('oh-my-pi-chater');
        const args: string[] = [];
        const thinking = config.get<string>('thinkingLevel', 'off');
        if (thinking && thinking !== 'off') {
            args.push('--thinking', thinking);
        }

        const invocation = await resolvePiCliInvocation(preferredBackend);
        this._outputChannel.appendLine(
            `Starting ${invocation.backend} in RPC mode (--mode rpc) — ${describeCliInvocation(invocation)}`,
        );
        await this._bridge.start(cwd, args, preferredBackend, { permission: this._permission });
        this._rpcUi.setChrome(this.extensionChrome);

        this._unsubscribe = this._bridge.on((event) => {
            this._onBridgeEvent(event);
        });

        // The model list waits on the CLI's provider discovery (local servers + network, ~0.5s or far more):
        // it loads in the background. Until then the tab shows the list another worker here last loaded.
        this._catalogKey = `${this.backend}\0${cwd}`;
        const cached = catalogByWorkspace.get(this._catalogKey);
        if (cached) {
            this._setCatalog(cached.models, cached.skills);
        }
        void this._refreshModelsAndSkills();
        await Promise.all([
            this._applyRpcModesFromSettings(),
            this._refreshState(),
            this._refreshMessages(),
            this._refreshSessionStats(),
        ]);
        try {
            await applyPiCliDefaultModel(this);
        } catch {
            /* model not available in current backend */
        }

        this._isInitialized = true;
        const state = this._shim;
        this._outputChannel.appendLine(
            `Pi RPC ready. Model: ${state?.model ? `${state.model.provider}/${state.model.id}` : 'none'}`,
        );
    }

    /** Push the steering/follow-up modes of this backend's config (omp: config.yml, pi: settings.json). */
    private async _applyRpcModesFromSettings(): Promise<void> {
        const backend = this.backend;
        const settings = backend === 'omp' ? readOmpConfig(getPiAgentDir('omp')) : readPiSettingsJson(backend);
        try {
            const steering = settings.steeringMode === 'all' ? 'all' : 'one-at-a-time';
            const followUp = settings.followUpMode === 'all' ? 'all' : 'one-at-a-time';
            await Promise.all([
                this._bridge.setSteeringMode(steering),
                this._bridge.setFollowUpMode(followUp),
            ]);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`RPC steering/follow-up mode: ${msg}`);
        }
    }

    private _onBridgeEvent(event: PiAgentEvent | RpcExtensionUIRequest): void {
        if (event.type === 'extension_ui_request') {
            this._rpcUi.handleRequest(event as RpcExtensionUIRequest);
            return;
        }

        const agentEvent = event as PiAgentEvent;
        if (agentEvent.type === 'agent_start' && this._shim) {
            this._shim.isStreaming = true;
            this._shim.isRetrying = false;
        }
        if (agentEvent.type === 'auto_retry_start' && this._shim) {
            this._shim.isRetrying = true;
            const attempt = agentEvent.attempt;
            if (typeof attempt === 'number') {
                this._shim.retryAttempt = attempt;
            }
        }
        if (agentEvent.type === 'auto_retry_end' && this._shim) {
            this._shim.isRetrying = false;
        }
        if (agentEvent.type === 'agent_end' && this._shim) {
            this._shim.isStreaming = false;
        }

        this.events.dispatch(agentEvent);

        if (agentEvent.type === 'agent_end' && this._shim) {
            void this.syncFromRpc();
        }
        if (agentEvent.type === 'message_end') {
            void this._refreshMessages();
        }
        if (agentEvent.type === 'context_usage' && this._shim) {
            const usage = agentEvent.usage as RpcSessionStats['contextUsage'] | undefined;
            if (usage) {
                this._shim.contextUsage = {
                    tokens: usage.tokens ?? null,
                    contextWindow: usage.contextWindow ?? 0,
                    percent: usage.percent ?? null,
                };
            }
        }
        if (agentEvent.type === 'tools_changed' && this._shim) {
            const tools = agentEvent.tools;
            if (Array.isArray(tools)) {
                this._shim.activeToolNames = tools.map(String);
            }
        }
    }

    /** Refresh messages + session state from Pi RPC (await before UI stateSync). The model and skill lists follow in the background (`onDidChangeCatalog`). */
    async syncFromRpc(): Promise<void> {
        void this._refreshModelsAndSkills();
        await Promise.all([
            this._refreshMessages(),
            this._refreshState(),
            this._refreshSessionStats(),
        ]);
    }

    private async _refreshState(): Promise<void> {
        if (!this._shim) {
            return;
        }
        try {
            const state = await this._bridge.getState();
            this._shim.isStreaming = state.isStreaming;
            this._shim.sessionId = state.sessionId;
            this._shim.sessionFile = state.sessionFile;
            this._shim.thinkingLevel = state.thinkingLevel;
            const displayName =
                state.sessionName?.trim() ||
                readSessionDisplayName(state.sessionFile) ||
                undefined;
            this._shim.sessionName = displayName;
            if (state.model) {
                this._shim.model = {
                    provider: String(state.model.provider),
                    id: state.model.id,
                    name: state.model.name,
                };
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`RPC get_state failed: ${msg}`);
        }
    }

    private async _refreshSessionStats(): Promise<void> {
        try {
            const stats = await this._bridge.getSessionStats();
            this._sessionStats = {
                input: stats.tokens.input,
                output: stats.tokens.output,
                cacheRead: stats.tokens.cacheRead,
                cacheWrite: stats.tokens.cacheWrite,
                cost: stats.cost,
            };
            if (stats.contextUsage && this._shim) {
                this._shim.contextUsage = {
                    tokens: stats.contextUsage.tokens ?? null,
                    contextWindow: stats.contextUsage.contextWindow,
                    percent: stats.contextUsage.percent ?? null,
                };
            }
        } catch {
            /* ignore */
        }
    }

    private async _refreshMessages(): Promise<void> {
        try {
            this._messages = (await this._bridge.getMessages()) as any[];
            await this._attachForkEntryIds();
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`Loading session messages failed: ${message}`);
        }
    }

    private async _attachForkEntryIds(): Promise<void> {
        try {
            const forkMessages = await this._bridge.getForkMessages();
            enrichUserMessagesWithForkEntryIds(this._messages, forkMessages);
        } catch {
            /* fork list optional */
        }
    }

    /** Run a Pi CLI slash command over RPC and refresh chat when the CLI goes idle. */
    async runCliSlashCommand(text: string): Promise<void> {
        if (!this._bridge.isStarted) {
            throw new Error('Pi RPC not started');
        }
        const trimmed = text.trim();
        if (isVscodeOnlySlash(trimmed)) {
            await tryHandleSlashCommand(this, trimmed);
            return;
        }
        let settled = false;
        const done = new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    unsub();
                    resolve();
                }
            }, 30_000);
            const unsub = this._bridge.on((event) => {
                if (event.type === 'agent_end') {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        unsub();
                        resolve();
                    }
                }
            });
        });
        await this._bridge.prompt(text);
        await done;
        await this.syncFromRpc();
    }

    async prompt(text: string, images?: ImageContent[]): Promise<void> {
        await this.submitInput(text, { mode: 'prompt' }, images);
    }

    async steer(text: string, images?: ImageContent[]): Promise<void> {
        await this.submitInput(text, { mode: 'steer' }, images);
    }

    async followUp(text: string, images?: ImageContent[]): Promise<void> {
        await this.submitInput(text, { mode: 'followUp' }, images);
    }

    async submitInput(
        text: string,
        options: { mode: 'prompt' | 'steer' | 'followUp'; streamingBehavior?: 'steer' | 'followUp' } = {
            mode: 'prompt',
        },
        images?: ImageContent[],
    ): Promise<void> {
        if (!this._bridge.isStarted) {
            throw new Error('Pi RPC not started');
        }

        const trimmed = text.trim();
        if (!trimmed && (!images || images.length === 0)) {
            return;
        }

        if (await tryHandleBashPrefix(this, trimmed)) {
            return;
        }

        if (trimmed.startsWith('/')) {
            await tryHandleSlashCommand(this, trimmed);
            return;
        }

        const rpcImages = images as any[] | undefined;
        if (options.mode === 'steer') {
            await this._bridge.steer(text, rpcImages);
            return;
        }
        if (options.mode === 'followUp') {
            await this._bridge.followUp(text, rpcImages);
            return;
        }
        // An explicit streamingBehavior is sent even when idle: pi and omp then run it as a plain
        // prompt, and the send cannot race a run that started after isStreaming was last updated.
        if (options.streamingBehavior || this._shim?.isStreaming) {
            const behavior = options.streamingBehavior ?? 'steer';
            await this._bridge.prompt(text, rpcImages, behavior);
            return;
        }
        await this._bridge.prompt(text, rpcImages);
    }

    async abort(): Promise<void> {
        if (!this._bridge.isStarted) {
            return;
        }
        if (this._shim?.isBashRunning) {
            await this._bridge.abortBash();
        }
        if (this._shim?.isRetrying) {
            await this._bridge.abortRetry();
        }
        const timeoutMs = 12_000;
        try {
            await Promise.race([
                this._bridge.abort(),
                new Promise<void>((_, reject) => {
                    setTimeout(() => reject(new Error('Stop timed out after 12s')), timeoutMs);
                }),
            ]);
        } finally {
            if (this._shim) {
                this._shim.isStreaming = false;
                this._shim.isRetrying = false;
            }
            try {
                await this.syncFromRpc();
            } catch {
                /* best-effort refresh after stop */
            }
        }
    }

    async runBash(command: string, excludeFromContext: boolean): Promise<void> {
        if (this._shim?.isBashRunning) {
            vscode.window.showWarningMessage('A bash command is already running.');
            return;
        }
        if (!this._shim) {
            return;
        }
        this._shim.isBashRunning = true;
        try {
            await this._bridge.bash(command, excludeFromContext);
            await this._refreshMessages();
        } finally {
            this._shim.isBashRunning = false;
        }
    }

    async compact(customInstructions?: string): Promise<void> {
        await this._bridge.compact(customInstructions);
        await this._refreshMessages();
        await this._refreshSessionStats();
    }

    /** Restart the CLI so it re-reads packages, skills and extensions; the tab stays on its backend and conversation. */
    async reloadPiAgentResources(): Promise<void> {
        const cwd = this._shim?.cwd ?? process.cwd();
        const backend = this.backend;
        const file = this._shim?.sessionFile;
        await this._bridge.stop();
        await this._bridge.start(cwd, [], backend, { permission: this._permission });
        if (file && fs.existsSync(file)) {
            await this._bridge.switchSession(file);
        }
        await this._applyRpcModesFromSettings();
        await this.syncFromRpc();
        this._outputChannel.appendLine('Pi RPC process restarted (reload)');
    }

    async setModel(provider: string, modelId: string): Promise<void> {
        await this._bridge.setModel(provider, modelId);
        await this._refreshState();
    }

    setThinkingLevel(level: string): void {
        void this._bridge.setThinkingLevel(level);
        if (this._shim) {
            this._shim.thinkingLevel = level;
        }
    }

    cycleThinkingLevel(): string | undefined {
        void this._bridge.cycleThinkingLevel().then((r) => {
            if (r && this._shim) {
                this._shim.thinkingLevel = r.level;
            }
        });
        return this._shim?.thinkingLevel;
    }

    async cycleModel(): Promise<{ model: { provider: string; id: string }; thinkingLevel: string } | null> {
        const result = await this._bridge.cycleModel();
        await this._refreshState();
        return result;
    }

    async newSession(): Promise<void> {
        await this._bridge.newSession();
        await this.syncFromRpc();
        try {
            await applyPiCliDefaultModel(this);
        } catch {
            /* model not available in current backend */
        }
    }

    /**
     * Re-read the session file after another process (the TUI) appended to it. A same-path
     * `switch_session` does not reliably reload, so bounce through a fresh (unpersisted) session.
     */
    async reloadSessionFromDisk(): Promise<void> {
        const file = this._shim?.sessionFile;
        if (file && fs.existsSync(file)) {
            await this._bridge.newSession();
            await this._bridge.switchSession(file);
        }
        await this.syncFromRpc();
    }

    async loadSession(sessionPath: string): Promise<boolean> {
        // A freshly created tab's RPC process may still be starting; switching before
        // `initialize` settles fails ("bridge not started") or races its state refresh.
        await this.waitUntilReady();
        try {
            const result = await this._bridge.switchSession(sessionPath);
            if (result.cancelled) {
                return false;
            }
            await this.syncFromRpc();
            // switch_session restores the saved model. Applying the CLI default here would
            // append a model_change to this conversation and overwrite its restored choice.
            return true;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (/working directory does not exist|cwd from session file does not exist/i.test(message)) {
                const cwd = this._shim?.cwd ?? process.cwd();
                const choice = await vscode.window.showWarningMessage(
                    'This session was created in a folder that no longer exists. Pi RPC cannot resume it in a different folder yet.',
                    { modal: true, detail: message },
                    'OK',
                );
                if (choice) {
                    this._outputChannel.appendLine(`Resume blocked (missing cwd): ${message}`);
                }
                return false;
            }
            throw err;
        }
    }

    async forkFromMessage(entryId: string): Promise<{ text: string; cancelled: boolean }> {
        const result = await this._bridge.fork(entryId);
        await this._refreshState();
        await this._refreshMessages();
        return result;
    }

    /** Resend edited user text: new turn at end, or fork from that message first. */
    async resendUserMessage(
        messageIndex: number,
        text: string,
        mode: 'new' | 'fork',
        entryId?: string,
    ): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed) {
            throw new Error('Message is empty');
        }
        const msg = this._messages[messageIndex];
        if (!msg || msg.role !== 'user') {
            throw new Error('Not a user message');
        }

        if (mode === 'fork') {
            const id =
                entryId ||
                (typeof msg._forkEntryId === 'string' ? msg._forkEntryId : undefined);
            if (!id) {
                throw new Error('Cannot fork: no entry id for this message. Try “Send as new message”.');
            }
            const forked = await this.forkFromMessage(id);
            if (forked.cancelled) {
                return;
            }
        }

        await this.submitInput(trimmed, {
            mode: 'prompt',
            streamingBehavior: 'steer',
        });
        await this.syncFromRpc();
    }

    /** Regenerate assistant reply for the user turn before `assistantMessageIndex`. */
    async regenerateAssistant(
        assistantMessageIndex: number,
        mode: 'new' | 'fork',
    ): Promise<void> {
        const assistant = this._messages[assistantMessageIndex];
        if (!assistant || assistant.role !== 'assistant') {
            throw new Error('Not an assistant message');
        }
        const userIdx = findPrecedingUserMessageIndex(this._messages, assistantMessageIndex);
        if (userIdx < 0) {
            throw new Error('No user message found for this turn');
        }
        const userText = userMessagePlainText(this._messages[userIdx]);
        if (!userText) {
            throw new Error('User message is empty');
        }
        const entryId =
            typeof (this._messages[userIdx] as { _forkEntryId?: string })._forkEntryId === 'string'
                ? (this._messages[userIdx] as { _forkEntryId: string })._forkEntryId
                : undefined;

        await this.resendUserMessage(userIdx, userText, mode, entryId);
    }

    async cloneSession(): Promise<{ cancelled: boolean }> {
        const result = await this._bridge.clone();
        await this._refreshState();
        await this._refreshMessages();
        return result;
    }

    async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
        return this._bridge.getForkMessages();
    }

    async exportHtml(outputPath?: string): Promise<{ path: string }> {
        return this._bridge.exportHtml(outputPath);
    }

    async setSessionName(name: string): Promise<void> {
        await this._bridge.setSessionName(name);
        if (this._shim) {
            this._shim.sessionName = name;
        }
    }

    async applySteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
        await this._bridge.setSteeringMode(mode);
    }

    async applyFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
        await this._bridge.setFollowUpMode(mode);
    }

    getModels(): ModelInfo[] {
        return this._cachedModels;
    }

    /** Fires when the model or skill list changed; they load in the background after startup and on every sync. */
    onDidChangeCatalog(listener: () => void): () => void {
        this._catalogListeners.add(listener);
        return () => this._catalogListeners.delete(listener);
    }

    private _setCatalog(models: ModelInfo[], skills: SkillInfo[]): void {
        this._cachedModels = models;
        this._cachedSkills = skills;
        const snapshot = JSON.stringify([models, skills]);
        if (snapshot === this._catalogSnapshot) {
            return;
        }
        this._catalogSnapshot = snapshot;
        if (models.length > 0) {
            catalogByWorkspace.set(this._catalogKey, { models, skills });
        }
        for (const listener of this._catalogListeners) {
            listener();
        }
    }

    /** Never rejects: a list that fails to load is left empty. */
    private async _refreshModelsAndSkills(): Promise<void> {
        let models: ModelInfo[] = [];
        try {
            const available = await this._bridge.getAvailableModels();
            const loggedIn = vscode.workspace.getConfiguration('oh-my-pi-chater').get<boolean>('showAllModels', false)
                ? undefined
                : await this._loggedInProviders();
            const visible = loggedIn ? available.filter((m) => loggedIn.has(m.provider)) : available;
            // No stored login at all (env-var / models.json keys only): don't leave the picker empty.
            models = (visible.length > 0 ? visible : available).map((m) => ({
                provider: m.provider,
                id: m.id,
                name: m.id,
            }));
        } catch {
            /* left empty */
        }
        let skills: SkillInfo[] = [];
        try {
            skills = await this.getSkillsAsync();
        } catch {
            /* left empty */
        }
        this._setCatalog(models, skills);
    }

    /** Stored `/login` credentials; omp on runtimes without `node:sqlite` falls back to RPC auth status. */
    private async _loggedInProviders(): Promise<Set<string> | undefined> {
        const stored = await readLoggedInProviders(getAgentLayout(this.backend));
        if (stored || this.backend !== 'omp') {
            return stored;
        }
        try {
            const providers = await this._bridge.getLoginProviders();
            return new Set(providers.filter((p) => p.authenticated).map((p) => p.id));
        } catch {
            return undefined;
        }
    }

    async listSlashCommands(): Promise<SlashCommandListItem[]> {
        const items: SlashCommandListItem[] = RPC_BUILTIN_SLASH.map((c) => ({
            invocation: `/${c.name}`,
            name: c.name,
            description: c.description,
            source: 'builtin' as const,
        }));
        const builtinNames = new Set(RPC_BUILTIN_SLASH.map((c) => c.name));
        const commands = await this._bridge.getCommands();
        for (const cmd of commands) {
            // VS Code handles its own builtins (model picker, settings…); omp also lists them.
            if (builtinNames.has(cmd.name)) {
                continue;
            }
            items.push({
                invocation: `/${cmd.name}`,
                name: cmd.name,
                description: cmd.description,
                source: cmd.source,
            });
        }
        return items;
    }

    getCurrentModel(): ModelInfo | undefined {
        const m = this._shim?.model;
        if (!m) {
            return undefined;
        }
        return { provider: m.provider, id: m.id, name: m.name };
    }

    getThinkingLevel(): string | undefined {
        return this._shim?.thinkingLevel;
    }

    getSkills(): SkillInfo[] {
        return this._cachedSkills;
    }

    async getSkillsAsync(): Promise<SkillInfo[]> {
        const commands = await this._bridge.getCommands();
        return commands
            .filter((c) => c.source === 'skill')
            .map((c) => ({
                name: c.name.replace(/^skill:/, ''),
                description: c.description ?? '',
                filePath: c.path ?? '',
                source: c.source,
                disableModelInvocation: false,
            }));
    }

    getActiveToolNames(): string[] {
        return this._shim?.activeToolNames ?? [];
    }

    get messages(): any[] {
        return this._messages;
    }

    getMessages(): any[] {
        return this._messages;
    }

    getPlanModeInfo(): PlanModeInfo {
        const jsonlEntries = readSessionJsonlEntries(this._shim?.sessionFile);
        return readPlanModeInfoFromContext({
            messages: this._messages,
            jsonlEntries,
            activeToolNames: this._shim?.activeToolNames,
        });
    }

    async setAgentMode(mode: 'agent' | 'plan'): Promise<void> {
        if (this.backend !== 'pi') {
            throw new Error(PLAN_MODE_PI_ONLY);
        }
        const cmd = mode === 'plan' ? '/plan' : '/plan exit';
        await this._bridge.prompt(cmd);
        // Plan extension updates jsonl + chrome shortly after slash handling.
        await new Promise((resolve) => setTimeout(resolve, 400));
        await this.syncFromRpc();
    }

    async implementPlan(): Promise<void> {
        if (this.backend !== 'pi') {
            throw new Error(PLAN_MODE_PI_ONLY);
        }
        const plan = this.getPlanModeInfo().planMarkdown.trim();
        if (!plan) {
            throw new Error('No proposed plan to implement');
        }
        await this._bridge.prompt('/plan exit');
        await this._bridge.prompt(buildImplementPlanPrompt(plan));
    }

    setMessages(msgs: any[]): void {
        this._messages = msgs;
    }

    serializeState(): SerializedAgentState {
        const shim = this._shim;
        return {
            messages: this._messages.map(safeSerialize),
            model: shim?.model
                ? { provider: shim.model.provider, id: shim.model.id, name: shim.model.name }
                : undefined,
            thinkingLevel: shim?.thinkingLevel,
            isStreaming: shim?.isStreaming ?? false,
            tools: shim?.activeToolNames ?? [],
            sessionId: shim?.sessionId,
            sessionName: shim?.sessionName,
            contextUsage: shim?.contextUsage,
            sessionTokens: this._sessionStats,
            planMode: this.getPlanModeInfo(),
        };
    }

    async showModelPicker(searchTerm?: string): Promise<void> {
        await this._refreshModelsAndSkills();
        let models = this._cachedModels;
        if (searchTerm?.trim()) {
            const q = searchTerm.trim().toLowerCase();
            models = models.filter(
                (m) =>
                    m.id.toLowerCase().includes(q) ||
                    m.provider.toLowerCase().includes(q) ||
                    (m.name?.toLowerCase().includes(q) ?? false),
            );
        }
        if (models.length === 0) {
            vscode.window.showWarningMessage('No models from Pi RPC. Check ~/.pi/agent auth.');
            return;
        }
        type ModelPick = vscode.QuickPickItem & { model?: ModelInfo };
        const current = this.getCurrentModel();
        const keyOf = (m: ModelInfo): string => `${m.provider}/${m.id}`;
        // Item buttons only render on the hovered/active row, so the leading icon carries the
        // always-visible starred state; the trailing button is the toggle.
        const toItem = (m: ModelInfo, starred: boolean): ModelPick => ({
            label: m.name ?? m.id,
            iconPath: starred
                ? new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'))
                : new vscode.ThemeIcon('star-empty'),
            description:
                current?.provider === m.provider && current.id === m.id ? `${m.provider} · current` : m.provider,
            model: m,
            buttons: [
                {
                    iconPath: new vscode.ThemeIcon(starred ? 'close' : 'star-add'),
                    tooltip: starred ? 'Remove from favorites' : 'Add to favorites (shown in the chat input)',
                },
            ],
        });
        // Favorites first (starring order); the rest keep RPC order.
        const buildItems = (): ModelPick[] => {
            const favorites = readFavoriteModels();
            const byKey = new Map(models.map((m) => [keyOf(m), m]));
            const starred = favorites.map((k) => byKey.get(k)).filter((m): m is ModelInfo => !!m);
            const rest = models.filter((m) => !favorites.includes(keyOf(m)));
            const items: ModelPick[] = [];
            if (starred.length > 0) {
                items.push({ label: 'Favorites', kind: vscode.QuickPickItemKind.Separator });
                items.push(...starred.map((m) => toItem(m, true)));
                items.push({ label: 'All models', kind: vscode.QuickPickItemKind.Separator });
            }
            items.push(...rest.map((m) => toItem(m, false)));
            return items;
        };

        const quickPick = vscode.window.createQuickPick<ModelPick>();
        quickPick.placeholder = 'Select model · ★ = in chat input favorites · hover a row to star/unstar';
        quickPick.matchOnDescription = true;
        quickPick.items = buildItems();
        const currentItem = current && quickPick.items.find((i) => i.model && keyOf(i.model) === keyOf(current));
        if (currentItem) {
            quickPick.activeItems = [currentItem];
        }
        quickPick.onDidTriggerItemButton(async ({ item }) => {
            if (!item.model) {
                return;
            }
            const key = keyOf(item.model);
            await toggleFavoriteModel(key);
            quickPick.items = buildItems();
            const same = quickPick.items.find((i) => i.model && keyOf(i.model) === key);
            if (same) {
                quickPick.activeItems = [same];
            }
        });
        const pick = await new Promise<ModelInfo | undefined>((resolve) => {
            quickPick.onDidAccept(() => {
                resolve(quickPick.selectedItems[0]?.model);
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                resolve(undefined);
                quickPick.dispose();
            });
            quickPick.show();
        });
        if (pick) {
            await this.setModel(pick.provider, pick.id);
        }
    }

    async showForkPicker(): Promise<void> {
        const messages = await this.getForkMessages();
        if (messages.length === 0) {
            vscode.window.showInformationMessage('No messages available to fork from.');
            return;
        }
        const pick = await vscode.window.showQuickPick(
            messages.map((m) => ({
                label: m.text.slice(0, 120) || m.entryId,
                description: m.entryId,
                entryId: m.entryId,
            })),
            { title: 'Fork session from message', placeHolder: 'Select fork point' },
        );
        if (!pick) {
            return;
        }
        const result = await this.forkFromMessage(pick.entryId);
        if (result.cancelled) {
            vscode.window.showInformationMessage('Fork cancelled by extension.');
        } else {
            vscode.window.showInformationMessage('Forked to new session branch.');
        }
    }

    async dispose(): Promise<void> {
        this._unsubscribe?.();
        this._rpcUi.dispose();
        await this._bridge.stop();
        this._shim = undefined;
        this.events.clear();
    }

    static async disposeGlobal(): Promise<void> {
        /* no global state */
    }
}

function safeSerialize(obj: unknown): unknown {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { _serializationFailed: true };
    }
}

export async function createPiChatSession(
    outputChannel: vscode.OutputChannel,
    preferredBackend?: AgentBackend,
    targetCwd?: string,
): Promise<PiRpcSessionManager> {
    const rpc = new PiRpcSessionManager(outputChannel);
    await rpc.initialize(preferredBackend, targetCwd);
    return rpc;
}
