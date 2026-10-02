import { escapeHtml } from '../../shared/html';
import type { SettingsData } from '../../shared/protocol';
import { buildAuthTab } from './auth';
import { buildCommandsTab } from './commands';
import { el } from './dom';
import { discardEdits, saveEdits, withMcpEdits } from './edits';
import { bindEvents } from './events';
import { buildGeneralTab } from './general';
import { bindMcpServerCards, buildMcpServerCard, buildMcpTab } from './mcp';
import { buildOmpPluginsTab, buildPackagesTab } from './packages';
import { bindSaveBar, buildSaveBar } from './saveBar';
import { buildSkillsTab, renderSkillsSection } from './skills';
import { settingsState } from './state';
import { buildTabNav, switchSettingsTab } from './tabs';
import { renderVoiceSkills } from './voice';
import { buildVoiceTab, discardVoiceChanges, restoreVoiceDrafts, saveVoice } from './voiceSetup';

function buildHeader(data: SettingsData): HTMLElement {
    const header = el('div', 'settings-header');
    const available = data.availableBackends;

    header.innerHTML = `
        <div class="settings-header-top">
            <div class="settings-title-group">
                <h1>Pi Fellow Settings</h1>
                <p class="settings-version">Extension v${escapeHtml(data.extensionVersion ?? '?')}</p>
            </div>
            <div class="backend-toggle-group">
                <span class="backend-toggle-label">Backend</span>
                <div class="backend-segmented-control" role="radiogroup" aria-label="Agent backend selection">
                    ${available.map((b) => `
                        <button type="button" class="backend-segment-btn${b === data.backend ? ' active' : ''}" data-backend="${b}" role="radio" aria-checked="${b === data.backend ? 'true' : 'false'}">
                            ${b}
                        </button>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
    return header;
}

/** Builds the whole page from the settings as shown (`currentSettings`: saved, with the unsaved edits). */
export function render(): void {
    const data = settingsState.currentSettings;
    if (!data) {
        return;
    }
    const app = document.getElementById('settings-app')!;
    // Settings echoed back rebuild the page; keep the field being typed in (value, caret, focus)
    // and the scroll position.
    const active = document.activeElement;
    const focused = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.id ? active : null;
    const typing = focused && {
        id: focused.id,
        value: focused.value,
        selectionStart: focused.selectionStart,
        selectionEnd: focused.selectionEnd,
    };
    const scrollY = window.scrollY;
    app.innerHTML = '';

    const container = el('div', 'settings-container');

    const header = buildHeader(data);
    container.appendChild(header);
    container.appendChild(buildTabNav(data.backend));

    const panels = el('div', 'settings-tab-panels');
    panels.appendChild(buildGeneralTab(data));
    panels.appendChild(buildAuthTab(data));
    panels.appendChild(buildVoiceTab(data));
    panels.appendChild(data.backend === 'omp' ? buildOmpPluginsTab(data) : buildPackagesTab(data));
    panels.appendChild(buildSkillsTab(data));
    panels.appendChild(buildMcpTab(data));
    panels.appendChild(buildCommandsTab(data));
    container.appendChild(panels);
    container.appendChild(buildSaveBar());

    app.appendChild(container);
    switchSettingsTab(settingsState.activeTab, false);
    bindEvents();
    bindSaveBar({
        save: () => {
            saveVoice();
            saveEdits();
        },
        discard: () => {
            discardEdits();
            discardVoiceChanges();
            render();
        },
    });
    restoreVoiceDrafts();
    renderSkillsSection();
    renderVoiceSkills();
    window.scrollTo(0, scrollY);
    const refocus = typing && document.getElementById(typing.id);
    if (typing && (refocus instanceof HTMLInputElement || refocus instanceof HTMLTextAreaElement)) {
        refocus.value = typing.value;
        refocus.focus();
        if (typing.selectionStart !== null && typing.selectionEnd !== null) {
            refocus.setSelectionRange(typing.selectionStart, typing.selectionEnd);
        }
    }
}

/** Rebuilds only the MCP server cards, or the whole page when their list is not there yet. */
export function renderMcpSection(): void {
    if (!settingsState.currentSettings?.syncWithPiCli) {
        return;
    }
    const cfg = settingsState.currentSettings.piConfig;
    if (!cfg) {
        return;
    }
    const list = document.getElementById('mcp-server-list-root');
    if (!list || !settingsState.mcpSnapshot) {
        render();
        return;
    }
    const snapshot = withMcpEdits(settingsState.mcpSnapshot);
    list.innerHTML = '';
    if (snapshot.servers.length === 0) {
        list.innerHTML = '<p class="setting-description">No MCP servers configured.</p>';
    } else {
        for (const server of snapshot.servers) {
            list.appendChild(buildMcpServerCard(server));
        }
    }
    bindMcpServerCards();
}
