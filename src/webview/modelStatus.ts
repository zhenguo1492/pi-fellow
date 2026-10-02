/**
 * The model status line over the active tab's conversation, laid out like the Bot view's header:
 * one summary line (model · context · plan limits); clicking it floats the details (context and
 * session tokens, every usage window with its reset) over the transcript. Renders the host's
 * `ModelStatusInfo` (src/providers/model-status.ts). On omp the Context row expands into the
 * TUI's Context Usage grid, fetched from omp's `/context` while it is shown.
 */
import { escapeHtml } from '../shared/html';
import type { ClientMessage, ContextBreakdownCategory, ContextBreakdownInfo, ModelStatusInfo } from '../shared/protocol';
import { formatTokenCount } from './tokenCount';
import { vscode } from './vscodeApi';

/** Arrows swapping places: opens the model QuickPick. */
const SWITCH_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5.5h10M10 3l2.5 2.5L10 8"/><path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/></svg>';

const SEP = '<span class="ms-sep">·</span>';

/** Limit tone: warning from 90%, error once exhausted (as the old status bar item's background). */
function tone(usedPercent: number): string {
    return usedPercent >= 100 ? ' ms-err' : usedPercent >= 90 ? ' ms-warn' : '';
}

function meter(percent: number, cls = tone(percent)): string {
    const pct = Math.max(0, Math.min(100, percent));
    return `<span class="ms-meter${cls}"><i style="width:${pct}%"></i></span>`;
}

function row(key: string, value: string): string {
    return `<div class="ms-row"><span class="ms-k">${escapeHtml(key)}</span><span class="ms-v">${value}</span></div>`;
}

const root = document.createElement('div');
root.className = 'ms-head';
root.hidden = true;
root.innerHTML = `
<button type="button" class="ms-sum" aria-expanded="false" title="Show context and usage limits"><span class="ms-dot" aria-hidden="true"></span><span class="ms-sum-v"></span><span class="ms-working" hidden><span class="ms-spinner" aria-hidden="true"></span><span class="ms-working-text"></span></span><span class="ms-car">▶</span></button>
<button type="button" class="ms-switch" title="Switch model" aria-label="Switch model">${SWITCH_ICON}</button>
<div class="ms-detail"></div>`;

const sumBtn = root.querySelector<HTMLButtonElement>('.ms-sum')!;
const sumEl = root.querySelector<HTMLElement>('.ms-sum-v')!;
const workingEl = root.querySelector<HTMLElement>('.ms-working')!;
const workingTextEl = root.querySelector<HTMLElement>('.ms-working-text')!;
const detailEl = root.querySelector<HTMLElement>('.ms-detail')!;
function setOpen(open: boolean): void {
    root.classList.toggle('open', open);
    sumBtn.setAttribute('aria-expanded', String(open));
    if (open) {
        requestBreakdownIfStale();
    }
}
sumBtn.addEventListener('click', () => setOpen(!root.classList.contains('open')));
root.querySelector('.ms-switch')!.addEventListener('click', () => {
    setOpen(false);
    vscode.postMessage({ type: 'selectModel' } satisfies ClientMessage);
});
detailEl.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-ctx-toggle]')) {
        return;
    }
    ctxExpanded = !ctxExpanded;
    if (lastStatus) {
        renderHeader(lastStatus);
    }
    requestBreakdownIfStale();
});
root.addEventListener('mouseleave', () => setOpen(false));
document.addEventListener('click', (e) => {
    // The dispatch-time path: a click that re-renders the details (the Context toggle) detaches its
    // target, which `root.contains` would then count as outside.
    if (!e.composedPath().includes(root)) {
        setOpen(false);
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        setOpen(false);
    }
});

/** The line's node; `render()` in chat/layout.ts wipes #app on tab switches and re-inserts it. */
export const modelStatusEl: HTMLElement = root;

/** Last markup per element, so frequent identical updates do not re-parse (and reset hover/selection). */
const htmlCache = new WeakMap<Element, string>();
function setHtml(el: Element, html: string): void {
    if (htmlCache.get(el) !== html) {
        el.innerHTML = html;
        htmlCache.set(el, html);
    }
}

let lastStatus: ModelStatusInfo | undefined;
let currentWorking = false;
let currentWorkingLabel: string | undefined;

/** The Context row shows its breakdown; kept while the details close and reopen. */
let ctxExpanded = false;
let breakdown: ContextBreakdownInfo | undefined;
let breakdownError: string | undefined;
/** Context use the shown (or requested) breakdown was fetched for; a new value refetches it. */
let breakdownFor: string | undefined;
let breakdownInFlight = false;

