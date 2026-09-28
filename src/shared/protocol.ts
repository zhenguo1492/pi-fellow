import type { EditorContextInfo } from './editorContext';
import type { VoiceAgentAction, VoiceStatus, VoiceViewClientMessage, VoiceViewHostMessage } from './voiceViewProtocol';
import type { VoiceAvatar, VoiceSpeakerId } from './voiceSpeakers';
import type { TtsConfig } from '../voiceAgent/tts';
import type { StatusBarLimit, UsageAccountDetail } from '../pi/providerUsage';

export interface ContextUsageInfo {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}

/** One slice of the context window, as omp's `/context` reports it. */
export interface ContextBreakdownCategory {
    id: 'systemPrompt' | 'systemTools' | 'systemContext' | 'skills' | 'messages' | 'other';
    label: string;
    tokens: number;
}

/** omp's `/context` report: what fills the context window, like the TUI's Context Usage grid. */
export interface ContextBreakdownInfo {
    contextWindow: number;
    usedTokens: number;
    /** Non-empty categories, in report order. */
    categories: ContextBreakdownCategory[];
    /** Reserved for auto-compaction: compaction runs before usage reaches it. */
    autoCompactBufferTokens: number;
    freeTokens: number;
    /** Report lines past the categories (snapcompact savings), verbatim. */
    notes: string[];
}

export type AgentBackend = 'pi' | 'omp';

/** Cumulative session tokens from Pi getSessionStats() (all assistant turns). */
export interface SessionTokenStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}

/** The line over the active tab's conversation: model, context use and the provider's plan limits. */
export interface ModelStatusInfo {
    /** Display name; absent when no model is selected. */
    model?: string;
    activity: 'idle' | 'streaming' | 'retrying';
    /** Reconnect attempt while retrying, else 0. */
    retryAttempt: number;
    context?: ContextUsageInfo;
    /** Context use (percent) from which the ctx figure warns: setting `contextUsageWarningThreshold`. */
    contextWarnPercent: number;
    tokens?: SessionTokenStats;
    thinking?: string;
    /** Limits that gate the model, shortest window first: the summary line. */
    limits: StatusBarLimit[];
    /** Every window per account: the details. */
    usage: UsageAccountDetail[];
    usageError?: string;
    /** The Context row expands into a per-category breakdown (`getContextBreakdown`): omp only. */
    contextBreakdown: boolean;
}

export interface PiAuthProviderInfo {
    id: string;
    configured: boolean;
}

export interface PiCommandInfo {
    name: string;
    invocationName: string;
    description?: string;
    source?: string;
}

import type { ExtensionUiRequestPayload } from './extensionUi';

/**
 * An mcp.json the backend reads. Both: `global` (agent dir mcp.json), `project` (workspace .mcp.json),
 * `projectAgent` (.pi/mcp.json or .omp/mcp.json). pi only: the shared user files `sharedGlobal`
 * (~/.config/mcp/mcp.json), `agentsGlobal` (~/.agents/mcp.json), `agentsNestedGlobal` (~/.agents/mcp/mcp.json).
 * omp only: `globalCompat` (agent dir .mcp.json), `projectAgentCompat` (.omp/.mcp.json), `projectRoot` (mcp.json).
 */
export type McpScopeId =
    | 'global'
    | 'globalCompat'
    | 'sharedGlobal'
    | 'agentsGlobal'
    | 'agentsNestedGlobal'
    | 'project'
    | 'projectRoot'
    | 'projectAgent'
    | 'projectAgentCompat';

/** `reachable`: the last Check found the command or URL; the MCP handshake itself is not tested. */
export type McpConnectionStatus = 'disabled' | 'idle' | 'cached' | 'reachable' | 'failed';

export interface McpToolSummary {
    name: string;
    description?: string;
}

