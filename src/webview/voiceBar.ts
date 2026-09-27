/**
 * The voice agent's place in the composer (docs/voice-agent-design.md §11): a robot status line
 * over the input box, and where typed text goes. The robot and its label are one button. Voice agent
 * off: it starts it. On: the label says what it is doing (listening, thinking, …) and a click stops it.
 * The composer talks to what the tab shows: its conversation → the omp worker, the Bot view → the
 * voice agent (offline: nobody, the composer is locked).
 */
import type { VoiceReadiness } from '../shared/protocol';
import { VOICE_MODE_LABEL, voiceIsOn, type VoiceAgentAction, type VoicePhase, type VoiceStatus } from '../shared/voiceViewProtocol';
import { voiceWaveHtml } from './voiceWave';
import { vscode } from './vscodeApi';

const BAR_ID = 'voice-bar';

export const ICON_ROBOT =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="5" width="11" height="8.5" rx="2.5"/><path d="M8 5V2.75"/><circle cx="8" cy="2.25" r=".75" fill="currentColor" stroke="none"/><circle cx="5.75" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="10.25" cy="9" r="1" fill="currentColor" stroke="none"/><path d="M1 8.25v2M15 8.25v2"/></svg>';
const ICON_HUSH =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 6l3.5 4M14.5 6L11 10"/></svg>';
/** Page of dotted entries, one per line: the voice agent's conversation, the Bot view. */
const ICON_LOG =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="1.75" width="11" height="12.5" rx="1.5"/><path d="M7 5.25h4M7 8h4M7 10.75h2.5"/><circle cx="5" cy="5.25" r=".75" fill="currentColor" stroke="none"/><circle cx="5" cy="8" r=".75" fill="currentColor" stroke="none"/><circle cx="5" cy="10.75" r=".75" fill="currentColor" stroke="none"/></svg>';
/** Speech bubble: the worker's conversation, shown instead of the Bot view. */
const ICON_CHAT =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7.5L4.5 14v-2.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5z"/></svg>';
/** Person handing off to a worker box: omp mode, the voice agent delegates the work to the omp worker. */
const ICON_DELEGATE =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4.5" cy="4.5" r="2"/><path d="M1 12.5a3.5 3.5 0 0 1 7 0"/><path d="M9 6h4.5M11.5 4l2 2-2 2"/><rect x="10" y="9.5" width="5" height="4.5" rx="1.2"/><circle cx="11.75" cy="11.75" r=".5" fill="currentColor" stroke="none"/><circle cx="13.25" cy="11.75" r=".5" fill="currentColor" stroke="none"/></svg>';
/** Handshake (Lucide, ISC), padded and thinner to match the delegate icon's size and weight: pair mode, the voice agent works beside the user. */
const ICON_HANDSHAKE =
    '<svg viewBox="-1 -1 26 26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/></svg>';

/** Muted is shown as a tag next to the phase, not as a phase of its own. */
type ShownPhase = Exclude<VoicePhase, 'muted'>;

const PHASE_LABEL: Record<ShownPhase, string> = {
    off: 'Voice agent',
    standby: 'Standby',
    listening: 'Listening',
    userSpeaking: 'Hearing you',
    transcribing: 'Transcribing',
    thinking: 'Thinking',
    synthesizing: 'Synthesizing',
    speaking: 'Speaking',
};

const PHASE_TITLE: Record<ShownPhase, string> = {
    off: 'Start the voice agent: talk with it, or type to it here.',
    standby: 'Another VS Code window has the microphone. Focus this window to talk here.',
    listening: 'Listening: talk any time.',
    userSpeaking: 'Hearing you.',
    transcribing: 'Turning what you said into text.',
    thinking: 'The voice model is working on a reply.',
    synthesizing: 'The reply is being turned into speech.',
    speaking: 'Speaking. Talk or type to cut it off.',
};

let status: VoiceStatus | undefined;
/** STT and TTS checks from the host; the voice agent needs both. Absent until the host reports them. */
let readiness: VoiceReadiness | undefined;
/** The active tab shows the Bot view instead of the worker's conversation. */
let botViewShown = false;

function post(action: VoiceAgentAction): void {
    vscode.postMessage({ type: 'voiceAgent', action });
}

/** Why the voice agent cannot start, one line per failing service; undefined when it can. */
function unavailableReason(): string | undefined {
    if (!readiness) {
        return 'Checking the speech services…';
    }
    const reasons = [readiness.stt, readiness.tts].filter((c) => !c.ok).map((c) => c.reason ?? 'Unavailable.');
    return reasons.length > 0 ? reasons.join('\n') : undefined;
}

export const voiceBarHtml = `<div id="${BAR_ID}" class="voice-bar" data-state="off">
    <button type="button" class="voice-bar-toggle" data-act="robot">
        <span class="voice-bar-robot">${ICON_ROBOT}</span>
        <span class="voice-bar-dot" aria-hidden="true"></span>
        <span class="voice-bar-label" role="status" aria-live="polite"></span>
    </button>
    <span class="voice-bar-muted" title="The microphone is muted: it hears nothing. Click the mic in the input box to unmute." hidden>Muted</span>
    <span class="voice-bar-spacer">${voiceWaveHtml}</span>
    <button type="button" class="voice-bar-btn" data-act="mode"></button>
    <button type="button" class="voice-bar-btn" data-act="hush" title="Stop the reply being spoken" aria-label="Stop the reply being spoken">${ICON_HUSH}</button>
    <button type="button" class="voice-bar-btn" data-act="panel">${ICON_LOG}</button>
</div>`;

