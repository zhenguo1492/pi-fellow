import type {
    SettingsClientMessage,
    SettingsServerMessage,
    SettingsData,
    SkillInfo,
    PiAgentConfigData,
    McpSettingsSnapshot,
    McpServerSummary,
    AgentBackend,
    VoiceSettings,
} from '../shared/protocol';
import type { TtsConfig } from '../voiceAgent/tts';
import { getKemdiMcpHints } from '../shared/kemdiMcpHints';
import { applySttDryRun, applyTtsDryRunResult, openSttDryRun, openTtsDryRun } from './voiceDryRun';

declare function acquireVsCodeApi(): {
    postMessage(message: SettingsClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();

type SettingsTabId = 'general' | 'auth' | 'voice' | 'packages' | 'skills' | 'mcp' | 'commands';

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
    tts: 'voice',
    auth: 'auth',
    defaults: 'auth',
    packages: 'packages',
    extensions: 'packages',
    skills: 'skills',
    mcp: 'mcp',
    commands: 'commands',
};

let currentSettings: SettingsData | null = null;
/** Voice tab fields typed but not saved yet, by element id: they survive re-renders until Test saves them. */
const voiceDrafts = new Map<string, string>();
/** A section's Test is saving and checking; its button waits. */
const voiceTesting: Record<VoiceService, boolean> = { stt: false, tts: false };
let loadedSkills: SkillInfo[] = [];
let mcpSnapshot: McpSettingsSnapshot | null = null;
let activeTab: SettingsTabId = (vscode.getState()?.activeTab as SettingsTabId) ?? 'general';
if ((activeTab as string) === 'stt' || (activeTab as string) === 'tts') {
    activeTab = 'voice';
}

window.addEventListener('message', (event) => {
    const msg = event.data as SettingsServerMessage;
    switch (msg.type) {
        case 'settings': {
            const previous = currentSettings;
            currentSettings = msg.data;
            if (msg.data.mcpSnapshot) {
                mcpSnapshot = msg.data.mcpSnapshot;
            }
            if (previous && withoutVoice(previous) === withoutVoice(msg.data)) {
                // Only the voice settings changed (e.g. a Test saved them): update in place, so the
                // fields keep their undo history (Ctrl+Z back to the previous URL).
                syncVoiceFields();
            } else if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
                // Keep the current draft when settings arrive during editing.
                renderVoiceStatus('stt');
                renderVoiceStatus('tts');
            } else {
                render(msg.data);
            }
            break;
        }
        case 'mcpSnapshot':
            mcpSnapshot = msg.snapshot;
            renderMcpSection();
            break;
        case 'settingChanged':
            if (currentSettings) {
                (currentSettings as any)[msg.key] = msg.value;
                render(currentSettings);
            }
            break;
        case 'skills':
            loadedSkills = msg.skills;
            renderSkillsSection();
            break;
        case 'piConfigUpdated':
            vscode.postMessage({ type: 'getSettings' });
            vscode.postMessage({ type: 'getSkills' });
            break;
        case 'success':
            showToast(msg.message, 'info');
            break;
        case 'error':
            showToast(msg.message, 'error');
            break;
        case 'scrollToSection':
            scrollToSettingsSection(msg.section);
            break;
        case 'voiceTestResult':
            voiceTesting[msg.service] = false;
            if (currentSettings) {
                // Saved as sent: the form's values are the settings now, whatever the check said.
                if (msg.service === 'stt') {
                    currentSettings.voice = readSttForm();
                } else {
                    currentSettings.tts = readTtsForm();
                }
                currentSettings.voiceReadiness[msg.service] = msg.check;
            }
            document.querySelectorAll(`[data-draft="${msg.service}"] [data-key]`).forEach((field) => voiceDrafts.delete(field.id));
            renderVoiceStatus(msg.service);
            showToast(msg.message, msg.ok ? 'info' : 'error');
            break;
        case 'sttDryRun':
            applySttDryRun(msg.run, msg.event);
            break;
        case 'ttsDryRunResult':
            applyTtsDryRunResult(msg);
            break;
    }
});

/** The settings minus the Voice tab's, to tell a voice-only change from one that needs a full render. */
function withoutVoice(data: SettingsData): string {
    return JSON.stringify({ ...data, voice: undefined, tts: undefined, voiceReadiness: undefined });
}

/** The saved value behind a Voice field (`voice.sttUrl`, `voiceAgent.tts.speed`, …). */
function savedVoiceValue(data: SettingsData, key: string): string | number | undefined {
    const [section, name] = key.startsWith('voiceAgent.tts.')
        ? [data.tts, key.slice('voiceAgent.tts.'.length)]
        : key.startsWith('voice.')
          ? [data.voice, key.slice('voice.'.length)]
          : [undefined, ''];
    const value: unknown = section ? Object.entries(section).find(([k]) => k === name)?.[1] : undefined;
    return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

/**
 * Shows newly saved voice settings without rebuilding the fields: a field with an unsaved draft keeps
 * it, and one that already shows the saved value is not touched (writing `.value` would clear its undo).
 */
function syncVoiceFields(): void {
    const data = currentSettings;
    if (!data) {
        return;
    }
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-draft] [data-key]').forEach((field) => {
        const saved = savedVoiceValue(data, field.dataset.key ?? '');
        if (saved === undefined || voiceDrafts.has(field.id)) {
            return;
        }
        const shown = typeof saved === 'number' ? Number(field.value) === saved : field.value.trim() === saved;
        if (!shown) {
            field.value = String(saved);
        }
    });
    renderVoiceStatus('stt');
    renderVoiceStatus('tts');
}

type VoiceService = 'stt' | 'tts';

function voiceServiceOf(value: string | undefined): VoiceService | undefined {
    return value === 'stt' || value === 'tts' ? value : undefined;
}

