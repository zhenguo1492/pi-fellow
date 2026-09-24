import * as os from 'node:os';
import * as path from 'node:path';

/**
 * CLI family driving the RPC session.
 * - `pi`: Node script (`cli.js`), state under `~/.pi/agent`.
 * - `omp`: Oh My Pi standalone binary, state under `~/.omp/agent` (or a named profile).
 *
 * Kept free of `vscode` imports so session/catalog code stays unit-testable.
 */
export type AgentBackend = 'pi' | 'omp';

export interface AgentLayout {
    backend: AgentBackend;
    /** Agent state root (sessions/, settings, credentials). */
    agentDir: string;
}

/** Agent state dir, mirroring each CLI's own resolution order. */
export function resolveAgentDir(
    backend: AgentBackend,
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): string {
    if (backend === 'omp') {
        // omp: OMP_PROFILE (then PI_PROFILE) wins over PI_CODING_AGENT_DIR.
        const profile = (env.OMP_PROFILE ?? env.PI_PROFILE)?.trim();
        if (profile) {
            return path.join(home, '.omp', 'profiles', profile, 'agent');
        }
    }
    const override = env.PI_CODING_AGENT_DIR?.trim();
    if (override) {
        return override;
    }
    return path.join(home, backend === 'omp' ? '.omp' : '.pi', 'agent');
}
