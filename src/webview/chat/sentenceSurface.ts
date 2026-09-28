/**
 * The chat's text for the Alt gestures (sentenceActions.ts): prompts, replies and summaries
 * (`.message-content`), Thought blocks (`.thinking-content`), and the text in tool cards
 * (`.tv-out`, such as a task's assignment). A sentence is cut, as TTS reads it, from the paragraph
 * it is in: a paragraph, list item, heading, table cell, or a card's text block. Code blocks are
 * left out. The chat redraws its history on every state sync, so a sentence is found again by the
 * text of its paragraph.
 */
import { pieceAt, rangeInNodes, textNodesIn, type PickedSentence, type SentenceSurface } from '../sentencePick';

const ROOTS = '.message-content, .thinking-content, .tv-out';
/** Paragraphs of their own. */
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd, pre, figcaption';
/** Never read: code blocks with their header, card titles, buttons, placeholders. */
const SKIP = '.code-block-wrapper, .tv-out-title, button, svg, .thinking-placeholder';
/** Chat keys are the paragraph's text after this, apart from Bot view entry ids. */
const KEY_PREFIX = 'chat\u0000';

/** The paragraph's own text: nested paragraphs (a sub-list in a list item) are their own. */
function paragraphNodes(block: Element): Text[] {
    return textNodesIn(block, (el) => el.matches(SKIP) || el.matches(BLOCKS));
}

function paragraphText(nodes: readonly Text[]): string {
    return nodes.map((n) => n.data).join('');
}

/** The paragraph `el` is in, within `root`; the root itself for text directly in it. */
function paragraphOf(el: Element, root: Element): Element {
    const block = el.closest(BLOCKS);
    return block && root.contains(block) ? block : root;
}

/** Where each picked sentence's paragraph was last seen. */
const paragraphs = new WeakMap<PickedSentence, Element>();

/** The paragraph showing `text` now, after a redraw replaced the one it was seen in. */
function findParagraph(text: string): Element | undefined {
    for (const root of document.querySelectorAll(ROOTS)) {
        for (const block of [root, ...root.querySelectorAll(BLOCKS)]) {
            if (!block.parentElement?.closest(SKIP) && paragraphOf(block, root) === block && paragraphText(paragraphNodes(block)) === text) {
                return block;
            }
        }
    }
    return undefined;
}

export const chatSentences: SentenceSurface = {
    name: 'chat',
    pick(node, offset) {
        const parent = node.parentElement;
        const root = parent?.closest(ROOTS);
        if (!parent || !root || parent.closest(SKIP)) {
            return undefined;
        }
        const block = paragraphOf(parent, root);
        const nodes = paragraphNodes(block);
        let at = offset;
        for (const t of nodes) {
            if (t === node) {
                break;
            }
            at += t.length;
        }
        const text = paragraphText(nodes);
        const piece = pieceAt(text, at);
        if (!piece) {
            return undefined;
        }
        const sentence: PickedSentence = { surface: chatSentences, entryId: KEY_PREFIX + text, piece, source: text.slice(...piece.range!) };
        paragraphs.set(sentence, block);
        return sentence;
    },
    rangeOf(sentence) {
        const text = sentence.entryId.slice(KEY_PREFIX.length);
        let block = paragraphs.get(sentence);
        let nodes = block?.isConnected ? paragraphNodes(block) : [];
        if (paragraphText(nodes) !== text) {
            block = findParagraph(text);
            if (!block) {
                return undefined;
            }
            paragraphs.set(sentence, block);
            nodes = paragraphNodes(block);
        }
        return sentence.piece.range && rangeInNodes(nodes, ...sentence.piece.range);
    },
};
