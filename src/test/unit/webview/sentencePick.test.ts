// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { chatSentences } from '../../../webview/chat/sentenceSurface';
import { replayPieces } from '../../../voiceAgent/sentences';
import { paragraphPieces } from '../../../webview/sentencePick';
import { selectedText, surfaceOfSelection, toolbarPosition } from '../../../webview/selectionToolbar';

describe('paragraphPieces', () => {
    const text = 'First one. Still first.\n\nSecond here. And more.\n \n\nThird';
    const texts = (offset: number, of = text) => paragraphPieces(of, offset).map((p) => of.slice(...p.range!));

    it('gives the sentences of the paragraph the caret is in, each as TTS reads it', () => {
        expect(paragraphPieces(text, text.indexOf('And')).map((p) => p.text)).toEqual(['Second here.', 'And more.']);
        expect(texts(0)).toEqual(['First one.', 'Still first.']);
        expect(texts(text.length)).toEqual(['Third']);
    });

    it('gives a caret in the blank lines to the paragraph after them', () => {
        expect(texts(text.indexOf('\n\n') + 1)).toEqual(['Second here.', 'And more.']);
        expect(texts(text.indexOf(' \n') + 1)).toEqual(['Third']);
    });

    it('keeps a single line break inside the paragraph', () => {
        expect(texts(0, 'Line one\nline two.')).toEqual(['Line one', 'line two.']);
    });

    it('has nothing to read in a paragraph with no words', () => {
        expect(paragraphPieces('Words.\n\n```\ncode\n```', 12)).toEqual([]);
    });
});

describe('selectedText', () => {
    beforeEach(() => {
        document.body.innerHTML =
            '<div class="message-content"><p id="a">Intro text. <b>Bold bit</b> ends.</p><div class="code-block-wrapper"><pre>code();</pre></div><h2 id="h">A heading</h2><p id="b">Last one here.</p></div>';
    });

    it('reads the selection block by block, without code, and finds each sentence of it in the page', () => {
        const range = document.createRange();
        range.setStart(document.querySelector('#a')!.firstChild!, 6);
        range.setEnd(document.querySelector('#b')!.firstChild!, 8);
        const spoken = selectedText(range);
        expect(spoken.text).toBe('text. Bold bit ends.\nA heading\nLast one');
        // A heading with no full stop is still a sentence of its own: the block ends it.
        const sentences = replayPieces(spoken.text);
        expect(sentences.map((p) => spoken.rangeOf(...p.range!)!.toString())).toEqual(['text.', 'Bold bit ends.', 'A heading', 'Last one']);
    });
});

describe('chatSentences with Alt+Shift', () => {
    beforeEach(() => {
        document.body.innerHTML =
            '<div class="message-content"><p>One. <b>Two.</b></p><ul><li>Item a. Item b.<ul><li>Nested.</li></ul></li></ul></div>' +
            '<div class="chat-header">Header</div><div class="message-content"><p>Other message.</p></div>';
    });

    it('picks the whole paragraph around the caret, each sentence a part found where it is', () => {
        const two = document.querySelector('b')!.firstChild as Text;
        expect(chatSentences.pick(two, 1, 'sentence')!.source).toBe('Two.');
        expect(chatSentences.pick(two, 1, 'sentence')!.parts).toBeUndefined();
        const paragraph = chatSentences.pick(two, 1, 'paragraph')!;
        expect(paragraph.source).toBe('One. Two.');
        expect(paragraph.piece.text).toBe('One. Two.');
        // Read sentence by sentence, as each is cached when read on its own.
        expect(paragraph.piece.parts).toEqual(['One.', 'Two.']);
        expect(chatSentences.rangeOf(paragraph)!.toString()).toBe('One. Two.');
        expect(paragraph.parts!.map((p) => chatSentences.rangeOf(p)!.toString())).toEqual(['One.', 'Two.']);
    });

    it('leaves a nested list out of its list item', () => {
        const item = document.querySelector('li')!.firstChild as Text;
        expect(chatSentences.pick(item, 0, 'paragraph')!.source).toBe('Item a. Item b.');
    });

    it('finds the paragraph again after the chat redraws it', () => {
        const one = document.querySelector('p')!.firstChild as Text;
        const paragraph = chatSentences.pick(one, 0, 'paragraph')!;
        document.body.innerHTML = document.body.innerHTML;
        const range = chatSentences.rangeOf(paragraph)!;
        expect(range.toString()).toBe('One. Two.');
        expect(range.startContainer.isConnected).toBe(true);
    });
});

describe('surfaceOfSelection', () => {
    beforeEach(() => {
        document.body.innerHTML =
            '<div class="message-content"><p>First message.</p></div><div class="chat-header">Header</div><div class="message-content"><p>Second message.</p></div>';
    });
    const texts = (): Text[] => [...document.querySelectorAll('p, .chat-header')].map((el) => el.firstChild as Text);

    it('takes a selection across two messages, header text between them included', () => {
        const [first, , second] = texts();
        const range = document.createRange();
        range.setStart(first, 6);
        range.setEnd(second, 6);
        expect(surfaceOfSelection(range, [chatSentences])).toBe(chatSentences);
    });

    it('refuses a selection that starts or ends outside the messages', () => {
        const [first, header] = texts();
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(header, 3);
        expect(surfaceOfSelection(range, [chatSentences])).toBeUndefined();
    });

    it('ignores the text a selection only touches at its edge', () => {
        // Triple-click: the end is at the start of the next block's text.
        const [first, header] = texts();
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(header, 0);
        expect(surfaceOfSelection(range, [chatSentences])).toBe(chatSentences);
    });
});

describe('toolbarPosition', () => {
    it('centres the bar above the pointer', () => {
        expect(toolbarPosition(200, 300, 100, 26, 800, 600)).toEqual({ left: 150, top: 264 });
    });

    it('goes below the pointer without room above, and stays inside the window', () => {
        expect(toolbarPosition(20, 15, 100, 26, 800, 600)).toEqual({ left: 4, top: 25 });
        expect(toolbarPosition(790, 20, 100, 26, 800, 600)).toEqual({ left: 696, top: 30 });
    });
});
