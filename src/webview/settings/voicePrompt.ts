/**
 * The voice agent's instructions on the Voice tab: `voiceAgent.extraPrompt`, shown as Markdown (View)
 * or in a textarea (Edit), and the built-in prompt, read-only under "View default prompt". The
 * extra prompt saves when the textarea loses focus or on View; while edited, its text is a draft
 * in `settingsState` so page re-renders keep it.
 */
import { escapeHtml } from '../../shared/html';
import { bindCopyButtons, renderMarkdownLiteralHtml } from '../chat/markdown';
import { vscode } from './api';
import { buildSection, el } from './dom';
import { settingsState } from './state';

const EXTRA_PROMPT_INPUT = 'voice-extra-prompt-input';
/** An empty extra prompt: its View text, and the textarea's placeholder. */
const EXTRA_PROMPT_EMPTY = 'No extra instructions. Choose Edit to add some.';
const EXTRA_PROMPT_PLACEHOLDER = 'Such as how formal to be, which language to answer in, or project terms to use. Markdown is fine.';

function buildExtraPromptRow(saved: string): HTMLElement {
    const row = el('div', 'setting-row voice-extra-prompt');
    const draft = settingsState.voiceExtraPromptDraft;
    const body = draft !== undefined
        ? `<textarea id="${EXTRA_PROMPT_INPUT}" class="setting-input voice-extra-prompt-input" rows="8" spellcheck="false" placeholder="${escapeHtml(EXTRA_PROMPT_PLACEHOLDER)}">${escapeHtml(draft)}</textarea>`
        : saved.trim()
            ? `<div class="voice-prompt-markdown">${renderMarkdownLiteralHtml(saved)}</div>`
            : `<p class="voice-extra-prompt-empty">${escapeHtml(EXTRA_PROMPT_EMPTY)}</p>`;
    row.innerHTML = `
        <div class="setting-label-row">
            <label${draft !== undefined ? ` for="${EXTRA_PROMPT_INPUT}"` : ''}>Voice agent extra prompt</label>
            <button type="button" class="setting-btn secondary small" data-voice-extra-prompt-toggle>${draft !== undefined ? 'View' : 'Edit'}</button>
        </div>
        ${body}
        <p class="setting-description">Appended to the voice agent's built-in prompt under "Additional instructions from the user:". Markdown is fine. Saved when you leave the field; a running voice agent restarts between turns to take it, and the conversation carries on.</p>`;
    return row;
}

function buildDefaultPromptRow(): HTMLElement {
    const row = el('div', 'setting-row voice-default-prompt');
    row.innerHTML = `
        <details class="voice-default-prompt-details"${settingsState.voiceDefaultPromptOpen ? ' open' : ''}>
            <summary>View default prompt</summary>
            <div class="voice-prompt-markdown"></div>
        </details>
        <p class="setting-description">The voice agent's built-in instructions, read-only: they go with its tools and modes, and change with the extension.</p>`;
    return row;
}

export function buildVoicePromptSection(extraPrompt: string): HTMLElement {
    return buildSection('Instructions', [buildExtraPromptRow(extraPrompt), buildDefaultPromptRow()], 'voice-prompt');
}

/** Saves the draft when it differs from the saved text, and counts it saved before the settings come back. */
function saveExtraPrompt(): void {
    const settings = settingsState.currentSettings;
    const draft = settingsState.voiceExtraPromptDraft;
    if (!settings || draft === undefined || draft === settings.voiceExtraPrompt) {
        return;
    }
    settings.voiceExtraPrompt = draft;
    vscode.postMessage({ type: 'updateSetting', key: 'voiceAgent.extraPrompt', value: draft });
}

function bindExtraPrompt(): void {
    const row = document.querySelector<HTMLElement>('.voice-extra-prompt');
    const saved = settingsState.currentSettings?.voiceExtraPrompt;
    if (!row || saved === undefined) {
        return;
    }
    const input = row.querySelector<HTMLTextAreaElement>(`#${EXTRA_PROMPT_INPUT}`);
    input?.addEventListener('input', () => {
        settingsState.voiceExtraPromptDraft = input.value;
    });
    input?.addEventListener('blur', saveExtraPrompt);
    const toggle = row.querySelector<HTMLButtonElement>('[data-voice-extra-prompt-toggle]')!;
    // Keeps focus in the textarea: its blur would save, and the page re-render under the click.
    toggle.addEventListener('mousedown', (e) => e.preventDefault());
    toggle.addEventListener('click', () => {
        if (settingsState.voiceExtraPromptDraft === undefined) {
            settingsState.voiceExtraPromptDraft = saved;
        } else {
            saveExtraPrompt();
            settingsState.voiceExtraPromptDraft = undefined;
        }
        row.replaceWith(buildExtraPromptRow(settingsState.currentSettings?.voiceExtraPrompt ?? saved));
        bindExtraPrompt();
        const textarea = document.getElementById(EXTRA_PROMPT_INPUT);
        if (textarea instanceof HTMLTextAreaElement) {
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        }
    });
    bindCopyButtons();
}

/** The default prompt is rendered when first expanded, not on every page render. */
function bindDefaultPrompt(): void {
    const details = document.querySelector<HTMLDetailsElement>('.voice-default-prompt-details');
    const prompt = settingsState.currentSettings?.voiceDefaultPrompt;
    if (!details || prompt === undefined) {
        return;
    }
    const content = details.querySelector<HTMLElement>('.voice-prompt-markdown')!;
    const fill = () => {
        if (details.open && !content.hasChildNodes()) {
            content.innerHTML = renderMarkdownLiteralHtml(prompt);
            bindCopyButtons();
        }
    };
    details.addEventListener('toggle', () => {
        settingsState.voiceDefaultPromptOpen = details.open;
        fill();
    });
    fill();
}

/** Once per full render. */
export function bindVoicePrompt(): void {
    bindExtraPrompt();
    bindDefaultPrompt();
}