export interface McpServerSummary {
    name: string;
    /** Config file owning the entry (a toggle writes there), or `import` for pi `imports`. */
    scope: McpScopeId | 'import';
    /** e.g. `Project (.omp/mcp.json)` or `cursor import`. */
    sourceLabel: string;
    enabled: boolean;
    canToggle: boolean;
    ownerPath: string;
    transport: 'stdio' | 'http' | 'unknown';
    commandPreview?: string;
    url?: string;
    /** Setup advice for this server on the current backend. */
    hints: string[];
    tools: McpToolSummary[];
    toolCount: number;
    /** `unavailable`: the backend keeps no tool cache this extension can read (omp). */
    cacheStatus: 'fresh' | 'stale' | 'none' | 'unavailable';
    status: McpConnectionStatus;
    statusMessage?: string;
}

export interface McpConfigPathInfo {
    id: McpScopeId;
    label: string;
    path: string;
    exists: boolean;
}

export interface McpSettingsSnapshot {
    hasMcpAdapter: boolean;
    disableProxyTool: boolean;
    globalDirectTools?: boolean;
    toolPrefix?: string;
    configPaths: McpConfigPathInfo[];
    importSources: string[];
    servers: McpServerSummary[];
}

export interface PiAgentConfigData {
    packages: string[];
    extensionPaths: string[];
    skillPaths: string[];
    enableSkillCommands: boolean;
    steeringMode: 'all' | 'one-at-a-time';
    followUpMode: 'all' | 'one-at-a-time';
    authProviders: PiAuthProviderInfo[];
    mcpFileExists: boolean;
    commands: PiCommandInfo[];
    availableModels: ModelInfo[];
}

export interface SettingsData {
    backend: AgentBackend;
    /** Installed CLIs; the settings backend picker offers only these. */
    availableBackends: AgentBackend[];
    extensionVersion: string;
    syncWithPiCli: boolean;
    piAgentDir: string;
    piConfigLoadError?: string;
    piDefaultProvider?: string;
    piDefaultModel?: string;
    piDefaultThinkingLevel?: string;
    piConfig?: PiAgentConfigData;
    mcpSnapshot?: McpSettingsSnapshot;
    /** Where the backend's credentials were found: its login store, a provider env var, or none. */
    authMethod: 'login' | 'env' | 'none';
    defaultPermissionLevel: PermissionLevel;
    allowedTools: string[];
    contextUsageWarningThreshold: number;
    /** npm: sources for recommended Pi packages not yet in settings.json */
    recommendedPackagesMissing?: string[];
    voice: VoiceSettings;
    tts: TtsConfig;
    voiceReadiness: VoiceReadiness;
    /** Which cloud providers (voicePresets.ts `CLOUD_PROVIDERS`) have an API key stored; the keys never reach the webview. */
    voiceApiKeys: Record<string, boolean>;
    /** Your own servers' settings as last configured, kept when a Cloud or Built-in save overwrites them. */
    voiceOwnServers: OwnVoiceServers;
    /** `voiceAgent.skills`: names of the skills the voice agent loads. */
    voiceSkills: string[];
    /** `voiceAgent.messageButtons`: Alt over a sentence (Bot view and chat) reads it aloud and translates it. */
    voiceMessageButtons: boolean;
    /** `voiceAgent.translateTo`: the language those translations are in. */
    voiceTranslateTo: string;
    /**
     * `voiceAgent.userName` / `userAvatar` and `botName` / `botAvatar` as set, with the avatar as the
     * Bot view shows it (`resolved`; a picture read into a data URI) or why it shows the default (`error`).
     */
    voiceSpeakers: Record<VoiceSpeakerId, { name: string; avatar: string; resolved?: VoiceAvatar; error?: string }>;
}

/** Your own servers' fields (settings field key → value) by part, remembered in globalState. */
export type OwnVoiceServers = Partial<Record<keyof VoiceReadiness, Record<string, string>>>;

/** `builtin`: Moonshine in the built-in voice engine (src/voice/builtinEngine); `custom`: the server at `sttUrl`. */
export type SttEngine = 'builtin' | 'custom';

export interface VoiceSettings {
    sttEngine: SttEngine;
    sttUrl: string;
    sttModel: string;
    language: string;
    vadConfidence: number;
    vadStopSecs: number;
}

/** A voice service's last check against the current settings; `reason` (when not ok) is shown on the disabled button. */
export interface VoiceServiceCheck {
    ok: boolean;
    reason?: string;
    /** The check of the current settings has not answered yet. */
    checking?: boolean;
}

