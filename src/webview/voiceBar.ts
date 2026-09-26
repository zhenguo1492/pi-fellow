/**
 * The voice agent's place in the composer (docs/voice-agent-design.md §11): a robot status line
 * over the input box, and the choice where typed text goes. Voice agent off: the robot starts it.
 * On: the line says what it is doing (listening, thinking, synthesizing, speaking, …), the robot
 * stops it, and the composer's text goes to it unless "omp" is ticked. Slash commands and
 * messages with attachments always go to omp.
 */
import type { VoiceReadiness } from '../shared/protocol';
import { VOICE_MODE_LABEL, type VoiceAgentAction, type VoicePhase, type VoiceStatus } from '../shared/voiceViewProtocol';
import { voiceWaveHtml } from './voiceWave';
import { vscode } from './vscodeApi';

const BAR_ID = 'voice-bar';
const TARGET_ID = 'voice-target';

const ICON_ROBOT =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="5" width="11" height="8.5" rx="2.5"/><path d="M8 5V2.75"/><circle cx="8" cy="2.25" r=".75" fill="currentColor" stroke="none"/><circle cx="5.75" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="10.25" cy="9" r="1" fill="currentColor" stroke="none"/><path d="M1 8.25v2M15 8.25v2"/></svg>';
const ICON_HUSH =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 6l3.5 4M14.5 6L11 10"/></svg>';
/** Page of dotted entries, one per line: the log of what was said, shown in the Bot view. */
const ICON_LOG =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="1.75" width="11" height="12.5" rx="1.5"/><path d="M7 5.25h4M7 8h4M7 10.75h2.5"/><circle cx="5" cy="5.25" r=".75" fill="currentColor" stroke="none"/><circle cx="5" cy="8" r=".75" fill="currentColor" stroke="none"/><circle cx="5" cy="10.75" r=".75" fill="currentColor" stroke="none"/></svg>';
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
/** Ticked: the composer's text goes to omp while the voice agent is on. Reset each time it starts. */
let toOmp = false;

function post(action: VoiceAgentAction): void {
    vscode.postMessage({ type: 'voiceAgent', action });
}

/** Voice mode is on (or starting): the composer talks to the voice agent by default. */
function voiceOn(): boolean {
    return status !== undefined && (status.phase !== 'off' || status.starting);
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
    <button type="button" class="voice-bar-robot" data-act="robot">${ICON_ROBOT}</button>
    <span class="voice-bar-dot" aria-hidden="true"></span>
    <span class="voice-bar-label" role="status" aria-live="polite"></span>
    <span class="voice-bar-muted" title="The microphone is muted: it hears nothing. Click the mic in the input box to unmute." hidden>Muted</span>
    <span class="voice-bar-spacer">${voiceWaveHtml}</span>
    <button type="button" class="voice-bar-btn" data-act="mode"></button>
    <button type="button" class="voice-bar-btn" data-act="hush" title="Stop the reply being spoken" aria-label="Stop the reply being spoken">${ICON_HUSH}</button>
    <button type="button" class="voice-bar-btn" data-act="panel" title="Show the log (Bot view: conversation, engines, token use)" aria-label="Show the log">${ICON_LOG}</button>
</div>`;

export const voiceTargetHtml = `<label id="${TARGET_ID}" class="voice-target" title="Send what you type to the omp worker instead of the voice agent. Slash commands and messages with attachments always go to the worker." hidden>
    <input type="checkbox"><span>To worker</span>
</label>`;

/** Wires the status line and the target checkbox; call once the composer skeleton exists. */
export function bindVoiceBar(onTargetChange: () => void): void {
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
                if (!voiceOn() && unavailableReason() !== undefined) {
                    vscode.postMessage({ type: 'openSettings', section: 'voice' });
                    return;
                }
                post({ type: voiceOn() ? 'stop' : 'start' });
                return;
            case 'mode':
                post({ type: 'mode', mode: status?.mode === 'pair' ? 'omp' : 'pair' });
                return;
            case 'hush':
                post({ type: 'hush' });
                return;
            case 'panel':
                post({ type: 'showPanel' });
                return;
        }
    });
    const box = document.querySelector<HTMLInputElement>(`#${TARGET_ID} input`);
    box?.addEventListener('change', () => {
        toOmp = box.checked;
        onTargetChange();
    });
    render();
}

