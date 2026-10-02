import { describe, expect, it } from 'vitest';
import {
    BLOCK_ZOOM_RANGE,
    PAGE_ZOOM_RANGE,
    appendToBoard,
    describeBoardEdit,
    formatOutline,
    parseBoard,
    parseBoardLink,
    parseBoardZoom,
    parseWebElement,
    replaceBoardBlock,
    showMeIsCard,
    WEB_ELEMENT_LIMITS,
    webPageViewport,
    zoomByWheel,
    zoomStep,
} from '../../../shared/board';

const DOC = ['# Login', '', 'The client sends a token.', '', '```mermaid', 'sequenceDiagram', 'A->>B: hi', '```', '', '```ts', 'const a = 1;', '```', '', 'Last words.'].join('\n');

describe('board blocks', () => {
    it('numbers each kind in document order; a mermaid fence is a diagram, a rule is not a block', () => {
        const doc = parseBoard(`${DOC}\n\n---\n\n\`\`\`mermaid title="x"\ngraph TD\nA-->B\n\`\`\``);
        expect(doc.blocks.map((b) => `${b.id}:${b.kind}`)).toEqual(['h1:heading', 'p1:paragraph', 'd1:diagram', 'c1:code', 'p2:paragraph', 'd2:diagram']);
    });

    it('keeps earlier ids when appending, so the agent can still point at them', () => {
        const before = parseBoard(DOC).blocks.map((b) => b.id);
        const after = parseBoard(appendToBoard(DOC, 'One more.\n\n```ts\nx();\n```')).blocks.map((b) => b.id);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after.slice(before.length)).toEqual(['p3', 'c2']);
    });

    it('replaces a block with several without merging them into their neighbours', () => {
        const next = replaceBoardBlock(DOC, 'p1', 'First.\nstill first\n\nSecond.');
        expect(formatOutline(parseBoard(next))).toBe(
            ['h1 heading "Login"', 'p1 paragraph "First. still first"', 'p2 paragraph "Second."', 'd1 diagram sequenceDiagram, 2 lines', 'c1 code ts, 1 lines', 'p3 paragraph "Last words."'].join('\n'),
        );
    });

    it('removes a block with an empty replacement, and refuses an unknown id', () => {
        expect(parseBoard(replaceBoardBlock(DOC, 'd1', '')).blocks.map((b) => b.id)).toEqual(['h1', 'p1', 'c1', 'p2']);
        expect(parseBoard(replaceBoardBlock(DOC, 'p2', '')).blocks.map((b) => b.id)).toEqual(['h1', 'p1', 'd1', 'c1']);
        expect(() => replaceBoardBlock(DOC, 'p9', 'x')).toThrow('No block p9');
    });

    it('describes a saved edit by block id', () => {
        expect(describeBoardEdit(DOC, DOC)).toBe('no block changed');
        expect(describeBoardEdit(DOC, replaceBoardBlock(DOC, 'c1', '```ts\nconst a = 2;\n```\n\nNew.'))).toBe('changed c1, p2; added p3');
        expect(describeBoardEdit(DOC, replaceBoardBlock(DOC, 'd1', ''))).toBe('removed d1');
    });

    it('makes an html fence a web page (w ids) outlined by its title, while raw HTML stays an html block', () => {
        const doc = parseBoard(
            [
                '<div>raw</div>',
                '```html\n<title>Stack (array)</title>\n<button id="push">Push</button>\n```',
                '```HTML demo\n<h2>Queue <small>demo</small></h2>\n```',
                '```html\n<p>no title</p>\n```',
                '```xml\n<a/>\n```',
            ].join('\n\n'),
        );
        expect(doc.blocks.map((b) => `${b.id}:${b.kind}`)).toEqual(['x1:html', 'w1:web', 'w2:web', 'w3:web', 'c1:code']);
        expect(formatOutline(doc).split('\n').slice(1)).toEqual(['w1 web page "Stack (array)", 2 lines', 'w2 web page "Queue demo", 1 lines', 'w3 web page, 1 lines', 'c1 code xml, 1 lines']);
    });

    it("reads a web page's design size from its viewport meta tag, bounded, and outlines it", () => {
        expect(webPageViewport('<meta name="viewport" content="width=3840, height=2160">')).toEqual({ width: 3840, height: 2160 });
        expect(webPageViewport("<meta content='height=600;width=1280' name=viewport>")).toEqual({ width: 1280, height: 600 });
        expect(webPageViewport('<meta name="viewport" content="width=1440">')).toEqual({ width: 1440 });
        // Bounded: 240–7680 wide, at most 8 times as tall; a height alone or device-width declares nothing.
        expect(webPageViewport('<meta name="viewport" content="width=99999, height=1">')).toEqual({ width: 7680, height: 40 });
        expect(webPageViewport('<meta name="viewport" content="width=100, height=99999">')).toEqual({ width: 240, height: 1920 });
        for (const html of ['<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="height=500">', '<meta name="description" content="width=900">', '<p>width=900</p>']) {
            expect(webPageViewport(html)).toEqual({});
        }
        const doc = parseBoard('```html\n<meta name="viewport" content="width=3840, height=2160">\n<title>Wall</title>\n```\n\n```html\n<meta name="viewport" content="width=1280">\n```');
        expect(formatOutline(doc)).toBe('w1 web page "Wall", 3840×2160, 2 lines\nw2 web page, 1280 wide, 1 lines');
    });
});

