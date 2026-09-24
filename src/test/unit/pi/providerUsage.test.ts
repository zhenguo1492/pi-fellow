import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    parseClaudeUsage,
    fetchPiProviderUsage,
    parseCodexUsage,
    parseOmpUsage,
    ProviderUsageTracker,
    statusBarWindows,
    type ProviderAccountUsage,
} from '../../../pi/providerUsage';

const bar = (accounts: ProviderAccountUsage[], modelId: string) =>
    statusBarWindows(accounts, modelId).map((w) => `${w.text} ${Math.round(w.usedPercent)}%`);

describe('parseClaudeUsage', () => {
    const accounts = [
        {
            windows: parseClaudeUsage({
                five_hour: { utilization: 99, resets_at: '2026-09-24T01:50:00Z' },
                limits: [
                    { kind: 'session', group: 'session', percent: 11, resets_at: '2026-09-24T01:50:00Z' },
                    { kind: 'weekly_all', group: 'weekly', percent: 3, resets_at: '2026-09-30T11:00:00Z' },
                    { kind: 'weekly_scoped', group: 'weekly', percent: 40, scope: { model: { display_name: 'Fable' } } },
                ],
            }),
        },
    ];

    it('prefers limits[] over legacy buckets and keeps reset times', () => {
        expect(accounts[0].windows.map((w) => [w.label, w.usedPercent, w.resetsAt])).toEqual([
            ['Current session', 11, Date.parse('2026-09-24T01:50:00Z')],
            ['Current week (all models)', 3, Date.parse('2026-09-30T11:00:00Z')],
            ['Current week (Fable)', 40, undefined],
        ]);
    });

    it('shows the per-model weekly limit only for that model', () => {
        expect(bar(accounts, 'claude-opus-5-5')).toEqual(['5h 11%', '7d 3%']);
        expect(bar(accounts, 'claude-fable-5')).toEqual(['5h 11%', '7d 3%', 'Fable 7d 40%']);
    });

    it('falls back to legacy top-level buckets and skips null ones', () => {
        const legacy = [
            {
                windows: parseClaudeUsage({
                    five_hour: { utilization: 42.5, resets_at: null },
                    seven_day: null,
                    seven_day_opus: { utilization: 7 },
                }),
            },
        ];
        expect(bar(legacy, 'claude-opus-4-1')).toEqual(['5h 43%', 'Opus 7d 7%']);
        expect(bar(legacy, 'claude-sonnet-4-5')).toEqual(['5h 43%']);
    });
});

describe('parseCodexUsage', () => {
    it('reads primary/secondary windows with second-based reset_at', () => {
        const usage = parseCodexUsage(
            {
                plan_type: 'plus',
                rate_limit: {
                    primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1790223869 },
                    secondary_window: { used_percent: 48, limit_window_seconds: 604800, reset_after_seconds: 60 },
                },
            },
            1_000,
        )!;
        expect(usage.plan).toBe('plus');
        expect(usage.windows.map((w) => w.resetsAt)).toEqual([1790223869_000, 61_000]);
        expect(bar([usage], 'gpt-5.5')).toEqual(['5h 0%', '7d 48%']);
    });

    it('shows the Spark limit only for Spark models', () => {
        const usage = parseCodexUsage({
            rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
            additional_rate_limits: [
                {
                    limit_name: 'GPT-5.3-Codex-Spark',
                    rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 18000 } },
                },
            ],
        })!;
        expect(bar([usage], 'gpt-5.5')).toEqual(['5h 10%']);
        expect(bar([usage], 'gpt-5.3-codex-spark')).toEqual(['5h 10%', 'GPT-5.3-Codex-Spark 5h 90%']);
    });
});

describe('parseOmpUsage', () => {
    const limit = (id: string, label: string, scope: object, windowId: string, usedFraction: number) => ({
        id,
        label,
        scope,
        window: { id: windowId, resetsAt: 123 },
        amount: { usedFraction },
    });

    it('returns one account per report and ignores limits without an amount', () => {
        const accounts = parseOmpUsage({
            reports: [
                {
                    metadata: { email: 'a@example.com' },
                    limits: [
                        limit('anthropic:5h', 'Claude 5 Hour', { shared: true }, '5h', 0.11),
                        { label: 'No amount', window: { id: '7d' }, amount: { unit: 'percent' } },
                    ],
                },
                { limits: [] },
            ],
        });
        expect(accounts).toEqual([
            {
                account: 'a@example.com',
                windows: [expect.objectContaining({ label: 'Claude 5 Hour', span: '5h', resetsAt: 123 })],
            },
        ]);
    });

    it('scopes Anthropic tier limits to matching models', () => {
        const accounts = parseOmpUsage({
            reports: [
                {
                    limits: [
                        limit('anthropic:5h', 'Claude 5 Hour', { shared: true }, '5h', 0.11),
                        limit('anthropic:7d:fable', 'Claude 7 Day (Fable)', { tier: 'fable' }, '7d', 0.25),
                    ],
                },
            ],
        });
        expect(bar(accounts, 'claude-opus-5-5')).toEqual(['5h 11%']);
        expect(bar(accounts, 'claude-fable-5')).toEqual(['5h 11%', 'Fable 7d 25%']);
    });

    it('picks the Antigravity bucket of the model family and merges duplicated shared buckets', () => {
        const accounts = parseOmpUsage({
            reports: [
                {
                    limits: [
                        limit('google-antigravity:google:default:gemini-5h', 'Gemini', {}, '5h', 0.44),
                        limit('google-antigravity:google:default:gemini-weekly', 'Gemini', {}, 'weekly', 0.23),
                        limit('google-antigravity:anthropic:default:3p-5h', 'Claude & GPT (shared)', { shared: true }, '5h', 0.05),
                        limit('google-antigravity:openai:default:3p-5h', 'Claude & GPT (shared)', { shared: true }, '5h', 0.05),
                    ],
                },
            ],
        });
        expect(accounts[0].windows).toHaveLength(3);
        expect(bar(accounts, 'gemini-3-pro-high')).toEqual(['5h 44%', '7d 23%']);
        expect(bar(accounts, 'claude-sonnet-4-5')).toEqual(['5h 5%']);
        expect(bar(accounts, 'gpt-oss-120b-medium')).toEqual(['5h 5%']);
    });

    it('falls back to the first limit by label when none applies (Copilot plan tiers)', () => {
        const accounts = parseOmpUsage({
            reports: [
                {
                    limits: [
                        limit('copilot:premium', 'Premium Requests', { tier: 'individual' }, 'monthly', 0.3),
                        limit('copilot:chat', 'Chat Requests', { tier: 'individual' }, 'monthly', 0),
                    ],
                },
            ],
        });
        expect(bar(accounts, 'claude-sonnet-4.5')).toEqual(['Premium Requests 30%']);
    });
});

