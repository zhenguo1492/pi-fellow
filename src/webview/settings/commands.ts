import { escapeHtml } from '../../shared/html';
import type { PiAgentConfigData, SettingsData } from '../../shared/protocol';
import { buildReloadRow, buildSection, el } from './dom';
import { emptyPiConfig } from './piConfig';
import { buildTabPanel } from './tabs';

export function buildCommandsTab(data: SettingsData): HTMLElement {
    const cfg = data.piConfig ?? emptyPiConfig();
    return buildTabPanel('commands', [
        buildSection('Slash commands', [
            buildCommandsList(cfg),
            buildReloadRow(),
        ], 'commands'),
    ]);
}

function buildCommandsList(cfg: PiAgentConfigData): HTMLElement {
    const row = el('div', 'setting-row');
    if (cfg.commands.length === 0) {
        row.innerHTML = `<p class="setting-description">No extension commands loaded. Add packages or extension paths, then Reload session.</p>`;
        return row;
    }
    const max = 40;
    const shown = cfg.commands.slice(0, max);
    row.innerHTML = `
        <div class="commands-list">
            ${shown.map((c) => `
                <div class="command-item">
                    <span class="command-name">/${escapeHtml(c.invocationName)}</span>
                    ${c.description ? `<span class="command-desc">${escapeHtml(c.description)}</span>` : ''}
                    ${c.source ? `<span class="command-source">${escapeHtml(c.source)}</span>` : ''}
                </div>
            `).join('')}
        </div>
        ${cfg.commands.length > max ? `<p class="setting-description">Showing ${max} of ${cfg.commands.length} commands.</p>` : ''}
    `;
    return row;
}
