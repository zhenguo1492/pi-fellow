/**
 * The voice agent's place in the composer (docs/voice-agent-design.md §11): a status line over the
 * input box, and where typed text goes. The avatar and its label are one button that switches the
 * tab between the worker's conversation (or its TUI) and the Bot view; while voice mode is on the
 * label says what it is doing (listening, thinking, …). The phone button at the right end starts
 * voice mode (microphone and speaker) and, while it is on, hangs up.
 * The follow button next to the avatar sets whether the editor follows Pi's focus (docs/voice-pair-agent-cursor.md).
 * A speech service that does not work does not keep it offline: it runs without it (design §5.13),
 * and a grey tag says so ("Can't hear", "No voice"; a click opens Settings → Voice).
 * The composer talks to what the tab shows: its conversation → the omp worker, the Bot view → the
 * voice agent, by voice mode while it is on and as a text chat otherwise.
 */
import type { VoiceReadiness } from '../shared/protocol';
import { voiceIsOn, type VoiceAgentAction, type VoicePhase, type VoiceStatus } from '../shared/voiceViewProtocol';
import { DEFAULT_SPEAKER_NAMES } from '../shared/voiceSpeakers';
import { ICON_ROBOT } from './avatar';
import { setAvatarThinking } from './avatarMotion';
import { voiceWaveHtml } from './voiceWave';
import { vscode } from './vscodeApi';

const BAR_ID = 'voice-bar';

const ICON_HUSH =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 6l3.5 4M14.5 6L11 10"/></svg>';
const PHONE_PATH =
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z';
/** Handset: start voice mode (also on the Bot view's welcome). */
export const ICON_CALL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PHONE_PATH}"/></svg>`;
/** Handset lying flat, filled (Material "call_end"): stop voice mode. */
const ICON_HANG_UP =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>';
/** Eye: open while the editor follows Pi, struck through otherwise. */
const ICON_FOLLOW_ON =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg>';
const ICON_FOLLOW_OFF =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 13.5l11-11"/></svg>';

/** Muted is shown as a tag next to the phase, not as a phase of its own. */
type ShownPhase = Exclude<VoicePhase, 'muted'>;

/** Offline the label is the voice agent's name instead (Settings → Voice → Voice agent → Names and avatars). */
const PHASE_LABEL: Record<Exclude<ShownPhase, 'off'>, string> = {
    standby: 'Standby',
    listening: 'Listening',
    soundDetected: 'Detecting speech',
    userSpeaking: 'Hearing you',
    transcribing: 'Transcribing',
    thinking: 'Thinking',
    synthesizing: 'Synthesizing',
    speaking: 'Speaking',
};

const PHASE_TITLE: Record<Exclude<ShownPhase, 'off'>, string> = {
    standby: 'Another VS Code window has the microphone. Focus this window to talk here.',
    listening: 'Listening: talk any time.',
    soundDetected: 'Heard a sound; checking it is you.',
    userSpeaking: 'Hearing you.',
    transcribing: 'Turning what you said into text.',
    thinking: 'The voice model is working on a reply.',
    synthesizing: 'The reply is being turned into speech.',
    speaking: 'Speaking. Talk or type to cut it off.',
};

/** The tags of a speech service the voice agent works without: label, and what it does instead. */
const SERVICE_TAG = {
    stt: { label: "Can't hear", instead: 'The voice agent works without speech-to-text: type to it in the Bot view.' },
    tts: { label: 'No voice', instead: 'The voice agent works without text-to-speech: its replies show as text in the Bot view.' },
} as const;

let status: VoiceStatus | undefined;
/** STT and TTS readiness from the host: last probe or real request of each, updated live. Absent until the host reports them. */
let readiness: VoiceReadiness | undefined;
/** The active tab shows the Bot view instead of the worker's conversation. */
let botViewShown = false;
/** The active tab is in TUI mode: leaving the Bot view goes back to its terminal. */
let botViewOverTui = false;
/** The voice agent's name and avatar (`voiceAgent.botName`, `voiceAgent.botAvatar`, as the Bot view draws it); the robot by default. */
let botName = DEFAULT_SPEAKER_NAMES.bot;
let robotHtml = ICON_ROBOT;
let robotVersion = 0;

