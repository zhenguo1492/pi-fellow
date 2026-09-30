/**
 * Read aloud and Translate for text selected with the mouse in the chat's messages or the Bot view
 * (`voiceAgent.messageButtons`, as the Alt gestures): as the drag ends, a small bar floats at the
 * pointer with the two buttons. Read aloud goes the way Alt+click does, sentence by sentence with
 * the read-along (readAlong.ts); Translate opens the translation panel (translatePopup.ts) by the
 * selection. A press elsewhere, Escape, a scroll, or the selection going away hides the bar.
 */
import { replayPieces } from '../voiceAgent/sentences';
import { pickedOf, textNodesIn, type PickedSentence, type SentencePickActions, type SentenceSurface, type SentenceView } from './sentencePick';

/** Between the pointer and the bar, and between the bar and the window's edges. */
const GAP_PX = 10;
const MARGIN_PX = 4;
/** Selections' keys for the host (their audio is cached under them), apart from Bot view entries and chat paragraphs. */
const KEY_PREFIX = 'selection\u0000';

/** Where each selection was, with its text there (`Range.toString`), to tell once it is gone. */
const selected = new WeakMap<PickedSentence, { range: Range; text: string }>();

/**
 * Selected text is where it was selected, while that text is still there: a redraw that replaces
 * it (a chat state sync) loses it, as it loses the selection.
 */
const selectionView: SentenceView = {
    name: 'selection',
    rangeOf(sentence) {
        const at = selected.get(sentence);
        return at && !at.range.collapsed && at.range.toString() === at.text ? at.range : undefined;
    },
};

/** Blocks whose text a line break parts from the next block's, as TTS would read them. */
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd, pre, figcaption, div';
/** Never read: code blocks, buttons, icons. */
const UNSPOKEN = '.code-block-wrapper, button, svg';

/**
 * The text `range` covers as its text nodes hold it (a line break between blocks; code blocks and
 * buttons left out), and the DOM range of any stretch of that text: where each sentence is.
 */
export function selectedText(range: Range): { text: string; rangeOf(start: number, end: number): Range | undefined } {
    const root = range.commonAncestorContainer;
    const nodes = root instanceof Text ? [root] : textNodesIn(root instanceof Element ? root : document.body, (el) => el.matches(UNSPOKEN));
    const segments: Array<{ node: Text; from: number; at: number; length: number }> = [];
    let text = '';
    let block: Element | null | undefined;
    for (const node of nodes) {
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : node.length;
        if (to <= from || !range.intersectsNode(node)) {
            continue;
        }
        const own = node.parentElement?.closest(BLOCKS);
        if (block !== undefined && own !== block) {
            text += '\n';
        }
        block = own;
        segments.push({ node, from, at: text.length, length: to - from });
        text += node.data.slice(from, to);
    }
    return {
        text,
        rangeOf(start, end) {
            // A start at a segment's end is the next one's start; an end at a segment's start, the previous one's end.
            const first = segments.find((s) => start >= s.at && start < s.at + s.length);
            const last = segments.findLast((s) => end > s.at && end <= s.at + s.length);
            if (!first || !last) {
                return undefined;
            }
            const part = document.createRange();
            part.setStart(first.node, first.from + start - first.at);
            part.setEnd(last.node, last.from + end - last.at);
            return part;
        },
    };
}

/**
 * The surface a selection is in: the one holding the first and the last text it covers
 * (whitespace aside). A selection across two messages counts; one reaching out of the messages
 * (into the composer, a header) does not.
 */
export function surfaceOfSelection(range: Range, surfaces: readonly SentenceSurface[]): SentenceSurface | undefined {
    const root = range.commonAncestorContainer;
    const nodes = root instanceof Text ? [root] : textNodesIn(root instanceof Element ? root : document.body);
    let first: Text | undefined;
    let last: Text | undefined;
    for (const node of nodes) {
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : node.length;
        if (range.intersectsNode(node) && node.data.slice(from, to).trim()) {
            first ??= node;
            last = node;
        }
    }
    return first && last ? surfaces.find((s) => s.holds(first) && s.holds(last)) : undefined;
}

