/**
 * Dry-run dialogs of the settings' Voice tab. The extension host does the work (the webview cannot
 * open the microphone): STT records one sentence and the transcript shows here; TTS synthesizes a
 * text and the WAV comes back as a data URL for an <audio> player.
 */
import type { SettingsClientMessage, SettingsServerMessage, SttDryRunEvent, VoiceSettings } from '../shared/protocol';
import type { TtsConfig } from '../voiceAgent/tts';

type Post = (message: SettingsClientMessage) => void;
type TtsResult = Extract<SettingsServerMessage, { type: 'ttsDryRunResult' }>;

const DEFAULT_TTS_TEXT = 'Hello, this is a text-to-speech test.';

let closeCurrent: (() => void) | undefined;
/** Tags each STT recording; events of an earlier one (closed or restarted) are ignored. */
let sttRun = 0;

interface SttUi {
    status: HTMLElement;
    meter: HTMLElement;
    transcript: HTMLElement;
    stop: HTMLButtonElement;
    again: HTMLButtonElement;
    running: boolean;
    heard: boolean;
    failed: boolean;
}

interface TtsUi {
    status: HTMLElement;
    player: HTMLElement;
    synthesize: HTMLButtonElement;
}

let stt: SttUi | undefined;
let tts: TtsUi | undefined;

function button(label: string, className: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `setting-btn ${className}`;
    b.textContent = label;
    return b;
}

/** Opens a modal (closing any other); Escape, the × and a click on the backdrop close it. */
function openDialog(title: string, meta: string, onClose: () => void): { body: HTMLElement; footer: HTMLElement } {
    closeCurrent?.();
    const backdrop = document.createElement('div');
    backdrop.className = 'voice-dialog-backdrop';
    backdrop.innerHTML = `
        <div class="voice-dialog" role="dialog" aria-modal="true" aria-labelledby="voice-dialog-title">
            <div class="voice-dialog-header">
                <h3 id="voice-dialog-title"></h3>
                <button type="button" class="voice-dialog-close" aria-label="Close">×</button>
            </div>
            <p class="voice-dialog-meta"></p>
            <div class="voice-dialog-body"></div>
            <div class="voice-dialog-footer"></div>
        </div>`;
    backdrop.querySelector('h3')!.textContent = title;
    backdrop.querySelector('.voice-dialog-meta')!.textContent = meta;
    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            close();
        }
    };
    const close = () => {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        closeCurrent = undefined;
        onClose();
    };
    backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) {
            close();
        }
    });
    backdrop.querySelector('.voice-dialog-close')!.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    closeCurrent = close;
    const footer = backdrop.querySelector<HTMLElement>('.voice-dialog-footer')!;
    const done = button('Close', 'secondary');
    done.addEventListener('click', close);
    footer.appendChild(done);
    return { body: backdrop.querySelector<HTMLElement>('.voice-dialog-body')!, footer };
}

function setStatus(el: HTMLElement, state: 'busy' | 'ok' | 'error' | 'idle', text: string): void {
    el.dataset.state = state;
    el.textContent = text;
}

// ── Speech-to-text ─────────────────────────────────────────────────────────

/** `apiKey`: one typed in the settings but not stored, used instead of the stored key. */
export function openSttDryRun(settings: VoiceSettings, apiKey: string | undefined, post: Post): void {
    const meta = (settings.sttEngine === 'builtin'
        ? ['built-in engine (Moonshine, English)']
        : [settings.sttUrl || '(no URL)', settings.sttModel || 'first model at /models']
    ).concat(`language ${settings.language || 'auto'}`).join(' · ');
    const { body, footer } = openDialog('Speech-to-text dry run', meta, () => {
        if (stt?.running) {
            post({ type: 'stopSttDryRun' });
        }
        stt = undefined;
    });
    body.innerHTML = `
        <p class="voice-dialog-hint">Say one sentence. Listening stops after the first transcript.</p>
        <p class="voice-dialog-status" role="status"></p>
        <div class="voice-dialog-meter" aria-hidden="true"><span></span></div>
        <div class="voice-dialog-transcript" aria-live="polite"></div>`;
    const stop = button('Stop', 'secondary');
    const again = button('Record again', 'primary');
    footer.prepend(stop, again);
    stt = {
        status: body.querySelector<HTMLElement>('.voice-dialog-status')!,
        meter: body.querySelector<HTMLElement>('.voice-dialog-meter span')!,
        transcript: body.querySelector<HTMLElement>('.voice-dialog-transcript')!,
        stop,
        again,
        running: false,
        heard: false,
        failed: false,
    };
    const start = () => {
        if (!stt) return;
        stt.running = true;
        stt.heard = false;
        stt.failed = false;
        stt.transcript.textContent = '';
        stt.transcript.dataset.empty = 'true';
        setStatus(stt.status, 'busy', 'Starting the microphone…');
        renderSttButtons();
        post({ type: 'startSttDryRun', run: ++sttRun, settings, apiKey });
    };
    stop.addEventListener('click', () => post({ type: 'stopSttDryRun' }));
    again.addEventListener('click', start);
    start();
}

