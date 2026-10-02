/**
 * The Voice tab's sub-tabs (Speech-to-text, Text-to-speech, Voice agent). Panels only hide, so
 * their fields and listeners live on; the chosen one is kept in `settingsState` and the webview state.
 */
import { vscode } from './api';
import { el } from './dom';
import { buildUnsavedDot, renderSaveBar } from './saveBar';
import { settingsState } from './state';

export type VoiceSubtab = 'stt' | 'tts' | 'agent';

const VOICE_SUBTABS: ReadonlyArray<{ id: VoiceSubtab; label: string }> = [
    { id: 'stt', label: 'Speech-to-text' },
    { id: 'tts', label: 'Text-to-speech' },
    { id: 'agent', label: 'Voice agent' },
];

/** The sub-tab that holds `element`, if it is on the Voice tab. */
export function voiceSubtabOf(element: Element | null): VoiceSubtab | undefined {
    const id = element?.closest<HTMLElement>('[data-voice-subpanel]')?.dataset.voiceSubpanel;
    return VOICE_SUBTABS.find((tab) => tab.id === id)?.id;
}

export function switchVoiceSubtab(subtab: VoiceSubtab, persist = true): void {
    settingsState.voiceSubtab = subtab;
    if (persist) {
        vscode.setState({ ...(vscode.getState() ?? {}), voiceSubtab: subtab });
    }
    document.querySelectorAll<HTMLButtonElement>('[data-voice-subtab]').forEach((btn) => {
        const selected = btn.dataset.voiceSubtab === subtab;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-selected', String(selected));
        btn.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll<HTMLElement>('[data-voice-subpanel]').forEach((panel) => {
        panel.hidden = panel.dataset.voiceSubpanel !== subtab;
    });
    renderSaveBar();
}

function buildVoiceSubtabNav(): HTMLElement {
    const nav = el('div', 'voice-subtabs');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Voice settings');
    for (const tab of VOICE_SUBTABS) {
        const selected = tab.id === settingsState.voiceSubtab;
        const btn = el('button', `voice-subtab-btn${selected ? ' active' : ''}`) as HTMLButtonElement;
        btn.type = 'button';
        btn.id = `voice-subtab-${tab.id}`;
        btn.dataset.voiceSubtab = tab.id;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-controls', `voice-subpanel-${tab.id}`);
        btn.setAttribute('aria-selected', String(selected));
        btn.tabIndex = selected ? 0 : -1;
        const label = el('span');
        label.textContent = tab.label;
        btn.append(label, buildUnsavedDot());
        btn.addEventListener('click', () => switchVoiceSubtab(tab.id));
        nav.appendChild(btn);
    }
    nav.addEventListener('keydown', (e) => {
        const index = VOICE_SUBTABS.findIndex((tab) => tab.id === settingsState.voiceSubtab);
        const last = VOICE_SUBTABS.length - 1;
        const next = e.key === 'ArrowRight' ? (index + 1) % VOICE_SUBTABS.length
            : e.key === 'ArrowLeft' ? (index + last) % VOICE_SUBTABS.length
            : e.key === 'Home' ? 0
            : e.key === 'End' ? last
            : undefined;
        if (next === undefined) {
            return;
        }
        e.preventDefault();
        const id = VOICE_SUBTABS[next].id;
        switchVoiceSubtab(id);
        document.getElementById(`voice-subtab-${id}`)?.focus();
    });
    return nav;
}

/** The sub-tab bar, and a panel per sub-tab. */
export function buildVoiceSubtabs(panels: Record<VoiceSubtab, HTMLElement[]>): HTMLElement[] {
    const built = VOICE_SUBTABS.map(({ id }) => {
        const panel = el('div', 'voice-subpanel');
        panel.id = `voice-subpanel-${id}`;
        panel.dataset.voiceSubpanel = id;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', `voice-subtab-${id}`);
        panel.hidden = id !== settingsState.voiceSubtab;
        panel.append(...panels[id]);
        return panel;
    });
    return [buildVoiceSubtabNav(), ...built];
}