/**
 * Where a bar `width` × `height` goes for a drag that ended at (`x`, `y`) in a window
 * `viewWidth` × `viewHeight`: centred above the pointer, below it when there is no room above,
 * kept inside the window.
 */
export function toolbarPosition(x: number, y: number, width: number, height: number, viewWidth: number, viewHeight: number): { left: number; top: number } {
    const above = y - GAP_PX - height;
    return {
        left: Math.max(MARGIN_PX, Math.min(x - width / 2, viewWidth - width - MARGIN_PX)),
        top: above >= MARGIN_PX ? above : Math.max(MARGIN_PX, Math.min(y + GAP_PX, viewHeight - height - MARGIN_PX)),
    };
}

export interface SelectionToolbar {
    hide(): void;
}

/** Shows the bar over `surfaces`' selections; `actions` are the Alt gestures'. Once, at startup. */
export function installSelectionToolbar(surfaces: readonly SentenceSurface[], actions: SentencePickActions): SelectionToolbar {
    const el = document.createElement('div');
    el.className = 'sentence-sel';
    el.hidden = true;
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Selected text');
    el.innerHTML = '<button type="button" data-act="read">Read aloud</button><button type="button" data-act="translate">Translate</button>';
    document.body.append(el);
    const readButton = el.querySelector<HTMLButtonElement>('[data-act="read"]')!;
    /** The selection the bar is for. */
    let shown: PickedSentence | undefined;

    const hide = (): void => {
        if (shown) {
            shown = undefined;
            el.hidden = true;
        }
    };
    /** Shows the bar at (`x`, `y`) for the selection now, if it is text in the messages; else hides it. */
    const showAt = (x: number, y: number): void => {
        const selection = document.getSelection();
        const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0).cloneRange() : undefined;
        const text = selection?.toString().trim() ?? '';
        if (!range || !text || !actions.enabled() || !surfaceOfSelection(range, surfaces)) {
            hide();
            return;
        }
        const spoken = selectedText(range);
        const pieces = replayPieces(spoken.text);
        // Without a piece (nothing in it is spoken: code, symbols) Read aloud is off, and the piece is never read.
        shown = pickedOf(selectionView, KEY_PREFIX + text, spoken.text, pieces, text) ?? {
            surface: selectionView,
            entryId: KEY_PREFIX + text,
            piece: { text, range: [0, text.length] },
            source: text,
        };
        selected.set(shown, { range, text: range.toString() });
        for (const part of shown.parts ?? []) {
            const at = spoken.rangeOf(...part.piece.range!);
            if (at) {
                selected.set(part, { range: at, text: at.toString() });
            }
        }
        readButton.disabled = pieces.length === 0;
        el.hidden = false;
        const { left, top } = toolbarPosition(x, y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    };

    // Pressed, the buttons would clear the selection (and take the focus): the bar keeps both.
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
        const act = (e.target as Element).closest<HTMLButtonElement>('button')?.dataset.act;
        const sentence = shown;
        if (!sentence || !act) {
            return;
        }
        hide();
        if (act === 'read') {
            actions.read(sentence);
        } else {
            actions.translate(sentence);
        }
    });
    document.addEventListener(
        'mouseup',
        (e) => {
            // Alt+click is a gesture on a sentence, not the end of a selection.
            if (e.button !== 0 || e.altKey || el.contains(e.target as Node)) {
                return;
            }
            const { clientX, clientY } = e;
            // The selection settles after the press ends: a click inside one clears it only then.
            setTimeout(() => showAt(clientX, clientY));
        },
        true,
    );
    // Captured: the Alt gestures stop the press from reaching the page.
    document.addEventListener(
        'mousedown',
        (e) => {
            if (!el.contains(e.target as Node)) {
                hide();
            }
        },
        true,
    );
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hide();
        }
    });
    document.addEventListener('selectionchange', () => {
        if (shown && document.getSelection()?.toString().trim() !== shown.source) {
            hide();
        }
    });
    // Scroll events do not bubble; captured, every scrolled area reports here.
    document.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('resize', hide);
    return { hide };
}
