import { formatTimestamp, truncate, tryParseJSON } from './helpers';
import { extractToolCalls } from './messageContent';

/** One-line tool card title: tool-specific phrasing, else `name: <first string hint>`, else the bare name. */
export function getToolLabel(name: string, args: any): string {
    switch (name.toLowerCase()) {
        case 'bash':
            return args?.command ? truncate(args.command, 60) : 'Execute command';
        case 'read':
            return args?.path ? `Read ${truncate(args.path, 50)}` : 'Read file';
        case 'write':
            return args?.path ? `Write ${truncate(args.path, 50)}` : 'Write file';
        case 'edit':
            return args?.path ? `Edit ${truncate(args.path, 50)}` : 'Edit file';
        case 'glob':
            return args?.pattern ? `Glob ${truncate(args.pattern, 50)}` : 'Find files';
        case 'grep':
            return args?.pattern ? `Grep ${truncate(args.pattern, 50)}` : 'Search files';
        default: {
            if (args && typeof args === 'object') {
                const hint = args.query ?? args.path ?? args.file ?? args.action ?? args.url ?? args.name ?? args.command;
                if (typeof hint === 'string' && hint.trim()) {
                    return `${name}: ${truncate(hint, 50)}`;
                }
            }
            return name;
        }
    }
}

/** Plain text of a tool result: strings, text-item arrays, `content`/`text`/`output`, else pretty JSON. */
export function extractToolResultText(result: any): string {
    if (result === undefined || result === null) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
        return result
            .map((item: any) => (typeof item === 'string' ? item : item?.text ?? ''))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof result === 'object') {
        if (Array.isArray(result.content)) {
            const text = result.content
                .map((item: any) => (typeof item === 'string' ? item : item?.text ?? ''))
                .filter(Boolean)
                .join('\n');
            if (text) return text;
        }
        if (result.text) return result.text;
        if (result.output) return result.output;
    }
    return JSON.stringify(result, null, 2);
}

/** `key: value` per line; non-string values JSON-encoded. */
export function formatToolArgs(args: any): string {
    if (!args || typeof args !== 'object') return '';
    const entries = Object.entries(args);
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}: ${val}`;
    }).join('\n');
}

/** Parsed tool-call arguments from the assistant message that issued `toolCallId`. */
export function findToolCallArgs(messages: any[], beforeIndex: number, toolCallId: string): unknown {
    const call = findToolCallInMessages(messages, beforeIndex, toolCallId);
    const args = call?.arguments ?? call?.args ?? call?.input ?? {};
    return typeof args === 'string' ? tryParseJSON(args) : args;
}

/** Tool result footer text parts: timestamp, then the issuing assistant step's token usage. */
export function toolFooterParts(msg: any, allMessages: any[], msgIndex: number): string[] {
    const parts: string[] = [];
    const ts = msg.timestamp;
    if (ts) parts.push(formatTimestamp(ts));

    const precedingAssistant = findPrecedingAssistant(allMessages, msgIndex);
    if (precedingAssistant?.usage) {
        const u = precedingAssistant.usage;
        if (u.input > 0) parts.push(`${u.input.toLocaleString()} in`);
        if (u.output > 0) parts.push(`${u.output.toLocaleString()} out`);
    }
    return parts;
}

/** Nearest assistant message before `beforeIndex` within the same turn (a user message ends the search). */
export function findPrecedingAssistant(messages: any[], beforeIndex: number): any | null {
    for (let i = beforeIndex - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') return messages[i];
        if (messages[i].role === 'user') return null;
    }
    return null;
}

/** The tool call with `toolCallId` from any assistant message before `beforeIndex`. */
export function findToolCallInMessages(messages: any[], beforeIndex: number, toolCallId: string): any | undefined {
    if (!toolCallId) return undefined;
    for (let i = beforeIndex - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        const tcs = extractToolCalls(m);
        for (const tc of tcs) {
            if ((tc.id ?? tc.toolCallId) === toolCallId) return tc;
        }
    }
    return undefined;
}
