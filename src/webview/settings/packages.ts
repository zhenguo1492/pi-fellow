import { escapeHtml } from '../../shared/html';
import type { SettingsData } from '../../shared/protocol';
import { buildAddRow, buildListEditor, buildReadOnlyRow, buildSection, el } from './dom';
import { emptyPiConfig } from './piConfig';
import { buildTabPanel } from './tabs';

export function buildOmpPluginsTab(data: SettingsData): HTMLElement {
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

export function buildPackagesTab(data: SettingsData): HTMLElement {
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
                `<li><strong>${escapeHtml(shortPath(i.path))}</strong> <span class="ext-issue-cat">[${escapeHtml(i.category)}]</span><br>${escapeHtml(i.message)}<br><span class="ext-issue-hint">${escapeHtml(i.hint)}</span></li>`,
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

function buildRecommendedPackagesBanner(missing?: string[]): HTMLElement | null {
    if (!missing?.length) {
        return null;
    }
    const row = el('div', 'setting-row pi-config-error');
    row.innerHTML = `
        <p class="setting-description">
            <strong>Recommended for Oh My Pi Chater:</strong>
            ${missing.map((s) => `<code>${escapeHtml(s)}</code>`).join(', ')} —
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
