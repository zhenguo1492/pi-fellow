/**
 * Tool-card renderer contract, ported from oh-my-pi collab-web `tool-render`
 * (a1b3b83). Renderers must tolerate partial/malformed `args` and `details`:
 * both arrive as plain JSON from the agent.
 */

export interface ToolResultPayload {
    content: Array<{ type: string; [key: string]: unknown }>;
    details?: unknown;
    isError?: boolean;
}

export interface ToolRenderProps {
    /** Tool name the renderer was resolved for. */
    name: string;
    /** Tool-call arguments with the `i` intent field stripped. */
    args: Record<string, unknown>;
    result?: ToolResultPayload;
    running?: boolean;
}

/** A DOM child; falsy values are skipped. */
export type Child = Node | string | null | undefined | false;

export interface ToolRenderer {
    /** Inline header items, joined by spaces. No block elements. */
    summary(props: ToolRenderProps): Child[];
    /** Expanded body blocks. Omit when the summary says everything. */
    body?(props: ToolRenderProps): Child[];
    /**
     * Controls beside the header, outside the toggle button, so they work with the card collapsed.
     * The view that shows the card handles their clicks.
     */
    actions?(props: ToolRenderProps): Child[];
}
