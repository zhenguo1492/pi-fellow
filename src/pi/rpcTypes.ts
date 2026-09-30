/** Pi CLI RPC protocol types (stdin/stdout JSONL). No SDK dependency. */

export interface RpcImageContent {
    type: 'image';
    data: string;
    mimeType: string;
}

export type RpcCommand =
    | {
          id?: string;
          type: 'prompt';
          message: string;
          images?: RpcImageContent[];
          streamingBehavior?: 'steer' | 'followUp';
      }
    | { id?: string; type: 'steer'; message: string; images?: RpcImageContent[] }
    | { id?: string; type: 'follow_up'; message: string; images?: RpcImageContent[] }
    | { id?: string; type: 'abort' }
    | { id?: string; type: 'new_session'; parentSession?: string }
    | { id?: string; type: 'get_state' }
    | { id?: string; type: 'set_model'; provider: string; modelId: string }
    | { id?: string; type: 'cycle_model' }
    | { id?: string; type: 'get_available_models' }
    | { id?: string; type: 'get_login_providers' }
    | { id?: string; type: 'set_thinking_level'; level: string }
    | { id?: string; type: 'cycle_thinking_level' }
    | { id?: string; type: 'set_steering_mode'; mode: 'all' | 'one-at-a-time' }
    | { id?: string; type: 'set_follow_up_mode'; mode: 'all' | 'one-at-a-time' }
    | { id?: string; type: 'compact'; customInstructions?: string }
    | { id?: string; type: 'set_auto_compaction'; enabled: boolean }
    | { id?: string; type: 'set_auto_retry'; enabled: boolean }
    | { id?: string; type: 'abort_retry' }
    | { id?: string; type: 'bash'; command: string; excludeFromContext?: boolean }
    | { id?: string; type: 'abort_bash' }
    | { id?: string; type: 'get_session_stats' }
    | { id?: string; type: 'export_html'; outputPath?: string }
    | { id?: string; type: 'switch_session'; sessionPath: string }
    | { id?: string; type: 'fork' | 'branch'; entryId: string }
    | { id?: string; type: 'clone' }
    | { id?: string; type: 'get_fork_messages' | 'get_branch_messages' }
    | { id?: string; type: 'get_last_assistant_text' }
    | { id?: string; type: 'set_session_name'; name: string }
    | { id?: string; type: 'get_messages' }
    | { id?: string; type: 'get_commands' | 'get_available_commands' }
    | { id?: string; type: 'get_tree' }
    | { id?: string; type: 'negotiate_protocol'; protocolVersion: 2 }
    | { id?: string; type: 'set_host_tools'; tools: RpcHostToolDefinition[] };

/**
 * A tool the host executes; the agent calls it back with `host_tool_call` (omp docs rpc.md). omp
 * RPC has it natively; pi through the bundled extension (PiRpcBridge.setHostTools).
 */
export interface RpcHostToolDefinition {
    name: string;
    label?: string;
    description: string;
    /** JSON Schema of the arguments object. */
    parameters: Record<string, unknown>;
    /** Omitted → `discoverable`, which hides the tool until the model searches for it. */
    loadMode?: 'essential' | 'discoverable';
}

export interface RpcSlashCommand {
    name: string;
    description?: string;
    source: 'builtin' | 'extension' | 'prompt' | 'skill';
    /** pi: the file that defines it (a skill's SKILL.md); omp does not report it. */
    path?: string;
}

export interface RpcSessionState {
    model?: { provider: string; id: string; name?: string; contextWindow?: number };
    thinkingLevel: string;
    isStreaming: boolean;
    isCompacting: boolean;
    steeringMode?: 'all' | 'one-at-a-time';
    followUpMode?: 'all' | 'one-at-a-time';
    sessionId: string;
    sessionName?: string;
    sessionFile?: string;
    messageCount: number;
    pendingMessageCount?: number;
    autoCompactionEnabled?: boolean;
}

export interface RpcContextUsage {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}

export interface RpcSessionStats {
    tokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total?: number;
    };
    cost: number;
    turnCount?: number;
    contextUsage?: RpcContextUsage;
}

export interface RpcResponse {
    id?: string;
    type: 'response';
    success: boolean;
    command?: string;
    data?: unknown;
    error?: string;
}

export type RpcExtensionUIRequest =
    | {
          type: 'extension_ui_request';
          id: string;
          method: 'select';
          title: string;
          options: string[];
          timeout?: number;
      }
    | {
          type: 'extension_ui_request';
          id: string;
          method: 'confirm';
          title: string;
          message: string;
          timeout?: number;
      }
    | {
          type: 'extension_ui_request';
          id: string;
          method: 'input';
          title: string;
          placeholder?: string;
          timeout?: number;
      }
    | {
          type: 'extension_ui_request';
          id: string;
          method: 'editor';
          title: string;
          prefill?: string;
      }
    | {
          type: 'extension_ui_request';
          id: string;
          method: 'notify';
          message: string;
          notifyType?: 'info' | 'warning' | 'error';
      }
    | {
          type: 'extension_ui_request';
          id: string;
          method: 'setStatus';
          statusKey: string;
          statusText?: string;
      }
    | {
          type: 'extension_ui_request';
          id: string;
          method: 'setWidget';
          widgetKey: string;
          widgetLines?: string[];
          widgetPlacement?: 'aboveEditor' | 'belowEditor';
      }
    | {
          type: 'extension_ui_request';
          id: string;
          method: 'setTitle';
          title: string;
      }
    | {
          type: 'extension_ui_request';
          id: string;
          method: 'set_editor_text';
          text: string;
      };

export type RpcExtensionUIResponse =
    | { type: 'extension_ui_response'; id: string; value: string }
    | { type: 'extension_ui_response'; id: string; confirmed: boolean }
    | { type: 'extension_ui_response'; id: string; cancelled: true };

export type PiAgentEvent = { type: string; [key: string]: unknown };

export type PiRpcOutbound = PiAgentEvent | RpcExtensionUIRequest;
