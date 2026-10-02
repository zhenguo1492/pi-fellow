import type { AgentBackend } from '../../shared/protocol';
import { vscode } from './api';
import { el } from './dom';
import { buildUnsavedDot, renderSaveBar } from './saveBar';
import { settingsState } from './state';
import { switchVoiceSubtab, voiceSubtabOf } from './voiceTabs';

export type SettingsTabId = 'general' | 'auth' | 'voice' | 'packages' | 'skills' | 'mcp' | 'commands';

const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'auth', label: 'Auth & models' },
    { id: 'voice', label: 'Voice' },
    { id: 'packages', label: 'Packages' },
    { id: 'skills', label: 'Skills' },
    { id: 'mcp', label: 'MCP' },
    { id: 'commands', label: 'Commands' },
];

/** Maps legacy section ids (from /mcp, scrollToSection) to a tab. */
const SECTION_TO_TAB: Record<string, SettingsTabId> = {
    connection: 'general',
    'chat-ui': 'general',
    voice: 'voice',
    stt: 'voice',
    'stt-server': 'voice',
    'voice-listening': 'voice',
    voiceprint: 'voice',
    tts: 'voice',
    'tts-server': 'voice',
    'voice-speaking': 'voice',
    'voice-agent': 'voice',
    'voice-sentences': 'voice',
    auth: 'auth',
    defaults: 'auth',
    packages: 'packages',
    extensions: 'packages',
    skills: 'skills',
    mcp: 'mcp',
    commands: 'commands',
};

export function scrollToSettingsSection(section: string): void {
    const tab = SECTION_TO_TAB[section];
    if (tab) {
        switchSettingsTab(tab, false);
    }
    requestAnimationFrame(() => {
        const found = document.getElementById(`section-${section}`);
        // On the Voice tab: the sub-tab that holds it.
        const subtab = tab === 'voice' ? voiceSubtabOf(found) : undefined;
        if (subtab) {
            switchVoiceSubtab(subtab, false);
        }
        // A section of a setup not shown (e.g. the server fields on Built-in): that service's engine choice instead.
        const target = found?.closest('[hidden]') && subtab ? document.getElementById(`section-${subtab}`) : found;
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            target.classList.add('section-highlight');
            setTimeout(() => target.classList.remove('section-highlight'), 2000);
        }
    });
}

export function switchSettingsTab(tabId: SettingsTabId, persist = true): void {
    settingsState.activeTab = tabId;
    if (persist) {
        vscode.setState({ ...(vscode.getState() ?? {}), activeTab: tabId });
    }
    document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
        const id = (btn as HTMLButtonElement).dataset.tab as SettingsTabId;
        btn.classList.toggle('active', id === tabId);
        btn.setAttribute('aria-selected', id === tabId ? 'true' : 'false');
    });
    document.querySelectorAll('.settings-tab-panel').forEach((panel) => {
        const id = (panel as HTMLElement).dataset.tabPanel as SettingsTabId;
        panel.classList.toggle('active', id === tabId);
    });
    renderSaveBar();
}

export function buildTabNav(backend: AgentBackend = 'pi'): HTMLElement {
    const nav = el('nav', 'settings-tabs');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Settings sections');
    for (const tab of SETTINGS_TABS) {
        const btn = el('button', 'settings-tab-btn') as HTMLButtonElement;
        btn.type = 'button';
        btn.dataset.tab = tab.id;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', tab.id === settingsState.activeTab ? 'true' : 'false');
        const label = el('span');
        label.textContent = tab.id === 'packages' && backend === 'omp' ? 'Plugins' : tab.label;
        btn.append(label, buildUnsavedDot());
        if (tab.id === settingsState.activeTab) {
            btn.classList.add('active');
        }
        btn.addEventListener('click', () => switchSettingsTab(tab.id));
        nav.appendChild(btn);
    }
    return nav;
}

export function buildTabPanel(tabId: SettingsTabId, children: HTMLElement[]): HTMLElement {
    const panel = el('div', 'settings-tab-panel');
    panel.dataset.tabPanel = tabId;
    if (tabId === settingsState.activeTab) {
        panel.classList.add('active');
    }
    for (const child of children) {
        panel.appendChild(child);
    }
    return panel;
}