export interface VoiceReadiness {
    stt: VoiceServiceCheck;
    tts: VoiceServiceCheck;
}

/** The built-in engine's models (Settings → Voice, Built-in). */
export interface BuiltinVoiceStatus {
    downloaded: boolean;
    /** On disk when downloaded, else what the download fetches; undefined when unknown (offline). */
    bytes?: number;
    /** The engine process is up (or starting). */
    running: boolean;
}

/** One service's check after "Save & test": `message` is plain language (see explainVoiceError). */
export interface VoiceCheckResult {
    ok: boolean;
    message: string;
}

/** Voice dictation state shown on the composer's mic button. */
export interface DictationStatus {
    recording: boolean;
    /** VAD currently hears speech. */
    speaking: boolean;
    /** Speech segments sent to STT whose text has not arrived yet. */
    pending: number;
}

/** One STT dry run in the settings, as it happens. */
export type SttDryRunEvent =
    | { kind: 'status'; status: DictationStatus }
    /** Microphone level 0..1. */
    | { kind: 'level'; level: number }
    | { kind: 'text'; text: string }
    | { kind: 'error'; message: string }
    /** Microphone off and every transcript delivered. */
    | { kind: 'ended' };

export interface ToolCallPendingInfo {
    toolCallId: string;
    toolName: string;
    args: any;
}

export interface FileChangeInfo {
    filePath: string;
    toolCallId: string;
    toolName: string;
    isNew: boolean;
    diff?: string;
    addedLines: number;
    removedLines: number;
    turnIndex: number;
}

/**
 * What the tab's agents may do without asking (the composer's permission menu, labelled like Claude's
 * modes): ask (Manual) needs approval for file changes and commands; edit (Edit automatically)
 * changes files unasked but asks before commands and deletions; plan is read-only; auto runs everything.
 */
export type PermissionLevel = 'ask' | 'edit' | 'plan' | 'auto';

export interface TabInfo {
    id: string;
    name: string;
    isActive: boolean;
    isStreaming: boolean;
    hasNotification: boolean;
    /** The tab shows the Bot view (the voice agent's conversation) instead of its chat. */
    botView: boolean;
    /** The tab shows the agent CLI's TUI in an embedded terminal instead of its chat. */
    tuiMode: boolean;
}

export interface PlanTodoItem {
    id: string;
    text: string;
    done: boolean;
}

export interface PlanModeInfo {
    enabled: boolean;
    hasPlan: boolean;
    awaitingAction: boolean;
    statusLabel: 'off' | 'planning' | 'ready';
    planMarkdown: string;
    todos: PlanTodoItem[];
}

export interface PiExtensionChromeSnapshot {
    statuses: Array<{ key: string; text?: string }>;
    widgets: Array<{ key: string; lines?: string[]; placement?: 'aboveEditor' | 'belowEditor' }>;
    title?: string;
}

/** Shown in chat when the model API is unreachable or auto-retry is in progress. */
export interface ConnectionStatus {
    /** `connecting`: the tab's worker is starting or a restored conversation is loading; `message` says which. */
    phase: 'idle' | 'connecting' | 'retrying' | 'failed';
    message?: string;
    attempt?: number;
    maxAttempts?: number;
}

