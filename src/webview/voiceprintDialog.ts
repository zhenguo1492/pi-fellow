/**
 * The voiceprint dialogs of the settings' Voice tab. Enrollment: read the prompted sentences aloud,
 * one recording each, and the voiceprint is saved. Test: each utterance's similarity to the
 * voiceprint, and whether voice input would take it. The extension host records (the webview
 * cannot open the microphone) and reports each recording.
 */
import type { SettingsClientMessage } from '../shared/protocol';
import { MIN_ENROLL_SECS, VOICEPRINT_PROMPTS, type VoiceprintRunEvent } from '../shared/voiceprint';
import { button, openDialog, setStatus } from './voiceDryRun';

type Post = (message: SettingsClientMessage) => void;
type Mode = 'enroll' | 'test';

/** Tags each recording; events of an earlier one (closed or restarted) are ignored. */
let voiceprintRun = 0;

interface Ui {
    mode: Mode;
    status: HTMLElement;
    meter: HTMLElement;
    /** Enrollment: the prompts; test: the results. */
    list: HTMLElement;
    stop: HTMLButtonElement;
    again: HTMLButtonElement;
    running: boolean;
    failed: boolean;
    /** Enrollment: recordings kept so far; saved once they reach the prompts. */
    count: number;
    saved: boolean;
    /** Enrollment: why the last recording was not kept, until one is. */
    note: string;
}

let ui: Ui | undefined;

/** Opens the enrollment (`enroll`) or test dialog and starts recording. */
export function openVoiceprintDialog(mode: Mode, post: Post): void {
    const { body, footer } = openDialog(
        mode === 'enroll' ? 'Record your voiceprint' : 'Test your voiceprint',
        mode === 'enroll' ? `${VOICEPRINT_PROMPTS.length} sentences · on this computer` : 'each utterance compared with your voiceprint',
        () => {
            if (ui?.running) {
                post({ type: 'stopSttDryRun' });
            }
            ui = undefined;
        },
    );
    body.innerHTML =
        mode === 'enroll'
            ? `<p class="voice-dialog-hint">Read each sentence aloud in your normal voice, when nobody else is talking. It moves on by itself; a sentence under ${MIN_ENROLL_SECS} s is asked for again. Another language works as well.</p>
               <ol class="voiceprint-list voiceprint-prompts"></ol>`
            : `<p class="voice-dialog-hint">Talk, then let someone else talk: each utterance shows how much it sounds like your voiceprint and whether voice input takes it.</p>
               <ul class="voiceprint-list voiceprint-results" data-empty="true"></ul>`;
    body.insertAdjacentHTML(
        'beforeend',
        `<p class="voice-dialog-status" role="status"></p>
         <div class="voice-dialog-meter" aria-hidden="true"><span></span></div>`,
    );
    const stop = button('Stop', 'secondary');
    const again = button(mode === 'enroll' ? 'Start over' : 'Test again', 'primary');
    footer.prepend(stop, again);
    const current: Ui = {
        mode,
        status: body.querySelector<HTMLElement>('.voice-dialog-status')!,
        meter: body.querySelector<HTMLElement>('.voice-dialog-meter span')!,
        list: body.querySelector<HTMLElement>('.voiceprint-list')!,
        stop,
        again,
        running: false,
        failed: false,
        count: 0,
        saved: false,
        note: '',
    };
    ui = current;
    const start = () => {
        Object.assign(current, { running: true, failed: false, count: 0, saved: false, note: '' });
        if (mode === 'enroll') {
            current.list.replaceChildren(
                ...VOICEPRINT_PROMPTS.map((prompt) => {
                    const item = document.createElement('li');
                    item.textContent = prompt;
                    return item;
                }),
            );
            renderPrompts(current);
        } else {
            current.list.replaceChildren();
            current.list.dataset.empty = 'true';
        }
        setStatus(current.status, 'busy', 'Starting the microphone (the first time, the voiceprint model downloads)…');
        renderButtons(current);
        post({ type: 'startVoiceprint', run: ++voiceprintRun, mode });
    };
    stop.addEventListener('click', () => post({ type: 'stopSttDryRun' }));
    again.addEventListener('click', start);
    start();
}

function renderButtons(current: Ui): void {
    current.stop.hidden = !current.running;
    current.again.hidden = current.running;
    if (!current.running) {
        current.meter.style.width = '0%';
    }
}

/** Enrollment: sentences read are done, the next one is the one to read. */
function renderPrompts(current: Ui): void {
    current.list.querySelectorAll('li').forEach((item, i) => {
        item.dataset.state = i < current.count ? 'done' : i === current.count && !current.saved ? 'current' : 'pending';
    });
}

function listening(current: Ui): string {
    if (current.mode === 'test') {
        return 'Listening: talk.';
    }
    const next = `Read sentence ${Math.min(current.count + 1, VOICEPRINT_PROMPTS.length)} of ${VOICEPRINT_PROMPTS.length} aloud.`;
    return current.note ? `${current.note} ${next}` : next;
}

function addResult(current: Ui, event: Extract<VoiceprintRunEvent, { kind: 'match' }>): void {
    const item = document.createElement('li');
    item.dataset.accepted = String(event.accepted);
    const seconds = `${event.seconds.toFixed(1)} s`;
    item.textContent =
        event.similarity === undefined || event.threshold === undefined
            ? `${seconds}: too short to check, taken`
            : `${seconds}: similarity ${event.similarity.toFixed(2)} ${event.accepted ? '≥' : '<'} ${event.threshold.toFixed(2)}, ${event.accepted ? 'your voice, taken' : 'not your voice, dropped'}`;
    current.list.dataset.empty = 'false';
    current.list.prepend(item);
}

export function applyVoiceprintRun(run: number, event: VoiceprintRunEvent): void {
    const current = ui;
    if (!current || run !== voiceprintRun) {
        return;
    }
    switch (event.kind) {
        case 'status': {
            const s = event.status;
            if (current.failed || current.saved) {
                break;
            }
            if (s.pending > 0) {
                setStatus(current.status, 'busy', current.mode === 'enroll' ? 'Taking in your voice…' : 'Comparing…');
            } else if (s.speaking) {
                setStatus(current.status, 'busy', 'Hearing you…');
            } else if (s.recording) {
                setStatus(current.status, 'busy', listening(current));
            }
            break;
        }
        case 'level':
            current.meter.style.width = `${Math.round(Math.min(1, Math.max(0, event.level)) * 100)}%`;
            break;
        case 'sample':
            current.count = event.count;
            current.note = event.ok ? '' : `That was ${event.seconds.toFixed(1)} s, too short: read the whole sentence.`;
            renderPrompts(current);
            setStatus(current.status, 'busy', listening(current));
            break;
        case 'saved': {
            current.saved = true;
            renderPrompts(current);
            const odd = event.consistency < 0.5;
            setStatus(
                current.status,
                'ok',
                `Voiceprint saved from ${event.samples} recordings and turned on: voice input now takes only your voice.` +
                    (odd ? ` One recording sounds unlike the others (similarity ${event.consistency.toFixed(2)}): if your voice gets dropped, start over when it is quiet.` : ''),
            );
            break;
        }
        case 'match':
            addResult(current, event);
            break;
        case 'error':
            current.failed = true;
            setStatus(current.status, 'error', event.message);
            break;
        case 'ended':
            current.running = false;
            if (!current.failed && !current.saved) {
                setStatus(
                    current.status,
                    'idle',
                    current.mode === 'enroll' ? 'Stopped before the last sentence: nothing was saved.' : 'Stopped.',
                );
            }
            renderButtons(current);
            break;
    }
}
