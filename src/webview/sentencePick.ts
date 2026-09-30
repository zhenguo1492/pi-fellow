/**
 * Alt gestures on sentences, after EchoRead's modifier selection
 * (echo-read-edge src/content/modules/modifier-selection.ts): holding Alt highlights the sentence
 * under the pointer, Alt+click reads it aloud, Alt+right-click translates it. Adding Shift
 * (Alt+Shift) does the same with the whole paragraph; letting Shift go while Alt is still held
 * goes back to the sentence. Where sentences and paragraphs are is each surface's business (the
 * Bot view's transcript, the chat's messages and cards); this module finds the one under the
 * pointer and owns the gestures. Highlights are CSS Custom Highlights (`::highlight(name)`), so no
 * surface's DOM is touched.
 */
import type { VoiceReplayPiece } from '../shared/voiceViewProtocol';
import { replayPieces } from '../voiceAgent/sentences';

/** A sentence (or a paragraph, or a selection), as the gestures act on it. */
export interface PickedSentence {
    surface: SentenceView;
    /**
     * The host's key for the text the sentence is in (its audio is cached under it): a Bot view
     * entry id, the chat paragraph's key, or the selection's.
     */
    entryId: string;
    /** What is read aloud, and where it is in that text (`range`, or `sentence` for a spoken reply). */
    piece: VoiceReplayPiece;
    /** The sentence as shown: what is translated. */
    source: string;
    /**
     * Several sentences read one after another (a paragraph, a selection): each of them, in the
     * order of `piece.parts`, with where it is (the read-along highlights the one being read).
     */
    parts?: readonly PickedSentence[];
}

/** Where picked text is shown, and which view that is for the host. */
export interface SentenceView {
    /** `bot` sentences belong to a Bot view entry; `selection` is text the user selected. */
    readonly name: 'bot' | 'chat' | 'selection';
    /** Where `sentence` is now; undefined once it is no longer shown. */
    rangeOf(sentence: PickedSentence): Range | undefined;
}

/** What the gestures pick: one sentence, or the whole paragraph it is in (Alt+Shift). */
export type PickScope = 'sentence' | 'paragraph';

/** Text the gestures work on. */
export interface SentenceSurface extends SentenceView {
    readonly name: 'bot' | 'chat';
    /** The sentence (or its paragraph) at a caret, if the caret is in text of this surface. */
    pick(node: Text, offset: number, scope: PickScope): PickedSentence | undefined;
    /** Whether `node` is in this surface's text: where a selection may be read aloud or translated. */
    holds(node: Node): boolean;
}

/**
 * `hover`: under the pointer while Alt is held; `pinned`: the one whose translation is open;
 * `read-region`: the picked text (the region), the playback control; `loading` / `playing` /
 * `paused`: the sentence of it being read, before it is heard, while it is, and while paused.
 */
export type SentenceHighlight =
    | 'vp-sentence-hover'
    | 'vp-sentence-pinned'
    | 'vp-read-region'
    | 'vp-sentence-loading'
    | 'vp-sentence-playing'
    | 'vp-sentence-paused';

/** Paints `range` as `name`, or clears it. The read region lies under the sentence highlights. */
export function paintSentence(name: SentenceHighlight, range: Range | undefined): void {
    if (range) {
        const highlight = new Highlight(range);
        highlight.priority = name === 'vp-read-region' ? -1 : 0;
        CSS.highlights.set(name, highlight);
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

/**
 * `pieces` of `shown` (sentences, with their ranges) as the gestures pick them: one sentence, or
 * several read as one, each a part read and cached on its own, from the first one's start to the
 * last one's end. `source` (what is translated) is what `shown` has there, unless given.
 */
export function pickedOf(surface: SentenceView, entryId: string, shown: string, pieces: readonly VoiceReplayPiece[], source?: string): PickedSentence | undefined {
    const one = (piece: VoiceReplayPiece): PickedSentence => ({ surface, entryId, piece, source: shown.slice(...piece.range!) });
    const first = pieces[0];
    if (!first) {
        return undefined;
    }
    const texts = pieces.map((p) => p.text);
    const picked =
        pieces.length === 1
            ? one(first)
            : { ...one({ text: texts.join(' '), range: [first.range![0], pieces[pieces.length - 1].range![1]], parts: texts }), parts: pieces.map(one) };
    return source === undefined ? picked : { ...picked, source };
}

/**
 * The sentences of the paragraph of `text` a caret at `offset` is in: a blank line parts
 * paragraphs (a card's text block, a Bot view reply); a caret in the blank lines belongs to the
 * paragraph after them. None when nothing of that paragraph is spoken.
 */
export function paragraphPieces(text: string, offset: number): VoiceReplayPiece[] {
    let start = 0;
    let end = text.length;
    for (const gap of text.matchAll(/\n[^\S\n]*\n\s*/g)) {
        if (offset < gap.index) {
            end = gap.index;
            break;
        }
        start = gap.index + gap[0].length;
    }
    return replayPieces(text).filter((p) => p.range![0] >= start && p.range![1] <= end);
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
    /** With Alt: the paragraph instead of the sentence. Shift alone extends a selection, so it is only read with Alt. */
    let shiftHeld = false;
    let frame = 0;

    /** The sentence (or paragraph) at the viewport point, only when the point is on its text. */
    const sentenceAt = (x: number, y: number, scope: PickScope): { sentence: PickedSentence; range: Range } | undefined => {
        const caret = document.caretRangeFromPoint(x, y);
        const node = caret?.startContainer;
        if (!caret || !(node instanceof Text)) {
            return undefined;
        }
        for (const surface of surfaces) {
            const sentence = surface.pick(node, caret.startOffset, scope);
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
        const found = altHeld && pointer && actions.enabled() ? sentenceAt(pointer.x, pointer.y, shiftHeld ? 'paragraph' : 'sentence') : undefined;
        paintSentence('vp-sentence-hover', found?.range);
        document.body.toggleAttribute('data-sentence-pick', found !== undefined);
    };
    const release = (): void => {
        altHeld = false;
        shiftHeld = false;
        show();
    };
    // The gesture's target is found again from the point: the hover may be a frame behind.
    const picked = (e: MouseEvent): PickedSentence | undefined =>
        e.altKey && actions.enabled() ? sentenceAt(e.clientX, e.clientY, e.shiftKey ? 'paragraph' : 'sentence')?.sentence : undefined;
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
            if (e.repeat || !actions.enabled()) {
                return;
            }
            if (e.key === 'Alt') {
                // The pointer parked over a sentence, then Alt: highlight it at once.
                e.preventDefault();
                altHeld = true;
                shiftHeld = e.shiftKey;
                show();
            } else if (e.key === 'Shift' && altHeld) {
                shiftHeld = true;
                show();
            }
        },
        true,
    );
    document.addEventListener('keyup', (e) => {
        if (e.key === 'Alt') {
            release();
        } else if (e.key === 'Shift' && shiftHeld) {
            // Alt still held: back to the sentence.
            shiftHeld = false;
            show();
        }
    });
    window.addEventListener('blur', release);
    document.addEventListener(
        'mousemove',
        (e) => {
            pointer = { x: e.clientX, y: e.clientY };
            const shift = e.altKey && e.shiftKey;
            if (e.altKey !== altHeld || shift !== shiftHeld) {
                altHeld = e.altKey;
                shiftHeld = shift;
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
    // Captured before the page's handlers: Alt+press would start a selection or a drag (Alt+Shift+press
    // extend one), a click could open a card, a right-click VS Code's context menu.
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
