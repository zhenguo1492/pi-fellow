const PROPOSED_PLAN_BLOCK = /<proposed_plan>\s*[\s\S]*?\s*<\/proposed_plan>/gi;
const PLAN_CONTEXT_MARKER = '[CODEX-LIKE PLAN MODE ACTIVE]';

/** Messages that should not appear in the chat transcript (plan lives in editor). */
/** rpiv-todo `todo` tool results — tracked in Pi Plan.md, not as chat cards. */
export function shouldHideRpivTodoToolInChat(msg: any): boolean {
    if (!msg || typeof msg !== 'object') {
        return false;
    }
    const role = msg.role as string | undefined;
    if (role !== 'toolResult' && role !== 'tool') {
        return false;
    }
    return (msg.toolName as string | undefined)?.toLowerCase() === 'todo';
}

export function shouldHideMessageInChat(msg: any): boolean {
    if (shouldHideRpivTodoToolInChat(msg)) {
        return true;
    }
    if (!msg || typeof msg !== 'object') {
        return false;
    }

    const customType = msg.customType as string | undefined;
    if (customType === 'proposed-plan' || customType === 'plan-mode-context') {
        return true;
    }

    if (msg.role === 'custom' && (customType === 'proposed-plan' || customType === 'plan-mode-context')) {
        return true;
    }

    const text = messagePlainText(msg);

    if (msg.role === 'user' && isImplementPlanUserMessage(text)) {
        return true;
    }

    if (msg.role === 'assistant') {
        // Hide only a reply that was nothing but the plan; a step with no text (thinking and
        // tool calls only) still belongs in the transcript.
        const stripped = stripProposedPlanBlocks(text);
        if (stripped === '**Proposed Plan**' || (!stripped && text.trim())) {
            return true;
        }
    }

    return false;
}

/** Remove plan blocks from assistant text; returns empty if nothing left to show. */
export function stripPlanContentForChatDisplay(text: string): string {
    let out = stripProposedPlanBlocks(text);
    out = out.replace(/^\*\*Proposed Plan\*\*\s*/i, '').trim();
    if (out.includes(PLAN_CONTEXT_MARKER)) {
        return '';
    }
    return out;
}

export function stripProposedPlanBlocks(text: string): string {
    return text.replace(PROPOSED_PLAN_BLOCK, '').trim();
}

function isImplementPlanUserMessage(text: string): boolean {
    const t = text.trim();
    return (
        t.startsWith('Plan mode is now disabled') &&
        t.includes('Implement this proposed plan now')
    );
}

function messagePlainText(msg: any): string {
    const content = msg.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n');
    }
    return '';
}