function fieldText(key: string): string {
    const field = document.getElementById(`setting-${key}`);
    return field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value.trim() : '';
}

/** A number field's value clamped to its range; `fallback` while it does not parse. */
function fieldNumber(key: string, fallback: number): number {
    const field = document.getElementById(`setting-${key}`);
    if (!(field instanceof HTMLInputElement) || Number.isNaN(field.valueAsNumber)) {
        return fallback;
    }
    return Math.min(Number(field.max), Math.max(Number(field.min), field.valueAsNumber));
}

/** The STT section as typed. */
function readSttForm(): VoiceSettings {
    const saved = currentSettings?.voice;
    return {
        sttUrl: fieldText('voice.sttUrl'),
        sttModel: fieldText('voice.sttModel'),
        language: fieldText('voice.language'),
        vadConfidence: fieldNumber('voice.vadConfidence', saved?.vadConfidence ?? 0.5),
        vadStopSecs: fieldNumber('voice.vadStopSecs', saved?.vadStopSecs ?? 0.8),
    };
}

/** The TTS section as typed. */
function readTtsForm(): TtsConfig {
    const provider = fieldText('voiceAgent.tts.provider');
    return {
        provider: provider === 'chatterbox' || provider === 'kokoro' ? provider : 'openai',
        url: fieldText('voiceAgent.tts.url'),
        model: fieldText('voiceAgent.tts.model'),
        voice: fieldText('voiceAgent.tts.voice'),
        speed: fieldNumber('voiceAgent.tts.speed', currentSettings?.tts.speed ?? 1),
    };
}

/** The section's form no longer matches what is saved (and in use). */
function isVoiceDirty(service: VoiceService): boolean {
    if (!currentSettings) {
        return false;
    }
    const [form, saved]: [object, object] = service === 'stt'
        ? [readSttForm(), currentSettings.voice]
        : [readTtsForm(), currentSettings.tts];
    const savedValues: Record<string, unknown> = Object.fromEntries(Object.entries(saved));
    return Object.entries(form).some(([key, value]) => savedValues[key] !== value);
}

/** Test button (text, or a green check / red cross), status line of one section, from its check, draft and test state. */
function renderVoiceStatus(service: VoiceService): void {
    const check = currentSettings?.voiceReadiness[service];
    const testing = voiceTesting[service] || (check?.checking === true && !isVoiceDirty(service));
    const dirty = !testing && isVoiceDirty(service);
    const ok = !testing && !dirty && check?.ok === true;
    const failed = !testing && !dirty && check !== undefined && !check.ok;
    const button = document.querySelector<HTMLButtonElement>(`[data-voice-test="${service}"]`);
    if (button) {
        button.dataset.state = testing ? 'testing' : ok ? 'ok' : failed ? 'failed' : '';
        button.disabled = voiceTesting[service];
        const title = testing
            ? 'Testing the connection…'
            : ok
              ? 'Connected. Click to test again.'
              : failed
                ? `${check?.reason ?? 'Not connected.'}\nClick to test again.`
                : 'Save this section and test the connection.';
        button.title = title;
        button.setAttribute('aria-label', title);
    }
    const status = document.getElementById(`voice-status-${service}`);
    if (!status) {
        return;
    }
    const [state, text] = testing
        ? ['testing', 'Saving and checking…']
        : dirty
          ? ['dirty', 'Unsaved changes. Test saves them; until then the previous settings stay in use.']
          : ok
            ? ['ok', 'Connected.']
            : [check?.checking ? 'testing' : 'error', check?.reason ?? 'Not checked yet.'];
    status.dataset.state = state;
    status.textContent = text;
}

/** Puts typed-but-unsaved values back after a re-render. */
function restoreVoiceDrafts(): void {
    for (const [id, value] of voiceDrafts) {
        const field = document.getElementById(id);
        if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
            field.value = value;
        }
    }
    renderVoiceStatus('stt');
    renderVoiceStatus('tts');
}

function scrollToSettingsSection(section: string): void {
    const tab = SECTION_TO_TAB[section];
    if (tab) {
        switchSettingsTab(tab, false);
    }
    requestAnimationFrame(() => {
        const el = document.getElementById(`section-${section}`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            el.classList.add('section-highlight');
            setTimeout(() => el.classList.remove('section-highlight'), 2000);
        }
    });
}

function switchSettingsTab(tabId: SettingsTabId, persist = true): void {
    activeTab = tabId;
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
}

function buildTabNav(backend: AgentBackend = 'pi'): HTMLElement {
    const nav = el('nav', 'settings-tabs');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Settings sections');
    for (const tab of SETTINGS_TABS) {
        const btn = el('button', 'settings-tab-btn') as HTMLButtonElement;
        btn.type = 'button';
        btn.dataset.tab = tab.id;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', tab.id === activeTab ? 'true' : 'false');
        btn.textContent = tab.id === 'packages' && backend === 'omp' ? 'Plugins' : tab.label;
        if (tab.id === activeTab) {
            btn.classList.add('active');
        }
        btn.addEventListener('click', () => switchSettingsTab(tab.id));
        nav.appendChild(btn);
    }
    return nav;
}

function buildTabPanel(tabId: SettingsTabId, children: HTMLElement[]): HTMLElement {
    const panel = el('div', 'settings-tab-panel');
    panel.dataset.tabPanel = tabId;
    if (tabId === activeTab) {
        panel.classList.add('active');
    }
    for (const child of children) {
        panel.appendChild(child);
    }
    return panel;
}

