import { escapeHtml } from '../../shared/html';
import type { SettingsData } from '../../shared/protocol';
import { buildAddRow, buildListEditor, buildSection, el } from './dom';
import { emptyPiConfig } from './piConfig';
import { settingsState } from './state';
import { buildTabPanel } from './tabs';

export function buildSkillsTab(data: SettingsData): HTMLElement {
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

function buildSkillsPlaceholder(): HTMLElement {
    const row = el('div', 'setting-row');
    row.id = 'skills-list';
    row.innerHTML = `<p class="setting-description">Loading skills...</p>`;
    return row;
}

export function renderSkillsSection(): void {
    const container = document.getElementById('skills-list');
    const skills = settingsState.loadedSkills;
    if (!container || !skills) return;

    if (skills.length === 0) {
        container.innerHTML = `<p class="setting-description">No skills found. Add skill paths in the Skills tab or place SKILL.md under <code>~/.agents/skills/</code> or <code>.agents/skills/</code>.</p>`;
        return;
    }

    container.innerHTML = skills.map(skill => {
        const invocation = skill.disableModelInvocation
            ? '<span class="skill-badge">manual only</span>'
            : '';
        return `<div class="skill-card">
            <div class="skill-card-header">
                <span class="skill-card-name">/skill:${escapeHtml(skill.name)}</span>
                ${invocation}
            </div>
            ${skill.description ? `<p class="skill-card-desc">${escapeHtml(skill.description)}</p>` : ''}
            <p class="skill-card-path">${escapeHtml(skill.filePath)}</p>
            ${skill.source ? `<span class="skill-card-source">${escapeHtml(skill.source)}</span>` : ''}
        </div>`;
    }).join('');
}