export interface SerializedAgentState {
    messages: any[];
    model?: { provider: string; id: string; name?: string };
    thinkingLevel?: string;
    isStreaming: boolean;
    streamingMessage?: any;
    errorMessage?: string;
    tools: string[];
    sessionId?: string;
    sessionName?: string;
    contextUsage?: ContextUsageInfo;
    sessionTokens?: SessionTokenStats;
    fileChanges?: FileChangeInfo[];
    rollbackPoint?: number | null;
    tabs?: TabInfo[];
    activeTabId?: string;
    streamingText?: string;
    streamingThinking?: string;
    isThinking?: boolean;
    thinkingStartTime?: number;
    streamingThinkingDuration?: number;
    queuedMessages?: string[];
    /** Pending Pi RPC steering messages (delivered mid-run). */
    steeringMessages?: string[];
    /** Pending Pi RPC follow-up messages (delivered after run). */
    followUpMessages?: string[];
    pendingAttachments?: PendingAttachmentPreview[];
    planMode?: PlanModeInfo;
    piExtensionChrome?: PiExtensionChromeSnapshot;
    connectionStatus?: ConnectionStatus;
    /** The tab is loading a conversation restored at window startup: the transcript shows a loading state, not the welcome. */
    restoringHistory?: boolean;
    /** The tab's permission level; for pi, `plan` is pi's own plan mode. */
    permissionLevel?: PermissionLevel;
    /** Voice-agent tool calls of this tab waiting for Approve/Reject. */
    pendingToolApprovals?: ToolCallPendingInfo[];
    /** Active backend ('omp' or 'pi') of the current tab or workspace preference. */
    activeBackend?: AgentBackend;
    /** /login or /logout was requested: chat shows a banner that finishes it in the TUI. */
    tuiAuthPrompt?: TuiAuthCommand;
    /** Whether the speech services answered their checks: gates the composer mic (STT) and the voice agent (both). */
    voiceReadiness?: VoiceReadiness;
    /** The voice agent's state for the robot status line and the composer mic; absent until it is known. */
    voice?: VoiceStatus;
}

export type TuiAuthCommand = 'login' | 'logout';

export interface PendingAttachmentPreview {
    id: string;
    displayName: string;
    isImage: boolean;
    previewDataUrl?: string;
    absolutePath?: string;
}

export interface ModelInfo {
    provider: string;
    id: string;
    name?: string;
}

export interface SkillInfo {
    name: string;
    description: string;
    filePath: string;
    source: string;
    disableModelInvocation: boolean;
}

export interface SlashCommandListItem {
    invocation: string;
    name: string;
    description?: string;
    source: 'builtin' | 'extension' | 'prompt' | 'skill';
}

export interface SessionInfo {
    id: string;
    name?: string;
    path: string;
    lastModified?: number;
    created?: number;
    cwd?: string;
    /** All `message` entries (user, assistant, tool results). */
    messageCount?: number;
    /** User prompts — one per conversation turn. */
    turnCount?: number;
    /** Session file size on disk. */
    sizeBytes?: number;
    /** User turns spoken (or typed) to the voice agent about this session; its only content when no task went to the worker. */
    voiceTurns?: number;
    firstMessage?: string;
}

export interface SessionListRowPayload {
    sessionPath: string;
    label: string;
    meta: string;
    isCurrent: boolean;
}

export interface SessionListPayload {
    workspaceCwd: string;
    items: SessionListRowPayload[];
    backend?: AgentBackend;
    loading?: boolean;
    progress?: { loaded: number; total: number };
    error?: string;
}

export interface WorkspaceFileMatch {
    relativePath: string;
    absolutePath: string;
    basename: string;
}

export interface SessionTreeNodeData {
    id: string;
    parentId: string | null;
    timestamp: number;
    type: string;
    role?: string;
    textPreview?: string;
    displayText?: string;
    fullText?: string;
    label?: string;
    labelTimestamp?: string;
    isActivePath?: boolean;
    isCurrentLeaf?: boolean;
    childrenCount: number;
    depth: number;
    indent?: number;
    treePrefix?: string;
    customType?: string;
}

export interface SessionTreePayload {
    nodes: SessionTreeNodeData[];
    leafId: string | null;
    error?: string;
}

