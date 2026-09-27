import { escapeHtml } from '../../shared/html';
import { getKemdiMcpHints } from '../../shared/kemdiMcpHints';
import type { AgentBackend, McpServerSummary, McpSettingsSnapshot, PiAgentConfigData, SettingsData } from '../../shared/protocol';
import { vscode } from './api';
import { buildSection, el, showToast } from './dom';
import { emptyPiConfig } from './piConfig';
import { settingsState } from './state';
import { buildTabPanel } from './tabs';

export function buildMcpTab(data: SettingsData): HTMLElement {
    const cfg = data.piConfig ?? emptyPiConfig();
    return buildTabPanel('mcp', [buildMcpSection(data, cfg)]);
}

function buildMcpSection(data: SettingsData, cfg: PiAgentConfigData): HTMLElement {
    const snap = settingsState.mcpSnapshot ?? data.mcpSnapshot;
    const children: HTMLElement[] = [];

    children.push(buildMcpHelpBlock(snap, cfg, data.backend));

    if (!snap) {
        const loading = el('p', 'setting-description');
        loading.textContent = 'Loading MCP configuration…';
        children.push(loading);
        return buildSection('MCP servers', children, 'mcp');
    }

    if (!snap.hasMcpAdapter && data.backend !== 'omp') {
        children.push(buildMcpAdapterWarning());
    }

    const pathsRow = el('div', 'setting-row mcp-paths');
    const pathItems = snap.configPaths
        .map(
            (p) =>
                `<li><span class="mcp-path-label">${escapeHtml(p.label)}</span> ` +
                `<code class="mcp-path-code">${escapeHtml(p.path)}</code> ` +
                `<span class="mcp-path-badge ${p.exists ? 'exists' : 'missing'}">${p.exists ? 'exists' : 'missing'}</span></li>`,
        )
        .join('');
    pathsRow.innerHTML = `
        <div class="setting-label-row"><label>Config files</label></div>
        <ul class="mcp-path-list">${pathItems}</ul>
        ${snap.importSources.length ? `<p class="setting-description">Imports: ${escapeHtml(snap.importSources.map(formatMcpImportLabel).join(', '))}</p>` : ''}
    `;
    children.push(pathsRow);

    const actions = el('div', 'setting-row btn-row mcp-actions');
    actions.innerHTML = `
        <button type="button" class="setting-btn secondary" id="btn-test-all-mcp">Test all connections</button>
        <button type="button" class="setting-btn secondary" data-open-file="mcp">Edit mcp.json</button>
    `;
    children.push(actions);

    const list = el('div', 'mcp-server-list');
    list.id = 'mcp-server-list-root';
    if (snap.servers.length === 0) {
        list.innerHTML = '<p class="setting-description">No MCP servers configured.</p>';
    } else {
        for (const server of snap.servers) {
            list.appendChild(buildMcpServerCard(server));
        }
    }
    children.push(list);

    return buildSection('MCP servers', children, 'mcp');
}

function buildMcpHelpBlock(
    snap: McpSettingsSnapshot | null | undefined,
    cfg: PiAgentConfigData,
    backend: AgentBackend = 'pi',
): HTMLElement {
    const proxy = snap ? !snap.disableProxyTool : true;
    const direct = snap?.globalDirectTools;
    const isOmp = backend === 'omp';
    const row = el('div', 'setting-row mcp-help');
    const setupSteps = isOmp
        ? `<ol>
               <li><strong>Native MCP:</strong> Oh My Pi has native built-in MCP client support (no external adapter package required).</li>
               <li>Define servers in <code>mcp.json</code> or project <code>.mcp.json</code>.</li>
               <li>After changes, use <strong>Reload active session</strong>.</li>
           </ol>`
        : `<ol>
               <li>Install <code>npm:pi-mcp-adapter</code> in Packages (you have ${cfg.packages.some((p) => p.includes('pi-mcp-adapter')) ? 'it' : 'not yet'}).</li>
               <li>Define servers in <code>mcp.json</code> — not as separate npm packages per server.</li>
               <li>After changes, use <strong>Reload active session</strong>.</li>
           </ol>`;

    row.innerHTML = `
        <details class="mcp-help-details">
            <summary>How the model discovers and uses MCP (${isOmp ? 'omp native' : 'pi-mcp-adapter'})</summary>
            <div class="mcp-help-body">
                ${setupSteps}
                <p><strong>Default (proxy):</strong> The model gets one compact <code>mcp</code> tool (~200 tokens). It calls <code>mcp({ search: "…" })</code> to find tools, then <code>mcp({ tool: "…", args: … })</code>. Servers connect lazily on first use.</p>
                <p><strong>Direct tools:</strong> Set <code>"directTools": true</code> on a server (or globally in <code>mcp.json</code> settings). Tool names and schemas are injected into context — higher token cost, model sees them like built-in tools.</p>
                <p class="setting-description">Current: proxy ${proxy ? 'on' : 'off'}, global directTools ${direct ? 'on' : 'off or unset'}.</p>
            </div>
        </details>
    `;
    return row;
}

