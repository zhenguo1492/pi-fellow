/**
 * Composer mic button. Voice agent off: it toggles host-side dictation (the webview itself cannot
 * open the microphone): recording, it is a green stop button; stopped, it spins, disabled, until
 * what was said is transcribed and inserted at the caret. Voice agent on: it owns the microphone,
 * the mic is green while open and a click mutes it. It also decides which lines of the voice bar's
 * waveform show (voiceWave.ts): the microphone's while open, the bot's while it speaks.
 */
import type { DictationStatus, VoiceServiceCheck } from '../shared/protocol';
import { voiceIsOn, type VoiceStatus } from '../shared/voiceViewProtocol';
import { setWaveOpen } from './voiceWave';
import { vscode } from './vscodeApi';

const MIC_BUTTON_ID = 'btn-mic';

let status: DictationStatus = { recording: false, speaking: false, pending: 0 };
/** The STT service's check; absent until the host reports it (the mic stays hidden until then). */
let stt: VoiceServiceCheck | undefined;
/** The voice agent's state; while it is on or starting it owns the microphone. */
let voice: VoiceStatus | undefined;

export function setSttCheck(next: VoiceServiceCheck): void {
    stt = next;
    renderMicButton();
}

export function applyVoiceMicStatus(next: VoiceStatus | undefined): void {
    voice = next;
    renderMicButton();
}

const MIC_PATH = '<rect x="5.5" y="1.75" width="5" height="8" rx="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M3.25 7.5a4.75 4.75 0 009.5 0M8 12.25v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';

export const micButtonHtml = `
    <button id="${MIC_BUTTON_ID}" class="composer-action-btn composer-action-btn--ghost mic-btn" type="button" hidden>
        <svg class="mic-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">${MIC_PATH}</svg>
        <svg class="mic-off-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">${MIC_PATH}<path d="M2.5 1.5l11 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <svg class="mic-stop-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>
        <svg class="mic-busy-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5" opacity=".25"/><path d="M13.5 8A5.5 5.5 0 008 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>`;

const STATUS_ID = 'dictation-status';

/** Composer-footer line saying what dictation is doing, so the gap between speaking and text appearing is visible. */
export const dictationStatusHtml = `
    <span id="${STATUS_ID}" class="dictation-status" role="status" aria-live="polite" hidden>
        <span class="dictation-status-icon" aria-hidden="true"></span><span class="dictation-status-text"></span>
    </span>`;

/** Wires the mic button; call once the composer skeleton exists. */
export function bindMicButton(): void {
    const btn = document.getElementById(MIC_BUTTON_ID);
    if (!btn) {
        return;
    }
    // Keep focus (and the caret transcripts are inserted at) in the textarea.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!voiceIsOn(voice)) {
            vscode.postMessage({ type: 'toggleDictation' });
        } else if (voice && voice.phase !== 'standby' && !voice.starting) {
            vscode.postMessage({ type: 'voiceAgent', action: { type: 'mute', muted: !voice.muted } });
        }
    });
    renderMicButton();
}

export function applyDictationStatus(next: DictationStatus): void {
    status = next;
    renderMicButton();
}

function renderMicButton(): void {
    const btn = document.getElementById(MIC_BUTTON_ID) as HTMLButtonElement | null;
    if (!btn) {
        return;
    }
    if (voice && voiceIsOn(voice)) {
        renderVoiceMic(btn, voice);
        return;
    }
    // Unusable without a working STT service: red, and the tooltip says why. A click still reaches
    // the host, which repeats the reason and opens Settings → Voice.
    const unavailable = stt?.ok !== true;
    // Stopped with speech still being transcribed: a spinner, and no new recording until it lands.
    const busy = !status.recording && status.pending > 0;
    btn.hidden = stt === undefined;
    btn.disabled = busy;
    btn.classList.remove('is-voice', 'is-muted');
    btn.classList.toggle('is-unavailable', unavailable);
    btn.setAttribute('aria-disabled', String(unavailable || busy));
    // Recording: a green stop button; a click stops it and transcribes what was said.
    btn.classList.toggle('is-recording', status.recording);
    btn.classList.toggle('is-live', status.recording);
    btn.classList.toggle('is-speaking', status.speaking);
    btn.classList.toggle('is-busy', busy);
    btn.setAttribute('aria-busy', String(busy));
    renderStatusLine();
    setWaveOpen({ user: status.recording, bot: false });
    const label = unavailable
        ? (stt?.reason ?? 'Speech-to-text is unavailable.')
        : status.recording
          ? 'Stop voice input and transcribe'
          : busy
            ? 'Transcribing…'
            : 'Voice input';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', status.recording ? 'true' : 'false');
}

/**
 * Voice mode: the mic is green while open; a click mutes (mic-off icon) or unmutes it. Without STT
 * voice mode never opens the microphone: the button is disabled and says why.
 */
function renderVoiceMic(btn: HTMLButtonElement, v: VoiceStatus): void {
    const deaf = v.unavailable?.stt;
    // Starting, another window has the voice, or nothing to hear with: nothing to mute here.
    const idle = v.starting || v.phase === 'standby' || deaf !== undefined;
    const open = !v.muted && !idle;
    btn.hidden = false;
    btn.disabled = idle;
    btn.classList.add('is-voice');
    btn.classList.remove('is-unavailable', 'is-recording', 'is-busy');
    btn.setAttribute('aria-busy', 'false');
    btn.removeAttribute('aria-disabled');
    btn.classList.toggle('is-muted', v.muted);
    btn.classList.toggle('is-live', open);
    btn.classList.toggle('is-speaking', open && v.phase === 'userSpeaking');
    // The robot status line says what the voice agent is doing.
    const line = document.getElementById(STATUS_ID);
    if (line) {
        line.hidden = true;
    }
    // Without TTS nothing plays, so the bot's line never opens either (its phase is never speaking).
    setWaveOpen({ user: open, bot: v.phase === 'speaking' });
    const label = v.starting
        ? 'The voice agent is starting'
        : deaf !== undefined
          ? `The voice agent can't hear: ${deaf} Type to it instead.`
          : v.phase === 'standby'
            ? 'Another VS Code window has the microphone'
            : v.muted
              ? 'Unmute the microphone'
              : 'Mute the microphone';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', v.muted ? 'true' : 'false');
}

function renderStatusLine(): void {
    const line = document.getElementById(STATUS_ID);
    const text = line?.querySelector('.dictation-status-text');
    if (!line || !text) {
        return;
    }
    // Transcribing wins: it is the wait the user cannot otherwise see.
    const state = status.pending > 0 ? 'transcribing' : status.speaking ? 'speaking' : status.recording ? 'listening' : '';
    line.hidden = state === '';
    line.dataset.state = state;
    text.textContent =
        state === 'transcribing'
            ? status.pending > 1
                ? `Transcribing ${status.pending} clips…`
                : 'Transcribing…'
            : state === 'speaking'
              ? 'Hearing speech…'
              : 'Listening…';
}

/** Scripts written without spaces between words. */
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/** Inserts one transcribed utterance at the composer caret, spaced like typed text. */
export function insertDictatedText(text: string): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input || !text) {
        return;
    }
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const prev = input.value.charAt(start - 1);
    const first = text.charAt(0);
    const space =
        prev !== '' && !/\s/.test(prev) && !CJK.test(prev) && !CJK.test(first) && !/[,.!?;:)\]}]/.test(first);
    input.setRangeText(space ? ` ${text}` : text, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
}
