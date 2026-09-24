export const DEFAULT_CONVERSATION_TITLE = 'New Agent';

/** Extract plain text from a Pi user message. */
export function extractConversationMessageText(message: unknown): string {
    if (!message || typeof message !== 'object') {
        return '';
    }

    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }

    return content
        .filter(
            (part): part is { type?: string; text?: string } =>
                typeof part === 'object' && part !== null,
        )
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n');
}

function normalizeTitle(value: string): string {
    return value.replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim();
}

/** Prefer an explicit session name, otherwise use the first user prompt. */
export function deriveConversationTitle(
    sessionName: string | undefined,
    messages: unknown[] | undefined,
    pendingPrompt?: string,
): string | undefined {
    const explicitName = normalizeTitle(sessionName ?? '');
    if (explicitName) {
        return explicitName;
    }

    for (const message of messages ?? []) {
        if ((message as { role?: unknown })?.role !== 'user') {
            continue;
        }
        const text = normalizeTitle(extractConversationMessageText(message));
        if (text) {
            return text;
        }
    }

    const promptTitle = normalizeTitle(pendingPrompt ?? '');
    return promptTitle || undefined;
}