/** Wires the status line; call once the composer skeleton exists. */
export function bindVoiceBar(): void {
    const bar = document.getElementById(BAR_ID);
    bar?.addEventListener('mousedown', (e) => {
        // Keep focus (and the caret) in the textarea.
        if ((e.target as HTMLElement).closest('button')) {
            e.preventDefault();
        }
    });
    bar?.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        switch (act) {
            case 'robot':
                if (status?.starting) {
                    return;
                }
                if (!voiceIsOn(status) && unavailableReason() !== undefined) {
                    vscode.postMessage({ type: 'openSettings', section: 'voice' });
                    return;
                }
                post({ type: voiceIsOn(status) ? 'stop' : 'start' });
                return;
            case 'mode':
                post({ type: 'mode', mode: status?.mode === 'omp' ? 'pair' : 'omp' });
                return;
            case 'hush':
                post({ type: 'hush' });
                return;
            case 'panel':
                vscode.postMessage({ type: 'toggleBotView' });
                return;
        }
    });
    render();
}

export function applyVoiceBarStatus(next: VoiceStatus | undefined): void {
    status = next;
    render();
}

export function setVoiceReadiness(next: VoiceReadiness): void {
    readiness = next;
    render();
}

/** The log button switches the active tab between the worker's conversation and the Bot view; it shows which one a click brings. */
export function setBotViewShown(shown: boolean): void {
    botViewShown = shown;
    render();
}

/** Where the composer's text goes: to what the active tab shows. */
export function composerTarget(): 'voice' | 'omp' {
    return botViewShown ? 'voice' : 'omp';
}

/**
 * The Bot view with the voice agent off: nobody reads what is typed there, so the composer takes
 * nothing until the agent comes online or the tab goes back to the worker's conversation.
 */
export function composerLocked(): boolean {
    return botViewShown && !voiceIsOn(status);
}

/** Sends the composer's text to the voice agent: it goes in like speech and cuts off a reply. */
export function sendToVoice(text: string): void {
    post({ type: 'send', text });
}

function render(): void {
    const bar = document.getElementById(BAR_ID);
    if (!bar) {
        return;
    }
    const on = voiceIsOn(status);
    // Muted is not a state of the agent: it stays in its colour and a grey tag says the mic is off.
    const phase: ShownPhase = status?.phase === 'muted' ? 'listening' : (status?.phase ?? 'off');
    const muted = on && status?.muted === true;
    bar.dataset.state = status?.starting ? 'starting' : phase;
    bar.classList.toggle('on', on);
    const label = bar.querySelector<HTMLElement>('.voice-bar-label')!;
    const idleMuted = muted && phase === 'listening';
    label.textContent = status?.starting ? 'Starting…' : idleMuted ? 'Online' : PHASE_LABEL[phase];
    bar.querySelector<HTMLElement>('.voice-bar-muted')!.hidden = !muted;
    const toggle = bar.querySelector<HTMLButtonElement>('[data-act="robot"]')!;
    // Off and a speech service is not working: red, the tooltip says why, a click opens Settings → Voice.
    const blockedBy = on ? undefined : unavailableReason();
    const action = status?.starting
        ? 'The voice agent is starting…'
        : on
          ? 'Stop the voice agent'
          : blockedBy
            ? `The voice agent cannot start:\n${blockedBy}`
            : 'Start the voice agent';
    toggle.title = status?.starting
        ? 'The voice agent is starting: microphone, speech services and voice model.'
        : on
          ? `${idleMuted ? 'The voice agent is on and waiting; type to it, or unmute to talk.' : PHASE_TITLE[phase]}\nClick to stop the voice agent.`
          : blockedBy
            ? action
            : PHASE_TITLE.off;
    toggle.setAttribute('aria-label', action);
    toggle.setAttribute('aria-pressed', String(on));
    toggle.setAttribute('aria-disabled', String(blockedBy !== undefined || status?.starting === true));
    bar.querySelector('.voice-bar-robot')!.classList.toggle('is-unavailable', blockedBy !== undefined);
    const mode = bar.querySelector<HTMLButtonElement>('[data-act="mode"]')!;
    const pair = status?.mode !== 'omp';
    mode.hidden = !on || status?.starting === true;
    if (mode.dataset.mode !== (pair ? 'pair' : 'omp')) {
        mode.dataset.mode = pair ? 'pair' : 'omp';
        mode.innerHTML = pair ? ICON_HANDSHAKE : ICON_DELEGATE;
    }
    mode.title = pair
        ? 'Pair mode: the voice agent edits files and runs commands itself, and hands heavy jobs to the worker on its own. Click for Delegate mode, where the worker does all the work.'
        : 'Delegate mode: the voice agent hands the work to the omp worker and directs it. Click for Pair mode, where it edits and runs commands itself.';
    mode.setAttribute('aria-label', `${VOICE_MODE_LABEL[pair ? 'pair' : 'omp']} mode`);
    bar.querySelector<HTMLButtonElement>('[data-act="hush"]')!.hidden = phase !== 'speaking' && phase !== 'synthesizing';
    const panel = bar.querySelector<HTMLButtonElement>('[data-act="panel"]')!;
    if (panel.dataset.shown !== String(botViewShown)) {
        panel.dataset.shown = String(botViewShown);
        panel.innerHTML = botViewShown ? ICON_CHAT : ICON_LOG;
        const panelTitle = botViewShown
            ? 'Back to the worker conversation'
            : 'Show the voice agent conversation in this tab (Bot view: conversation, engines, token use)';
        panel.title = panelTitle;
        panel.setAttribute('aria-label', panelTitle);
        panel.setAttribute('aria-pressed', String(botViewShown));
    }
}
