import { escapeHtml } from '../../shared/html';
import type { AgentBackend, PiAgentConfigData, SettingsData } from '../../shared/protocol';
import { buildReadOnlyRow, buildSection, el } from './dom';
import { shownThinkingLevel } from './edits';
import { emptyPiConfig } from './piConfig';
import { buildTabPanel } from './tabs';

export function buildAuthTab(data: SettingsData): HTMLElement {
    const cfg = data.piConfig ?? emptyPiConfig();
    const isOmp = data.backend === 'omp';
    const defaultsTitle = isOmp ? `Defaults (${data.piAgentDir}/config.yml)` : 'Defaults (~/.pi/agent/settings.json)';
    return buildTabPanel('auth', [
        buildSection('Authentication', [
            buildReadOnlyRow('Agent directory', data.piAgentDir),
            buildAuthActionsRow(data.backend),
            buildFileButtons(data.backend),
            buildAuthIndicator(data.authMethod, data.backend),
            buildAuthProvidersList(cfg, data.backend),
        ], 'auth'),
        buildSection(defaultsTitle, [
            buildPiModelDefaults(data, cfg),
            buildPiThinkingSelect(shownThinkingLevel(data)),
            buildPiModeSelect('steering', 'Steering mode', cfg.steeringMode),
            buildPiModeSelect('followup', 'Follow-up mode', cfg.followUpMode),
        ], 'defaults'),
    ]);
}

function buildFileButtons(backend: AgentBackend = 'pi'): HTMLElement {
    const row = el('div', 'setting-row file-buttons');
    const settingsFile = backend === 'omp' ? 'config.yml' : 'settings.json';
    const authFile = backend === 'omp' ? 'models.yml' : 'auth.json';
    row.innerHTML = `
        <div class="btn-row">
            <button type="button" class="setting-btn secondary" data-open-file="settings">Open ${settingsFile}</button>
            <button type="button" class="setting-btn secondary" data-open-file="auth">Open ${authFile}</button>
            <button type="button" class="setting-btn secondary" data-open-file="mcp">Open mcp.json</button>
        </div>
        <p class="setting-description">Edits in the editor are saved to disk; use Reload session after changing configuration.</p>
    `;
    return row;
}

function buildAuthActionsRow(backend: AgentBackend): HTMLElement {
    const row = el('div', 'setting-row auth-actions');
    const store = backend === 'omp' ? 'agent.db' : 'auth.json';
    row.innerHTML = `
        <div class="setting-label-row"><label>Provider authentication</label></div>
        <div class="btn-row">
            <button type="button" class="setting-btn primary" id="btn-pi-login">Configure provider (/login)</button>
            <button type="button" class="setting-btn secondary" id="btn-pi-logout">Remove credentials (/logout)</button>
        </div>
        <p class="setting-description">Runs <code>/login</code> or <code>/logout</code> in the chat's terminal view, the same flow as the ${backend} CLI. Credentials are stored in <code>${store}</code>.</p>
    `;
    return row;
}

function buildAuthProvidersList(cfg: PiAgentConfigData, backend: AgentBackend = 'pi'): HTMLElement {
    const row = el('div', 'setting-row');
    if (cfg.authProviders.length === 0) {
        const fileHint = backend === 'omp' ? 'models.yml or agent.db' : 'auth.json';
        row.innerHTML = `<p class="setting-description">No providers configured in ${fileHint} yet. Use <strong>Configure provider</strong> above or open ${backend === 'omp' ? 'models.yml' : 'auth.json'}.</p>`;
        return row;
    }
    const items = cfg.authProviders.map((p) =>
        `<span class="provider-chip ${p.configured ? 'configured' : 'empty'}">${escapeHtml(p.id)}</span>`,
    ).join('');
    row.innerHTML = `
        <div class="setting-label-row"><label>Configured providers</label></div>
        <div class="provider-chips">${items}</div>
        ${cfg.mcpFileExists ? '' : '<p class="setting-description">mcp.json not found (optional).</p>'}
    `;
    return row;
}

/** `<option>`s of the default model select: the models of `provider`, or every model while it is auto. */
export function modelOptionsHtml(models: PiAgentConfigData['availableModels'], provider: string, selected: string): string {
    const shown = provider ? models.filter((m) => m.provider === provider) : models;
    return [
        { value: '', label: '(auto)' },
        ...shown.map((m) => ({ value: m.id, label: m.name ? `${m.id} — ${m.name}` : m.id })),
    ].map((o) =>
        `<option value="${escapeHtml(o.value)}" ${o.value === selected ? 'selected' : ''}>${escapeHtml(o.label)}</option>`,
    ).join('');
}

function buildPiModelDefaults(data: SettingsData, cfg: PiAgentConfigData): HTMLElement {
    const providers = [...new Set(cfg.availableModels.map((m) => m.provider))].sort();
    const currentProvider = data.piDefaultProvider ?? '';
    const configFile = data.backend === 'omp' ? 'config.yml' : 'settings.json';

    const providerOpts = [
        { value: '', label: '(auto)' },
        ...providers.map((p) => ({ value: p, label: p })),
    ];

    const row = el('div', 'setting-row pi-defaults');
    row.innerHTML = `
        <div class="setting-label-row"><label>Default provider / model</label></div>
        <div class="two-col">
            <select id="pi-default-provider" class="setting-select">
                ${providerOpts.map((o) =>
                    `<option value="${escapeHtml(o.value)}" ${o.value === currentProvider ? 'selected' : ''}>${escapeHtml(o.label)}</option>`,
                ).join('')}
            </select>
            <select id="pi-default-model" class="setting-select">
                ${modelOptionsHtml(cfg.availableModels, currentProvider, data.piDefaultModel ?? '')}
            </select>
        </div>
        <p class="setting-description">Saved to ${configFile} for new sessions; on Save, the chat tab shown now switches to it too.</p>
    `;
    return row;
}

function buildPiThinkingSelect(value: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row"><label for="pi-thinking">Default thinking level</label></div>
        <select id="pi-thinking" class="setting-select">
            ${['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((v) =>
                `<option value="${v}" ${v === value ? 'selected' : ''}>${v}</option>`,
            ).join('')}
        </select>
    `;
    return row;
}

function buildPiModeSelect(
    kind: 'steering' | 'followup',
    label: string,
    value: 'all' | 'one-at-a-time',
): HTMLElement {
    const id = `pi-${kind}-mode`;
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row"><label for="${id}">${escapeHtml(label)}</label></div>
        <select id="${id}" class="setting-select" data-pi-mode="${kind}">
            <option value="all" ${value === 'all' ? 'selected' : ''}>all</option>
            <option value="one-at-a-time" ${value === 'one-at-a-time' ? 'selected' : ''}>one-at-a-time</option>
        </select>
    `;
    return row;
}

function buildAuthIndicator(method: SettingsData['authMethod'], backend: AgentBackend): HTMLElement {
    const row = el('div', 'setting-row auth-indicator');
    const labels: Record<SettingsData['authMethod'], string> = {
        login: `Signed in (${backend === 'omp' ? '~/.omp/agent/agent.db' : '~/.pi/agent/auth.json'})`,
        env: 'Authenticated via environment variable',
        none: 'No credentials detected',
    };
    const icon = method === 'none' ? '&#10007;' : '&#10003;';
    const cls = method === 'none' ? 'auth-none' : 'auth-ok';
    row.innerHTML = `
        <div class="auth-status ${cls}">
            <span class="auth-icon">${icon}</span>
            <span>${labels[method]}</span>
        </div>
    `;
    return row;
}
