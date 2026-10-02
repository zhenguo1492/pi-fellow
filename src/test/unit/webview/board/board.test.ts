// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mermaid needs a real layout engine; the diagram host only records what it was asked to draw.
const drawn: string[] = [];
vi.mock('../../../../webview/board/diagrams', () => ({
    drawDiagram: async (host: HTMLElement, source: string) => {
        drawn.push(source);
        host.innerHTML = source.includes('broken') ? '<pre>error</pre>' : '<svg></svg>';
    },
    diagramFailure: (host: Element) => (host.innerHTML.includes('error') ? 'Parse error' : undefined),
    redrawDiagram: async () => {},
}));

import { WEB_ELEMENT_LIMITS, type BoardWebElement } from '../../../../shared/board';
import { renderDocument } from '../../../../webview/board/document';
import { findTextRange } from '../../../../webview/board/locate';
import { frameDocument, onWebPageInput, webFailure, type WebPageInput } from '../../../../webview/board/web';
import { describeElement } from '../../../../webview/board/webElement';

// jsdom lays nothing out: a web page's stage never resizes, so its scale is never set here.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

describe('findTextRange', () => {
    function section(html: string): HTMLElement {
        const el = document.createElement('section');
        el.innerHTML = html;
        return el;
    }

    it('matches across inline elements and whitespace runs', () => {
        const el = section('<p>The <strong>client</strong>\n   sends credentials</p>');
        expect(findTextRange(el, 'client sends')?.toString()).toBe('client\n   sends');
    });

    it('falls back to a case-insensitive match, then to the text without Markdown marks', () => {
        const el = section('<p>Refresh the <code>token</code> here</p>');
        expect(findTextRange(el, 'REFRESH THE')?.toString()).toBe('Refresh the');
        expect(findTextRange(el, 'the `token` here')?.toString()).toBe('the token here');
    });

    it('skips the board chrome and reports a missing passage', () => {
        const el = section('<div class="board-code-header board-chrome">ts Copy</div><pre><code>const a = 1;</code></pre>');
        expect(findTextRange(el, 'Copy')).toBeUndefined();
        expect(findTextRange(el, 'a = 1')?.toString()).toBe('a = 1');
        expect(findTextRange(el, '   ')).toBeUndefined();
    });
});

describe('renderDocument', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        drawn.length = 0;
    });

    const ids = () => [...container.children].map((el) => (el as HTMLElement).dataset.block);

    it('keeps unchanged blocks, rebuilds changed ones, and reports diagram failures', async () => {
        const first = await renderDocument(container, '# Title\n\nFirst.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nbroken\n```\n');
        expect(ids()).toEqual(['h1', 'p1', 'd1', 'd2']);
        expect(first.errors).toEqual([{ block: 'd2', message: 'Parse error' }]);
        const [h1, p1, d1] = [...container.children];

        const second = await renderDocument(container, '# Title\n\nFirst, changed.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nbroken\n```\n\nAdded.\n');
        expect(ids()).toEqual(['h1', 'p1', 'd1', 'd2', 'p2']);
        expect(container.children[0]).toBe(h1);
        expect(container.children[1]).not.toBe(p1);
        expect(container.children[2]).toBe(d1);
        expect(second.changed.map((el) => el.dataset.block)).toEqual(['p1', 'p2']);
        // A kept diagram is not drawn again, and its failure is still reported.
        expect(drawn).toHaveLength(2);
        expect(second.errors).toEqual([{ block: 'd2', message: 'Parse error' }]);
    });

    it('removes blocks that are gone and shows raw HTML as text', async () => {
        await renderDocument(container, 'One.\n\nTwo.\n');
        await renderDocument(container, '<div>raw</div>\n\nTwo <b>bold</b>.\n');
        expect(ids()).toEqual(['x1', 'p1']);
        expect(container.textContent).toContain('<div>raw</div>');
        expect(container.textContent).toContain('<b>bold</b>');
        expect(container.querySelector('div, b')).toBeNull();
    });
});

