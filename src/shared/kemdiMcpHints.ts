import type { AgentBackend } from './protocol';

/** Setup advice for kemdicode-mcp servers; empty for every other server. */
export function getKemdiMcpHints(
    server: { name: string; args: string[]; directTools?: unknown },
    backend: AgentBackend,
): string[] {
    if (!/kemdi/i.test(server.name)) {
        return [];
    }
    const hints: string[] = [];
    if (server.args.some((a) => a === '--model' || a === '-m' || a.startsWith('--model='))) {
        hints.push('Remove --model from the server args — it overrides the agent model and runs a separate LLM.');
    }
    // directTools is a pi-mcp-adapter setting; omp registers every MCP tool directly.
    if (backend === 'pi' && server.directTools !== true) {
        hints.push(
            'Set "directTools": true on kemdicode-mcp so the model sees tool names directly, not only the generic mcp proxy.',
        );
    }
    return hints;
}
