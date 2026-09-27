/**
 * The model status line over the active tab's conversation, laid out like the Bot view's header:
 * one summary line (model · context · plan limits); clicking it floats the details (context and
 * session tokens, every usage window with its reset) over the transcript. Renders the host's
 * `ModelStatusInfo` (src/providers/model-status.ts).
 */
import type { ClientMessage, ModelStatusInfo } from '../shared/protocol';
import { formatTokenCount } from './tokenStatsBar';
import { vscode } from './vscodeApi';

/** Arrows swapping places: opens the model QuickPick. */
const SWITCH_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5.5h10M10 3l2.5 2.5L10 8"/><path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/></svg>';

const SEP = '<span class="ms-sep">·</span>';

function esc(text: string): string {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Limit tone: warning from 90%, error once exhausted (as the old status bar item's background). */
function tone(usedPercent: number): string {
    return usedPercent >= 100 ? ' ms-err' : usedPercent >= 90 ? ' ms-warn' : '';
}

function meter(percent: number): string {
    const pct = Math.max(0, Math.min(100, percent));
    return `<span class="ms-meter${tone(pct)}"><i style="width:${pct}%"></i></span>`;
}

function row(key: string, value: string): string {
    return `<div class="ms-row"><span class="ms-k">${esc(key)}</span><span class="ms-v">${value}</span></div>`;
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
}
sumBtn.addEventListener('click', () => setOpen(!root.classList.contains('open')));
root.querySelector('.ms-switch')!.addEventListener('click', () => {
    setOpen(false);
    vscode.postMessage({ type: 'selectModel' } satisfies ClientMessage);
});
root.addEventListener('mouseleave', () => setOpen(false));
document.addEventListener('click', (e) => {
    if (!root.contains(e.target as Node)) {
        setOpen(false);
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        setOpen(false);
    }
});

/** The line's node; `render()` in main.ts wipes #app on tab switches and re-inserts it. */
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
    const workingText = currentWorking ? (currentWorkingLabel || 'Working…') : undefined;

    const brief = (key: string, value: string, cls = '') => `<span class="ms-item${cls}"><span class="ms-sk">${key}</span> ${value}</span>`;
    setHtml(
        sumEl,
        [
            `<span class="ms-model">${esc(name)}</span>`,
            ...(ctxPct !== undefined ? [brief('ctx', `${ctxPct}%`)] : []),
            ...s.limits.map((l) => brief(esc(l.text), `${Math.round(l.usedPercent)}%`, tone(l.usedPercent))),
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
    const rows = [row('Model', [esc(name), ...(s.thinking ? [`thinking ${esc(s.thinking)}`] : [])].join(SEP))];
    const ctx = s.context;
    if (ctx && ctx.contextWindow > 0) {
        const used = ctx.tokens === null ? '—' : formatTokenCount(ctx.tokens);
        rows.push(
            row(
                'Context',
                `${meter(ctxPct ?? 0)}${ctxPct === undefined ? '' : `${ctxPct}%${SEP}`}${used} / ${formatTokenCount(ctx.contextWindow)}`,
            ),
        );
    }
    const t = s.tokens;
    if (t) {
        rows.push(
            row(
                'Session',
                [
                    `in ${formatTokenCount(t.input)}`,
                    `out ${formatTokenCount(t.output)}`,
                    ...(t.cacheRead > 0 || t.cacheWrite > 0 ? [`cache read ${formatTokenCount(t.cacheRead)}`, `write ${formatTokenCount(t.cacheWrite)}`] : []),
                    ...(t.cost > 0 ? [`$${t.cost.toFixed(4)}`] : []),
                ].join(SEP),
            ),
        );
    }
    for (const acct of s.usage) {
        rows.push(`<div class="ms-group">${esc(acct.title)} usage</div>`);
        for (const w of acct.windows) {
            rows.push(
                row(
                    w.label,
                    `${meter(w.usedPercent)}<span class="${tone(w.usedPercent).trim()}">${Math.round(w.usedPercent)}%</span>${w.reset ? `${SEP}${esc(w.reset)}` : ''}`,
                ),
            );
        }
    }
    if (s.usageError) {
        rows.push(`<div class="ms-group ms-err">Usage fetch failed: ${esc(s.usageError)}</div>`);
    }
    setHtml(detailEl, rows.join(''));
}