describe('web pages', () => {
    it('stamps the frame nonce on the page\'s own inline scripts only, after the board\'s style and script, and lists inline handlers', () => {
        const { html, handlers } = frameDocument(
            '<title>Demo</title><button onclick="go()">Go</button><div onMouseOver="x()"></div><script>go = () => 1;</script><script src="https://cdn.example.com/lib.js"></script>',
            'N1',
        );
        const doc = new DOMParser().parseFromString(html, 'text/html');
        expect([...doc.head.children].map((el) => el.localName)).toEqual(['style', 'script', 'title']);
        expect([...doc.scripts].map((s) => [s.getAttribute('nonce'), s.getAttribute('src')])).toEqual([
            ['N1', null],
            ['N1', null],
            [null, 'https://cdn.example.com/lib.js'],
        ]);
        expect(doc.scripts[1].textContent).toBe('go = () => 1;');
        expect(handlers).toEqual(['onclick on <button>', 'onmouseover on <div>']);
    });

    it('runs a web block in a frame sandboxed to scripts only, and reports its inline handlers', async () => {
        vi.useFakeTimers();
        try {
            const container = document.createElement('div');
            document.body.append(container);
            const rendered = renderDocument(container, 'Intro.\n\n```html\n<h1>Stack</h1>\n<button onclick="push()">Push</button>\n```\n');
            // The page never says it loaded here: the render stops waiting for it.
            await vi.advanceTimersByTimeAsync(2000);
            const { errors } = await rendered;
            const frame = container.querySelector<HTMLIFrameElement>('section[data-block="w1"] iframe')!;
            expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
            expect(frame.srcdoc).toContain('<button onclick="push()">Push</button>');
            expect(container.querySelector('section[data-block="w1"] .board-web-title')?.textContent).toBe('Stack');
            expect(errors).toEqual([{ block: 'w1', message: expect.stringMatching(/^inline event handlers do not run on a board \(onclick on <button>\)/) }]);
            container.remove();
        } finally {
            vi.useRealTimers();
        }
    });

    it("lays a page out at its declared design size, else at the block's width and its content's height, and stops a frame-height feedback loop", async () => {
        // The frames' own scripts do not run here: the test is each page, on the port the board hands it.
        const channels: MessageChannel[] = [];
        const Real = globalThis.MessageChannel;
        globalThis.MessageChannel = class extends Real {
            constructor() {
                super();
                channels.push(this);
            }
        };
        const container = document.createElement('div');
        document.body.append(container);
        try {
            void renderDocument(container, '```html\n<meta name="viewport" content="width=3840, height=2160">\n<p>wall</p>\n```\n\n```html\n<p>column</p>\n```\n');
            const section = (id: string) => container.querySelector<HTMLElement>(`section[data-block="${id}"]`)!;
            const size = (id: string) => ['--natural', '--natural-height', '--ratio'].map((name) => section(id).querySelector<HTMLElement>('.board-web-view')!.style.getPropertyValue(name));
            // Declared: 3840 × 2160. Not declared: the block's width (jsdom has none, so 800), 16:9 until the page reports.
            expect([size('w1'), size('w2')]).toEqual([
                ['3840px', '2160px', '0.5625'],
                ['800px', '450px', '0.5625'],
            ]);
            for (const id of ['w1', 'w2']) {
                section(id).querySelector('iframe')!.dispatchEvent(new Event('load'));
            }
            const [wall, column] = channels.slice(-2).map((c) => c.port2);
            /** Posts a height as a page would; waits until the page's natural height is `expected`. */
            const grows = async (port: MessagePort, id: string, height: number, expected: string) => {
                port.postMessage({ height });
                await vi.waitFor(() => expect(size(id)[1]).toBe(expected));
            };
            /** Posts a height the board must not take; an error after it shows the board has read it. */
            const ignored = async (port: MessagePort, id: string, height: number) => {
                const before = size(id)[1];
                port.postMessage({ height });
                port.postMessage({ error: `after ${height}` });
                await vi.waitFor(() => expect(webFailure(section(id))).toContain(`after ${height}`));
                expect(size(id)[1]).toBe(before);
            };

            // A declared height stays, whatever the page's content measures.
            await ignored(wall, 'w1', 500);
            expect(size('w1')[1]).toBe('2160px');
            // Otherwise the content's height, growing and shrinking with it, within bounds.
            await grows(column, 'w2', 600, '600px');
            // 100vh plus a margin: every growth of the frame grows the page as much again. Taken once, then not.
            await grows(column, 'w2', 616, '616px');
            await ignored(column, 'w2', 632);
            await grows(column, 'w2', 300, '300px');
            await grows(column, 'w2', 5, '40px');
            await grows(column, 'w2', 99999, '6400px');
            for (const port of [wall, column]) {
                port.close();
            }
        } finally {
            globalThis.MessageChannel = Real;
            container.remove();
        }
    });

    it('takes an Alt + click pick and the hovered box from a page, checked; a pick goes to the board, the box outlines the element', async () => {
        const channels: MessageChannel[] = [];
        const Real = globalThis.MessageChannel;
        globalThis.MessageChannel = class extends Real {
            constructor() {
                super();
                channels.push(this);
            }
        };
        const inputs: WebPageInput[] = [];
        onWebPageInput((_section, input) => inputs.push(input));
        const container = document.createElement('div');
        document.body.append(container);
        try {
            void renderDocument(container, '```html\n<button>Go</button>\n```\n');
            const section = container.querySelector<HTMLElement>('section[data-block="w1"]')!;
            section.querySelector('iframe')!.dispatchEvent(new Event('load'));
            const port = channels.at(-1)!.port2;
            const element: BoardWebElement = { selector: 'body > button', tag: 'button', text: 'Go', html: '<button>Go</button>' };
            port.postMessage({ type: 'pick', element: { ...element, html: 'x'.repeat(1000) }, rect: { left: 10, top: -1e9, width: 80, height: 'tall' } });
            port.postMessage({ type: 'pick', element: { tag: 'button', html: '' }, rect: { left: 0, top: 0, width: 1, height: 1 } });
            port.postMessage({ type: 'pick', element, rect: { left: 10, top: 20, width: 80, height: -5 } });
            await vi.waitFor(() => expect(inputs).toHaveLength(1));
            // A box with a height that is no number, and an element without a selector, are no pick; a box is bounded.
            expect(inputs).toEqual([{ type: 'pick', element, rect: { left: 10, top: 20, width: 80, height: 0 } }]);

            const outline = section.querySelector<HTMLElement>('.board-web-hover')!;
            const shown = () => [outline.hidden, ...['--hover-left', '--hover-top', '--hover-width', '--hover-height'].map((name) => outline.style.getPropertyValue(name))];
            expect(outline.hidden).toBe(true);
            port.postMessage({ type: 'hover', rect: { left: 5, top: 6, width: 7, height: 8 } });
            await vi.waitFor(() => expect(shown()).toEqual([false, '5', '6', '7', '8']));
            port.postMessage({ type: 'hover', rect: null });
            await vi.waitFor(() => expect(outline.hidden).toBe(true));
            port.close();
        } finally {
            globalThis.MessageChannel = Real;
            onWebPageInput(() => {});
            container.remove();
        }
    });

    describe('describeElement', () => {
        const page = (body: string) => {
            const doc = document.implementation.createHTMLDocument('page');
            doc.body.innerHTML = body;
            return doc;
        };

        it('names an element by a selector that finds it again: from a unique id, else from body by tag, classes and :nth-of-type', () => {
            const doc = page(
                '<div id="app"><ul class="list main extra more"><li>One</li><li class="on">Two</li></ul></div>' +
                    '<p>a</p><p class="x y"><span>s</span></p>' +
                    '<div id="dup"></div><div id="dup"><i>i</i></div>' +
                    '<section id="a:b c"><em>e</em></section>',
            );
            const cases: [string, string][] = [
                ['li.on', '#app > ul.list.main.extra > li.on:nth-of-type(2)'],
                ['span', 'body > p.x.y:nth-of-type(2) > span'],
                // An id two elements share names neither.
                ['i', 'body > div:nth-of-type(3) > i'],
                ['em', '#a\\:b\\ c > em'],
                ['#app', '#app'],
                ['body', 'body'],
            ];
            for (const [find, selector] of cases) {
                const el = doc.querySelector(find)!;
                expect(describeElement(el, WEB_ELEMENT_LIMITS).selector).toBe(selector);
                expect(doc.querySelector(selector)).toBe(el);
            }
        });

        it('gives its tag, id, classes, text and HTML, whitespace collapsed and cut to the limits', () => {
            const many = Array.from({ length: 20 }, (_, i) => `c${i}`).join(' ');
            const doc = page(`<button id="go" class="primary  big">\n  Push\n  <b>one</b>\n</button><div class="${many}">${'word '.repeat(200)}</div>`);
            expect(describeElement(doc.querySelector('button')!, WEB_ELEMENT_LIMITS)).toEqual({
                selector: '#go',
                tag: 'button',
                id: 'go',
                classes: ['primary', 'big'],
                text: 'Push one',
                html: '<button id="go" class="primary big"> Push <b>one</b> </button>',
            });
            const long = describeElement(doc.querySelector('div')!, WEB_ELEMENT_LIMITS);
            expect([long.classes?.length, long.text?.length, long.text?.endsWith('…'), long.html.length, long.html.endsWith('…')]).toEqual([
                WEB_ELEMENT_LIMITS.classes,
                WEB_ELEMENT_LIMITS.text,
                true,
                WEB_ELEMENT_LIMITS.html,
                true,
            ]);
        });
    });

    describe("the board's script in a page", () => {
        /** Runs the script the board puts first in a page, on a stand-in window, with `home` as the parent window. */
        function runFrameScript(home: MessagePort): EventTarget {
            const { html } = frameDocument('<p>demo</p>', 'N1');
            const script = new DOMParser().parseFromString(html, 'text/html').scripts[0].textContent!;
            const win = new EventTarget();
            const NoSizes = class {
                observe() {}
            };
            new Function('addEventListener', 'parent', 'ResizeObserver', script)(win.addEventListener.bind(win), home, NoSizes);
            return win;
        }
        const handOver = (port: MessagePort, source: MessagePort | null) => new MessageEvent('message', { data: 'board-web-port', ports: [port], source });

        it("takes its port only from its parent, before the page's own listeners see it, and forwards only what the user did", async () => {
            const home = new MessageChannel();
            const win = runFrameScript(home.port1);
            const pageSaw: number[] = [];
            win.addEventListener('message', (e) => pageSaw.push((e as MessageEvent).ports.length), true);
            // Its height, held until it has a port.
            win.dispatchEvent(new Event('load'));

            const forged = new MessageChannel();
            const forgedGot: unknown[] = [];
            forged.port1.onmessage = (e) => forgedGot.push(e.data);
            win.dispatchEvent(handOver(forged.port2, null));
            const real = new MessageChannel();
            const got: unknown[] = [];
            real.port1.onmessage = (e) => got.push(e.data);
            win.dispatchEvent(handOver(real.port2, home.port1));
            await vi.waitFor(() => expect(got).toEqual([{ height: 0 }]));
            // The page's listener saw the forged hand-over only: the real one stopped at the board's script.
            expect([forgedGot, pageSaw]).toEqual([[], [1]]);

            // Events the page's own scripts dispatch are not the user's: a fake Escape, press, Ctrl + "="
            // or Alt + click goes nowhere, and the Alt + click stays the page's. The error after them
            // arrives in order, so nothing came before it.
            const pageClicks: boolean[] = [];
            win.addEventListener('click', (e) => pageClicks.push(e.defaultPrevented));
            win.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            win.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, cancelable: true }));
            win.dispatchEvent(new MouseEvent('pointerdown'));
            win.dispatchEvent(new MouseEvent('pointerdown', { altKey: true, cancelable: true }));
            win.dispatchEvent(new MouseEvent('click', { altKey: true, cancelable: true }));
            win.dispatchEvent(new ErrorEvent('error', { message: 'after them' }));
            await vi.waitFor(() => expect(got).toEqual([{ height: 0 }, { error: 'after them' }]));
            expect(pageClicks).toEqual([false]);
            for (const channel of [home, forged, real]) {
                channel.port1.close();
            }
        });
    });
});
