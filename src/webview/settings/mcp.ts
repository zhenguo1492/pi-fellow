import { escapeHtml } from '../../shared/html';
import type { McpClient, McpServerSummary, McpSettingsSnapshot, SettingsData } from '../../shared/protocol';
import { vscode } from './api';
import { buildSection, el, showToast } from './dom';
import { setEdit, withMcpEdits } from './edits';
import { settingsState } from './state';
import { buildTabPanel } from './tabs';

export function buildMcpTab(data: SettingsData): HTMLElement {
    return buildTabPanel('mcp', [buildMcpSection(data)]);
}

function buildMcpSection(data: SettingsData): HTMLElement {
    const saved = settingsState.mcpSnapshot ?? data.mcpSnapshot;
    const snap = saved && withMcpEdits(saved);
    const children: HTMLElement[] = [];

    // Until the snapshot arrives, only omp's client is known: pi's depends on its packages and version.
    const client = snap?.client ?? (data.backend === 'omp' ? 'omp' : undefined);
    if (client) {
        children.push(buildMcpHelpBlock(snap, client));
    }

    if (!snap) {
        const loading = el('p', 'setting-description');
        loading.textContent = 'Loading MCP configuration…';
        children.push(loading);
        return buildSection('MCP servers', children, 'mcp');
    }

    if (snap.clientMissing) {
        children.push(buildMcpClientWarning(snap.clientMissing));
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
    const precedence =
        snap.client === 'pi-adapter'
            ? 'Highest precedence first; pi-mcp-adapter merges a server’s fields across files, higher files winning.'
            : 'Highest precedence first; the first file that defines a server wins.';
    pathsRow.innerHTML = `
        <div class="setting-label-row"><label>Config files</label></div>
        <p class="setting-description">${precedence}</p>
        <ul class="mcp-path-list">${pathItems}</ul>
        ${snap.importSources.length ? `<p class="setting-description">Imports: ${escapeHtml(snap.importSources.join(', '))}</p>` : ''}
    `;
    children.push(pathsRow);

    const actions = el('div', 'setting-row btn-row mcp-actions');
    actions.innerHTML = `
        <button type="button" class="setting-btn secondary" id="btn-test-all-mcp">Check all servers</button>
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

const CLIENT_LABEL: Record<McpClient, string> = {
    omp: 'omp native',
    'pi-builtin': 'pi built-in',
    'pi-adapter': 'pi-mcp-adapter',
};

function buildMcpHelpBlock(snap: McpSettingsSnapshot | null | undefined, client: McpClient): HTMLElement {
    const row = el('div', 'setting-row mcp-help');
    let body: string;
    if (client === 'omp') {
        body = `<ol>
                   <li>Oh My Pi has a built-in MCP client; no adapter package is needed.</li>
                   <li>Define servers in project <code>.omp/mcp.json</code> or user <code>~/.omp/agent/mcp.json</code>; root <code>mcp.json</code> / <code>.mcp.json</code> are read as a portable fallback. omp also picks up Claude Code, Cursor, Codex, Gemini and VS Code MCP configs, which are not listed here — <code>/mcp list</code> in chat shows every source.</li>
                   <li>Disabling a server sets <code>"enabled": false</code> on its entry. <code>disabledServers</code> / <code>enabledServers</code> in the user mcp.json override any source.</li>
                   <li>After changes, use <strong>Reload active session</strong> (or <code>/mcp reload</code> in chat).</li>
               </ol>
               <p>Each connected server’s tools are registered directly, as <code>mcp__&lt;server&gt;_&lt;tool&gt;</code> tools.</p>`;
    } else if (client === 'pi-builtin') {
        body = `<ol>
                   <li>pi has a built-in MCP client (its <code>mcp</code> extension); no package is needed. Installing <code>npm:pi-mcp-adapter</code> replaces it.</li>
                   <li>Define servers in user <code>~/.pi/agent/mcp.json</code> or, for trusted projects, <code>.pi/mcp.json</code>; a project entry replaces a user entry of the same name.</li>
                   <li>Disabling a server sets <code>"enabled": false</code> on its entry.</li>
                   <li>After changes, use <strong>Reload active session</strong>; <code>/mcp</code> in chat shows live status, sign-ins and reconnects.</li>
               </ol>
               <p>Tools are named <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>. A server’s <code>"exposure"</code> decides how the model reaches them: <code>codemode</code> (default) from codemode scripts, <code>deferred</code> through <code>tool_search</code>, <code>direct</code> declared like built-in tools, <code>hidden</code> not at all.</p>`;
    } else {
        body = `<ol>
                   <li><code>npm:pi-mcp-adapter</code> (in Packages) is pi’s MCP client when installed; it replaces pi’s built-in one.</li>
                   <li>Define servers in one of the mcp.json files below — not as separate npm packages per server.</li>
                   <li>Disabling a server sets <code>"disabled": true</code> on its entry.</li>
                   <li>After changes, use <strong>Reload active session</strong>.</li>
               </ol>
               <p><strong>Default (proxy):</strong> The model gets one compact <code>mcp</code> tool (~200 tokens). It calls <code>mcp({ search: "…" })</code> to find tools, then <code>mcp({ tool: "…", args: … })</code>. Servers connect lazily on first use.</p>
               <p><strong>Direct tools:</strong> Set <code>"directTools": true</code> on a server (or globally in <code>mcp.json</code> settings). Tool names and schemas are injected into context — higher token cost, model sees them like built-in tools.</p>
               <p class="setting-description">Current: proxy ${snap?.disableProxyTool ? 'off' : 'on'}, global directTools ${snap?.globalDirectTools ? 'on' : 'off or unset'}.</p>`;
    }

    row.innerHTML = `
        <details class="mcp-help-details">
            <summary>How the model discovers and uses MCP (${CLIENT_LABEL[client]})</summary>
            <div class="mcp-help-body">${body}</div>
        </details>
    `;
    return row;
}

function buildMcpClientWarning(missing: NonNullable<McpSettingsSnapshot['clientMissing']>): HTMLElement {
    const row = el('div', 'setting-row pi-config-error');
    row.innerHTML =
        missing === 'builtin-disabled'
            ? '<strong>No MCP client.</strong> pi’s built-in <code>mcp</code> extension is turned off (<code>builtin:mcp</code> excluded in settings <code>extensions</code>) and <code>npm:pi-mcp-adapter</code> is not installed, so MCP servers in mcp.json are ignored. Turn the built-in one back on (<code>pi config</code> → Built-in extensions) or add the adapter under Packages, then reload the session.'
            : '<strong>No MCP client.</strong> This pi has no built-in MCP client and <code>npm:pi-mcp-adapter</code> is not installed, so MCP servers in mcp.json are ignored. Update pi or add the adapter under Packages, then reload the session.';
    return row;
}

export function buildMcpServerCard(server: McpServerSummary): HTMLElement {
    const card = el('div', `mcp-server-card status-${server.status}`);
    const statusClass = mcpStatusDotClass(server.status);

    const toggleHtml = server.canToggle
        ? `<label class="mcp-toggle"><input type="checkbox" data-mcp-toggle="${escapeHtml(server.name)}" data-mcp-scope="${server.scope}" ${server.enabled ? 'checked' : ''} /> Enabled</label>`
        : `<span class="setting-description">Imported — edit source file to disable</span>`;

    const toolsId = `mcp-tools-${server.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    let toolsHtml: string;
    if (server.toolCount > 0) {
        toolsHtml = `<details class="mcp-tools-details"><summary>${server.toolCount} tools (pi-mcp-adapter cache)</summary><ul class="mcp-tool-list" id="${toolsId}">${server.tools
            .map(
                (t) =>
                    `<li><span class="mcp-tool-name">${escapeHtml(t.name)}</span>` +
                    (t.description
                        ? `<span class="mcp-tool-desc">${escapeHtml(t.description.slice(0, 200))}${t.description.length > 200 ? '…' : ''}</span>`
                        : ''),
            )
            .join('')}</ul></details>`;
    } else if (server.cacheStatus === 'unavailable') {
        toolsHtml = '<span class="setting-description">omp keeps tool lists internally — <code>/mcp list</code> in chat shows them</span>';
    } else {
        toolsHtml = '<span class="setting-description">No cached tool list — pi-mcp-adapter caches it once the server connects in a session</span>';
    }

    const transport =
        server.transport === 'http'
            ? escapeHtml(server.url ?? 'HTTP')
            : escapeHtml(server.commandPreview ?? 'stdio');

    const hintsHtml = server.hints.length
        ? `<ul class="mcp-kemdi-hints">${server.hints.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`
        : '';

    card.innerHTML = `
        <div class="mcp-server-header">
            <span class="mcp-status-dot ${statusClass}" title="${escapeHtml(server.statusMessage ?? server.status)}"></span>
            <span class="mcp-server-name">${escapeHtml(server.name)}</span>
            <span class="mcp-server-scope" title="${escapeHtml(server.ownerPath)}">${escapeHtml(server.sourceLabel)}</span>
            ${toggleHtml}
        </div>
        <p class="mcp-server-meta">${transport} · ${escapeHtml(server.statusMessage ?? server.status)}</p>
        ${hintsHtml}
        <div class="mcp-server-tools">${toolsHtml}</div>
        <button type="button" class="setting-btn secondary mcp-test-btn" data-mcp-test="${escapeHtml(server.name)}" title="Finds the command on PATH or requests the URL; does not start the server or run the MCP handshake">Check reachability</button>
    `;
    return card;
}

function mcpStatusDotClass(status: string): string {
    switch (status) {
        case 'reachable':
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
            setEdit(`mcp:${serverName}`, { kind: 'mcpServer', scope, serverName, enabled: el.checked }, el);
        });
    });
}
