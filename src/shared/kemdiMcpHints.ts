import type { McpServerSummary } from './protocol';

/** UX hints for kemdicode-mcp in Pi settings (directTools, drop --model). */
export function getKemdiMcpHints(server: McpServerSummary): string[] {
    if (!/kemdi/i.test(server.name)) {
        return [];
    }
    const hints: string[] = [];
    const preview = server.commandPreview ?? '';
    if (/--model\b|-m\b/.test(preview)) {
        hints.push(
            'Remove --model from mcp.json args — it overrides Pi and runs a separate LLM. Oh My Pi Chater can sync model into workspace .kemdicode-mcp.json (gitignored).',
        );
    }
    if (server.directTools !== true) {
        hints.push(
            'Set "directTools": true on kemdicode-mcp so the model sees tool names directly, not only the generic mcp proxy.',
        );
    }
    hints.push('After changing Pi model, reload the session to refresh Kemdi alignment.');
    return hints;
}
