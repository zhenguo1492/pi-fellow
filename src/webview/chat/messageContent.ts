import type { ConnectionStatus } from '../../shared/protocol';
import { parseUserMessageForDisplay } from '../../shared/attachmentMessageDisplay';
import { stripPlanContentForChatDisplay } from '../../shared/planMessageFilter';

export function lastAssistantMessage(messages: any[] | undefined): any | undefined {
    if (!messages?.length) {
        return undefined;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant') {
            return messages[i];
        }
    }
    return undefined;
}

export function failedConnectionFromAssistant(msg: any | undefined): ConnectionStatus | undefined {
    if (!msg || msg.stopReason !== 'error') {
        return undefined;
    }
    const message =
        typeof msg.errorMessage === 'string' && msg.errorMessage.trim()
            ? msg.errorMessage.trim()
            : 'Request failed';
    return { phase: 'failed', message };
}

export function messageFingerprint(msg: any): string {
    const role = msg?.role ?? '';
    const text = extractText(msg);
    const ts = msg?.timestamp ?? '';
    return `${role}:${text}:${ts}`;
}

export function getUserMessagePlainForCopy(msg: any): string {
    const raw = extractText(msg);
    const { displayText } = parseUserMessageForDisplay(raw);
    return displayText || raw;
}

export function getAssistantPlainForCopy(msg: any): string {
    let text = extractText(msg);
    if (text) {
        text = stripPlanContentForChatDisplay(text);
    }
    return text;
}

/** Steering messages have user role in RPC history but do not start a new chat turn. */
export function isTurnPrompt(msg: unknown): boolean {
    return typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'user'
        && (!('steering' in msg) || msg.steering !== true);
}
/** Index of the last turn-starting user message in `messages`, or -1. */
export function findLastUserMessageIndex(messages: any[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (isTurnPrompt(messages[i])) {
            return i;
        }
    }
    return -1;
}

export function extractToolCalls(msg: any): any[] {
    if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) return msg.toolCalls;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return msg.tool_calls;
    if (Array.isArray(msg.content)) {
        const tcs = msg.content.filter((c: any) => c.type === 'toolCall' || c.type === 'tool_call' || c.type === 'tool_use');
        if (tcs.length > 0) return tcs;
    }
    return [];
}

export function thinkingBlockText(block: any): string {
    if (!block || typeof block !== 'object') {
        return '';
    }
    if (block.type === 'redacted_thinking') {
        return typeof block.data === 'string' && block.data.trim()
            ? block.data
            : '[Thinking redacted by provider]';
    }
    if (block.type === 'thinking') {
        return block.thinking ?? block.text ?? '';
    }
    return '';
}

export function extractThinking(msg: any): string {
    if (Array.isArray(msg.content)) {
        return msg.content
            .map((c: any) => thinkingBlockText(c))
            .filter((t: string) => t.trim())
            .join('\n\n');
    }
    return typeof msg.thinking === 'string' ? msg.thinking : '';
}

export function extractText(msg: any): string {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
    }
    return msg.text ?? '';
}

export function extractImages(msg: any): { mimeType: string; data: string; name?: string }[] {
    if (!Array.isArray(msg.content)) {
        return [];
    }
    return msg.content
        .filter((c: any) => c.type === 'image' && typeof c.data === 'string' && c.data.length > 0)
        .map((c: any) => ({
            mimeType: c.mimeType ?? 'image/png',
            data: c.data,
            name: c.name,
        }));
}
