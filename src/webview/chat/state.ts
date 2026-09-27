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
    activeBackend: AgentBackend;
    tuiMode: boolean;
    tuiAuthPrompt?: TuiAuthCommand;
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
    activeBackend: 'pi',
    tuiMode: false,
};