function buildHeader(data: SettingsData): HTMLElement {
    const header = el('div', 'settings-header');
    const available = data.availableBackends;

    header.innerHTML = `
        <div class="settings-header-top">
            <div class="settings-title-group">
                <h1>Oh My Pi Chater Settings</h1>
                <p class="settings-version">Extension v${escHtml(data.extensionVersion ?? '?')}</p>
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

function render(data: SettingsData): void {
    const app = document.getElementById('settings-app')!;
    // Saving a text field echoes the settings back and rebuilds the page; keep
    // the field being typed in (value, caret, focus) and the scroll position.
    const focused = document.activeElement instanceof HTMLInputElement && document.activeElement.id
        ? document.activeElement
        : null;
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

    app.appendChild(container);
    switchSettingsTab(activeTab, false);
    bindEvents();
    restoreVoiceDrafts();
    renderSkillsSection();
    window.scrollTo(0, scrollY);
    const refocus = typing && document.getElementById(typing.id);
    if (typing && refocus instanceof HTMLInputElement) {
        refocus.value = typing.value;
        refocus.focus();
        if (typing.selectionStart !== null && typing.selectionEnd !== null) {
            refocus.setSelectionRange(typing.selectionStart, typing.selectionEnd);
        }
    }
}

function buildGeneralTab(data: SettingsData): HTMLElement {
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
            buildToggle('autoApproveTools', 'Auto-approve tool calls (VS Code)', data.autoApproveTools,
                'Tool policy is still owned by the agent CLI. This only affects legacy approval UI if enabled.'),
            buildRange('contextUsageWarningThreshold', 'Context usage warning', data.contextUsageWarningThreshold, 0, 100,
                `Warn in the chat footer above ${data.contextUsageWarningThreshold}% context.`),
        ], 'chat-ui'),
        buildSection('Keyboard Shortcuts', [buildShortcutsInfo()]),
    );
    return buildTabPanel('general', children);
}
function buildVoiceGuideCard(): HTMLElement {
    const note = el('p', 'voice-guide-note');
    note.textContent = 'Speech-to-text powers the chat mic (dictation) and voice mode; text-to-speech gives voice mode its voice. Edits here are drafts: the Test button next to each URL saves its section, even when the check fails, and then shows a green check or a red cross. Until then the previous settings stay in use. Dry run tries the values as typed without saving them.';
    return note;
}

/**
 * A URL field with the section's "Test" button: it saves the section and checks it, then carries a
 * green check (connected) or a red cross (not; the tooltip says why). Edited again, the mark goes.
 */
function buildServiceUrlRow(service: VoiceService, key: string, label: string, value: string, placeholder: string, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <div class="setting-input-wrapper">
            <input type="text" id="setting-${key}" class="setting-input" data-key="${key}" value="${escHtml(value)}" placeholder="${escHtml(placeholder)}">
            <button type="button" class="setting-btn secondary voice-test-btn" data-voice-test="${service}">
                <span>Test</span>
                <svg class="voice-test-ok" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M13.5 4.5l-7 7L3 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <svg class="voice-test-failed" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
                </svg>
            </button>
        </div>
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

/** Dry run (tries the typed values unsaved) and the section's status line. */
function buildVoiceActions(service: VoiceService): HTMLElement {
    const row = el('div', 'setting-row voice-actions');
    row.innerHTML = `
        <div class="voice-actions-buttons">
            <button type="button" class="setting-btn secondary" data-voice-dry-run="${service}">Dry run…</button>
        </div>
        <p class="voice-status" id="voice-status-${service}" role="status"></p>
        <p class="setting-description">${service === 'stt'
            ? 'Dry run records one sentence from your microphone and shows what the service transcribed.'
            : 'Dry run synthesizes a sentence you type and gives you the audio to play.'}</p>
    `;
    return row;
}

/** A section whose fields are drafts until its Test button saves them. */
function buildDraftSection(service: VoiceService, title: string, children: HTMLElement[]): HTMLElement {
    const section = buildSection(title, [...children, buildVoiceActions(service)], service);
    section.dataset.draft = service;
    return section;
}

function buildVoiceTab(data: SettingsData): HTMLElement {
    return buildTabPanel('voice', [
        buildVoiceGuideCard(),
        buildDraftSection('stt', 'Speech-to-Text (STT)', [
            buildServiceUrlRow('stt', 'voice.sttUrl', 'Speech-to-text URL', data.voice.sttUrl, 'http://127.0.0.1:8010/v1',
                'OpenAI-compatible API base URL; /audio/transcriptions is appended. Checked with GET /models: the chat mic works only when it answers.'),
            buildTextInput('voice.sttModel', 'Model', data.voice.sttModel,
                'Transcription model id. Empty uses the first model listed at /models.',
                'first model at /models'),
            buildTextInput('voice.language', 'Language', data.voice.language,
                'ISO-639-1 hint such as zh or en. Empty lets the model detect it per utterance.',
                'auto-detect'),
            buildNumberInput('voice.vadConfidence', 'VAD threshold', data.voice.vadConfidence, 0.1, 0.95, 0.05,
                'Silero VAD speech probability (0.1–0.95). Lower it (e.g. 0.35) if quiet speech is missed; raise it if background noise gets transcribed.'),
            buildNumberInput('voice.vadStopSecs', 'Pause to end an utterance (s)', data.voice.vadStopSecs, 0.2, 3, 0.1,
                'Each utterance is transcribed as soon as this much silence follows it, so text appears while you keep talking.'),
        ]),
        buildDraftSection('tts', 'Text-to-Speech (TTS)', [
            buildSelect('voiceAgent.tts.provider', 'Provider', data.tts.provider, [
                { value: 'openai', label: 'OpenAI-compatible' },
                { value: 'chatterbox', label: 'chatterbox-tts' },
                { value: 'kokoro', label: 'Kokoro-FastAPI' },
            ], 'Decides how the language is sent: chatterbox gets zh/en per sentence, Kokoro gets Chinese runs as lang_code z, OpenAI-compatible gets none.'),
            buildServiceUrlRow('tts', 'voiceAgent.tts.url', 'Text-to-speech URL', data.tts.url, 'http://127.0.0.1:8881/v1',
                'OpenAI-compatible base URL; /audio/speech is appended. Checked with GET /models, which must list the model below. Voice mode needs it.'),
            buildTextInput('voiceAgent.tts.model', 'Model', data.tts.model,
                'Empty uses the provider default: chatterbox-multilingual, kokoro, or tts-1.',
                'provider default'),
            buildTextInput('voiceAgent.tts.voice', 'Voice', data.tts.voice,
                'Empty uses the provider default: default (chatterbox), af_sarah (Kokoro), or alloy.',
                'provider default'),
            buildNumberInput('voiceAgent.tts.speed', 'Speed', data.tts.speed, 0.5, 2, 0.1,
                'Speaking speed (0.5–2). Takes effect when voice mode starts.'),
        ]),
    ]);
}

function buildAuthTab(data: SettingsData): HTMLElement {
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

function buildOmpPluginsTab(data: SettingsData): HTMLElement {
    const cfg = data.piConfig ?? emptyPiConfig();
    return buildTabPanel('packages', [
        buildSection('Built-in Capabilities & Tools', [
            buildReadOnlyRow(
                'Runtime',
                'Oh My Pi (omp) is a standalone binary with native built-in capabilities and multi-ecosystem support (no Node native modules to compile).',
            ),
            buildReadOnlyRow(
                'MCP Support',
                'Native MCP client built into binary — connects to stdio, HTTP, and SSE servers with auto tool discovery.',
            ),
            buildReadOnlyRow(
                'Code Intelligence',
                'Built-in Language Server Protocol (LSP) diagnostics, format-on-write, and cross-file symbol indexing.',
            ),
            buildReadOnlyRow(
                'Execution & Shell',
                'Built-in Bash sandbox with background tasks, Python/Jupyter kernel, Puppeteer browser automation, and native host control.',
            ),
            buildReadOnlyRow(
                'Search & Traversal',
                'Built-in ripgrep, ast-grep (structural search), semantic file search, and glob tools.',
            ),
        ], 'omp-capabilities'),
        buildSection('Plugins & Extensions', [
            buildReadOnlyRow('User plugins', '~/.omp/plugins/'),
            buildReadOnlyRow('Project plugins', '.omp/plugins/'),
            buildReadOnlyRow(
                'Skills Registry',
                'skills.omp.sh — install community skills via `omp skill install` in terminal.',
            ),
            buildListEditor('extensions', cfg.extensionPaths, 'Path to extension file (.ts, .js)'),
            buildAddRow('extensions', 'Add extension path', 'Absolute or ~ path'),
        ], 'omp-plugins'),
    ]);
}

function buildPackagesTab(data: SettingsData): HTMLElement {
    const cfg = data.piConfig ?? emptyPiConfig();
    const packagesSection: HTMLElement[] = [];
    const recBanner = buildRecommendedPackagesBanner(data.recommendedPackagesMissing);
    if (recBanner) {
        packagesSection.push(recBanner);
    }
    const extIssues = buildExtensionLoadIssuesBanner(data);
    if (extIssues) {
        packagesSection.push(extIssues);
    }
    packagesSection.push(
        buildPackageCatalogRow(),
        buildListEditor('packages', cfg.packages, 'npm:package-name or git URL'),
        buildAddRow('packages', 'Add package manually', 'e.g. npm:@narumitw/pi-plan-mode'),
        buildReadOnlyRow(
            'Catalog',
            'Same packages as pi.dev/packages (via npm). Install runs npm + updates ~/.pi/agent.',
        ),
    );
    return buildTabPanel('packages', [
        buildSection('Packages (npm/git)', packagesSection, 'packages'),
        buildSection('Extension paths', [
            buildListEditor('extensions', cfg.extensionPaths, 'Path to extension .ts file'),
            buildAddRow('extensions', 'Add extension path', 'Absolute or ~ path'),
        ], 'extensions'),
    ]);
}

function buildSkillsTab(data: SettingsData): HTMLElement {
    const cfg = data.piConfig ?? emptyPiConfig();
    const skillsSection = buildSection('Installed skills', [buildSkillsPlaceholder()]);
    skillsSection.id = 'skills-section';
    const storageHint = data.backend === 'omp' ? 'saved to config.yml (skills.customDirectories)' : 'saved to settings.json (skills)';
    return buildTabPanel('skills', [
        buildSection('Skill paths', [
            buildListEditor('skillpaths', cfg.skillPaths, `Directory containing SKILL.md files (${storageHint})`),
            buildAddRow('skillpaths', 'Add skill directory', 'Absolute or ~ path'),
            buildPiSkillCommandsToggle(cfg.enableSkillCommands),
        ], 'skills'),
        skillsSection,
    ]);
}

function buildMcpTab(data: SettingsData): HTMLElement {
    const cfg = data.piConfig ?? emptyPiConfig();
    return buildTabPanel('mcp', [buildMcpSection(data, cfg)]);
}

function buildCommandsTab(data: SettingsData): HTMLElement {
    const cfg = data.piConfig ?? emptyPiConfig();
    return buildTabPanel('commands', [
        buildSection('Slash commands', [
            buildCommandsList(cfg),
            buildReloadRow(),
        ], 'commands'),
    ]);
}

function emptyPiConfig(): PiAgentConfigData {
    return {
        packages: [],
        extensionPaths: [],
        skillPaths: [],
        enableSkillCommands: true,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        authProviders: [],
        mcpFileExists: false,
        commands: [],
        availableModels: [],
    };
}

function buildPiConfigErrorBanner(message: string): HTMLElement {
    const row = el('div', 'setting-row pi-config-error');
    row.innerHTML = `<p class="setting-description"><strong>Pi config partial load:</strong> ${escHtml(message)}. Package list may still work from settings.json.</p>`;
    return row;
}

function buildExtensionLoadIssuesBanner(data: SettingsData): HTMLElement | null {
    const issues = data.extensionLoadIssues ?? [];
    if (issues.length === 0) {
        return null;
    }
    const loaded = data.loadedExtensionCount ?? '?';
    const native = issues.filter((i) => i.category === 'native').length;
    const rows = issues
        .slice(0, 6)
        .map(
            (i) =>
                `<li><strong>${escHtml(shortPath(i.path))}</strong> <span class="ext-issue-cat">[${escHtml(i.category)}]</span><br>${escHtml(i.message)}<br><span class="ext-issue-hint">${escHtml(i.hint)}</span></li>`,
        )
        .join('');
    const more =
        issues.length > 6
            ? `<p class="setting-description">…and ${issues.length - 6} more (Output → Oh My Pi Chater)</p>`
            : '';
    const rebuildBtn =
        native > 0
            ? '<button type="button" class="setting-btn" id="btn-rebuild-native">Rebuild native modules</button>'
            : '';
    const row = el('div', 'setting-row pi-config-error');
    row.innerHTML = `
        <p class="setting-description"><strong>${issues.length} Pi package(s) failed in this editor</strong> (${loaded} loaded). CLI and VS Code share ~/.pi/agent, but native addons (e.g. <code>pi-hermes-memory</code> / SQLite) must match the editor’s Node/Electron ABI.</p>
        <ul class="ext-load-issues">${rows}</ul>
        ${more}
        <div class="setting-actions-row">${rebuildBtn}</div>
    `;
    return row;
}

function shortPath(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : p;
}

function buildMcpSection(data: SettingsData, cfg: PiAgentConfigData): HTMLElement {
    const snap = mcpSnapshot ?? data.mcpSnapshot;
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
                `<li><span class="mcp-path-label">${escHtml(p.label)}</span> ` +
                `<code class="mcp-path-code">${escHtml(p.path)}</code> ` +
                `<span class="mcp-path-badge ${p.exists ? 'exists' : 'missing'}">${p.exists ? 'exists' : 'missing'}</span></li>`,
        )
        .join('');
    pathsRow.innerHTML = `
        <div class="setting-label-row"><label>Config files</label></div>
        <ul class="mcp-path-list">${pathItems}</ul>
        ${snap.importSources.length ? `<p class="setting-description">Imports: ${escHtml(snap.importSources.map(formatMcpImportLabel).join(', '))}</p>` : ''}
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

function buildMcpServerCard(server: McpServerSummary): HTMLElement {
    const card = el('div', `mcp-server-card status-${server.status}`);
    const statusClass = mcpStatusDotClass(server.status);
    const scopeLabel =
        server.scope === 'import'
            ? `import${server.importSource ? ` (${server.importSource})` : ''}`
            : server.scope;

    const toggleHtml = server.canToggle
        ? `<label class="mcp-toggle"><input type="checkbox" data-mcp-toggle="${escHtml(server.name)}" data-mcp-scope="${server.scope}" ${server.enabled ? 'checked' : ''} /> Enabled</label>`
        : `<span class="setting-description">Imported — edit source file to disable</span>`;

    const toolsId = `mcp-tools-${server.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const toolsHtml =
        server.toolCount > 0
            ? `<details class="mcp-tools-details"><summary>${server.toolCount} tools (from cache)</summary><ul class="mcp-tool-list" id="${toolsId}">${server.tools
                  .map(
                      (t) =>
                          `<li><span class="mcp-tool-name">${escHtml(t.name)}</span>` +
                          (t.description
                              ? `<span class="mcp-tool-desc">${escHtml(t.description.slice(0, 200))}${t.description.length > 200 ? '…' : ''}</span>`
                              : ''),
                  )
                  .join('')}</ul></details>`
            : '<span class="setting-description">No cached tools — use session or Test connection after first run</span>';

    const transport =
        server.transport === 'http'
            ? escHtml(server.url ?? 'HTTP')
            : escHtml(server.commandPreview ?? 'stdio');

    const kemdiHints = getKemdiMcpHints(server);
    const hintsHtml = kemdiHints.length
        ? `<ul class="mcp-kemdi-hints">${kemdiHints.map((h) => `<li>${escHtml(h)}</li>`).join('')}</ul>`
        : '';

    card.innerHTML = `
        <div class="mcp-server-header">
            <span class="mcp-status-dot ${statusClass}" title="${escHtml(server.statusMessage ?? server.status)}"></span>
            <span class="mcp-server-name">${escHtml(server.name)}</span>
            <span class="mcp-server-scope">${escHtml(scopeLabel)}</span>
            ${toggleHtml}
        </div>
        <p class="mcp-server-meta">${transport} · ${escHtml(server.statusMessage ?? server.status)}</p>
        ${hintsHtml}
        <div class="mcp-server-tools">${toolsHtml}</div>
        <button type="button" class="setting-btn secondary mcp-test-btn" data-mcp-test="${escHtml(server.name)}">Test connection</button>
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

function renderMcpSection(): void {
    if (!currentSettings?.syncWithPiCli) {
        return;
    }
    const cfg = currentSettings.piConfig;
    if (!cfg) {
        return;
    }
    const list = document.getElementById('mcp-server-list-root');
    if (!list || !mcpSnapshot) {
        render(currentSettings);
        return;
    }
    list.innerHTML = '';
    if (mcpSnapshot.servers.length === 0) {
        list.innerHTML = '<p class="setting-description">No MCP servers configured.</p>';
    } else {
        for (const server of mcpSnapshot.servers) {
            list.appendChild(buildMcpServerCard(server));
        }
    }
    bindMcpServerCards();
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
        `<span class="provider-chip ${p.configured ? 'configured' : 'empty'}">${escHtml(p.id)}</span>`,
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
                    `<option value="${escHtml(o.value)}" ${o.value === currentProvider ? 'selected' : ''}>${escHtml(o.label)}</option>`,
                ).join('')}
            </select>
            <select id="pi-default-model" class="setting-select" data-pi-field="model">
                ${modelOpts.map((o) =>
                    `<option value="${escHtml(o.value)}" ${o.value === currentModel ? 'selected' : ''}>${escHtml(o.label)}</option>`,
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
        <div class="setting-label-row"><label for="${id}">${escHtml(label)}</label></div>
        <select id="${id}" class="setting-select" data-pi-mode="${kind}">
            <option value="all" ${value === 'all' ? 'selected' : ''}>all</option>
            <option value="one-at-a-time" ${value === 'one-at-a-time' ? 'selected' : ''}>one-at-a-time</option>
        </select>
    `;
    return row;
}

function buildPiSkillCommandsToggle(enabled: boolean): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-toggle-row">
            <label class="toggle-label" for="pi-enable-skill-cmds">
                <span class="toggle-switch">
                    <input type="checkbox" id="pi-enable-skill-cmds" ${enabled ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </span>
                <span>Enable skill slash commands</span>
            </label>
        </div>
    `;
    return row;
}

function buildListEditor(kind: string, items: string[], hint: string): HTMLElement {
    const row = el('div', 'setting-row');
    const listId = `list-${kind}`;
    if (items.length === 0) {
        row.innerHTML = `<div id="${listId}" class="pi-list empty"><p class="setting-description">None configured.</p></div>`;
        return row;
    }
    row.innerHTML = `
        <div id="${listId}" class="pi-list" data-list-kind="${kind}">
            ${items.map((item, i) => `
                <div class="pi-list-item">
                    <code class="pi-list-value" title="${escHtml(hint)}">${escHtml(item)}</code>
                    <button type="button" class="setting-btn danger small" data-remove-kind="${kind}" data-remove-index="${i}">Remove</button>
                </div>
            `).join('')}
        </div>
    `;
    return row;
}

function buildRecommendedPackagesBanner(missing?: string[]): HTMLElement | null {
    if (!missing?.length) {
        return null;
    }
    const row = el('div', 'setting-row pi-config-error');
    row.innerHTML = `
        <p class="setting-description">
            <strong>Recommended for Oh My Pi Chater:</strong>
            ${missing.map((s) => `<code>${escHtml(s)}</code>`).join(', ')} —
            not in your Pi packages yet. Use command palette
            <strong>Oh My Pi Chater: Install Recommended Packages</strong> or add manually below.
        </p>
    `;
    return row;
}

function buildPackageCatalogRow(): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="btn-row">
            <button type="button" class="setting-btn primary" id="btn-browse-pi-catalog">Browse Pi package catalog…</button>
            <button type="button" class="setting-btn secondary" id="btn-open-pi-packages-site">pi.dev/packages</button>
        </div>
        <p class="setting-description">Search by name or description. Types: extension, skill, theme, prompt (from package keywords).</p>
    `;
    return row;
}

function buildAddRow(kind: string, label: string, placeholder: string): HTMLElement {
    const row = el('div', 'setting-row pi-add-row');
    row.innerHTML = `
        <div class="setting-label-row"><label>${escHtml(label)}</label></div>
        <div class="add-row">
            <input type="text" class="setting-input" data-add-kind="${kind}" placeholder="${escHtml(placeholder)}">
            <button type="button" class="setting-btn primary" data-add-btn="${kind}">Add</button>
        </div>
    `;
    return row;
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
                    <span class="command-name">/${escHtml(c.invocationName)}</span>
                    ${c.description ? `<span class="command-desc">${escHtml(c.description)}</span>` : ''}
                    ${c.source ? `<span class="command-source">${escHtml(c.source)}</span>` : ''}
                </div>
            `).join('')}
        </div>
        ${cfg.commands.length > max ? `<p class="setting-description">Showing ${max} of ${cfg.commands.length} commands.</p>` : ''}
    `;
    return row;
}

function buildReloadRow(): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <button type="button" class="setting-btn secondary" id="btn-reload-pi-session">Reload active session</button>
        <p class="setting-description">Reloads extensions, skills, and packages into the sidebar chat without restarting VS Code.</p>
    `;
    return row;
}