// Webview -> Extension messages
export type ClientMessage =
    | { type: 'prompt'; text: string; attachments?: any[] }
    | { type: 'slashCommand'; text: string }
    | { type: 'steer'; text: string }
    /** From the Bot view a chat tab shows in place of its conversation. */
    | { type: 'voice'; message: VoiceViewClientMessage }
    /** From the chat's robot status line, composer mic and composer, for the voice agent. */
    | { type: 'voiceAgent'; action: VoiceAgentAction }
    /** The model status line's switch button: the model QuickPick (favorites are starred there). */
    | { type: 'selectModel' }
    /** The model status line's expanded Context row: answered with `contextBreakdown`. */
    | { type: 'getContextBreakdown' }
    | { type: 'pickAttachments' }
    | { type: 'addPastedImages'; items: { mimeType: string; dataBase64: string; name?: string }[] }
    | { type: 'addDroppedTextFiles'; files: { name: string; text: string }[] }
    | { type: 'dropFilePaths'; paths: string[] }
    | { type: 'dropAttachFailed'; mimeTypes: string[] }
    | { type: 'searchWorkspaceFiles'; requestId: string; query: string }
    | { type: 'removeAttachment'; id: string }
    | { type: 'followUp'; text: string }
    | { type: 'abort' }
    | { type: 'getModels' }
    | { type: 'setModel'; provider: string; modelId: string }
    | { type: 'setThinkingLevel'; level: string }
    | { type: 'newSession' }
    | { type: 'openResumePicker' }
    | { type: 'toggleSessionPanel' }
    | { type: 'closeSessionPanel' }
    | { type: 'loadSessionList'; query?: string }
    | { type: 'resumeSession'; sessionPath: string }
    | { type: 'deleteSession'; sessionPath: string }
    | { type: 'renameSession'; sessionPath: string; name: string }
    | { type: 'getState' }
    | { type: 'approveToolCall'; toolCallId: string }
    | { type: 'rejectToolCall'; toolCallId: string }
    | { type: 'openFile'; filePath: string; startLine?: number; endLine?: number }
    | { type: 'setEditorContextEnabled'; enabled: boolean }
    | { type: 'toggleDictation' }
    | { type: 'readImageFile'; filePath: string; requestId: string }
    | { type: 'openDiff'; filePath: string; toolCallId: string }
    | { type: 'acceptFileChanges' }
    | { type: 'undoFileChange'; filePath: string; toolCallId: string }
    | { type: 'restoreCheckpoint'; messageIndex: number }
    | { type: 'redoCheckpoint' }
    | { type: 'confirmAction'; action: string; message: string; payload?: any }
    | { type: 'createTab'; backend?: AgentBackend }
    | { type: 'closeTab'; tabId: string }
    | { type: 'switchTab'; tabId: string }
    /** The tab icon or the robot status line's log button; no `tabId`: the active tab. Switches to the tab. */
    | { type: 'toggleBotView'; tabId?: string }
    /** `section`: scroll the settings to it (`voice`, `mcp`, …). */
    | { type: 'openSettings'; section?: string }
    | { type: 'getSkills' }
    | { type: 'getSlashCommands' }
    | { type: 'queueMessage'; text: string }
    | { type: 'interruptAndSend'; text: string }
    | { type: 'editQueuedMessage'; index: number; text: string }
    | { type: 'removeQueuedMessage'; index: number }
    /** Pull a queued message out of the queue and deliver it to the running turn as a steer. */
    | { type: 'steerQueuedMessage'; index: number }
    | { type: 'cancelQueue' }
    | { type: 'setPermissionLevel'; level: PermissionLevel }
    | { type: 'implementPlan' }
    | { type: 'openPlanDocument' }
    | {
          type: 'resendUserMessage';
          messageIndex: number;
          text: string;
          mode: 'new' | 'fork';
          entryId?: string;
      }
    | { type: 'regenerateAssistant'; assistantMessageIndex: number; mode: 'new' | 'fork' }
    | { type: 'openSessionTree' }
    | { type: 'toggleTuiMode' }
    /** Banner clicked: switch to the TUI and run the pending /login or /logout there. */
    | { type: 'runTuiAuth' }
    | { type: 'dismissTuiAuth' }
    /** Webview mounted/fit a terminal for the tab (also restarts an exited TUI). */
    | { type: 'tuiStart'; tabId: string; cols: number; rows: number }
    | { type: 'tuiInput'; tabId: string; data: string }
    | { type: 'tuiResize'; tabId: string; cols: number; rows: number }
    | { type: 'closeSessionTree' }
    | { type: 'forkSessionTree'; entryId: string; summarize?: boolean; customInstructions?: string }
    | {
          type: 'extensionUiResponse';
          id: string;
          cancelled?: boolean;
          value?: string;
          confirmed?: boolean;
      };