export function applyVoiceBarStatus(next: VoiceStatus | undefined): void {
    const wasOn = voiceOn();
    status = next;
    if (voiceOn() && !wasOn) {
        toOmp = false;
    }
    render();
}

export function setVoiceReadiness(next: VoiceReadiness): void {
    readiness = next;
    render();
}

/** Where the composer's text goes now; `omp` for slash commands and attachments regardless. */
export function composerTarget(text: string, attachments: number): 'voice' | 'omp' {
    return voiceOn() && !toOmp && attachments === 0 && !text.startsWith('/') ? 'voice' : 'omp';
}

/** Placeholder of the input box while the voice agent is on and gets what is typed. */
export function voicePlaceholder(): string | undefined {
    return voiceOn() && !toOmp ? 'Talk to the voice agent…' : undefined;
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
    const on = voiceOn();
    // Muted is not a state of the agent: it stays in its colour and a grey tag says the mic is off.
    const phase: ShownPhase = status?.phase === 'muted' ? 'listening' : (status?.phase ?? 'off');
    const muted = on && status?.muted === true;
    bar.dataset.state = status?.starting ? 'starting' : phase;
    bar.classList.toggle('on', on);
    const label = bar.querySelector<HTMLElement>('.voice-bar-label')!;
    const idleMuted = muted && phase === 'listening';
    label.textContent = status?.starting ? 'Starting…' : idleMuted ? 'Online' : PHASE_LABEL[phase];
    label.title = status?.starting
        ? 'The voice agent is starting: microphone, speech services and voice model.'
        : idleMuted
          ? 'The voice agent is on and waiting; type to it, or unmute to talk.'
          : PHASE_TITLE[phase];
    bar.querySelector<HTMLElement>('.voice-bar-muted')!.hidden = !muted;
    const robot = bar.querySelector<HTMLButtonElement>('[data-act="robot"]')!;
    // Off and a speech service is not working: red, the tooltip says why, a click opens Settings → Voice.
    const blockedBy = on ? undefined : unavailableReason();
    const robotTitle = status?.starting
        ? 'The voice agent is starting…'
        : on
          ? 'Stop the voice agent'
          : blockedBy
            ? `The voice agent cannot start:\n${blockedBy}`
            : 'Start the voice agent';
    robot.title = robotTitle;
    robot.setAttribute('aria-label', robotTitle);
    robot.setAttribute('aria-pressed', String(on));
    robot.setAttribute('aria-disabled', String(blockedBy !== undefined));
    robot.classList.toggle('is-unavailable', blockedBy !== undefined);
    if (blockedBy) {
        label.title = robotTitle;
    }
    const mode = bar.querySelector<HTMLButtonElement>('[data-act="mode"]')!;
    const pair = status?.mode === 'pair';
    mode.hidden = !on || status?.starting === true;
    if (mode.dataset.mode !== (pair ? 'pair' : 'omp')) {
        mode.dataset.mode = pair ? 'pair' : 'omp';
        mode.innerHTML = pair ? ICON_HANDSHAKE : ICON_DELEGATE;
    }
    mode.title = pair
        ? 'Pair mode: the voice agent edits files and runs commands itself, and does not direct the worker. Click for Delegate mode, where it hands the work to the worker again.'
        : 'Delegate mode: the voice agent hands the work to the omp worker and directs it. Click for Pair mode, where it edits and runs commands itself.';
    mode.setAttribute('aria-label', `${VOICE_MODE_LABEL[pair ? 'pair' : 'omp']} mode`);
    bar.querySelector<HTMLButtonElement>('[data-act="hush"]')!.hidden = phase !== 'speaking' && phase !== 'synthesizing';

    const target = document.getElementById(TARGET_ID);
    if (target) {
        target.hidden = !on;
        target.querySelector<HTMLInputElement>('input')!.checked = toOmp;
    }
}
