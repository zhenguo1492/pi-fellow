import type { EditorContextInfo } from './editorContext';

export interface ContextUsageInfo {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
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

export interface PiExtensionLoadIssue {
    path: string;
    message: string;
    category: 'native' | 'tui' | 'sdk' | 'other';
    hint: string;
}

import type { ExtensionUiRequestPayload } from './extensionUi';

export type McpScopeId = 'global' | 'project' | 'projectPi';

export type McpConnectionStatus =
    | 'disabled'
    | 'unknown'
    | 'idle'
    | 'cached'
    | 'connected'
    | 'failed'
    | 'testing';

export interface McpToolSummary {
    name: string;
    description?: string;
}

export interface McpServerSummary {
    name: string;
    scope: McpScopeId | 'import';
    importSource?: string;
    enabled: boolean;
    canToggle: boolean;
    ownerPath: string;
    transport: 'stdio' | 'http' | 'unknown';
    commandPreview?: string;
    url?: string;
    directTools?: boolean | string[];
    tools: McpToolSummary[];
    toolCount: number;
    cacheStatus: 'fresh' | 'stale' | 'none';
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
    availableBackends?: AgentBackend[];
    extensionVersion: string;
    syncWithPiCli: boolean;
    piAgentDir: string;
    piConfigLoadError?: string;
    piDefaultProvider?: string;
    piDefaultModel?: string;
    piDefaultThinkingLevel?: string;
    piPackageCount: number;
    piConfig?: PiAgentConfigData;
    mcpSnapshot?: McpSettingsSnapshot;
    apiProvider: string;
    apiBaseUrl: string;
    apiKeySet: boolean;
    authMethod: 'env' | 'pi-login' | 'manual' | 'none';
    defaultModel: string;
    thinkingLevel: string;
    autoApproveTools: boolean;
    allowedTools: string[];
    autoSaveSessions: boolean;
    sessionStoragePath: string;
    contextUsageWarningThreshold: number;
    /** npm: sources for recommended Pi packages not yet in settings.json */
    recommendedPackagesMissing?: string[];
    /** Live session: Pi packages/extensions that failed to load in this editor */
    extensionLoadIssues?: PiExtensionLoadIssue[];
    loadedExtensionCount?: number;
    voice: VoiceSettings;
}

export interface VoiceSettings {
    sttUrl: string;
    sttModel: string;
    language: string;
    vadConfidence: number;
    vadStopSecs: number;
    sttValid?: boolean;
}

/** Voice dictation state shown on the composer's mic button. */
export interface DictationStatus {
    recording: boolean;
    /** VAD currently hears speech. */
    speaking: boolean;
    /** Speech segments sent to STT whose text has not arrived yet. */
    pending: number;
}

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

export interface TabInfo {
    id: string;
    name: string;
    isActive: boolean;
    isStreaming: boolean;
    hasNotification: boolean;
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
    phase: 'idle' | 'retrying' | 'failed';
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
    /** Active backend ('omp' or 'pi') of the current tab or workspace preference. */
    activeBackend?: AgentBackend;
    /** Backends detected on this machine. */
    availableBackends?: AgentBackend[];
    /** Every tab shows the agent CLI's TUI in an embedded terminal instead of the chat UI. */
    tuiMode?: boolean;
    /** omp /login or /logout was requested: chat shows a banner that finishes it in the TUI. */
    tuiAuthPrompt?: TuiAuthCommand;
    /** Whether voice input (STT) is configured and valid (HTTP 200). Mic button shows only when true. */
    sttValid?: boolean;
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
    source: 'builtin' | 'extension' | 'skill';
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
    | { type: 'setBackend'; backend: AgentBackend }
    | { type: 'closeTab'; tabId: string }
    | { type: 'switchTab'; tabId: string }
    | { type: 'openSettings' }
    | { type: 'getSkills' }
    | { type: 'getSlashCommands' }
    | { type: 'queueMessage'; text: string }
    | { type: 'interruptAndSend'; text: string }
    | { type: 'editQueuedMessage'; index: number; text: string }
    | { type: 'removeQueuedMessage'; index: number }
    | { type: 'cancelQueue' }
    | { type: 'setAgentMode'; mode: 'agent' | 'plan' }
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
    | { type: 'setApiKey'; provider: string; key: string }
    | { type: 'clearApiKey'; provider: string }
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
    | { type: 'rebuildNativeModules' }
    | { type: 'testStt'; url?: string };

// Extension -> Webview messages
export type ServerMessage =
    | { type: 'ready' }
    | { type: 'stateSync'; state: SerializedAgentState }
    | { type: 'agentEvent'; event: any }
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
    /** Microphone level 0..1 while recording. */
    | { type: 'dictationLevel'; level: number }
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
    | { type: 'editorContext'; context: EditorContextInfo | null; enabled: boolean };

// Extension -> Settings webview messages
export type SettingsServerMessage =
    | { type: 'settings'; data: SettingsData }
    | { type: 'settingChanged'; key: string; value: any }
    | { type: 'skills'; skills: SkillInfo[] }
    | { type: 'piConfigUpdated' }
    | { type: 'success'; message: string }
    | { type: 'error'; message: string }
    | { type: 'mcpSnapshot'; snapshot: McpSettingsSnapshot }
    | { type: 'scrollToSection'; section: string }
    | { type: 'sttTestResult'; ok: boolean; status?: number; message: string };
