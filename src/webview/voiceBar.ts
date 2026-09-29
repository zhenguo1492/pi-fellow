/**
 * The voice agent's place in the composer (docs/voice-agent-design.md §11): a robot status line
 * over the input box, and where typed text goes. The robot and its label are one button. Voice agent
 * off: it starts it. On: the label says what it is doing (listening, thinking, …) and a click stops it.
 * Either way a click also switches the tab to the Bot view, if it is not showing it already.
 * The follow button next to it sets whether the editor follows Pi's focus (docs/voice-pair-agent-cursor.md).
 * A speech service that does not work does not keep it offline: it runs without it (design §5.13),
 * and a grey tag says so ("Can't hear", "No voice"; a click opens Settings → Voice).
 * The composer talks to what the tab shows: its conversation → the omp worker, the Bot view → the
 * voice agent (offline: nobody, the composer is locked).
 */
import type { VoiceReadiness } from '../shared/protocol';
import { voiceIsOn, type VoiceAgentAction, type VoicePhase, type VoiceStatus } from '../shared/voiceViewProtocol';
import { DEFAULT_SPEAKER_NAMES } from '../shared/voiceSpeakers';
import { ICON_ROBOT } from './avatar';
import { voiceWaveHtml } from './voiceWave';
import { vscode } from './vscodeApi';

const BAR_ID = 'voice-bar';

const ICON_HUSH =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 6l3.5 4M14.5 6L11 10"/></svg>';
/** Page of dotted entries, one per line: the voice agent's conversation, the Bot view. */
const ICON_LOG =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="1.75" width="11" height="12.5" rx="1.5"/><path d="M7 5.25h4M7 8h4M7 10.75h2.5"/><circle cx="5" cy="5.25" r=".75" fill="currentColor" stroke="none"/><circle cx="5" cy="8" r=".75" fill="currentColor" stroke="none"/><circle cx="5" cy="10.75" r=".75" fill="currentColor" stroke="none"/></svg>';
/** Speech bubble: the worker's conversation, shown instead of the Bot view. */
const ICON_CHAT =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7.5L4.5 14v-2.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5z"/></svg>';
/** Crosshair, like a map's "follow my location": filled centre while the editor follows Pi, hollow otherwise. */
const ICON_FOLLOW_ON =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="4.75"/><path d="M8 1v2.25M8 12.75V15M1 8h2.25M12.75 8H15"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/></svg>';
const ICON_FOLLOW_OFF =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="4.75"/><path d="M8 1v2.25M8 12.75V15M1 8h2.25M12.75 8H15"/></svg>';

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

const PHASE_TITLE: Record<ShownPhase, string> = {
    off: 'Start the voice agent: talk with it, or type to it in the Bot view.',
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
    <button type="button" class="voice-bar-toggle" data-act="robot">
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
            case 'robot': {
                const stopping = !status?.starting && voiceIsOn(status);
                if (!status?.starting) {
                    post({ type: stopping ? 'stop' : 'start' });
                }
                // Starting shows the voice agent's conversation (Bot view); stopping goes back to the worker's.
                if (stopping ? botViewShown : !botViewShown) {
                    vscode.postMessage({ type: 'toggleBotView' });
                }
                return;
            }
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

/**
 * The log button switches the active tab between the worker's conversation, or its TUI (`tuiTab`), and
 * the Bot view; it shows which one a click brings.
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
    bar.querySelector<HTMLElement>('.voice-bar-muted')!.hidden = !muted;
    // Set only when it changed (also on a rebuilt bar): re-parsing it would restart the starting pulse.
    const robot = bar.querySelector<HTMLElement>('.voice-bar-robot')!;
    if (robot.dataset.version !== String(robotVersion)) {
        robot.dataset.version = String(robotVersion);
        robot.innerHTML = robotHtml;
    }
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
    const toggle = bar.querySelector<HTMLButtonElement>('[data-act="robot"]')!;
    const action = status?.starting ? 'The voice agent is starting…' : on ? 'Stop the voice agent' : 'Start the voice agent';
    const phaseTitle = deaf && idle
        ? "The voice agent is on and waiting. It can't hear you: type to it in the Bot view."
        : muted && idle
          ? 'The voice agent is on and waiting; type to it, or unmute to talk.'
          : voiceless && phase === 'thinking'
            ? 'The voice model is working on a reply; it shows as text in the Bot view.'
            : PHASE_TITLE[phase];
    toggle.title = status?.starting
        ? 'The voice agent is starting: microphone, speech services and voice model.'
        : on
          ? `${phaseTitle}\nClick to stop the voice agent.`
          : PHASE_TITLE.off;
    toggle.setAttribute('aria-label', action);
    toggle.setAttribute('aria-pressed', String(on));
    toggle.setAttribute('aria-disabled', String(status?.starting === true));
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
    const panel = bar.querySelector<HTMLButtonElement>('[data-act="panel"]')!;
    const panelKey = `${botViewShown}:${botViewOverTui}`;
    if (panel.dataset.shown !== panelKey) {
        panel.dataset.shown = panelKey;
        panel.innerHTML = botViewShown ? ICON_CHAT : ICON_LOG;
        const panelTitle = !botViewShown
            ? 'Show the voice agent conversation in this tab (Bot view: conversation, engines, token use)'
            : botViewOverTui
              ? 'Back to the terminal (TUI); it kept running'
              : 'Back to the worker conversation';
        panel.title = panelTitle;
        panel.setAttribute('aria-label', panelTitle);
        panel.setAttribute('aria-pressed', String(botViewShown));
    }
}