function buildSection(title: string, children: HTMLElement[], sectionId?: string): HTMLElement {
    const section = el('div', 'settings-section');
    if (sectionId) {
        section.id = `section-${sectionId}`;
    }
    const heading = el('h2', 'section-title');
    heading.textContent = title;
    section.appendChild(heading);
    for (const child of children) {
        section.appendChild(child);
    }
    return section;
}

function buildSelect(key: string, label: string, value: string, options: { value: string; label: string }[], description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <select id="setting-${key}" class="setting-select" data-key="${key}">
            ${options.map(o => `<option value="${escHtml(o.value)}" ${o.value === value ? 'selected' : ''}>${escHtml(o.label)}</option>`).join('')}
        </select>
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildTextInput(key: string, label: string, value: string, description: string, placeholder = description.split('.')[0]): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <input type="text" id="setting-${key}" class="setting-input" data-key="${key}" value="${escHtml(value)}" placeholder="${escHtml(placeholder)}">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildNumberInput(key: string, label: string, value: number, min: number, max: number, step: number, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <input type="number" id="setting-${key}" class="setting-input setting-input--number" data-key="${key}" value="${value}" min="${min}" max="${max}" step="${step}">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildToggle(key: string, label: string, value: boolean, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-toggle-row">
            <label class="toggle-label" for="setting-${key}">
                <span class="toggle-switch">
                    <input type="checkbox" id="setting-${key}" data-key="${key}" ${value ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </span>
                <span>${escHtml(label)}</span>
            </label>
        </div>
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildRange(key: string, label: string, value: number, min: number, max: number, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
            <span class="range-value" id="range-val-${key}">${value}%</span>
        </div>
        <input type="range" id="setting-${key}" class="setting-range" data-key="${key}" min="${min}" max="${max}" value="${value}">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildPiCliSyncInfo(data: SettingsData): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `<p class="setting-description">
        Chat uses <code>pi --mode rpc</code>. Edit <code>${escHtml(data.piAgentDir)}</code> here or in the terminal — same files.
        Slash commands like <code>/mcp</code> and <code>/packages</code> jump to the matching tab above.
    </p>`;
    return row;
}

function buildReadOnlyRow(label: string, value: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row"><label>${escHtml(label)}</label></div>
        <p class="setting-readonly"><code>${escHtml(value)}</code></p>
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

function buildSkillsPlaceholder(): HTMLElement {
    const row = el('div', 'setting-row');
    row.id = 'skills-list';
    row.innerHTML = `<p class="setting-description">Loading skills...</p>`;
    return row;
}

function renderSkillsSection(): void {
    const container = document.getElementById('skills-list');
    if (!container) return;

    if (loadedSkills.length === 0) {
        container.innerHTML = `<p class="setting-description">No skills found. Add skill paths in the Skills tab or place SKILL.md under <code>~/.agents/skills/</code> or <code>.agents/skills/</code>.</p>`;
        return;
    }

    container.innerHTML = loadedSkills.map(skill => {
        const invocation = skill.disableModelInvocation
            ? '<span class="skill-badge">manual only</span>'
            : '';
        return `<div class="skill-card">
            <div class="skill-card-header">
                <span class="skill-card-name">/skill:${escHtml(skill.name)}</span>
                ${invocation}
            </div>
            ${skill.description ? `<p class="skill-card-desc">${escHtml(skill.description)}</p>` : ''}
            <p class="skill-card-path">${escHtml(skill.filePath)}</p>
            ${skill.source ? `<span class="skill-card-source">${escHtml(skill.source)}</span>` : ''}
        </div>`;
    }).join('');
}

function bindEvents(): void {
    document.querySelectorAll('.backend-segment-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const b = (e.currentTarget as HTMLElement).dataset.backend as AgentBackend;
            if (b && b !== currentSettings?.backend) {
                vscode.postMessage({ type: 'setBackend', backend: b });
            }
        });
    });

    document.querySelectorAll('.setting-select[data-key]').forEach((select) => {
        // Voice sections save only through their Test button.
        if (select.closest('[data-draft]')) return;
        select.addEventListener('change', () => {
            const key = (select as HTMLSelectElement).dataset.key!;
            vscode.postMessage({ type: 'updateSetting', key, value: (select as HTMLSelectElement).value });
        });
    });

    // Save text inputs on 'change' (blur / Enter) to prevent re-rendering and flickering while typing
    document.querySelectorAll('.setting-input[data-key]').forEach((input) => {
        if (input.closest('[data-draft]')) return;
        input.addEventListener('change', () => {
            const field = input as HTMLInputElement;
            const key = field.dataset.key!;
            let value: string | string[] | number = field.value;
            if (key === 'allowedTools') {
                value = field.value.split(',').map((s) => s.trim()).filter(Boolean);
            } else if (field.type === 'number') {
                if (Number.isNaN(field.valueAsNumber)) {
                    return;
                }
                value = Math.min(Number(field.max), Math.max(Number(field.min), field.valueAsNumber));
            }
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    // Voice sections: edits stay drafts (kept across re-renders) until the section's Test saves them.
    document.querySelectorAll<HTMLElement>('[data-draft] [data-key]').forEach((field) => {
        const service = voiceServiceOf(field.closest<HTMLElement>('[data-draft]')?.dataset.draft);
        if (!service || !(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
        const keep = () => {
            voiceDrafts.set(field.id, field.value);
            renderVoiceStatus(service);
        };
        field.addEventListener('input', keep);
        field.addEventListener('change', keep);
    });

    document.querySelectorAll<HTMLButtonElement>('[data-voice-test]').forEach((btn) => {
        // Keep focus (and the caret) in the field being edited: Ctrl+Z right after a Test still undoes it.
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
            const service = voiceServiceOf(btn.dataset.voiceTest);
            if (!service || voiceTesting[service]) return;
            voiceTesting[service] = true;
            renderVoiceStatus(service);
            vscode.postMessage(service === 'stt' ? { type: 'testStt', settings: readSttForm() } : { type: 'testTts', settings: readTtsForm() });
        });
    });

    document.querySelectorAll<HTMLButtonElement>('[data-voice-dry-run]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const post = (message: SettingsClientMessage) => vscode.postMessage(message);
            if (btn.dataset.voiceDryRun === 'stt') {
                openSttDryRun(readSttForm(), post);
            } else {
                openTtsDryRun(readTtsForm(), post);
            }
        });
    });

    document.querySelectorAll('input[type="checkbox"][data-key]').forEach((cb) => {
        cb.addEventListener('change', () => {
            vscode.postMessage({
                type: 'updateSetting',
                key: (cb as HTMLInputElement).dataset.key!,
                value: (cb as HTMLInputElement).checked,
            });
        });
    });

    document.querySelectorAll('.setting-range').forEach((range) => {
        range.addEventListener('input', () => {
            const key = (range as HTMLInputElement).dataset.key!;
            const value = parseInt((range as HTMLInputElement).value, 10);
            const label = document.getElementById(`range-val-${key}`);
            if (label) label.textContent = `${value}%`;
        });
        range.addEventListener('change', () => {
            vscode.postMessage({
                type: 'updateSetting',
                key: (range as HTMLInputElement).dataset.key!,
                value: parseInt((range as HTMLInputElement).value, 10),
            });
        });
    });

    document.getElementById('btn-save-pi-defaults')?.addEventListener('click', () => {
        const provider = (document.getElementById('pi-default-provider') as HTMLSelectElement)?.value;
        const model = (document.getElementById('pi-default-model') as HTMLSelectElement)?.value;
        const thinkingLevel = (document.getElementById('pi-thinking') as HTMLSelectElement)?.value;
        vscode.postMessage({
            type: 'updatePiDefaults',
            provider: provider || undefined,
            model: model || undefined,
            thinkingLevel,
        });
    });

    document.getElementById('pi-thinking')?.addEventListener('change', (e) => {
        const thinkingLevel = (e.target as HTMLSelectElement).value;
        vscode.postMessage({ type: 'updatePiDefaults', thinkingLevel });
    });

    document.querySelectorAll('[data-pi-mode]').forEach((sel) => {
        sel.addEventListener('change', () => {
            const kind = (sel as HTMLSelectElement).dataset.piMode!;
            const mode = (sel as HTMLSelectElement).value as 'all' | 'one-at-a-time';
            if (kind === 'steering') {
                vscode.postMessage({ type: 'setPiSteeringMode', mode });
            } else {
                vscode.postMessage({ type: 'setPiFollowUpMode', mode });
            }
        });
    });

    document.getElementById('pi-enable-skill-cmds')?.addEventListener('change', (e) => {
        vscode.postMessage({
            type: 'setPiEnableSkillCommands',
            enabled: (e.target as HTMLInputElement).checked,
        });
    });

    document.querySelectorAll('[data-add-btn]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const kind = (btn as HTMLButtonElement).dataset.addBtn!;
            const input = document.querySelector(`input[data-add-kind="${kind}"]`) as HTMLInputElement;
            const value = input?.value?.trim();
            if (!value) {
                showToast('Enter a value first', 'error');
                return;
            }
            postAdd(kind, value);
            input.value = '';
        });
    });

    document.querySelectorAll('[data-remove-kind]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const kind = (btn as HTMLButtonElement).dataset.removeKind!;
            const index = parseInt((btn as HTMLButtonElement).dataset.removeIndex!, 10);
            postRemove(kind, index);
        });
    });

    document.querySelectorAll('[data-open-file]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const file = (btn as HTMLButtonElement).dataset.openFile as 'settings' | 'auth' | 'mcp';
            vscode.postMessage({ type: 'openPiAgentFile', file });
        });
    });

    document.getElementById('btn-reload-pi-session')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'reloadPiSession' });
    });

    document.getElementById('btn-rebuild-native')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'rebuildNativeModules' });
    });

    document.getElementById('btn-pi-login')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'runPiLogin' });
    });

    document.getElementById('btn-pi-logout')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'runPiLogout' });
    });

    document.getElementById('btn-browse-pi-catalog')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'browsePiCatalog' });
    });

    document.getElementById('btn-open-pi-packages-site')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'openExternalUrl', url: 'https://pi.dev/packages' });
    });

    document.getElementById('btn-test-all-mcp')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'testAllMcpServers' });
    });
    bindMcpServerCards();
    bindApiKeyHandlers();
}

