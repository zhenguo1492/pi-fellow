import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentBackend } from './agentBackend';

/**
 * Subscription rate-limit usage for the active model's provider (Claude `/usage`,
 * ChatGPT "Usage remaining"). Kept free of `vscode` imports so parsing stays unit-testable.
 */

export interface UsageWindow {
    /** Long label, e.g. `Current week (all models)`. */
    label: string;
    /** Window span for the status bar (`5h`, `7d`, `mo`). */
    span?: string;
    /** Model-specific qualifier shown before the span, e.g. `Fable` → `Fable 7d`. */
    tag?: string;
    /** Plan-wide limit: counts against every model of the provider. */
    shared?: boolean;
    /** Lower-case model-id substrings this limit is restricted to; takes precedence over `shared`. */
    appliesTo?: string[];
    /** 0–100. */
    usedPercent: number;
    /** Epoch ms. */
    resetsAt?: number;
}

export interface ProviderAccountUsage {
    /** Account identity (email) when the backend reports several accounts. */
    account?: string;
    /** Subscription plan, e.g. `plus`. */
    plan?: string;
    windows: UsageWindow[];
}

export interface UsageTarget {
    backend: AgentBackend;
    provider: string;
}

export interface ProviderUsageSnapshot {
    target: UsageTarget;
    /** Last successful fetch; empty = provider has no usage endpoint (e.g. API-key providers). */
    accounts: ProviderAccountUsage[];
    fetchedAt?: number;
    /** Last fetch failure; `accounts` keeps the previous successful result. */
    error?: string;
}

/** `null` = provider/credential has no subscription usage to report. */
export type UsageFetcher = (target: UsageTarget) => Promise<ProviderAccountUsage[] | null>;

/*
 * Wire shapes of third-party payloads. Every field is optional/nullable: the payload is
 * untrusted, so consumers reach nested objects with `?.` and verify leaves with `typeof`.
 */
interface ClaudeBucket {
    utilization?: number | null;
    resets_at?: string | null;
}
interface ClaudeLimit {
    kind?: string;
    group?: string;
    percent?: number | null;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null } | null } | null;
}
interface ClaudeUsagePayload {
    limits?: ClaudeLimit[] | null;
    five_hour?: ClaudeBucket | null;
    seven_day?: ClaudeBucket | null;
    seven_day_opus?: ClaudeBucket | null;
    seven_day_sonnet?: ClaudeBucket | null;
}
interface CodexWindow {
    used_percent?: number | null;
    limit_window_seconds?: number | null;
    reset_after_seconds?: number | null;
    reset_at?: number | null;
}
interface CodexRateLimit {
    primary_window?: CodexWindow | null;
    secondary_window?: CodexWindow | null;
}
interface CodexUsagePayload {
    plan_type?: string | null;
    rate_limit?: CodexRateLimit | null;
    additional_rate_limits?: Array<{
        limit_name?: string | null;
        metered_feature?: string | null;
        rate_limit?: CodexRateLimit | null;
    } | null> | null;
}
interface AntigravityQuotaPayload {
    groups?: Array<{
        displayName?: string;
        buckets?: Array<{
            bucketId?: string;
            displayName?: string;
            window?: string;
            remainingFraction?: number;
            resetTime?: string;
        } | null> | null;
    } | null> | null;
}
interface OmpUsagePayload {
    reports?: Array<{
        metadata?: { email?: string | null } | null;
        limits?: Array<{
            id?: string;
            label?: string;
            scope?: { shared?: boolean; tier?: string; modelId?: string } | null;
            window?: { id?: string; resetsAt?: number | null } | null;
            amount?: { usedFraction?: number | null; used?: number | null; limit?: number | null } | null;
        } | null> | null;
    } | null> | null;
}
interface PiOAuthCredential {
    type?: string;
    access?: string;
    expires?: number;
    accountId?: string;
}

