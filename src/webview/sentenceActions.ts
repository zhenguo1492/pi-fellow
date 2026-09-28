/**
 * Reading aloud and translating sentences with Alt (`voiceAgent.messageButtons`), wherever the
 * webview shows them: the Bot view and the chat's messages and cards (the surfaces). Holds what
 * the host says about them (`sentenceActions`: on or off, the language, the sentence being read),
 * asks the host to read or translate, plays what it reads when voice mode is off, and highlights
 * the sentence being read. The gestures are sentencePick.ts, the translation translatePopup.ts.
 */
import type { ClientMessage } from '../shared/protocol';
import type { VoiceViewClientMessage, VoiceViewHostMessage } from '../shared/voiceViewProtocol';
import { installSentencePick, paintSentence, type PickedSentence, type SentencePick, type SentenceSurface } from './sentencePick';
import { showToast } from './chat/toast';
import { createTranslationPopup } from './translatePopup';
import { vscode } from './vscodeApi';

function post(message: VoiceViewClientMessage): void {
    vscode.postMessage({ type: 'voice', message } satisfies ClientMessage);
}

let current: Extract<VoiceViewHostMessage, { type: 'sentenceActions' }> = { type: 'sentenceActions', enabled: false, translateTo: '' };
/** The sentence last sent to be read aloud: where the host's `replay` is shown. */
let reading: PickedSentence | undefined;

let pick: SentencePick | undefined;
const popup = createTranslationPopup({
    target: () => current.translateTo,
    request: (requestId, text, to) => post({ type: 'translate', requestId, text, to }),
});

/** Highlights `reading` while the host reads it: `loading` until it is heard, then `playing`. */
function paintReplay(): void {
    const replay = current.replay;
    const same =
        reading !== undefined &&
        replay !== undefined &&
        replay.entryId === reading.entryId &&
        replay.piece.text === reading.piece.text &&
        replay.piece.sentence === reading.piece.sentence &&
        replay.piece.range?.join() === reading.piece.range?.join();
    const range = same ? reading!.surface.rangeOf(reading!) : undefined;
    paintSentence('vp-sentence-loading', replay?.phase !== 'playing' ? range : undefined);
    paintSentence('vp-sentence-playing', replay?.phase === 'playing' ? range : undefined);
}

let frame = 0;
/** After a surface was drawn: finds the highlighted sentences again (their text may be new nodes). */
function refresh(): void {
    frame ||= requestAnimationFrame(() => {
        frame = 0;
        pick?.refresh();
        popup.refresh();
        paintReplay();
    });
}

/** Starts the gestures over `surfaces`; once, at startup. */
export function installSentenceActions(surfaces: readonly SentenceSurface[]): void {
    pick = installSentencePick(surfaces, {
        enabled: () => current.enabled,
        read: (sentence) => {
            // Created on the click, so the webview lets it play.
            replayAudio ??= new AudioContext();
            void replayAudio.resume();
            reading = sentence;
            post({ type: 'replay', entryId: sentence.entryId, piece: sentence.piece, surface: sentence.surface.name });
        },
        translate: (sentence) => popup.open(sentence),
    });
    // Surfaces redraw on their own schedules (snapshots, state syncs, streaming); only what is
    // highlighted needs finding again, and only while something is.
    new MutationObserver(() => {
        if (pick?.active() || popup.isOpen() || current.replay) {
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
            }
            if (!msg.replay) {
                reading = undefined;
            }
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