describe('ProviderUsageTracker', () => {
    it('drops a result that arrives after the target switched', async () => {
        const stale = Promise.withResolvers<ProviderAccountUsage[]>();
        const fresh = Promise.withResolvers<void>();
        const tracker = new ProviderUsageTracker(
            (target) =>
                target.provider === 'old'
                    ? stale.promise
                    : Promise.resolve([{ windows: [{ label: 'fresh', usedPercent: 1 }] }]),
            () => fresh.resolve(),
        );
        tracker.setTarget({ backend: 'pi', provider: 'old' });
        tracker.setTarget({ backend: 'pi', provider: 'new' });
        await fresh.promise;
        stale.resolve([{ windows: [{ label: 'stale', usedPercent: 99 }] }]);
        // The tracker subscribed to `stale` first, so its continuation has run once this await resumes.
        await stale.promise;
        expect(tracker.snapshot?.target.provider).toBe('new');
        expect(tracker.snapshot?.accounts[0].windows[0].label).toBe('fresh');
    });

    it('keeps the last good usage when a refresh fails', async () => {
        let fail = false;
        let changed = Promise.withResolvers<void>();
        const tracker = new ProviderUsageTracker(
            async () => {
                if (fail) throw new Error('HTTP 429');
                return [{ windows: [{ label: 'w', usedPercent: 5 }] }];
            },
            () => changed.resolve(),
            0,
        );
        tracker.setTarget({ backend: 'pi', provider: 'anthropic' });
        await changed.promise;
        fail = true;
        changed = Promise.withResolvers<void>();
        tracker.refresh();
        await changed.promise;
        expect(tracker.snapshot?.error).toBe('HTTP 429');
        expect(tracker.snapshot?.accounts[0].windows[0].usedPercent).toBe(5);
    });
});

describe('fetchPiProviderUsage', () => {
    it('shows the active Antigravity model pool from Pi OAuth quota', async () => {
        const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-usage-'));
        try {
            await fs.writeFile(path.join(agentDir, 'auth.json'), JSON.stringify({
                antigravity: {
                    type: 'oauth',
                    access: JSON.stringify({ token: 'test-token', projectId: 'test-project' }),
                    expires: 100_000,
                },
            }));
            let request: { url: string; init?: RequestInit } | undefined;
            const fetchQuota = (async (url: string | URL | Request, init?: RequestInit) => {
                request = { url: String(url), init };
                return new Response(JSON.stringify({
                    groups: [
                        {
                            displayName: 'Gemini Models',
                            buckets: [
                                { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.22, resetTime: '2026-09-24T15:00:00Z' },
                                { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.87 },
                            ],
                        },
                        {
                            displayName: 'Claude and GPT models',
                            buckets: [
                                { bucketId: '3p-5h', window: '5h', remainingFraction: 0.84 },
                            ],
                        },
                    ],
                }), { status: 200 });
            }) as typeof fetch;
            const accounts = await fetchPiProviderUsage(agentDir, 'antigravity', fetchQuota, 1_000);
            expect(request?.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
            expect(request?.init?.method).toBe('POST');
            expect(request?.init?.body).toBe(JSON.stringify({ project: 'test-project' }));
            expect(new Headers(request?.init?.headers).get('authorization')).toBe('Bearer test-token');
            expect(bar(accounts ?? [], 'gemini-3.8-flash')).toEqual(['5h 78%', '7d 13%']);
            expect(bar(accounts ?? [], 'claude-sonnet-4.5')).toEqual(['5h 16%']);
            expect(accounts?.[0].windows[0].resetsAt).toBe(Date.parse('2026-09-24T15:00:00Z'));
            expect(accounts?.[0].windows[0].label).toBe('Gemini Models 5h');
        } finally {
            await fs.rm(agentDir, { recursive: true, force: true });
        }
    });
});