describe('showMeIsCard', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

    it('keeps up to five lines on a card, fences not counted', () => {
        expect(showMeIsCard({ markdown: lines(5) })).toBe(true);
        expect(showMeIsCard({ markdown: `\`\`\`bash\n${lines(5)}\n\`\`\`` })).toBe(true);
        expect(showMeIsCard({ markdown: lines(6) })).toBe(false);
    });

    it('puts any diagram or web page, and anything aimed at a board, on a board', () => {
        expect(showMeIsCard({ markdown: '```mermaid\ngraph TD\n```' })).toBe(false);
        expect(showMeIsCard({ markdown: '```html\n<button>Go</button>\n```' })).toBe(false);
        expect(showMeIsCard({ markdown: 'npm test', board: 'new' })).toBe(false);
        expect(showMeIsCard({ markdown: 'npm test', mode: 'append' })).toBe(true);
        expect(showMeIsCard({ markdown: 'npm test', mode: 'block' })).toBe(false);
    });
});

describe('parseBoardLink', () => {
    it('opens web pages in the browser, http and https only', () => {
        expect(parseBoardLink('https://example.com/a b?q=1#x')).toEqual({ kind: 'web', url: 'https://example.com/a%20b?q=1#x' });
        expect(parseBoardLink('HTTP://example.com')).toEqual({ kind: 'web', url: 'http://example.com/' });
        for (const href of ['mailto:a@b.c', 'command:workbench.action.quit', 'javascript:alert(1)', 'vscode://x', 'data:text/html,x', '#heading', '', 'https://']) {
            expect(parseBoardLink(href)).toEqual({ kind: 'none' });
        }
    });

    it('reads relative and absolute paths, with a line or range as #L12, #L12-L20, :12, :12-20 or :12:5', () => {
        expect(parseBoardLink('src/shared/board.ts')).toEqual({ kind: 'file', path: 'src/shared/board.ts' });
        expect(parseBoardLink('board.ts:12')).toEqual({ kind: 'file', path: 'board.ts', line: 12 });
        expect(parseBoardLink('./src/a.ts:12-20')).toEqual({ kind: 'file', path: './src/a.ts', line: 12, endLine: 20 });
        expect(parseBoardLink('src/a.ts:12:5')).toEqual({ kind: 'file', path: 'src/a.ts', line: 12 });
        expect(parseBoardLink('src/a.ts#L12')).toEqual({ kind: 'file', path: 'src/a.ts', line: 12 });
        expect(parseBoardLink('src/a.ts#L12-L20')).toEqual({ kind: 'file', path: 'src/a.ts', line: 12, endLine: 20 });
        expect(parseBoardLink('docs/My%20Notes.md#usage')).toEqual({ kind: 'file', path: 'docs/My Notes.md' });
        expect(parseBoardLink('/home/u/x.ts#L3')).toEqual({ kind: 'file', path: '/home/u/x.ts', line: 3 });
        expect(parseBoardLink('file:///home/u/my%20x.ts#L3')).toEqual({ kind: 'file', path: '/home/u/my x.ts', line: 3 });
        expect(parseBoardLink('C:\\work\\x.ts:7')).toEqual({ kind: 'file', path: 'C:\\work\\x.ts', line: 7 });
    });
});

