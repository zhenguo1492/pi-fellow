import type { McpClient } from './protocol';

/** Setup advice for kemdicode-mcp servers; empty for every other server. */
export function getKemdiMcpHints(
    server: { name: string; args: string[]; directTools?: unknown; exposure?: unknown },
    client: McpClient,
): string[] {
    if (!/kemdi/i.test(server.name)) {
        return [];
    }
    const hints: string[] = [];
    if (server.args.some((a) => a === '--model' || a === '-m' || a.startsWith('--model='))) {
        hints.push('Remove --model from the server args — it overrides the agent model and runs a separate LLM.');
    }
    // omp registers every MCP tool directly; pi-mcp-adapter hides them behind its `mcp` proxy unless
    // directTools, pi's built-in client behind codemode unless `"exposure": "direct"`.
    if (client === 'pi-adapter' && server.directTools !== true) {
        hints.push(
            'Set "directTools": true on kemdicode-mcp so the model sees tool names directly, not only the generic mcp proxy.',
        );
    } else if (client === 'pi-builtin' && server.exposure !== 'direct') {
        hints.push(
            'Set "exposure": "direct" on kemdicode-mcp so the model sees its tools directly, not only through codemode scripts.',
        );
    }
    return hints;
}
