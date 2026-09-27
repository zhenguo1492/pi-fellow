import { safeSerialize, type SidebarHost } from './sidebarHost';
import type { MessageHandlers } from './sidebarMessageHandlers';
import type { TabState } from './sidebarTabState';

/**
 * Waits for Approve/Reject of a tool call in the tab's approval card (the voice agent's changes in Manual,
 * and its commands and deletions in Edit automatically). The card is in the composer area, so it shows in the chat and in the Bot view; it is
 * part of every state sync, so it comes back after a tab switch.
 */
export function requestToolApproval(host: SidebarHost, tab: TabState, toolCallId: string, toolName: string, args: unknown): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const info = { toolCallId, toolName, args: safeSerialize(args) };
        tab.pendingApprovals.set(toolCallId, { info, resolve });
        if (tab.id === host.activeTabId) {
            host.post({ type: 'toolCallPending', pending: info });
        }
    });
}

function resolveToolApproval(host: SidebarHost, tab: TabState, toolCallId: string, approved: boolean): void {
    const pending = tab.pendingApprovals.get(toolCallId);
    if (pending) {
        tab.pendingApprovals.delete(toolCallId);
        pending.resolve(approved);
        if (tab.id === host.activeTabId) {
            host.post({ type: 'toolCallResolved', toolCallId });
        }
    }
}

/** The tab is closing: nothing waiting on it runs. */
export function rejectPendingApprovals(tab: TabState): void {
    for (const pending of tab.pendingApprovals.values()) {
        pending.resolve(false);
    }
    tab.pendingApprovals.clear();
}

export function toolApprovalHandlers(host: SidebarHost): MessageHandlers {
    return {
        approveToolCall: (msg, tab) => {
            resolveToolApproval(host, tab, msg.toolCallId, true);
        },
        rejectToolCall: (msg, tab) => {
            resolveToolApproval(host, tab, msg.toolCallId, false);
        },
    };
}
