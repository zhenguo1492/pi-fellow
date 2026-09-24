import type { ContextUsageInfo, SessionTokenStats } from '../shared/protocol';

export function formatTokenCount(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(1)}k`;
    }
    return n.toLocaleString();
}

export function renderTokenStatsBar(
    contextUsage: ContextUsageInfo | undefined,
    sessionTokens: SessionTokenStats | undefined,
): string {
    const ctx = renderContextSection(contextUsage);
    const io = renderIoSection(sessionTokens);

    if (!ctx && !io) {
        return '';
    }

    return `
        <div class="token-stats-inner">
            ${ctx}
            ${io ? `<div class="token-stats-divider" aria-hidden="true"></div>${io}` : ''}
        </div>
    `;
}

function renderContextSection(cu: ContextUsageInfo | undefined): string {
    if (!cu || cu.contextWindow <= 0) {
        return '';
    }

    const windowK = formatTokenCount(cu.contextWindow);
    const tokensKnown = cu.tokens !== null && cu.tokens >= 0;
    const tokensK = tokensKnown ? formatTokenCount(cu.tokens!) : '—';
    const pct = cu.percent !== null ? Math.min(100, Math.max(0, Math.round(cu.percent))) : null;
    const fillPct = pct ?? 0;
    const warn = pct !== null && pct >= 80;
    const pctLabel = pct !== null ? `${pct}%` : '—';

    return `
        <div class="token-stats-group token-stats-context" title="Estimated tokens in the current context window">
            <span class="token-stats-label">Context</span>
            <div class="token-stats-meter ${warn ? 'warn' : ''}">
                <div class="token-stats-meter-fill" style="width:${fillPct}%"></div>
            </div>
            <span class="token-stats-values">${tokensK} / ${windowK}</span>
            <span class="token-stats-pct">${pctLabel}</span>
        </div>
    `;
}

function renderIoSection(st: SessionTokenStats | undefined): string {
    if (!st) {
        return '';
    }

    const inK = formatTokenCount(st.input);
    const outK = formatTokenCount(st.output);
    const cache =
        st.cacheRead > 0 || st.cacheWrite > 0
            ? `<span class="token-stats-cache" title="Prompt cache read / write">↻ ${formatTokenCount(st.cacheRead)} · ✎ ${formatTokenCount(st.cacheWrite)}</span>`
            : '';
    const cost =
        st.cost > 0
            ? `<span class="token-stats-cost" title="Session cost (USD)">$${st.cost.toFixed(4)}</span>`
            : '';

    return `
        <div class="token-stats-group token-stats-io" title="Session totals across all completed turns">
            <span class="token-stats-io-item"><span class="token-io-label">In</span><span class="token-io-value">${inK}</span></span>
            <span class="token-stats-io-item"><span class="token-io-label">Out</span><span class="token-io-value">${outK}</span></span>
            ${cache}
            ${cost}
        </div>
    `;
}
