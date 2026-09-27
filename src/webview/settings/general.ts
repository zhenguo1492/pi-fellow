import { escapeHtml } from '../../shared/html';
import type { SettingsData } from '../../shared/protocol';
import { buildRange, buildReadOnlyRow, buildReloadRow, buildSection, buildSelect, buildTextInput, el } from './dom';
import { buildTabPanel } from './tabs';

export function buildGeneralTab(data: SettingsData): HTMLElement {
    const children: HTMLElement[] = [];
    if (data.piConfigLoadError) {
        children.push(buildPiConfigErrorBanner(data.piConfigLoadError));
    }
    const isOmp = data.backend === 'omp';
    const sectionTitle = isOmp ? 'Oh My Pi (omp) CLI (RPC backend)' : 'Pi CLI (RPC backend)';
    const modeDesc = isOmp
        ? 'Runs `omp --mode rpc` — standalone binary with built-in MCP, LSP, tools, and multi-ecosystem skills.'
        : 'Runs `pi --mode rpc` — same packages, skills, MCP, and slash commands as the terminal.';
    const configFile = isOmp ? `${data.piAgentDir}/config.yml` : `${data.piAgentDir}/settings.json`;

    children.push(
        buildSection(sectionTitle, [
            buildReadOnlyRow('Mode', modeDesc),
            buildReadOnlyRow('Agent directory', data.piAgentDir),
            buildReadOnlyRow('Config file', configFile),
            buildReadOnlyRow('Sessions', `${data.piAgentDir}/sessions/`),
            buildPiCliSyncInfo(data),
            buildReloadRow(),
        ], 'connection'),
        buildSection('Chat UI', [
            buildSelect('defaultPermissionLevel', 'Default permission mode', data.defaultPermissionLevel, [
                { value: 'ask', label: 'Manual — approve each edit and command' },
                { value: 'edit', label: 'Edit automatically — approve commands and deletions only' },
                { value: 'plan', label: 'Plan — read-only' },
                { value: 'auto', label: 'Auto — run every tool without asking' },
            ], 'Mode of new chat tabs until you pick one in the menu next to the model chip under the chat input; then new tabs start in the last mode picked and a reopened conversation keeps its own. It applies to the worker and the voice agent.'),
            buildTextInput('allowedTools', 'Tools allowed without asking', data.allowedTools.join(', '),
                'Manual and Edit automatically: comma-separated tool names that run without approval (e.g. bash). Plan still blocks them.', 'e.g. bash'),
            buildRange('contextUsageWarningThreshold', 'Context usage warning', data.contextUsageWarningThreshold, 0, 100,
                `Warn in the chat footer above ${data.contextUsageWarningThreshold}% context.`),
        ], 'chat-ui'),
        buildSection('Keyboard Shortcuts', [buildShortcutsInfo()]),
    );
    return buildTabPanel('general', children);
}

function buildPiConfigErrorBanner(message: string): HTMLElement {
    const row = el('div', 'setting-row pi-config-error');
    row.innerHTML = `<p class="setting-description"><strong>Pi config partial load:</strong> ${escapeHtml(message)}. Package list may still work from settings.json.</p>`;
    return row;
}

function buildPiCliSyncInfo(data: SettingsData): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `<p class="setting-description">
        Chat uses <code>pi --mode rpc</code>. Edit <code>${escapeHtml(data.piAgentDir)}</code> here or in the terminal — same files.
        Slash commands like <code>/mcp</code> and <code>/packages</code> jump to the matching tab above.
    </p>`;
    return row;
}

function buildShortcutsInfo(): HTMLElement {
    const row = el('div', 'setting-row shortcuts-info');
    row.innerHTML = `
        <div class="shortcuts-list">
            <div class="shortcut-item"><kbd>Ctrl+Shift+L</kbd><span>Focus chat</span></div>
            <div class="shortcut-item"><kbd>Ctrl+Shift+N</kbd><span>New session</span></div>
            <div class="shortcut-item"><kbd>Ctrl+Alt+M</kbd><span>Voice input</span></div>
            <div class="shortcut-item"><kbd>Escape</kbd><span>Stop generation</span></div>
        </div>
        <p class="setting-description">
            <a href="#" id="btn-open-keybindings">Open Keyboard Shortcuts editor</a>
        </p>
    `;
    return row;
}
