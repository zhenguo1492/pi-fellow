import type { ContextBreakdownCategory, ContextBreakdownInfo } from '../shared/protocol';

const ANSI = /\x1b\[[0-9;]*m/g;

const CATEGORY_IDS: Record<string, ContextBreakdownCategory['id']> = {
    'System prompt': 'systemPrompt',
    'System tools': 'systemTools',
    'System context': 'systemContext',
    Skills: 'skills',
    Messages: 'messages',
};

/** `  <label padded to 16> [<bar>] <pct>%  <tokens> tokens` */
const ROW = /^ {2}(\S.*?)\s+\[[^\]]*\]\s+\d+%\s+(\d+) tokens$/;

/**
 * Parses the text omp's `/context` builtin prints over RPC (`command_output`; omp
 * slash-commands/helpers/context-report.ts): a `Context window: N tokens (P% used)` header, one row
 * per non-empty category, then `Auto-compact buf` and `Free` rows and optional snapcompact notes.
 * Throws with the report's own message when it carries no breakdown (e.g. no model selected).
 */
export function parseContextReport(text: string): ContextBreakdownInfo {
    const lines = text.replace(ANSI, '').split('\n');
    const header = /^Context window: (\d+) tokens/.exec(lines[0] ?? '');
    if (!header) {
        throw new Error(text.trim() || 'omp printed no context report');
    }
    const info: ContextBreakdownInfo = {
        contextWindow: Number(header[1]),
        usedTokens: 0,
        categories: [],
        autoCompactBufferTokens: 0,
        freeTokens: 0,
        notes: [],
    };
    for (const line of lines.slice(1)) {
        const row = ROW.exec(line);
        if (!row) {
            if (line.trim()) info.notes.push(line.trimEnd());
            continue;
        }
        const label = row[1];
        const tokens = Number(row[2]);
        if (label === 'Auto-compact buf') {
            info.autoCompactBufferTokens = tokens;
        } else if (label === 'Free') {
            info.freeTokens = tokens;
        } else {
            info.categories.push({ id: CATEGORY_IDS[label] ?? 'other', label, tokens });
            info.usedTokens += tokens;
        }
    }
    return info;
}