// Settings webview -> Extension messages
export type SettingsClientMessage =
    | { type: 'setBackend'; backend: AgentBackend }
    | { type: 'getSettings' }
    | { type: 'updateSetting'; key: string; value: any }
    | { type: 'getSkills' }
    | { type: 'updatePiDefaults'; provider?: string; model?: string; thinkingLevel?: string }
    | { type: 'addPiPackage'; source: string }
    | { type: 'removePiPackage'; index: number }
    | { type: 'addPiExtensionPath'; path: string }
    | { type: 'removePiExtensionPath'; index: number }
    | { type: 'addPiSkillPath'; path: string }
    | { type: 'removePiSkillPath'; index: number }
    | { type: 'setPiEnableSkillCommands'; enabled: boolean }
    | { type: 'setPiSteeringMode'; mode: 'all' | 'one-at-a-time' }
    | { type: 'setPiFollowUpMode'; mode: 'all' | 'one-at-a-time' }
    | { type: 'openPiAgentFile'; file: 'settings' | 'auth' | 'mcp' }
    | { type: 'reloadPiSession' }
    | { type: 'browsePiCatalog' }
    | { type: 'openExternalUrl'; url: string }
    | { type: 'getMcpSnapshot' }
    | { type: 'setMcpServerEnabled'; scope: McpScopeId; serverName: string; enabled: boolean }
    | { type: 'testMcpServer'; serverName: string }
    | { type: 'testAllMcpServers' }
    | { type: 'runPiLogin' }
    | { type: 'runPiLogout' }
    /**
     * Checks your own server's section as given, without saving anything; an empty or unknown model
     * is detected from the server (`voiceTestResult.detectedModel`).
     */
    | { type: 'testStt'; settings: VoiceSettings }
    | { type: 'testTts'; settings: TtsConfig }
    /**
     * Saves both voice sections and the typed API keys (stored in SecretStorage, never sent back);
     * with `test`, then checks every custom service and answers `voiceSaved` with the results.
     */
    | { type: 'saveVoice'; stt: VoiceSettings; tts: TtsConfig; apiKeys: Record<string, string>; test: boolean }
    /** Removes a cloud provider's stored API key. */
    | { type: 'removeVoiceApiKey'; provider: string }
    /** "Choose picture…": picks an image file and saves it as the speaker's avatar. */
    | { type: 'pickAvatar'; speaker: VoiceSpeakerId }
    /** Dry runs use the form's values (and typed key), saved or not. `run` tags the events of one recording. */
    | { type: 'startSttDryRun'; run: number; settings: VoiceSettings; apiKey?: string }
    | { type: 'stopSttDryRun' }
    | { type: 'ttsDryRun'; settings: TtsConfig; text: string; apiKey?: string }
    /** Opens the cloud provider's API key page (voicePresets.ts `CLOUD_PROVIDERS`) in the browser. */
    | { type: 'openVoiceKeyPage'; provider: string }
    /** Asks for `builtinVoiceStatus`; `prepareBuiltinVoice` downloads the models and starts the engine first. */
    | { type: 'getBuiltinVoiceStatus' }
    | { type: 'prepareBuiltinVoice' }
    /** The Voice tab has unsaved changes (or not): closing the panel then warns. */
    | { type: 'voiceDirty'; dirty: boolean };