function finite(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function isoMs(v: unknown): number | undefined {
    if (typeof v !== 'string') return undefined;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : undefined;
}

function clampPercent(p: number): number {
    return Math.min(100, Math.max(0, p));
}

/** `/api/oauth/usage` payload (Claude Pro/Max OAuth). */
export function parseClaudeUsage(raw: unknown): UsageWindow[] {
    const payload = raw as ClaudeUsagePayload | null | undefined;
    const windows: UsageWindow[] = [];
    // Current shape: `limits[]` carries session/weekly plus per-model weekly buckets.
    if (Array.isArray(payload?.limits)) {
        for (const l of payload.limits) {
            const pct = finite(l?.percent);
            if (!l || pct === undefined) continue;
            const usedPercent = clampPercent(pct);
            const resetsAt = isoMs(l.resets_at);
            const model = l.scope?.model?.display_name;
            const modelName = typeof model === 'string' && model ? model : undefined;
            const kind = typeof l.kind === 'string' ? l.kind : 'limit';
            if (kind === 'session') {
                windows.push({ label: 'Current session', span: '5h', shared: true, usedPercent, resetsAt });
            } else if (kind === 'weekly_all') {
                windows.push({ label: 'Current week (all models)', span: '7d', shared: true, usedPercent, resetsAt });
            } else if (l.group === 'weekly' && modelName) {
                windows.push({
                    label: `Current week (${modelName})`,
                    span: '7d',
                    tag: modelName,
                    appliesTo: [modelName.toLowerCase()],
                    usedPercent,
                    resetsAt,
                });
            } else {
                windows.push({ label: modelName ? `${kind} (${modelName})` : kind, usedPercent, resetsAt });
            }
        }
        if (windows.length > 0) return windows;
    }
    // Legacy shape: fixed top-level buckets with `utilization` (0–100).
    const legacy: Array<[bucket: ClaudeBucket | null | undefined, shape: Omit<UsageWindow, 'usedPercent'>]> = [
        [payload?.five_hour, { label: 'Current session', span: '5h', shared: true }],
        [payload?.seven_day, { label: 'Current week (all models)', span: '7d', shared: true }],
        [payload?.seven_day_opus, { label: 'Current week (Opus)', span: '7d', tag: 'Opus', appliesTo: ['opus'] }],
        [payload?.seven_day_sonnet, { label: 'Current week (Sonnet)', span: '7d', tag: 'Sonnet', appliesTo: ['sonnet'] }],
    ];
    for (const [bucket, shape] of legacy) {
        const pct = finite(bucket?.utilization);
        if (pct === undefined) continue;
        windows.push({ ...shape, usedPercent: clampPercent(pct), resetsAt: isoMs(bucket?.resets_at) });
    }
    return windows;
}

/** A primary/secondary window; `extra` = a model-specific additional limit (e.g. Codex Spark). */
function codexWindow(
    w: CodexWindow | null | undefined,
    nowMs: number,
    extra?: { name: string; slug: string },
): UsageWindow | undefined {
    const pct = finite(w?.used_percent);
    if (pct === undefined) return undefined;
    const seconds = finite(w?.limit_window_seconds);
    const span =
        seconds === undefined || seconds <= 0
            ? undefined
            : seconds >= 86_400
              ? `${Math.round(seconds / 86_400)}d`
              : `${Math.max(1, Math.round(seconds / 3600))}h`;
    const window = span === undefined ? 'Limit' : span === '7d' ? 'Weekly' : `${span} window`;
    const resetAt = finite(w?.reset_at);
    const resetAfter = finite(w?.reset_after_seconds);
    const resetsAt =
        resetAt !== undefined
            ? resetAt > 1e12
                ? resetAt
                : resetAt * 1000
            : resetAfter !== undefined
              ? nowMs + resetAfter * 1000
              : undefined;
    return {
        label: extra ? `${extra.name} ${window}` : window,
        span,
        ...(extra ? { tag: extra.name, appliesTo: [extra.slug] } : { shared: true }),
        usedPercent: clampPercent(pct),
        resetsAt,
    };
}

/** `chatgpt.com/backend-api/wham/usage` payload (ChatGPT plan via openai-codex OAuth). */
export function parseCodexUsage(raw: unknown, nowMs = Date.now()): ProviderAccountUsage | null {
    const payload = raw as CodexUsagePayload | null | undefined;
    const windows: UsageWindow[] = [];
    for (const w of [payload?.rate_limit?.primary_window, payload?.rate_limit?.secondary_window]) {
        const parsed = codexWindow(w, nowMs);
        if (parsed) windows.push(parsed);
    }
    if (Array.isArray(payload?.additional_rate_limits)) {
        for (const extra of payload.additional_rate_limits) {
            const name = String(extra?.limit_name || extra?.metered_feature || 'extra');
            // Same slugging as omp: Spark limits are reported under internal feature names.
            const lower = `${name} ${extra?.metered_feature ?? ''}`.toLowerCase();
            const slug = lower.includes('spark') || lower.includes('bengalfox') ? 'spark' : name.toLowerCase();
            for (const w of [extra?.rate_limit?.primary_window, extra?.rate_limit?.secondary_window]) {
                const parsed = codexWindow(w, nowMs, { name, slug });
                if (parsed) windows.push(parsed);
            }
        }
    }
    if (windows.length === 0) return null;
    const plan = payload?.plan_type;
    return { plan: typeof plan === 'string' && plan ? plan : undefined, windows };
}

/** Pi's Antigravity plugin reports remaining quota by Gemini vs Claude/GPT pool. */
export function parseAntigravityQuota(raw: unknown): ProviderAccountUsage | null {
    const payload = raw as AntigravityQuotaPayload | null | undefined;
    if (!Array.isArray(payload?.groups)) return null;
    const windows: UsageWindow[] = [];
    for (const group of payload.groups) {
        if (!Array.isArray(group?.buckets)) continue;
        const appliesTo = group.buckets.some((b) => typeof b?.bucketId === 'string' && b.bucketId.toLowerCase().includes('gemini'))
            ? ['gemini']
            : ['claude', 'gpt'];
        for (const bucket of group.buckets) {
            const remaining = finite(bucket?.remainingFraction);
            if (remaining === undefined) continue;
            const span = bucket?.window === 'weekly' ? '7d' : bucket?.window;
            windows.push({
                label: `${group.displayName || 'Antigravity'} ${span || bucket?.displayName || 'quota'}`,
                span,
                appliesTo,
                usedPercent: clampPercent((1 - remaining) * 100),
                resetsAt: isoMs(bucket?.resetTime),
            });
        }
    }
    return windows.length ? { windows } : null;
}

/** Antigravity buckets are per model family: `google-antigravity:<family>:<tier>:<bucket>`. */
const ANTIGRAVITY_FAMILY_MODELS: Record<string, string[]> = {
    google: ['gemini'],
    anthropic: ['claude'],
    openai: ['gpt'],
};

/** `omp usage --json` output: one report per authenticated account. */
export function parseOmpUsage(raw: unknown): ProviderAccountUsage[] {
    const payload = raw as OmpUsagePayload | null | undefined;
    if (!Array.isArray(payload?.reports)) return [];
    const accounts: ProviderAccountUsage[] = [];
    for (const report of payload.reports) {
        if (!Array.isArray(report?.limits)) continue;
        // omp repeats one bucket per model family (Antigravity "Claude & GPT (shared)"): merge them.
        const byKey = new Map<string, UsageWindow>();
        for (const limit of report.limits) {
            const amount = limit?.amount;
            const fraction = finite(amount?.usedFraction);
            const used = finite(amount?.used);
            const cap = finite(amount?.limit);
            const pct =
                fraction !== undefined
                    ? fraction * 100
                    : used !== undefined && cap !== undefined && cap > 0
                      ? (used / cap) * 100
                      : undefined;
            if (!limit || pct === undefined) continue;
            const windowId = typeof limit.window?.id === 'string' ? limit.window.id : undefined;
            const span = windowId === 'weekly' ? '7d' : windowId === 'monthly' ? 'mo' : windowId;
            const tier = typeof limit.scope?.tier === 'string' && limit.scope.tier ? limit.scope.tier : undefined;
            const modelId = typeof limit.scope?.modelId === 'string' && limit.scope.modelId ? limit.scope.modelId : undefined;
            const family = typeof limit.id === 'string' ? /^google-antigravity:([a-z]+):/.exec(limit.id)?.[1] : undefined;
            // Tier (fable, spark) is the model-id fragment omp itself matches on; modelId is a fallback.
            const appliesTo = family
                ? ANTIGRAVITY_FAMILY_MODELS[family]
                : tier
                  ? [tier.toLowerCase()]
                  : modelId
                    ? [modelId.toLowerCase()]
                    : undefined;
            const window: UsageWindow = {
                label: typeof limit.label === 'string' && limit.label ? limit.label : (windowId ?? 'Limit'),
                span,
                // Family buckets are already labelled by family; tiers (Fable, Spark) need a tag.
                tag: !family && tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : undefined,
                shared: limit.scope?.shared === true,
                appliesTo,
                usedPercent: clampPercent(pct),
                resetsAt: finite(limit.window?.resetsAt),
            };
            const key = `${window.label}|${span}|${window.usedPercent}|${window.resetsAt}`;
            const prev = byKey.get(key);
            if (!prev) {
                byKey.set(key, window);
            } else if (prev.appliesTo && appliesTo) {
                prev.appliesTo = [...new Set([...prev.appliesTo, ...appliesTo])];
            } else {
                prev.appliesTo = undefined;
            }
        }
        if (byKey.size === 0) continue;
        const email = report.metadata?.email;
        accounts.push({ account: typeof email === 'string' && email ? email : undefined, windows: [...byKey.values()] });
    }
    return accounts;
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const ANTIGRAVITY_QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const FETCH_TIMEOUT_MS = 10_000;

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
    const res = await fetchImpl(url, {
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    }
    return res.json();
}

/**
 * pi has no usage command: read its OAuth token from `auth.json` and query the provider directly.
 * Never refreshes — pi owns token rotation, and refreshing here would invalidate its refresh token.
 */
export async function fetchPiProviderUsage(
    agentDir: string,
    provider: string,
    fetchImpl: typeof fetch = fetch,
    nowMs = Date.now(),
): Promise<ProviderAccountUsage[] | null> {
    if (provider !== 'anthropic' && provider !== 'openai-codex' && provider !== 'antigravity') return null;
    let auth: Record<string, PiOAuthCredential | undefined> | null;
    try {
        auth = JSON.parse(await fs.readFile(path.join(agentDir, 'auth.json'), 'utf8'));
    } catch {
        return null;
    }
    const cred = auth?.[provider];
    if (cred?.type !== 'oauth' || typeof cred.access !== 'string' || !cred.access) {
        return null;
    }
    const expires = finite(cred.expires);
    if (expires !== undefined && expires <= nowMs) {
        throw new Error('OAuth token expired; pi refreshes it on the next request');
    }
    if (provider === 'antigravity') {
        // The plugin stores JSON { token, projectId } in `access`; older credentials may be a bare token.
        let token = cred.access;
        let projectId = 'aicode-consumers';
        try {
            const stored = JSON.parse(cred.access);
            if (typeof stored?.token !== 'string' || !stored.token) return null;
            token = stored.token;
            if (typeof stored.projectId === 'string' && stored.projectId) projectId = stored.projectId;
        } catch {
            // Bare OAuth token.
        }
        const res = await fetchImpl(ANTIGRAVITY_QUOTA_URL, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'user-agent': 'antigravity/cli/1.2.9 (aidev_client; auth_method=consumer)',
            },
            body: JSON.stringify({ project: projectId }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(ANTIGRAVITY_QUOTA_URL).host}`);
        const quota = parseAntigravityQuota(await res.json());
        return quota ? [quota] : null;
    }
    if (provider === 'anthropic') {
        const payload = await getJson(fetchImpl, CLAUDE_USAGE_URL, {
            authorization: `Bearer ${cred.access}`,
            'anthropic-beta': 'oauth-2025-04-20',
        });
        const windows = parseClaudeUsage(payload);
        return windows.length > 0 ? [{ windows }] : null;
    }
    const headers: Record<string, string> = { authorization: `Bearer ${cred.access}` };
    if (typeof cred.accountId === 'string' && cred.accountId) {
        headers['chatgpt-account-id'] = cred.accountId;
    }
    const usage = parseCodexUsage(await getJson(fetchImpl, CODEX_USAGE_URL, headers), nowMs);
    return usage ? [usage] : null;
}

function sameTarget(a: UsageTarget | undefined, b: UsageTarget | undefined): boolean {
    return a?.backend === b?.backend && a?.provider === b?.provider;
}

/**
 * Tracks usage for one target at a time. `refresh()` is throttled; a target switch drops the
 * previous snapshot and fetches immediately. Results for a superseded target are discarded.
 */
export class ProviderUsageTracker {
    private _target: UsageTarget | undefined;
    private _snapshot: ProviderUsageSnapshot | undefined;
    private _inflight = false;
    private _lastAttempt = 0;
    /** Target returned `null`: skip throttled refreshes until the target changes. */
    private _unsupported = false;

    constructor(
        private readonly _fetch: UsageFetcher,
        private readonly _onChange: () => void,
        private readonly _minIntervalMs = 30_000,
        private readonly _now: () => number = Date.now,
    ) {}

    get snapshot(): ProviderUsageSnapshot | undefined {
        return this._snapshot;
    }

    /** Point at the active model's provider; no-op when unchanged. */
    setTarget(target: UsageTarget | undefined): void {
        if (sameTarget(target, this._target)) return;
        this._target = target ? { ...target } : undefined;
        this._snapshot = undefined;
        this._unsupported = false;
        this._lastAttempt = 0;
        if (target) void this._run();
    }

    refresh(force = false): void {
        if (!this._target || this._inflight) return;
        if (!force && (this._unsupported || this._now() - this._lastAttempt < this._minIntervalMs)) return;
        void this._run();
    }

    private async _run(): Promise<void> {
        const target = this._target;
        if (!target) return;
        this._inflight = true;
        this._lastAttempt = this._now();
        try {
            const accounts = await this._fetch(target);
            if (!sameTarget(target, this._target)) return;
            this._unsupported = accounts === null;
            this._snapshot = { target, accounts: accounts ?? [], fetchedAt: this._now() };
        } catch (err: unknown) {
            if (!sameTarget(target, this._target)) return;
            this._snapshot = {
                target,
                accounts: this._snapshot?.accounts ?? [],
                fetchedAt: this._snapshot?.fetchedAt,
                error: err instanceof Error ? err.message : String(err),
            };
        } finally {
            if (sameTarget(target, this._target)) this._inflight = false;
        }
        this._onChange();
    }
}

export interface StatusBarLimit {
    text: string;
    usedPercent: number;
}

/** Span length in hours for ordering (`5h` < `7d` < `mo`); unknown spans sort last. */
const SPAN_HOURS: Record<string, number> = { h: 1, d: 24, mo: 720 };
function spanHours(span: string): number {
    const m = /^(\d*)(h|d|mo)$/.exec(span);
    return m ? (Number(m[1]) || 1) * SPAN_HOURS[m[2]] : Number.MAX_SAFE_INTEGER;
}

/**
 * Limits that gate `modelId` (first account), shortest window first: plan-wide windows plus
 * buckets restricted to this model (Claude Fable weekly, Antigravity Gemini vs Claude/GPT).
 * Nothing applicable (e.g. Copilot's per-plan request quotas) → the most-used window by label.
 */
export function statusBarWindows(accounts: readonly ProviderAccountUsage[], modelId: string): StatusBarLimit[] {
    const windows = accounts[0]?.windows ?? [];
    const id = modelId.toLowerCase();
    const applicable = windows.filter(
        (w): w is UsageWindow & { span: string } =>
            !!w.span && (w.appliesTo ? w.appliesTo.some((t) => id.includes(t)) : !!w.shared),
    );
    if (applicable.length > 0) {
        return applicable
            .sort((a, b) => spanHours(a.span) - spanHours(b.span))
            .map((w) => ({ text: w.tag ? `${w.tag} ${w.span}` : w.span, usedPercent: w.usedPercent }));
    }
    const tightest = windows.reduce<UsageWindow | undefined>(
        (best, w) => (best && best.usedPercent >= w.usedPercent ? best : w),
        undefined,
    );
    return tightest ? [{ text: tightest.label, usedPercent: tightest.usedPercent }] : [];
}

function formatReset(resetsAt: number, nowMs: number): string {
    const d = new Date(resetsAt);
    const sameDay = new Date(nowMs).toDateString() === d.toDateString();
    const abs = sameDay
        ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const mins = Math.max(0, Math.round((resetsAt - nowMs) / 60_000));
    const rel = mins >= 1440 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `resets ${abs} (in ${rel})`;
}

export interface UsageAccountDetail {
    /** `provider · plan`, plus the account when several are logged in. */
    title: string;
    windows: Array<{ label: string; usedPercent: number; reset?: string }>;
}

/** Every window per account, mirroring Claude `/usage`, for the chat's model status details. */
export function usageDetails(snapshot: ProviderUsageSnapshot, nowMs = Date.now()): UsageAccountDetail[] {
    const multi = snapshot.accounts.length > 1;
    return snapshot.accounts.map((acct) => ({
        title: [snapshot.target.provider, acct.plan, multi ? acct.account : undefined].filter(Boolean).join(' · '),
        windows: acct.windows.map((w) => ({
            label: w.label,
            usedPercent: w.usedPercent,
            reset: w.resetsAt === undefined ? undefined : formatReset(w.resetsAt, nowMs),
        })),
    }));
}
