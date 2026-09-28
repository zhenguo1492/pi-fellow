/**
 * Alt gestures on sentences, after EchoRead's modifier selection
 * (echo-read-edge src/content/modules/modifier-selection.ts): holding Alt highlights the sentence
 * under the pointer, Alt+click reads it aloud, Alt+right-click translates it. Where sentences are
 * is each surface's business (the Bot view's transcript, the chat's messages and cards); this
 * module finds the one under the pointer and owns the gestures. Highlights are CSS Custom
 * Highlights (`::highlight(name)`), so no surface's DOM is touched.
 */
import type { VoiceReplayPiece } from '../shared/voiceViewProtocol';
import { replayPieces } from '../voiceAgent/sentences';

/** A sentence, as the gestures act on it. */
export interface PickedSentence {
    surface: SentenceSurface;
    /**
     * The host's key for the text the sentence is in (its audio is cached under it): a Bot view
     * entry id, or the chat paragraph's key.
     */
    entryId: string;
    /** What is read aloud, and where it is in that text (`range`, or `sentence` for a spoken reply). */
    piece: VoiceReplayPiece;
    /** The sentence as shown: what is translated. */
    source: string;
}

/** Text the gestures work on. */
export interface SentenceSurface {
    /** Which view it is, for the host: `bot` sentences belong to a Bot view entry. */
    readonly name: 'bot' | 'chat';
    /** The sentence at a caret, if the caret is in text of this surface. */
    pick(node: Text, offset: number): PickedSentence | undefined;
    /** Where `sentence` is now; undefined once it is no longer shown. */
    rangeOf(sentence: PickedSentence): Range | undefined;
}

/**
 * `hover`: under the pointer while Alt is held; `pinned`: the one whose translation is open;
 * `loading` / `playing`: the one Alt+click reads aloud, before and while it is heard.
 */
export type SentenceHighlight = 'vp-sentence-hover' | 'vp-sentence-pinned' | 'vp-sentence-loading' | 'vp-sentence-playing';

/** Paints `range` as `name`, or clears it. */
export function paintSentence(name: SentenceHighlight, range: Range | undefined): void {
    if (range) {
        CSS.highlights.set(name, new Highlight(range));
    } else {
        CSS.highlights.delete(name);
    }
}

/**
 * The sentence of `text` a caret at `offset` is in (`replayPieces`, so as TTS reads it); a caret
 * between two sentences written without a space belongs to the one after it.
 */
export function pieceAt(text: string, offset: number): VoiceReplayPiece | undefined {
    const pieces = replayPieces(text);
    return pieces.find((p) => offset >= p.range![0] && offset < p.range![1]) ?? pieces.find((p) => offset === p.range![1]);
}

/** The text nodes under `root` in document order, leaving out the subtrees `skip` names. */
export function textNodesIn(root: Element, skip?: (el: Element) => boolean): Text[] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n instanceof Element && n !== root && skip?.(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n instanceof Text) {
            nodes.push(n);
        }
    }
    return nodes;
}

/** A range from `start` to `end` of the text in `nodes` (in order, as one string). */
export function rangeInNodes(nodes: readonly Text[], start: number, end: number): Range | undefined {
    const range = document.createRange();
    let seen = 0;
    let started = false;
    for (const node of nodes) {
        const next = seen + node.length;
        if (!started && start >= seen && start <= next) {
            range.setStart(node, start - seen);
            started = true;
        }
        if (started && end >= seen && end <= next) {
            range.setEnd(node, end - seen);
            return range;
        }
        seen = next;
    }
    return undefined;
}

export interface SentencePickActions {
    /** Whether the gestures are on now; off, Alt is left alone. */
    enabled(): boolean;
    read(sentence: PickedSentence): void;
    translate(sentence: PickedSentence): void;
}

export interface SentencePick {
    /** Finds the sentence under the pointer again after a surface was drawn, which may have replaced its text. */
    refresh(): void;
    /** Alt is held: a sentence may be highlighted. */
    active(): boolean;
}

/**
 * Listens for the gestures over `surfaces`. The body gets `data-sentence-pick` while a sentence is
 * under the pointer with Alt held (the pointer cursor).
 */
export function installSentencePick(surfaces: readonly SentenceSurface[], actions: SentencePickActions): SentencePick {
    let pointer: { x: number; y: number } | undefined;
    let altHeld = false;
    let frame = 0;

    /** The sentence at the viewport point, only when the point is on its text. */
    const sentenceAt = (x: number, y: number): { sentence: PickedSentence; range: Range } | undefined => {
        const caret = document.caretRangeFromPoint(x, y);
        const node = caret?.startContainer;
        if (!caret || !(node instanceof Text)) {
            return undefined;
        }
        for (const surface of surfaces) {
            const sentence = surface.pick(node, caret.startOffset);
            const range = sentence && surface.rangeOf(sentence);
            if (range) {
                // The caret is the nearest one: beside a line's end, or in the gap below the text, it is still found.
                const onText = [...range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
                return onText ? { sentence: sentence!, range } : undefined;
            }
        }
        return undefined;
    };
    const show = (): void => {
        const found = altHeld && pointer && actions.enabled() ? sentenceAt(pointer.x, pointer.y) : undefined;
        paintSentence('vp-sentence-hover', found?.range);
        document.body.toggleAttribute('data-sentence-pick', found !== undefined);
    };
    const release = (): void => {
        altHeld = false;
        show();
    };
    // The gesture's target is found again from the point: the hover may be a frame behind.
    const picked = (e: MouseEvent): PickedSentence | undefined => (e.altKey && actions.enabled() ? sentenceAt(e.clientX, e.clientY)?.sentence : undefined);
    /** Handles the event as the gesture when it is on a sentence; the page's own handlers never see it. */
    const claim = (e: MouseEvent, act?: (sentence: PickedSentence) => void): void => {
        const sentence = picked(e);
        if (sentence) {
            e.preventDefault();
            e.stopPropagation();
            act?.(sentence);
        }
    };

    document.addEventListener(
        'keydown',
        (e) => {
            if (e.key === 'Alt' && !e.repeat && actions.enabled()) {
                // The pointer parked over a sentence, then Alt: highlight it at once.
                e.preventDefault();
                altHeld = true;
                show();
            }
        },
        true,
    );
    document.addEventListener('keyup', (e) => {
        if (e.key === 'Alt') {
            release();
        }
    });
    window.addEventListener('blur', release);
    document.addEventListener(
        'mousemove',
        (e) => {
            pointer = { x: e.clientX, y: e.clientY };
            if (e.altKey !== altHeld) {
                altHeld = e.altKey;
            } else if (!altHeld) {
                return;
            }
            frame ||= requestAnimationFrame(() => {
                frame = 0;
                show();
            });
        },
        { passive: true },
    );
    // Captured before the page's handlers: Alt+press would start a selection or a drag, a click
    // could open a card, a right-click VS Code's context menu.
    document.addEventListener('mousedown', (e) => e.button === 0 && claim(e), true);
    document.addEventListener('click', (e) => e.button === 0 && claim(e, actions.read), true);
    document.addEventListener('contextmenu', (e) => claim(e, actions.translate), true);
    return {
        refresh: () => {
            if (altHeld) {
                show();
            }
        },
        active: () => altHeld,
    };
}
