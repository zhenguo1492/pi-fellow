import type {
    AgentBackend,
    FileChangeInfo,
    TabInfo,
    SkillInfo,
    SlashCommandListItem,
    PlanModeInfo,
    PiExtensionChromeSnapshot,
    ContextUsageInfo,
    SessionTokenStats,
    PendingAttachmentPreview,
    ConnectionStatus,
    TuiAuthCommand,
    PermissionLevel,
    ToolCallPendingInfo,
} from '../../shared/protocol';

// ── State ──

export interface ChatState {
    messages: any[];
    isStreaming: boolean;
    model?: { provider: string; id: string; name?: string };
    thinkingLevel?: string;
    tools: string[];
    sessionId?: string;
    sessionName?: string;
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    contextUsage?: ContextUsageInfo;
    sessionTokens?: SessionTokenStats;
    fileChanges: FileChangeInfo[];
    rollbackPoint: number | null;
    availableModels: any[];
    recentModels: { provider: string; id: string; name?: string }[];
    tabs: TabInfo[];
    activeTabId: string;
    skills: SkillInfo[];
    slashCommands: SlashCommandListItem[];
    queuedMessages: string[];
    steeringMessages: string[];
    followUpMessages: string[];
    pendingAttachments: PendingAttachmentPreview[];
    planMode: PlanModeInfo;
    piExtensionChrome?: PiExtensionChromeSnapshot;
    connectionStatus: ConnectionStatus;
    /** The tab is loading a restored conversation: the transcript shows a loading state instead of the welcome. */
    restoringHistory: boolean;
    activeBackend: AgentBackend;
    /** The active tab shows its CLI's TUI (per tab: `TabInfo.tuiMode`). */
    tuiMode: boolean;
    tuiAuthPrompt?: TuiAuthCommand;
    /** The composer's permission menu. */
    permissionLevel: PermissionLevel;
    /** Voice-agent changes waiting for Approve/Reject (cards above the input). */
    pendingToolApprovals: ToolCallPendingInfo[];
}

export function emptyPlanMode(): PlanModeInfo {
    return {
        enabled: false,
        hasPlan: false,
        awaitingAction: false,
        statusLabel: 'off',
        planMarkdown: '',
        todos: [],
    };
}

export const state: ChatState = {
    messages: [],
    isStreaming: false,
    tools: [],
    streamingText: '',
    streamingThinking: '',
    isThinking: false,
    thinkingStartTime: 0,
    streamingThinkingDuration: 0,
    availableModels: [],
    recentModels: [],
    fileChanges: [],
    rollbackPoint: null,
    tabs: [],
    activeTabId: '',
    skills: [],
    slashCommands: [],
    queuedMessages: [],
    steeringMessages: [],
    followUpMessages: [],
    pendingAttachments: [],
    planMode: emptyPlanMode(),
    connectionStatus: { phase: 'idle' },
    restoringHistory: false,
    activeBackend: 'pi',
    tuiMode: false,
    permissionLevel: 'ask',
    pendingToolApprovals: [],
};
