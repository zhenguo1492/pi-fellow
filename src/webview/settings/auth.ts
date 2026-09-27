import { escapeHtml } from '../../shared/html';
import type { AgentBackend, PiAgentConfigData, SettingsData } from '../../shared/protocol';
import { buildReadOnlyRow, buildSection, el } from './dom';
import { emptyPiConfig } from './piConfig';
import { buildTabPanel } from './tabs';

export function buildAuthTab(data: SettingsData): HTMLElement {
    const cfg = data.piConfig ?? emptyPiConfig();
    const isOmp = data.backend === 'omp';
    const defaultsTitle = isOmp ? `Defaults (${data.piAgentDir}/config.yml)` : 'Defaults (~/.pi/agent/settings.json)';
    return buildTabPanel('auth', [
        buildSection('Authentication', [
            buildReadOnlyRow('Agent directory', data.piAgentDir),
            buildAuthActionsRow(),
            buildFileButtons(data.backend),
            buildAuthIndicator(data.authMethod),
            buildAuthProvidersList(cfg, data.backend),
        ], 'auth'),
        buildSection(defaultsTitle, [
            buildPiModelDefaults(data, cfg),
            buildPiThinkingSelect(data.piDefaultThinkingLevel ?? (isOmp ? 'high' : 'off')),
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

function buildAuthActionsRow(): HTMLElement {
    const row = el('div', 'setting-row auth-actions');
    row.innerHTML = `
        <div class="setting-label-row"><label>Provider authentication</label></div>
        <div class="btn-row">
            <button type="button" class="setting-btn primary" id="btn-pi-login">Configure provider (/login)</button>
            <button type="button" class="setting-btn secondary" id="btn-pi-logout">Remove credentials (/logout)</button>
        </div>
        <p class="setting-description">Same flow as typing <code>/login</code> in chat. Saves API keys and OAuth tokens to <code>auth.json</code>. No Pi CLI required.</p>
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

function buildPiModelDefaults(data: SettingsData, cfg: PiAgentConfigData): HTMLElement {
    const providers = [...new Set(cfg.availableModels.map((m) => m.provider))].sort();
    const currentProvider = data.piDefaultProvider ?? '';
    const currentModel = data.piDefaultModel ?? '';

    const providerOpts = [
        { value: '', label: '(auto)' },
        ...providers.map((p) => ({ value: p, label: p })),
    ];

    const modelsForProvider = currentProvider
        ? cfg.availableModels.filter((m) => m.provider === currentProvider)
        : cfg.availableModels;

    const modelOpts = [
        { value: '', label: '(auto)' },
        ...modelsForProvider.map((m) => ({ value: m.id, label: m.name ? `${m.id} — ${m.name}` : m.id })),
    ];

    const row = el('div', 'setting-row pi-defaults');
    row.innerHTML = `
        <div class="setting-label-row"><label>Default provider / model</label></div>
        <div class="two-col">
            <select id="pi-default-provider" class="setting-select" data-pi-field="provider">
                ${providerOpts.map((o) =>
                    `<option value="${escapeHtml(o.value)}" ${o.value === currentProvider ? 'selected' : ''}>${escapeHtml(o.label)}</option>`,
                ).join('')}
            </select>
            <select id="pi-default-model" class="setting-select" data-pi-field="model">
                ${modelOpts.map((o) =>
                    `<option value="${escapeHtml(o.value)}" ${o.value === currentModel ? 'selected' : ''}>${escapeHtml(o.label)}</option>`,
                ).join('')}
            </select>
        </div>
        <button type="button" class="setting-btn primary" id="btn-save-pi-defaults">Save defaults</button>
        <p class="setting-description">Written to settings.json; active chat session picks this up on reload.</p>
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

function buildAuthIndicator(method: SettingsData['authMethod']): HTMLElement {
    const row = el('div', 'setting-row auth-indicator');
    const labels: Record<string, string> = {
        env: 'Authenticated via environment variable',
        'pi-login': 'Authenticated via ~/.pi/agent/auth.json',
        manual: 'Authenticated via stored API key',
        none: 'No credentials detected',
    };
    const icons: Record<string, string> = {
        env: '&#10003;',
        'pi-login': '&#10003;',
        manual: '&#10003;',
        none: '&#10007;',
    };
    const cls = method === 'none' ? 'auth-none' : 'auth-ok';
    row.innerHTML = `
        <div class="auth-status ${cls}">
            <span class="auth-icon">${icons[method]}</span>
            <span>${labels[method]}</span>
        </div>
    `;
    return row;
}