function buildMcpAdapterWarning(): HTMLElement {
    const row = el('div', 'setting-row pi-config-error');
    row.innerHTML =
        '<strong>pi-mcp-adapter missing.</strong> Add <code>npm:pi-mcp-adapter</code> under Packages, then reload the session. Without it, MCP servers in mcp.json are ignored.';
    return row;
}

export function buildMcpServerCard(server: McpServerSummary): HTMLElement {
    const card = el('div', `mcp-server-card status-${server.status}`);
    const statusClass = mcpStatusDotClass(server.status);
    const scopeLabel =
        server.scope === 'import'
            ? `import${server.importSource ? ` (${server.importSource})` : ''}`
            : server.scope;

    const toggleHtml = server.canToggle
        ? `<label class="mcp-toggle"><input type="checkbox" data-mcp-toggle="${escapeHtml(server.name)}" data-mcp-scope="${server.scope}" ${server.enabled ? 'checked' : ''} /> Enabled</label>`
        : `<span class="setting-description">Imported — edit source file to disable</span>`;

    const toolsId = `mcp-tools-${server.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const toolsHtml =
        server.toolCount > 0
            ? `<details class="mcp-tools-details"><summary>${server.toolCount} tools (from cache)</summary><ul class="mcp-tool-list" id="${toolsId}">${server.tools
                  .map(
                      (t) =>
                          `<li><span class="mcp-tool-name">${escapeHtml(t.name)}</span>` +
                          (t.description
                              ? `<span class="mcp-tool-desc">${escapeHtml(t.description.slice(0, 200))}${t.description.length > 200 ? '…' : ''}</span>`
                              : ''),
                  )
                  .join('')}</ul></details>`
            : '<span class="setting-description">No cached tools — use session or Test connection after first run</span>';

    const transport =
        server.transport === 'http'
            ? escapeHtml(server.url ?? 'HTTP')
            : escapeHtml(server.commandPreview ?? 'stdio');

    const kemdiHints = getKemdiMcpHints(server);
    const hintsHtml = kemdiHints.length
        ? `<ul class="mcp-kemdi-hints">${kemdiHints.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`
        : '';

    card.innerHTML = `
        <div class="mcp-server-header">
            <span class="mcp-status-dot ${statusClass}" title="${escapeHtml(server.statusMessage ?? server.status)}"></span>
            <span class="mcp-server-name">${escapeHtml(server.name)}</span>
            <span class="mcp-server-scope">${escapeHtml(scopeLabel)}</span>
            ${toggleHtml}
        </div>
        <p class="mcp-server-meta">${transport} · ${escapeHtml(server.statusMessage ?? server.status)}</p>
        ${hintsHtml}
        <div class="mcp-server-tools">${toolsHtml}</div>
        <button type="button" class="setting-btn secondary mcp-test-btn" data-mcp-test="${escapeHtml(server.name)}">Test connection</button>
    `;
    return card;
}

function mcpStatusDotClass(status: string): string {
    switch (status) {
        case 'connected':
            return 'dot-green';
        case 'cached':
            return 'dot-amber';
        case 'failed':
            return 'dot-red';
        case 'disabled':
            return 'dot-gray';
        default:
            return 'dot-muted';
    }
}

/** The server cards' controls; renderMcpSection rebuilds only the cards, so it binds only these again. */
export function bindMcpServerCards(): void {
    document.querySelectorAll('[data-mcp-test]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const name = (btn as HTMLButtonElement).dataset.mcpTest!;
            vscode.postMessage({ type: 'testMcpServer', serverName: name });
        });
    });

    document.querySelectorAll('[data-mcp-toggle]').forEach((input) => {
        input.addEventListener('change', (e) => {
            const el = e.target as HTMLInputElement;
            const serverName = el.dataset.mcpToggle!;
            const scope = el.dataset.mcpScope as McpServerSummary['scope'];
            if (scope === 'import') {
                showToast('Imported servers must be edited in the source MCP file', 'error');
                el.checked = !el.checked;
                return;
            }
            vscode.postMessage({
                type: 'setMcpServerEnabled',
                scope,
                serverName,
                enabled: el.checked,
            });
        });
    });
}

function formatMcpImportLabel(source: string): string {
    const labels: Record<string, string> = {
        cursor: 'editor-mcp',
        'claude-code': 'claude-mcp',
        windsurf: 'windsurf-mcp',
        codex: 'codex-mcp',
    };
    return labels[source] ?? source;
}
