import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentLayout } from './agentBackend';

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