function post(action: VoiceAgentAction): void {
    vscode.postMessage({ type: 'voiceAgent', action });
}

/**
 * Why the voice agent works without `service`, or undefined when it has it: while on, what voice
 * mode started without (or a microphone it cannot open); and, on or off, the service's readiness
 * failing, as its last real request or check went (not while it is still being checked). A later
 * success clears it.
 */
function serviceProblem(service: 'stt' | 'tts'): string | undefined {
    const startedWithout = status && voiceIsOn(status) && !status.starting ? status.unavailable?.[service] : undefined;
    const check = readiness?.[service];
    return startedWithout ?? (check && !check.ok && !check.checking ? (check.reason ?? 'Unavailable.') : undefined);
}

export const voiceBarHtml = `<div id="${BAR_ID}" class="voice-bar" data-state="off">
    <button type="button" class="voice-bar-toggle" data-act="view">
        <span class="voice-bar-robot">${ICON_ROBOT}</span>
        <span class="voice-bar-dot" aria-hidden="true"></span>
        <span class="voice-bar-label" role="status" aria-live="polite"></span>
    </button>
    <button type="button" class="voice-bar-btn" data-act="follow" hidden></button>
    <span class="voice-bar-tag voice-bar-muted" title="The microphone is muted: it hears nothing. Click the mic in the input box to unmute." hidden>Muted</span>
    <button type="button" class="voice-bar-tag" data-act="settings" data-service="stt" hidden>${SERVICE_TAG.stt.label}</button>
    <button type="button" class="voice-bar-tag" data-act="settings" data-service="tts" hidden>${SERVICE_TAG.tts.label}</button>
    <span class="voice-bar-spacer">${voiceWaveHtml}</span>
    <button type="button" class="voice-bar-btn" data-act="hush" title="Stop the reply being spoken" aria-label="Stop the reply being spoken">${ICON_HUSH}</button>
    <button type="button" class="voice-bar-btn" data-act="call"></button>
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
            case 'view':
                vscode.postMessage({ type: 'toggleBotView' });
                return;
            case 'call':
                if (!status?.starting) {
                    post({ type: voiceIsOn(status) ? 'stop' : 'start' });
                }
                return;
            case 'settings':
                vscode.postMessage({ type: 'openSettings', section: 'voice' });
                return;
            case 'follow':
                if (status) {
                    post({ type: 'follow', following: !status.following });
                }
                return;
            case 'hush':
                post({ type: 'hush' });
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

/**
 * The avatar button switches the active tab between the worker's conversation, or its TUI (`tuiTab`),
 * and the Bot view; it says which one a click brings.
 */
export function setBotViewShown(shown: boolean, tuiTab = false): void {
    botViewShown = shown;
    botViewOverTui = tuiTab;
    render();
}

/** The voice agent's name or avatar changed: the label shows the name while offline, and the robot button the avatar. */
export function setVoiceBarBot(name: string, avatarHtml: string): void {
    if (avatarHtml !== robotHtml) {
        robotHtml = avatarHtml;
        robotVersion++;
    }
    botName = name;
    render();
}

/** Where the composer's text goes: to what the active tab shows. */
export function composerTarget(): 'voice' | 'omp' {
    return botViewShown ? 'voice' : 'omp';
}

/** Sends the composer's text to the voice agent: like speech in voice mode (it cuts off a reply), a text turn otherwise. */
export function sendToVoice(text: string): void {
    post({ type: 'send', text });
}

/** Starts voice mode, as the phone button does while it is off; nothing while it is on or starting. */
export function callVoiceAgent(): void {
    if (!voiceIsOn(status)) {
        post({ type: 'start' });
    }
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
    // A pixel-art avatar plays its own thinking animation (the robot's is CSS, keyed on `data-state`).
    setAvatarThinking(bar.dataset.state === 'thinking');
    bar.classList.toggle('on', on);
    bar.querySelector<HTMLElement>('.voice-bar-muted')!.hidden = !muted;
    // Set only when it changed (also on a rebuilt bar): re-parsing it would restart the starting pulse.
    const robot = bar.querySelector<HTMLElement>('.voice-bar-robot')!;
    if (robot.dataset.version !== String(robotVersion)) {
        robot.dataset.version = String(robotVersion);
        robot.innerHTML = robotHtml;
    }
    // The Bot view animates its latest reply's avatar instead: one talking avatar on screen, not two.
    robot.classList.toggle('av-motion', !botViewShown);
    const problems = { stt: serviceProblem('stt'), tts: serviceProblem('tts') };
    for (const service of ['stt', 'tts'] as const) {
        const tag = bar.querySelector<HTMLElement>(`[data-service="${service}"]`)!;
        const problem = problems[service];
        tag.hidden = problem === undefined;
        tag.title = problem ? `${SERVICE_TAG[service].label}: ${problem}\n${SERVICE_TAG[service].instead}\nClick to open Settings → Voice.` : '';
        tag.setAttribute('aria-label', problem ? `${SERVICE_TAG[service].label}: ${problem} Open Settings → Voice.` : '');
    }
    // Without STT voice mode never listens: idle, it waits for typing.
    const deaf = on && !status?.starting && problems.stt !== undefined;
    const voiceless = on && !status?.starting && problems.tts !== undefined;
    const idle = phase === 'listening';
    const label = bar.querySelector<HTMLElement>('.voice-bar-label')!;
    label.textContent = status?.starting ? 'Starting…' : idle && (muted || deaf) ? 'Online' : phase === 'off' ? botName : PHASE_LABEL[phase];
    const viewTitle = !botViewShown
        ? `Show the conversation with ${botName} in this tab (Bot view: conversation, engines, token use)`
        : botViewOverTui
          ? 'Back to the terminal (TUI); it kept running'
          : 'Back to the worker conversation';
    const phaseTitle = deaf && idle
        ? "The voice agent is on and waiting. It can't hear you: type to it in the Bot view."
        : muted && idle
          ? 'The voice agent is on and waiting; type to it, or unmute to talk.'
          : voiceless && phase === 'thinking'
            ? 'The voice model is working on a reply; it shows as text in the Bot view.'
            : phase === 'off'
              ? undefined
              : PHASE_TITLE[phase];
    const toggle = bar.querySelector<HTMLButtonElement>('[data-act="view"]')!;
    toggle.title = status?.starting
        ? `Starting voice mode: microphone, speech services and voice model.\n${viewTitle}`
        : on && phaseTitle
          ? `${phaseTitle}\n${viewTitle}`
          : viewTitle;
    toggle.setAttribute('aria-label', viewTitle);
    toggle.setAttribute('aria-pressed', String(botViewShown));
    const call = bar.querySelector<HTMLButtonElement>('[data-act="call"]')!;
    const callState = status?.starting ? 'starting' : on ? 'on' : 'off';
    if (call.dataset.call !== callState) {
        call.dataset.call = callState;
        call.innerHTML = callState === 'on' ? ICON_HANG_UP : ICON_CALL;
    }
    call.title =
        callState === 'starting'
            ? 'Connecting: microphone, speech services and voice model…'
            : callState === 'on'
              ? `Hang up: stop voice mode and disconnect the microphone. You can still type to ${botName} in the Bot view.`
              : `Call ${botName}: start voice mode and talk. Without it, what you type in the Bot view is a text chat.`;
    call.setAttribute('aria-label', callState === 'on' ? 'Hang up' : `Call ${botName}`);
    call.setAttribute('aria-pressed', String(callState === 'on'));
    call.setAttribute('aria-disabled', String(callState === 'starting'));
    const follow = bar.querySelector<HTMLButtonElement>('[data-act="follow"]')!;
    follow.hidden = status === undefined;
    const following = status?.following === true;
    if (follow.dataset.following !== String(following)) {
        follow.dataset.following = String(following);
        follow.innerHTML = following ? ICON_FOLLOW_ON : ICON_FOLLOW_OFF;
        follow.title = following
            ? 'Following Pi: the editor opens and scrolls to what Pi points at, reads or writes. Typing in the editor stops following. Click to stop.'
            : "Follow Pi: open and scroll the editor to what Pi points at, reads or writes. Not following, Pi's code is only highlighted where it is already on screen.";
        follow.setAttribute('aria-label', following ? 'Stop following Pi' : 'Follow Pi');
        follow.setAttribute('aria-pressed', String(following));
    }
    bar.querySelector<HTMLButtonElement>('[data-act="hush"]')!.hidden = phase !== 'speaking' && phase !== 'synthesizing';
}
