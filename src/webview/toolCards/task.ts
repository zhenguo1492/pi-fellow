/** `task` (subagent batches) and `todo` (phased task list). */
import { type Tone, badge, badges, h, note, output, resultText, row } from './parts';
import type { Child, ToolRenderer } from './types';
import { detailsRecord, isRecord, normalizeWs, num, plural, str, truncate } from './util';

const MISSING_YIELD_PREFIX = 'SYSTEM WARNING: Subagent exited without calling yield tool';

interface TaskItem {
    id: string | null;
    description: string | null;
    assignment: string | null;
    isolated: boolean;
}

/** Spawned units of work across the batch (`tasks[]`) and flat/legacy arg shapes. */
function taskItems(args: Record<string, unknown>): TaskItem[] {
    const toItem = (entry: Record<string, unknown>): TaskItem => ({
        id: str(entry.id),
        description: str(entry.description),
        assignment: str(entry.assignment),
        isolated: entry.isolated === true,
    });
    if (Array.isArray(args.tasks)) return args.tasks.filter(isRecord).map(toItem);
    const flat = toItem(args);
    return flat.id || flat.description || flat.assignment ? [flat] : [];
}

/** Agent id chip; `Anna.Bob` nesting reads `Anna>Bob`. */
function agentChip(id: string): HTMLElement {
    return badge(id.split('.').join('>'), 'accent');
}

function fmtDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function fmtCount(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Outcome of one agent: aborted / merge failed / done / failed. */
function resultStatus(res: Record<string, unknown>): { label: string; tone: 'ok' | 'err' | 'warn' } {
    if (res.aborted === true) return { label: 'aborted', tone: 'err' };
    if (num(res.exitCode) === 0) return str(res.error) ? { label: 'merge failed', tone: 'warn' } : { label: 'done', tone: 'ok' };
    return { label: 'failed', tone: 'err' };
}

/** Final snapshot of one agent: status row, output preview, error/abort notes. */
function agentResult(res: Record<string, unknown>): Child[] {
    const { label, tone } = resultStatus(res);
    const description = str(res.description);
    const stats: string[] = [];
    const tokens = num(res.tokens);
    if (tokens) stats.push(`${fmtCount(tokens)} tok`);
    const requests = num(res.requests);
    if (requests) stats.push(`${requests} req`);
    const durationMs = num(res.durationMs);
    if (durationMs !== null) stats.push(fmtDuration(durationMs));
    const model = str(res.resolvedModel);
    if (model) stats.push(model);

    // The runtime prepends a warning line when a subagent never yielded; lift it out of the preview.
    let text = str(res.output) ?? '';
    let warning: string | null = null;
    const nl = text.indexOf('\n');
    const firstLine = (nl === -1 ? text : text.slice(0, nl)).trim();
    if (firstLine.startsWith(MISSING_YIELD_PREFIX)) {
        warning = firstLine;
        text = nl === -1 ? '' : text.slice(nl + 1).replace(/^\s*\n+/, '');
    }
    const error = str(res.error);
    const aborted = res.aborted === true;
    const abortReason = str(res.abortReason);
    const patchPath = str(res.patchPath);
    const branchName = str(res.branchName);
    return [
        row(
            agentChip(str(res.id) ?? 'agent'),
            badge(label, tone),
            res.truncated === true && badge('truncated', 'warn'),
            description && h('span', undefined, ` ${truncate(normalizeWs(description), 96)}`),
            stats.length > 0 && h('span', 'tv-faint', ` ${stats.join(' · ')}`),
        ),
        warning && note('warn', warning),
        aborted && abortReason && note('err', abortReason),
        text.trim() !== '' && output(text, { maxLines: 6, error: tone === 'err' }),
        error && !aborted && error !== abortReason && note(tone === 'warn' ? 'warn' : 'err', error),
        patchPath ? h('div', 'tv-faint', `patch: ${patchPath}`) : branchName && h('div', 'tv-faint', `branch: ${branchName}`),
    ];
}

const PROGRESS_TONE: Record<string, Tone> = { completed: 'ok', failed: 'err', aborted: 'err', running: 'accent' };

/** Live snapshot of one still-running agent. */
function agentProgress(p: Record<string, unknown>): HTMLElement {
    const status = str(p.status) ?? 'running';
    const description = str(p.description);
    const intent = str(p.lastIntent) ?? str(p.currentTool);
    const bits: string[] = [];
    const toolCount = num(p.toolCount);
    if (toolCount) bits.push(`${toolCount} tools`);
    const tokens = num(p.tokens);
    if (tokens) bits.push(`${fmtCount(tokens)} tok`);
    const durationMs = num(p.durationMs);
    if (durationMs) bits.push(fmtDuration(durationMs));
    return row(
        agentChip(str(p.id) ?? 'agent'),
        badge(status, PROGRESS_TONE[status]),
        description && h('span', undefined, ` ${truncate(normalizeWs(description), 96)}`),
        intent && h('span', 'tv-muted', ` ${truncate(normalizeWs(intent), 64)}`),
        bits.length > 0 && h('span', 'tv-faint', ` ${bits.join(' · ')}`),
    );
}

export const taskRenderer: ToolRenderer = {
    summary({ args }) {
        const agent = str(args.agent);
        const resume = str(args.resume);
        const tasks = taskItems(args);
        const label = tasks.length > 0 ? (tasks[0].description ?? tasks[0].id) : null;
        return [
            agent && badge(agent, 'accent'),
            !agent && resume && badge(`resume ${resume}`),
            label && h('span', 'tv-muted', truncate(normalizeWs(label), 72)),
            tasks.length > 1 && badge(`${tasks.length} tasks`),
        ];
    },

    body({ args, result }) {
        const resume = str(args.resume);
        const context = str(args.context);
        const tasks = taskItems(args);
        const details = detailsRecord(result);
        const results = Array.isArray(details?.results) ? details.results.filter(isRecord) : [];
        const progress = Array.isArray(details?.progress) ? details.progress.filter(isRecord) : [];
        const showProgress = results.length === 0 && progress.length > 0;

        const blocks: Child[] = [
            resume && badges([`resume ${resume}`]),
            context && output(context, { maxLines: 4, title: 'context' }),
        ];
        if (tasks.length > 0) {
            blocks.push(
                h(
                    'div',
                    'tv-list',
                    ...tasks.map((t, i) =>
                        h(
                            'div',
                            undefined,
                            row(
                                t.id ? agentChip(t.id) : badge(`#${i + 1}`, 'accent'),
                                t.isolated && badge('isolated'),
                                t.description && h('span', undefined, ` ${truncate(normalizeWs(t.description), 120)}`),
                            ),
                            t.assignment && output(t.assignment, { maxLines: 6, title: 'assignment' }),
                        ),
                    ),
                ),
            );
        }
        if (results.length > 0) {
            const counts: Record<string, number> = {};
            for (const res of results) {
                const { label } = resultStatus(res);
                counts[label] = (counts[label] ?? 0) + 1;
            }
            const total = num(details?.totalDurationMs);
            // Finished agents by runtime ascending, as the TUI orders them.
            const ordered = [...results].sort(
                (a, b) => (num(a.durationMs) ?? 0) - (num(b.durationMs) ?? 0) || (num(a.index) ?? 0) - (num(b.index) ?? 0),
            );
            blocks.push(
                h(
                    'div',
                    'tv-list',
                    ...ordered.flatMap(agentResult),
                    row(
                        null,
                        badges([
                            counts.done > 0 && badge(`${counts.done} succeeded`, 'ok'),
                            counts['merge failed'] > 0 && badge(`${counts['merge failed']} merge failed`, 'warn'),
                            counts.failed > 0 && badge(`${counts.failed} failed`, 'err'),
                            counts.aborted > 0 && badge(`${counts.aborted} aborted`, 'err'),
                        ]),
                        total !== null && h('span', 'tv-faint', ` ${fmtDuration(total)}`),
                    ),
                ),
            );
        } else if (showProgress) {
            blocks.push(h('div', 'tv-list', ...progress.map(agentProgress)));
        } else {
            blocks.push(resultText(result, { maxLines: 12 }));
        }
        return blocks;
    },
};

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned';
const TASK_ICONS: Record<TaskStatus, string> = { completed: '✓', in_progress: '→', abandoned: '✕', pending: '○' };
const ROMAN: ReadonlyArray<readonly [number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function roman(n: number): string {
    let out = '';
    let rem = n;
    for (const [value, sym] of ROMAN) {
        for (; rem >= value; rem -= value) out += sym;
    }
    return out;
}

/** Ops of a todo call: the current single `{op, …}` shape or legacy batched `{ops: […]}`. */
function todoOps(args: Record<string, unknown>): Record<string, unknown>[] {
    if (Array.isArray(args.ops)) return args.ops.filter(isRecord);
    return typeof args.op === 'string' ? [args] : [];
}

function todoOpRow(entry: Record<string, unknown>): HTMLElement {
    const parts: string[] = [];
    const task = str(entry.task);
    const phase = str(entry.phase);
    if (task !== null) parts.push(task);
    if (phase !== null) parts.push(phase);
    if (Array.isArray(entry.items) && entry.items.length > 0) parts.push(plural(entry.items.length, 'item'));
    if (Array.isArray(entry.list) && entry.list.length > 0) {
        let tasks = 0;
        for (const p of entry.list) if (isRecord(p) && Array.isArray(p.items)) tasks += p.items.length;
        parts.push(`${plural(entry.list.length, 'phase')} · ${tasks} tasks`);
    }
    return row(str(entry.op) ?? 'update', truncate(normalizeWs(parts.join(' · ')), 160));
}

function todoBoard(phases: unknown[]): HTMLElement | null {
    const board = h('div', 'tv-todo');
    phases.forEach((phase, i) => {
        if (!isRecord(phase)) return;
        board.append(h('div', 'tv-todo-phase', `${roman(i + 1)}. ${str(phase.name) ?? ''}`));
        for (const task of Array.isArray(phase.tasks) ? phase.tasks.filter(isRecord) : []) {
            const raw = task.status;
            const status: TaskStatus = raw === 'completed' || raw === 'in_progress' || raw === 'abandoned' ? raw : 'pending';
            board.append(
                h(
                    'div',
                    `tv-task tv-task--${status}`,
                    h('span', 'tv-task-icon', TASK_ICONS[status]),
                    h('span', undefined, str(task.content) ?? ''),
                ),
            );
        }
    });
    return board.childElementCount > 0 ? board : null;
}

export const todoRenderer: ToolRenderer = {
    summary({ args }) {
        const counts: Record<string, number> = {};
        let firstTask: string | null = null;
        for (const entry of todoOps(args)) {
            const op = str(entry.op) ?? 'update';
            counts[op] = (counts[op] ?? 0) + 1;
            if (firstTask === null) {
                firstTask = str(entry.task) ?? str(entry.phase);
                const head = firstTask === null && Array.isArray(entry.list) ? entry.list.find(isRecord) : undefined;
                if (head && Array.isArray(head.items)) firstTask = str(head.items[0]);
            }
        }
        const labels = Object.entries(counts).map(([op, n]) => (n > 1 ? `${op}×${n}` : op));
        return [badges(labels.length > 0 ? labels : ['update']), firstTask && h('span', undefined, truncate(normalizeWs(firstTask), 60))];
    },

    body({ args, result }) {
        const ops = todoOps(args);
        const details = detailsRecord(result);
        const phases = Array.isArray(details?.phases) && !result?.isError ? details.phases : null;
        return [
            ops.length > 0 && h('div', 'tv-list', ...ops.map(todoOpRow)),
            phases !== null ? todoBoard(phases) : resultText(result, { maxLines: 8 }),
        ];
    },
};