/** The server cards' controls; renderMcpSection rebuilds only the cards, so it binds only these again. */
function bindMcpServerCards(): void {
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

function bindApiKeyHandlers(): void {
    const saveKeyBtn = document.getElementById('btn-save-key');
    saveKeyBtn?.addEventListener('click', () => {
        const input = document.getElementById('api-key-input') as HTMLInputElement;
        const key = input?.value?.trim();
        const provider = currentSettings?.apiProvider || '';
        if (!provider) {
            showToast('Select a provider first', 'error');
            return;
        }
        if (!key) {
            showToast('Enter an API key', 'error');
            return;
        }
        vscode.postMessage({ type: 'setApiKey', provider, key });
    });

    document.getElementById('btn-change-key')?.addEventListener('click', () => {
        if (currentSettings) {
            currentSettings.apiKeySet = false;
            render(currentSettings);
        }
    });

    document.getElementById('btn-clear-key')?.addEventListener('click', () => {
        const provider = currentSettings?.apiProvider || '';
        if (provider) {
            vscode.postMessage({ type: 'clearApiKey', provider });
        }
    });
}

function postAdd(kind: string, value: string): void {
    switch (kind) {
        case 'packages':
            vscode.postMessage({ type: 'addPiPackage', source: value });
            break;
        case 'extensions':
            vscode.postMessage({ type: 'addPiExtensionPath', path: value });
            break;
        case 'skillpaths':
            vscode.postMessage({ type: 'addPiSkillPath', path: value });
            break;
    }
}

function postRemove(kind: string, index: number): void {
    showToast('Removing…', 'info');
    switch (kind) {
        case 'packages':
            vscode.postMessage({ type: 'removePiPackage', index });
            break;
        case 'extensions':
            vscode.postMessage({ type: 'removePiExtensionPath', index });
            break;
        case 'skillpaths':
            vscode.postMessage({ type: 'removePiSkillPath', index });
            break;
    }
}

let toastTimeout: ReturnType<typeof setTimeout>;

function showToast(message: string, type: 'error' | 'info' = 'info'): void {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = el('div', 'toast');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.className = `toast toast-${type} visible`;
    toast.textContent = message;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast!.classList.remove('visible'), 3000);
}

function el(tag: string, className?: string): HTMLElement {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
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

function escHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

vscode.postMessage({ type: 'getSettings' });
vscode.postMessage({ type: 'getSkills' });
vscode.postMessage({ type: 'getMcpSnapshot' });