/** Fetches the breakdown while it is on screen and the context moved since the last fetch; one at a time. */
function requestBreakdownIfStale(): void {
    const s = lastStatus;
    if (!s?.contextBreakdown || !ctxExpanded || !root.classList.contains('open') || breakdownInFlight) {
        return;
    }
    const key = `${s.model}\0${s.context?.tokens}\0${s.context?.contextWindow}`;
    if (key === breakdownFor) {
        return;
    }
    breakdownFor = key;
    breakdownInFlight = true;
    vscode.postMessage({ type: 'getContextBreakdown' } satisfies ClientMessage);
}

export function applyContextBreakdown(b: ContextBreakdownInfo | undefined, error: string | undefined): void {
    breakdownInFlight = false;
    breakdown = b;
    breakdownError = b ? undefined : (error ?? 'No context report');
    if (lastStatus) {
        renderHeader(lastStatus);
    }
    // The context may have moved while this one was in flight.
    requestBreakdownIfStale();
}

const GRID_CELLS = 200;

type CellKind = ContextBreakdownCategory['id'] | 'free' | 'buffer';

/**
 * omp's TUI Context Usage grid: every non-empty slice gets at least one cell; when they and the
 * auto-compact buffer overflow the grid the largest slices give cells back; free space fills the
 * gap and the buffer takes the tail.
 */
function gridCells(b: ContextBreakdownInfo): CellKind[] {
    const perCell = b.contextWindow / GRID_CELLS;
    const cellsFor = (tokens: number) => (tokens > 0 ? Math.max(1, Math.round(tokens / perCell)) : 0);
    const slices = b.categories.map((c) => ({ id: c.id, n: cellsFor(c.tokens) }));
    let buffer = cellsFor(b.autoCompactBufferTokens);
    let used = slices.reduce((sum, s) => sum + s.n, 0);
    let excess = used - (GRID_CELLS - buffer);
    if (excess > 0) {
        for (const s of [...slices].sort((x, y) => y.n - x.n)) {
            const give = Math.min(excess, s.n - 1);
            s.n -= give;
            excess -= give;
        }
        used = slices.reduce((sum, s) => sum + s.n, 0);
        buffer = Math.min(buffer, Math.max(0, GRID_CELLS - used));
    }
    const cells: CellKind[] = slices.flatMap((s) => Array<CellKind>(s.n).fill(s.id));
    const free = Math.max(0, GRID_CELLS - cells.length - buffer);
    cells.push(...Array<CellKind>(free).fill('free'), ...Array<CellKind>(buffer).fill('buffer'));
    return cells.slice(0, GRID_CELLS);
}

/** Share of the window as the TUI prints it: one decimal, `<0.1%` for a sliver. */
function share(tokens: number, window: number): string {
    const pct = window > 0 ? (tokens / window) * 100 : 0;
    return pct > 0 && pct < 0.05 ? '<0.1%' : `${pct.toFixed(1)}%`;
}

function renderBreakdown(): string {
    if (!breakdown) {
        const msg = breakdownError ? `<span class="ms-err">${escapeHtml(breakdownError)}</span>` : 'Loading breakdown…';
        return `<div class="ms-ctx ms-ctx-msg">${msg}</div>`;
    }
    const b = breakdown;
    const legend = (kind: CellKind, label: string, tokens: number, unit: string) =>
        `<div class="ms-ctx-li"><i class="ms-cell ms-c-${kind}"></i>${escapeHtml(label)}: <b>${formatTokenCount(tokens)}</b> <span class="ms-ctx-dim">${unit}(${share(tokens, b.contextWindow)})</span></div>`;
    const items = [
        ...b.categories.map((c) => legend(c.id, c.label, c.tokens, 'tokens ')),
        legend('free', 'Free space', b.freeTokens, ''),
        ...(b.autoCompactBufferTokens > 0 ? [legend('buffer', 'Autocompact buffer', b.autoCompactBufferTokens, 'tokens ')] : []),
    ];
    const notes = b.notes.map((n) => `<div class="ms-ctx-note">${escapeHtml(n)}</div>`).join('');
    return `<div class="ms-ctx">
<div class="ms-ctx-grid" aria-hidden="true">${gridCells(b).map((k) => `<i class="ms-cell ms-c-${k}"></i>`).join('')}</div>
<div class="ms-ctx-legend"><div class="ms-ctx-title">Estimated usage by category</div>${items.join('')}${notes}</div>
</div>`;
}

export function setModelWorkingStatus(working: boolean, label?: string): void {
    const nextWorking = Boolean(working);
    const nextLabel = working ? (label || 'Working…') : undefined;
    if (currentWorking === nextWorking && currentWorkingLabel === nextLabel && lastStatus) {
        return;
    }
    currentWorking = nextWorking;
    currentWorkingLabel = nextLabel;
    if (lastStatus) {
        renderHeader(lastStatus);
    } else if (working) {
        root.dataset.activity = 'streaming';
        workingEl.hidden = false;
        workingTextEl.textContent = nextLabel || 'Working…';
    } else {
        root.dataset.activity = 'idle';
        workingEl.hidden = true;
        workingTextEl.textContent = '';
    }
}

