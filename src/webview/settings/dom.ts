import { escapeHtml } from '../../shared/html';
import { settingsState } from './state';

export function el(tag: string, className?: string): HTMLElement {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

export function showToast(message: string, type: 'error' | 'info' = 'info'): void {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = el('div', 'toast');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.className = `toast toast-${type} visible`;
    toast.textContent = message;
    clearTimeout(settingsState.toastTimeout);
    settingsState.toastTimeout = setTimeout(() => toast!.classList.remove('visible'), 3000);
}

export function buildSection(title: string, children: HTMLElement[], sectionId?: string): HTMLElement {
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

export function buildSelect(key: string, label: string, value: string, options: { value: string; label: string }[], description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escapeHtml(label)}</label>
        </div>
        <select id="setting-${key}" class="setting-select" data-key="${key}">
            ${options.map(o => `<option value="${escapeHtml(o.value)}" ${o.value === value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
        </select>
        <p class="setting-description">${escapeHtml(description)}</p>
    `;
    return row;
}

export function buildTextInput(key: string, label: string, value: string, description: string, placeholder = description.split('.')[0]): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escapeHtml(label)}</label>
        </div>
        <input type="text" id="setting-${key}" class="setting-input" data-key="${key}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">
        <p class="setting-description">${escapeHtml(description)}</p>
    `;
    return row;
}

export function buildNumberInput(key: string, label: string, value: number, min: number, max: number, step: number, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escapeHtml(label)}</label>
        </div>
        <input type="number" id="setting-${key}" class="setting-input setting-input--number" data-key="${key}" value="${value}" min="${min}" max="${max}" step="${step}">
        <p class="setting-description">${escapeHtml(description)}</p>
    `;
    return row;
}

export function buildToggle(key: string, label: string, value: boolean, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-toggle-row">
            <label class="toggle-label" for="setting-${key}">
                <span class="toggle-switch">
                    <input type="checkbox" id="setting-${key}" data-key="${key}" ${value ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </span>
                <span>${escapeHtml(label)}</span>
            </label>
        </div>
        <p class="setting-description">${escapeHtml(description)}</p>
    `;
    return row;
}

export function buildRange(key: string, label: string, value: number, min: number, max: number, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escapeHtml(label)}</label>
            <span class="range-value" id="range-val-${key}">${value}%</span>
        </div>
        <input type="range" id="setting-${key}" class="setting-range" data-key="${key}" min="${min}" max="${max}" value="${value}">
        <p class="setting-description">${escapeHtml(description)}</p>
    `;
    return row;
}

export function buildReadOnlyRow(label: string, value: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row"><label>${escapeHtml(label)}</label></div>
        <p class="setting-readonly"><code>${escapeHtml(value)}</code></p>
    `;
    return row;
}

export function buildListEditor(kind: string, items: string[], hint: string): HTMLElement {
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
                    <code class="pi-list-value" title="${escapeHtml(hint)}">${escapeHtml(item)}</code>
                    <button type="button" class="setting-btn danger small" data-remove-kind="${kind}" data-remove-index="${i}">Remove</button>
                </div>
            `).join('')}
        </div>
    `;
    return row;
}

export function buildAddRow(kind: string, label: string, placeholder: string): HTMLElement {
    const row = el('div', 'setting-row pi-add-row');
    row.innerHTML = `
        <div class="setting-label-row"><label>${escapeHtml(label)}</label></div>
        <div class="add-row">
            <input type="text" class="setting-input" data-add-kind="${kind}" placeholder="${escapeHtml(placeholder)}">
            <button type="button" class="setting-btn primary" data-add-btn="${kind}">Add</button>
        </div>
    `;
    return row;
}

export function buildReloadRow(): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <button type="button" class="setting-btn secondary" id="btn-reload-pi-session">Reload active session</button>
        <p class="setting-description">Reloads extensions, skills, and packages into the sidebar chat without restarting VS Code.</p>
    `;
    return row;
}
