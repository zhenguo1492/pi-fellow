import type * as vscode from 'vscode';
import type { PiChatSession } from '../pi/slashCommands';
import type { AgentBackend, ServerMessage } from '../shared/protocol';
import type { TabState } from './sidebarTabState';

/** What the chat sidebar's modules need from the provider: its webview, the current backend's tabs, state pushes. */
export interface SidebarHost {
    readonly outputChannel: vscode.OutputChannel;
    readonly workspaceState: vscode.Memento;
    /** The current backend workspace's tabs. */
    readonly tabs: Map<string, TabState>;
    activeTabId: string;
    readonly activeTab: TabState;
    currentBackend: AgentBackend;
    post(message: ServerMessage): void;
    sendStateSync(): void;
    /** Pull latest messages/model from Pi RPC, then push to webview (avoids stale/laggy chat). */
    pushStateSync(): Promise<void>;
    postModelFooter(tab?: TabState): void;
    /** Route the session's extension UI, chat errors and extension chrome to the webview. */
    wireRpcSessionUi(session: PiChatSession): void;
}

/** A plain-JSON copy of an RPC value for `postMessage`; only its `type` when it does not serialize. */
export function safeSerialize(obj: unknown): unknown {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        // Unvalidated RPC value: its `type`, read the way any property read would be, still identifies it.
        const failed = obj as { type?: unknown } | null | undefined;
        return { type: failed?.type, _serializationFailed: true };
    }
}