// Extension -> Webview messages
export type ServerMessage =
    | { type: 'ready' }
    | { type: 'stateSync'; state: SerializedAgentState }
    | { type: 'agentEvent'; event: any }
    | { type: 'modelStatus'; status: ModelStatusInfo }
    | { type: 'contextBreakdown'; breakdown?: ContextBreakdownInfo; error?: string }
    | {
          type: 'models';
          models: ModelInfo[];
          current?: ModelInfo;
          thinkingLevel?: string;
          /** Starred `provider/id` keys, in the order they were starred. */
          favorites: string[];
      }
    | { type: 'modelChanged'; model: ModelInfo; thinkingLevel?: string }
    | { type: 'sessionChanged'; sessionId: string }
    | { type: 'fileChange'; change: FileChangeInfo }
    | { type: 'confirmResult'; action: string; confirmed: boolean; payload?: any }
    | { type: 'toolCallPending'; pending: ToolCallPendingInfo }
    | { type: 'toolCallResolved'; toolCallId: string }
    | { type: 'skills'; skills: SkillInfo[] }
    | { type: 'slashCommands'; commands: SlashCommandListItem[] }
    | { type: 'error'; message: string }
    | { type: 'extensionUiRequest'; request: ExtensionUiRequestPayload }
    | { type: 'extensionUiDismiss'; id: string }
    | { type: 'piExtensionChrome'; chrome: PiExtensionChromeSnapshot }
    | { type: 'setComposerText'; text: string }
    | { type: 'dictationStatus'; status: DictationStatus }
    /** Transcribed utterance to insert at the composer caret. */
    | { type: 'dictationText'; text: string }
    /** Microphone level 0..1 while recording, with its waveform (as in `voiceLevel`). */
    | { type: 'dictationLevel'; level: number; wave?: number[] }
    | { type: 'toast'; message: string; variant?: 'info' | 'error' }
    | {
          type: 'workspaceFiles';
          requestId: string;
          files: WorkspaceFileMatch[];
      }
    | { type: 'sessionPanel'; open: boolean }
    | { type: 'sessionTree'; open: boolean; data?: SessionTreePayload }
    | {
          type: 'imageFileData';
          requestId: string;
          filePath: string;
          dataUrl?: string;
          error?: string;
      }
    | { type: 'sessionList'; data: SessionListPayload }
    | { type: 'tuiData'; tabId: string; data: string }
    /** Full screen + scrollback of a running TUI; replaces whatever the tab's terminal shows. */
    | { type: 'tuiSnapshot'; tabId: string; data: string }
    | { type: 'tuiExit'; tabId: string; exitCode: number }
    /** Active editor file/selection the next prompt carries; `enabled` is the user's include toggle. */
    | { type: 'editorContext'; context: EditorContextInfo | null; enabled: boolean }
    /** For the Bot view a chat tab shows in place of its conversation. */
    | { type: 'voice'; message: VoiceViewHostMessage }
    /** The voice agent's state changed: robot status line and composer mic. */
    | { type: 'voiceStatus'; status: VoiceStatus }
    /**
     * Voice mode, ~16 per second: the microphone's level (0..1) while it listens, the bot's while a
     * reply plays, with the real waveform of that moment: `WAVE_POINTS` samples -1..1 of the
     * latest 64 ms, oldest first (src/voice/micLevel.ts `wavePoints`). Absent means silence.
     */
    | { type: 'voiceLevel'; level: number; source: VoiceLevelSource; wave?: number[] };

/** Whose sound a voice level measures: the user's microphone or the bot's reply. */
export type VoiceLevelSource = 'user' | 'bot';

// Extension -> Settings webview messages
export type SettingsServerMessage =
    | { type: 'settings'; data: SettingsData }
    | { type: 'skills'; skills: SkillInfo[] }
    | { type: 'piConfigUpdated' }
    | { type: 'success'; message: string }
    | { type: 'error'; message: string }
    | { type: 'mcpSnapshot'; snapshot: McpSettingsSnapshot }
    | { type: 'scrollToSection'; section: string }
    /**
     * `models`: what the server lists at /models for this task (the TTS Model field offers them);
     * `detectedModel`: the model the Test took, as the one shown was empty or unknown to the server.
     */
    | { type: 'voiceTestResult'; service: 'stt' | 'tts'; ok: boolean; message: string; check: VoiceServiceCheck; models?: string[]; detectedModel?: string }
    | { type: 'sttDryRun'; run: number; event: SttDryRunEvent }
    | { type: 'ttsDryRunResult'; ok: true; audio: string; seconds: number; elapsedMs: number }
    | { type: 'ttsDryRunResult'; ok: false; message: string }
    /**
     * Answer to `saveVoice`. `saved`: the settings and keys were written; `ok`: saved and every check
     * passed; `tests`: each checked service's result (built-in ones are not checked).
     */
    | { type: 'voiceSaved'; saved: boolean; ok: boolean; message: string; tests: Partial<Record<keyof VoiceReadiness, VoiceCheckResult>> }
    /** `busy`: downloading or starting; `error`: the last attempt failed (plain language). */
    | { type: 'builtinVoiceStatus'; status?: BuiltinVoiceStatus; busy: boolean; error?: string };
