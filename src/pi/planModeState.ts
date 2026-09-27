import type { PlanModeInfo, PlanTodoItem, PiExtensionChromeSnapshot } from '../shared/protocol';
import type { SessionJsonlEntry } from './sessionJsonl';

const PLAN_STATE_ENTRY = 'plan-mode-state';
const PLAN_STATE_ENTRY_LEGACY = 'plan-mode';
const PROPOSED_PLAN_MESSAGE = 'proposed-plan';
const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

interface RawPlanModeState {
    enabled?: boolean;
    latestPlan?: string;
    awaitingAction?: boolean;
}

export interface PlanModeContext {
    messages?: unknown[];
    jsonlEntries?: SessionJsonlEntry[];
    activeToolNames?: string[];
}

function readLatestPlanStateFromJsonl(entries: SessionJsonlEntry[]): RawPlanModeState | undefined {
    let last: RawPlanModeState | undefined;
    for (const entry of entries) {
        if (entry.type !== 'custom') {
            continue;
        }
        if (entry.customType === PLAN_STATE_ENTRY) {
            last = entry.data as RawPlanModeState;
        } else if (entry.customType === PLAN_STATE_ENTRY_LEGACY) {
            const legacy = entry.data as { enabled?: boolean };
            last = { enabled: legacy.enabled === true, awaitingAction: false };
        }
    }
    return last;
}

/** Plan mode snapshot for RPC sessions (jsonl + live messages). */
export function readPlanModeInfoFromContext(ctx: PlanModeContext): PlanModeInfo {
    const jsonlEntries = ctx.jsonlEntries ?? [];
    const messages = (ctx.messages ?? []) as any[];

    const raw: RawPlanModeState = readLatestPlanStateFromJsonl(jsonlEntries) ?? { enabled: false, awaitingAction: false };

    const enabled = raw.enabled === true;
    // Assistant text is only a plan while plan mode is on: any message that merely mentions
    // the tag (docs, code review, this very parser) would otherwise read as a proposed plan.
    const fromMessages = enabled ? extractPlanFromMessages(messages) : '';
    const fromBranch = extractPlanFromBranch(jsonlEntries);
    const planMarkdown = (raw.latestPlan?.trim() || fromBranch || fromMessages).trim();
    const awaitingAction = raw.awaitingAction === true;
    const hasPlan = planMarkdown.length > 0;

    let statusLabel: PlanModeInfo['statusLabel'] = 'off';
    if (enabled && hasPlan && awaitingAction) {
        statusLabel = 'ready';
    } else if (enabled) {
        statusLabel = 'planning';
    }

    return {
        enabled,
        hasPlan,
        awaitingAction,
        statusLabel,
        planMarkdown,
        todos: parsePlanTodos(planMarkdown),
    };
}

function extractPlanFromBranch(entries: SessionJsonlEntry[]): string {
    let last = '';
    for (const entry of entries) {
        if (entry.type !== 'custom_message' || entry.customType !== PROPOSED_PLAN_MESSAGE) {
            continue;
        }
        const content = entry.content;
        if (typeof content === 'string') {
            last = stripProposedPlanDisplay(content);
        }
    }
    return last;
}

function extractPlanFromMessages(messages: any[]): string {
    let last = '';
    for (const msg of messages) {
        if (msg?.customType === PROPOSED_PLAN_MESSAGE) {
            const c = msg.content;
            if (typeof c === 'string') {
                last = stripProposedPlanDisplay(c);
            }
        }
        if (msg?.role === 'assistant') {
            const text = messageText(msg);
            const match = PROPOSED_PLAN_PATTERN.exec(text);
            if (match?.[1]) {
                last = match[1].trim();
            }
        }
    }
    return last;
}

function stripProposedPlanDisplay(content: string): string {
    return content.replace(/^\*\*Proposed Plan\*\*\s*/i, '').trim();
}

function messageText(msg: any): string {
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

/** Markdown checkboxes and numbered steps under common headings. */
export function parsePlanTodos(markdown: string): PlanTodoItem[] {
    if (!markdown.trim()) {
        return [];
    }

    const lines = markdown.split('\n');
    const todos: PlanTodoItem[] = [];
    let id = 0;

    for (const line of lines) {
        const checkbox = /^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
        if (checkbox) {
            todos.push({
                id: `todo-${++id}`,
                text: checkbox[3].trim(),
                done: checkbox[2].toLowerCase() === 'x',
            });
            continue;
        }

        const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
        if (numbered) {
            todos.push({
                id: `step-${numbered[1]}`,
                text: numbered[2].trim(),
                done: false,
            });
        }
    }

    return todos;
}

export function buildImplementPlanPrompt(planMarkdown: string): string {
    return (
        'Plan mode is now disabled. Full tool access is restored. ' +
        `Implement this proposed plan now:\n\n${planMarkdown}`
    );
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Merge live plan-mode widget/status from Pi RPC extension chrome into session plan snapshot. */
export function enrichPlanModeFromExtensionChrome(
    planMode: PlanModeInfo,
    chrome?: PiExtensionChromeSnapshot,
): PlanModeInfo {
    if (!chrome) {
        return planMode;
    }

    const planWidget = chrome.widgets.find((w) => w.key === 'plan-mode-plan');
    const widgetLines = planWidget?.lines?.map((l) => stripAnsi(l)).filter((l) => l.trim()) ?? [];
    const widgetMarkdown = widgetLines.join('\n').trim();

    const statusRaw = chrome.statuses.find((s) => s.key === 'plan-mode')?.text ?? '';
    const status = stripAnsi(statusRaw).toLowerCase();

    let enabled = planMode.enabled;
    let statusLabel = planMode.statusLabel;
    let awaitingAction = planMode.awaitingAction;

    // pi-plan-mode: "plan active" / "plan ready" while on; "plan saved" / "plan implementing" after it was left.
    if (status.includes('plan') && !/\b(off|disabled|saved|implementing)\b/.test(status)) {
        enabled = true;
    }
    if (status.includes('ready') || status.includes('awaiting') || status.includes('review')) {
        statusLabel = 'ready';
        awaitingAction = true;
    } else if (enabled && !planMode.hasPlan && !widgetMarkdown) {
        statusLabel = 'planning';
    }

    const planMarkdown = planMode.planMarkdown.trim() || widgetMarkdown;
    const hasPlan = planMarkdown.length > 0;

    if (enabled && hasPlan && (awaitingAction || planMode.awaitingAction)) {
        statusLabel = 'ready';
    }

    return {
        ...planMode,
        enabled,
        hasPlan,
        awaitingAction,
        statusLabel,
        planMarkdown,
        todos: planMode.todos.length > 0 ? planMode.todos : parsePlanTodos(planMarkdown),
    };
}
