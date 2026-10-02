/**
 * The voice agent's instructions on the Voice tab: `voiceAgent.extraPrompt`, shown as Markdown (View)
 * or in a textarea (Edit), and the built-in prompt, read-only under "View default prompt". What is
 * typed is an edit (`edits.ts`) until the page's Save, so page re-renders keep it.
 */
import { escapeHtml } from '../../shared/html';
import { bindCopyButtons, renderMarkdownLiteralHtml } from '../chat/markdown';
import { buildSection, el } from './dom';
import { setSetting } from './edits';
import { settingsState } from './state';

const EXTRA_PROMPT_INPUT = 'voice-extra-prompt-input';
/** An empty extra prompt: its View text, and the textarea's placeholder. */
const EXTRA_PROMPT_EMPTY = 'No extra instructions. Choose Edit to add some.';
const EXTRA_PROMPT_PLACEHOLDER = 'Such as how formal to be, which language to answer in, or project terms to use. Markdown is fine.';

function buildExtraPromptRow(text: string): HTMLElement {
    const row = el('div', 'setting-row voice-extra-prompt');
    const editing = settingsState.voiceExtraPromptEditing;
    const body = editing
        ? `<textarea id="${EXTRA_PROMPT_INPUT}" class="setting-input voice-extra-prompt-input" rows="8" spellcheck="false" placeholder="${escapeHtml(EXTRA_PROMPT_PLACEHOLDER)}">${escapeHtml(text)}</textarea>`
        : text.trim()
            ? `<div class="voice-prompt-markdown">${renderMarkdownLiteralHtml(text)}</div>`
            : `<p class="voice-extra-prompt-empty">${escapeHtml(EXTRA_PROMPT_EMPTY)}</p>`;
    row.innerHTML = `
        <div class="setting-label-row">
            <label${editing ? ` for="${EXTRA_PROMPT_INPUT}"` : ''}>Voice agent extra prompt</label>
            <button type="button" class="setting-btn secondary small" data-voice-extra-prompt-toggle>${editing ? 'View' : 'Edit'}</button>
        </div>
        ${body}
        <p class="setting-description">Appended to the voice agent's built-in prompt under "Additional instructions from the user:". Markdown is fine. After Save, a running voice agent restarts between turns to take it, and the conversation carries on.</p>`;
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

function bindExtraPrompt(): void {
    const row = document.querySelector<HTMLElement>('.voice-extra-prompt');
    if (!row || !settingsState.currentSettings) {
        return;
    }
    const input = row.querySelector<HTMLTextAreaElement>(`#${EXTRA_PROMPT_INPUT}`);
    input?.addEventListener('input', () => {
        setSetting('voiceAgent.extraPrompt', input.value, input);
    });
    const toggle = row.querySelector<HTMLButtonElement>('[data-voice-extra-prompt-toggle]')!;
    toggle.addEventListener('click', () => {
        settingsState.voiceExtraPromptEditing = !settingsState.voiceExtraPromptEditing;
        row.replaceWith(buildExtraPromptRow(settingsState.currentSettings?.voiceExtraPrompt ?? ''));
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
