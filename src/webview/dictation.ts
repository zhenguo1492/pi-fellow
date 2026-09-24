/**
 * Composer mic button: toggles host-side dictation (the webview itself cannot
 * open the microphone) and inserts transcripts at the caret.
 */
import type { DictationStatus } from '../shared/protocol';
import { vscode } from './vscodeApi';

const MIC_BUTTON_ID = 'btn-mic';
const SHORTCUT = navigator.userAgent.includes('Mac') ? '⌘⌥M' : 'Ctrl+Alt+M';
/** Waveform bars; each shows one level report, newest on the right. */
const WAVE_BARS = 5;
/** Bar height at silence, so the waveform reads as "listening" rather than empty. */
const WAVE_MIN_SCALE = 0.18;

let status: DictationStatus = { recording: false, speaking: false, pending: 0 };
let levels: number[] = new Array(WAVE_BARS).fill(0);
let isSttValid = false;

export function setSttValid(valid: boolean): void {
    isSttValid = valid;
    renderMicButton();
}

export const micButtonHtml = `
    <button id="${MIC_BUTTON_ID}" class="composer-action-btn composer-action-btn--ghost mic-btn" type="button" hidden>
        <svg class="mic-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="1.75" width="5" height="8" rx="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M3.25 7.5a4.75 4.75 0 009.5 0M8 12.25v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <span class="mic-wave" aria-hidden="true">${'<span class="mic-wave-bar"></span>'.repeat(WAVE_BARS)}</span>
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
        vscode.postMessage({ type: 'toggleDictation' });
    });
    renderMicButton();
}

export function applyDictationStatus(next: DictationStatus): void {
    status = next;
    renderMicButton();
}

/** Shifts one level report (0..1) into the waveform. */
export function applyDictationLevel(level: number): void {
    levels = [...levels.slice(1), level];
    renderWave();
}

function renderWave(): void {
    const bars = document.querySelectorAll<HTMLElement>(`#${MIC_BUTTON_ID} .mic-wave-bar`);
    bars.forEach((bar, i) => {
        bar.style.transform = `scaleY(${(WAVE_MIN_SCALE + (1 - WAVE_MIN_SCALE) * (levels[i] ?? 0)).toFixed(3)})`;
    });
}

function renderMicButton(): void {
    const btn = document.getElementById(MIC_BUTTON_ID);
    if (!btn) {
        return;
    }
    btn.hidden = !isSttValid;
    btn.classList.toggle('is-recording', status.recording);
    btn.classList.toggle('is-speaking', status.speaking);
    btn.classList.toggle('is-pending', status.pending > 0);
    renderStatusLine();
    if (!status.recording) {
        levels = levels.map(() => 0);
        renderWave();
    }
    const label = status.recording
        ? `Stop voice input (${SHORTCUT})`
        : status.pending > 0
          ? 'Transcribing…'
          : `Voice input (${SHORTCUT})`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', status.recording ? 'true' : 'false');
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
