import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentLayout } from './agentBackend';

// js-yaml is bundled by esbuild
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml: { load(text: string): unknown } = require('js-yaml');

/**
 * Providers with credentials stored by `/login` (OAuth or API key), excluding keys that only
 * come from env vars or `models.yml`/`models.json` provider config.
 * - pi: top-level keys of `auth.json`.
 * - omp: enabled rows of `agent.db` → `auth_credentials`.
 *
 * `undefined` = store unreadable (missing file, or `node:sqlite` absent on older VS Code
 * runtimes); callers decide the fallback.
 */
export async function readLoggedInProviders(layout: AgentLayout): Promise<Set<string> | undefined> {
    if (layout.backend === 'pi') {
        try {
            const auth: Record<string, unknown> | null = JSON.parse(
                await fs.readFile(path.join(layout.agentDir, 'auth.json'), 'utf8'),
            );
            return auth ? new Set(Object.keys(auth)) : undefined;
        } catch {
            return undefined;
        }
    }
    try {
        // Dynamic: `node:sqlite` only exists on Node ≥22.5; VS Code ≤1.10x hosts ship Node 20.
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(path.join(layout.agentDir, 'agent.db'), { readOnly: true });
        try {
            const rows = db
                .prepare('SELECT DISTINCT provider FROM auth_credentials WHERE disabled_cause IS NULL')
                .all() as Array<{ provider: string }>;
            return new Set(rows.map((r) => r.provider));
        } finally {
            db.close();
        }
    } catch {
        return undefined;
    }
}

/**
 * Custom providers the user declared in `models.json` (pi) / `models.yml` (omp): entries with
 * their own `models` list. They have no `/login`, so the login store never names them.
 * Entries without `models` only re-point a built-in provider (baseUrl, placeholder key) and are
 * left out. Missing or unparsable file = none.
 */
export async function readCustomProviders(layout: AgentLayout): Promise<string[]> {
    const file = layout.backend === 'pi' ? 'models.json' : 'models.yml';
    let config: unknown;
    try {
        const text = await fs.readFile(path.join(layout.agentDir, file), 'utf8');
        config = layout.backend === 'pi' ? JSON.parse(text) : yaml.load(text);
    } catch {
        return [];
    }
    if (!config || typeof config !== 'object' || !('providers' in config)) {
        return [];
    }
    const providers = config.providers;
    if (!providers || typeof providers !== 'object') {
        return [];
    }
    return Object.entries(providers)
        .filter(([, p]: [string, unknown]) =>
            !!p && typeof p === 'object' && 'models' in p && Array.isArray(p.models) && p.models.length > 0)
        .map(([id]) => id);
}