function renderSttButtons(): void {
    if (!stt) return;
    stt.stop.hidden = !stt.running;
    stt.again.hidden = stt.running;
    if (!stt.running) {
        stt.meter.style.width = '0%';
    }
}

export function applySttDryRun(run: number, event: SttDryRunEvent): void {
    if (!stt || run !== sttRun) return;
    switch (event.kind) {
        case 'status': {
            const s = event.status;
            if (stt.failed) break;
            if (s.pending > 0) {
                setStatus(stt.status, 'busy', 'Transcribing…');
            } else if (s.speaking) {
                setStatus(stt.status, 'busy', 'Hearing you…');
            } else if (s.recording) {
                setStatus(stt.status, 'busy', 'Listening: say a sentence.');
            }
            break;
        }
        case 'level':
            stt.meter.style.width = `${Math.round(Math.min(1, Math.max(0, event.level)) * 100)}%`;
            break;
        case 'text': {
            stt.heard = true;
            stt.transcript.dataset.empty = 'false';
            const line = document.createElement('p');
            line.textContent = event.text;
            stt.transcript.appendChild(line);
            break;
        }
        case 'error':
            stt.failed = true;
            setStatus(stt.status, 'error', event.message);
            break;
        case 'ended':
            stt.running = false;
            if (!stt.failed) {
                setStatus(
                    stt.status,
                    stt.heard ? 'ok' : 'idle',
                    stt.heard ? 'Done: this is what the service heard.' : 'Nothing was transcribed. Record again and speak up.',
                );
            }
            renderSttButtons();
            break;
    }
}

// ── Text-to-speech ─────────────────────────────────────────────────────────

export function openTtsDryRun(settings: TtsConfig, apiKey: string | undefined, post: Post): void {
    const meta = (settings.engine === 'builtin'
        ? ['built-in engine (Piper, English)']
        : [settings.url || '(no URL)', settings.model || 'server model', `voice ${settings.voice || 'server default'}`, `language ${settings.languageField}`]
    ).concat(`speed ${settings.speed}`).join(' · ');
    const { body, footer } = openDialog('Text-to-speech dry run', meta, () => {
        tts = undefined;
    });
    body.innerHTML = `
        <label class="voice-dialog-hint" for="voice-dialog-text">Text to speak</label>
        <textarea id="voice-dialog-text" class="voice-dialog-text" rows="3"></textarea>
        <p class="voice-dialog-status" role="status"></p>
        <div class="voice-dialog-player"></div>`;
    const text = body.querySelector<HTMLTextAreaElement>('textarea')!;
    text.value = DEFAULT_TTS_TEXT;
    const synthesize = button('Synthesize', 'primary');
    footer.prepend(synthesize);
    tts = {
        status: body.querySelector<HTMLElement>('.voice-dialog-status')!,
        player: body.querySelector<HTMLElement>('.voice-dialog-player')!,
        synthesize,
    };
    const run = () => {
        if (!tts || synthesize.disabled) return;
        synthesize.disabled = true;
        tts.player.textContent = '';
        setStatus(tts.status, 'busy', 'Synthesizing…');
        post({ type: 'ttsDryRun', settings, text: text.value, apiKey });
    };
    synthesize.addEventListener('click', run);
    text.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            run();
        }
    });
    text.focus();
    text.select();
}

export function applyTtsDryRunResult(result: TtsResult): void {
    if (!tts) return;
    tts.synthesize.disabled = false;
    if (!result.ok) {
        setStatus(tts.status, 'error', result.message);
        return;
    }
    setStatus(tts.status, 'ok', `${result.seconds.toFixed(1)} s of audio, synthesized in ${(result.elapsedMs / 1000).toFixed(1)} s.`);
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = result.audio;
    tts.player.replaceChildren(audio);
}
