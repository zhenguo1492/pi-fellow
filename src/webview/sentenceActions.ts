/**
 * Reading aloud and translating sentences with Alt (`voiceAgent.messageButtons`), wherever the
 * webview shows them: the Bot view and the chat's messages and cards (the surfaces). Holds what
 * the host says about them (`sentenceActions`: on or off, the language, the read in progress),
 * asks the host to read or translate, and plays what it reads when voice mode is off. The gestures
 * are sentencePick.ts, the bar over a mouse selection selectionToolbar.ts, the picked text (the
 * region), its highlights and playback control readAlong.ts, the translation translatePopup.ts.
 */
import type { ClientMessage } from '../shared/protocol';
import type { VoiceViewClientMessage, VoiceViewHostMessage } from '../shared/voiceViewProtocol';
import { installSentencePick, type PickedSentence, type SentencePick, type SentenceSurface } from './sentencePick';
import { showToast } from './chat/toast';
import { createReadAlong } from './readAlong';
import { installSelectionToolbar, type SelectionToolbar } from './selectionToolbar';
import { createTranslationPopup } from './translatePopup';
import { vscode } from './vscodeApi';

function post(message: VoiceViewClientMessage): void {
    vscode.postMessage({ type: 'voice', message } satisfies ClientMessage);
}

let current: Extract<VoiceViewHostMessage, { type: 'sentenceActions' }> = { type: 'sentenceActions', enabled: false, translateTo: '' };

let pick: SentencePick | undefined;
let toolbar: SelectionToolbar | undefined;
const popup = createTranslationPopup({
    target: () => current.translateTo,
    request: (requestId, text, to) => post({ type: 'translate', requestId, text, to }),
});
/** Reads `sentence` aloud (from `fraction` into its sentence `part`, else from its start); it becomes the region. */
function read(sentence: PickedSentence, from?: { part: number; fraction: number }): void {
    // Created on the click, so the webview lets it play.
    replayAudio ??= new AudioContext();
    void replayAudio.resume();
    readAlong.start(sentence);
    post({ type: 'replay', entryId: sentence.entryId, piece: sentence.piece, surface: sentence.surface.name, from });
}
/** The picked text: its highlights, and the region as a playback control. */
const readAlong = createReadAlong({ post, read, translate: popup.open });

let frame = 0;
/** After a surface was drawn: finds the highlighted sentences again (their text may be new nodes). */
function refresh(): void {
    frame ||= requestAnimationFrame(() => {
        frame = 0;
        pick?.refresh();
        popup.refresh();
        readAlong.refresh();
    });
}

/** Starts the gestures and the selection bar over `surfaces`; once, at startup. */
export function installSentenceActions(surfaces: readonly SentenceSurface[]): void {
    const enabled = (): boolean => current.enabled;
    pick = installSentencePick(surfaces, {
        enabled,
        read,
        // Alt+right-click picks the text too: a click reads it, a right-click translates it again.
        translate: (sentence) => {
            readAlong.select(sentence);
            popup.open(sentence);
        },
    });
    toolbar = installSelectionToolbar(surfaces, { enabled, read, translate: popup.open });
    // Surfaces redraw on their own schedules (snapshots, state syncs, streaming); only what is
    // highlighted needs finding again, and only while something is.
    new MutationObserver(() => {
        if (pick?.active() || popup.isOpen() || readAlong.shown() || current.replay) {
            refresh();
        }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
}

/** The host's messages about sentences: every voice message but the Bot view's snapshot. */
export function handleSentenceMessage(msg: Exclude<VoiceViewHostMessage, { type: 'state' }>): void {
    switch (msg.type) {
        case 'sentenceActions':
            current = msg;
            if (!msg.enabled) {
                popup.close();
                toolbar?.hide();
                readAlong.clear();
            }
            readAlong.update(msg.replay);
            refresh();
            return;
        case 'translation':
            popup.answer(msg.requestId, msg.result);
            return;
        case 'replayError':
            showToast(`Could not read it aloud: ${msg.message}`, 'error');
            return;
        case 'replayAudio':
            playReplayClip(msg.clipId, msg.rate, msg.pcm);
            return;
        case 'replayHalt':
            haltReplay();
            return;
    }
}

// ── Replay audio without voice mode ──

/**
 * Web Audio for replays while voice mode is off. The host sends the sentence's audio; it reports
 * when it really starts (which moves the highlight) and ends, as voice mode's audio page does.
 */
let replayAudio: AudioContext | undefined;
let replayQueueEnd = 0;
const replayClips = new Map<number, { source: AudioBufferSourceNode; mark: ConstantSourceNode }>();

function playReplayClip(clipId: number, rate: number, base64: string): void {
    try {
        const ctx = (replayAudio ??= new AudioContext());
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
        const buffer = ctx.createBuffer(1, pcm.length, rate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) {
            channel[i] = pcm[i] / 32768;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        const at = Math.max(ctx.currentTime + 0.02, replayQueueEnd);
        source.start(at);
        replayQueueEnd = at + buffer.duration;
        // A silent source that ends as the clip starts: its onended runs on the audio clock (as on the audio page).
        const mark = ctx.createConstantSource();
        mark.offset.value = 0;
        mark.connect(ctx.destination);
        mark.start();
        mark.stop(at);
        mark.onended = () => post({ type: 'replayClipStarted', clipId });
        source.onended = () => {
            replayClips.delete(clipId);
            post({ type: 'replayClipEnded', clipId });
        };
        replayClips.set(clipId, { source, mark });
    } catch {
        post({ type: 'replayClipEnded', clipId });
    }
}

/** Stops the replay's clips without reporting them: the host already let them go. */
function haltReplay(): void {
    for (const { source, mark } of replayClips.values()) {
        source.onended = null;
        mark.onended = null;
        for (const node of [source, mark]) {
            try {
                node.stop();
            } catch {
                // never started
            }
        }
    }
    replayClips.clear();
    replayQueueEnd = 0;
}