export function applyModelStatus(s: ModelStatusInfo): void {
    lastStatus = s;
    requestBreakdownIfStale();
    renderHeader(s);
}

function renderHeader(s: ModelStatusInfo): void {
    root.hidden = false;
    // The header's working phase comes from the selected tab's stateSync/agent events.
    // ModelStatusInfo.activity can arrive later and must not revive the previous tab's phase.
    root.dataset.activity = s.activity === 'retrying' ? 'retrying' : currentWorking ? 'streaming' : 'idle';
    const name = s.model ?? 'No model';
    const pct = s.context?.percent;
    const ctxPct = typeof pct === 'number' && !Number.isNaN(pct) ? Math.round(pct) : undefined;
    const ctxTone = ctxPct !== undefined && ctxPct >= s.contextWarnPercent ? ' ms-warn' : '';
    const workingText = currentWorking ? (currentWorkingLabel || 'Working…') : undefined;

    const brief = (key: string, value: string, cls = '') => `<span class="ms-item${cls}"><span class="ms-sk">${key}</span> ${value}</span>`;
    setHtml(
        sumEl,
        [
            `<span class="ms-model">${escapeHtml(name)}</span>`,
            ...(ctxPct !== undefined ? [brief('ctx', `${ctxPct}%`, ctxTone)] : []),
            ...s.limits.map((l) => brief(escapeHtml(l.text), `${Math.round(l.usedPercent)}%`, tone(l.usedPercent))),
            ...(s.activity === 'retrying' ? [`<span class="ms-item ms-warn">reconnecting${s.retryAttempt > 0 ? ` ${s.retryAttempt}` : ''}</span>`] : []),
        ].join(SEP),
    );

    if (workingText) {
        workingEl.hidden = false;
        workingTextEl.textContent = workingText;
    } else {
        workingEl.hidden = true;
        workingTextEl.textContent = '';
    }

    sumBtn.title = workingText
        ? `${workingText} — Show context and usage limits`
        : 'Show context and usage limits';
    const rows = [row('Model', [escapeHtml(name), ...(s.thinking ? [`thinking ${escapeHtml(s.thinking)}`] : [])].join(SEP))];
    const ctx = s.context;
    if (ctx && ctx.contextWindow > 0) {
        const used = ctx.tokens === null ? '—' : formatTokenCount(ctx.tokens);
        const value = `${meter(ctxPct ?? 0, ctxTone)}${ctxPct === undefined ? '' : `<span class="${ctxTone.trim()}">${ctxPct}%</span>${SEP}`}${used} / ${formatTokenCount(ctx.contextWindow)}`;
        if (s.contextBreakdown) {
            rows.push(
                `<div class="ms-row"><button type="button" class="ms-k ms-ctx-toggle" data-ctx-toggle aria-expanded="${ctxExpanded}" title="${ctxExpanded ? 'Hide' : 'Show'} usage by category"><span class="ms-ctx-car">▶</span>Context</button><span class="ms-v ms-ctx-toggle" data-ctx-toggle>${value}</span></div>`,
                ...(ctxExpanded ? [renderBreakdown()] : []),
            );
        } else {
            rows.push(row('Context', value));
        }
    }
    const t = s.tokens;
    if (t) {
        // One short row each, like the Bot view's usage, so nothing is cut off at the panel's edge.
        rows.push(
            row(
                'Session',
                [`in ${formatTokenCount(t.input)}`, `out ${formatTokenCount(t.output)}`, ...(t.cost > 0 ? [`$${t.cost.toFixed(4)}`] : [])].join(SEP),
            ),
        );
        if (t.cacheRead > 0 || t.cacheWrite > 0) {
            // Hit: share of all prompt tokens served from the cache (`input` is the uncached part); first, so it shows however narrow the panel.
            rows.push(
                row(
                    'Cache',
                    [
                        `hit ${Math.round((t.cacheRead / (t.input + t.cacheRead + t.cacheWrite)) * 100)}%`,
                        `read ${formatTokenCount(t.cacheRead)}`,
                        `write ${formatTokenCount(t.cacheWrite)}`,
                    ].join(SEP),
                ),
            );
        }
    }
    for (const acct of s.usage) {
        rows.push(`<div class="ms-group">${escapeHtml(acct.title)} usage</div>`);
        for (const w of acct.windows) {
            rows.push(
                row(
                    w.label,
                    `${meter(w.usedPercent)}<span class="${tone(w.usedPercent).trim()}">${Math.round(w.usedPercent)}%</span>${w.reset ? `${SEP}${escapeHtml(w.reset)}` : ''}`,
                ),
            );
        }
    }
    if (s.usageError) {
        rows.push(`<div class="ms-group ms-err">Usage fetch failed: ${escapeHtml(s.usageError)}</div>`);
    }
    setHtml(detailEl, rows.join(''));
}