describe('board zoom', () => {
    it('steps by 1.1×, on its powers so steps there and back return to 100% exactly, within 10%–800% (blocks) and 30%–300% (the page)', () => {
        expect(zoomStep(BLOCK_ZOOM_RANGE, 1, 1)).toBe(1.1);
        expect(zoomStep(BLOCK_ZOOM_RANGE, 1, -1)).toBe(0.909091);
        let zoom = 1;
        for (let i = 0; i < 15; i++) zoom = zoomStep(BLOCK_ZOOM_RANGE, zoom, 1);
        expect(zoom).toBe(4.177248);
        for (let i = 0; i < 15; i++) zoom = zoomStep(BLOCK_ZOOM_RANGE, zoom, -1);
        expect(zoom).toBe(1);
        // Off the grid (after a wheel), a press goes to the next power that way.
        expect(zoomStep(BLOCK_ZOOM_RANGE, 1.05, 1)).toBe(1.1);
        expect(zoomStep(BLOCK_ZOOM_RANGE, 1.05, -1)).toBe(1);
        // The ends hold, and a step back from an end lands on the grid again.
        expect(zoomStep(BLOCK_ZOOM_RANGE, 8, 1)).toBe(8);
        expect(zoomStep(BLOCK_ZOOM_RANGE, 8, -1)).toBe(7.40025);
        expect(zoomStep(BLOCK_ZOOM_RANGE, 0.1, -1)).toBe(0.1);
        expect(zoomStep(PAGE_ZOOM_RANGE, 3, 1)).toBe(3);
        expect(zoomStep(PAGE_ZOOM_RANGE, 0.3, -1)).toBe(0.3);
    });

    it('zooms by the wheel in proportion to its travel: a 100 px notch is 1.1×, a quarter of it a quarter of the step', () => {
        expect(zoomByWheel(BLOCK_ZOOM_RANGE, 1, -100)).toBe(1.1);
        expect(zoomByWheel(BLOCK_ZOOM_RANGE, 1, 100)).toBe(0.909091);
        expect(zoomByWheel(BLOCK_ZOOM_RANGE, 1, -25)).toBe(1.024114);
        let zoom = 1;
        for (let i = 0; i < 4; i++) zoom = zoomByWheel(BLOCK_ZOOM_RANGE, zoom, -25);
        expect(zoom).toBeCloseTo(1.1, 5);
        expect(zoomByWheel(BLOCK_ZOOM_RANGE, 7.9, -1000)).toBe(8);
        expect(zoomByWheel(BLOCK_ZOOM_RANGE, 0.11, 1000)).toBe(0.1);
    });

    it('keeps a stored zoom, clamped to its range, and drops what is not one, and blocks at 100%', () => {
        expect(parseBoardZoom({ page: 9, blocks: { d0: 0.01, d1: 0.1, d2: 1, d3: 2.0763, d4: 'x', d5: 0, w1: 99, w2: 0.75 } })).toEqual({
            page: 3,
            blocks: { d0: 0.1, d1: 0.1, d3: 2.0763, w1: 8, w2: 0.75 },
        });
        expect(parseBoardZoom({ page: 0.2 })).toEqual({ page: 0.3, blocks: {} });
        expect(parseBoardZoom({ page: 1.5 })).toEqual({ page: 1.5, blocks: {} });
        expect(parseBoardZoom({ blocks: { d1: 2 } })).toBeUndefined();
        expect(parseBoardZoom('1.5')).toBeUndefined();
    });
});

describe('web page elements', () => {
    it('takes a picked element a page sent, cut to its limits, and drops what is not one', () => {
        const long = 'x'.repeat(1000);
        const parsed = parseWebElement({ selector: long, tag: 'button', id: '', classes: ['a', 3, '', ...Array(20).fill('c')], text: long, html: long, extra: 1 });
        expect(parsed).toEqual({
            selector: `${'x'.repeat(WEB_ELEMENT_LIMITS.selector - 1)}…`,
            tag: 'button',
            classes: ['a', ...Array(WEB_ELEMENT_LIMITS.classes - 1).fill('c')],
            text: `${'x'.repeat(WEB_ELEMENT_LIMITS.text - 1)}…`,
            html: `${'x'.repeat(WEB_ELEMENT_LIMITS.html - 1)}…`,
        });
        expect(parseWebElement({ selector: '#go', tag: 'button', id: 'go', html: '<button id="go">Go</button>' })).toEqual({
            selector: '#go',
            tag: 'button',
            id: 'go',
            html: '<button id="go">Go</button>',
        });
        expect(parseWebElement({ selector: ' ', tag: 'p', html: '' })).toBeUndefined();
        expect(parseWebElement({ selector: 'p', tag: 'p' })).toBeUndefined();
        expect(parseWebElement('p')).toBeUndefined();
    });
});
