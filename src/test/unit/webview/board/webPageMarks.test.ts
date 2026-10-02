// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoardClientMessage, BoardWebElement } from '../../../../shared/board';

const posted = vi.hoisted(() => [] as BoardClientMessage[]);
vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: (m: BoardClientMessage) => posted.push(m) } }));
vi.mock('../../../../webview/board/diagrams', () => ({
    drawDiagram: async () => {},
    diagramFailure: () => undefined,
    redrawDiagram: async () => {},
    watchDiagramTheme: () => {},
}));

/** The ports the board hands its pages, in order (the pages' own scripts do not run in jsdom). */
const channels: MessageChannel[] = [];

describe("board page: the user's mark in a web page", () => {
    let page: MessagePort;

    beforeAll(async () => {
        document.body.innerHTML = '<div id="board-app"></div>';
        window.scrollTo = () => {};
        window.scrollBy = () => {};
        globalThis.ResizeObserver ??= class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as unknown as typeof ResizeObserver;
        const Real = globalThis.MessageChannel;
        globalThis.MessageChannel = class extends Real {
            constructor() {
                super();
                channels.push(this);
            }
        };
        // Loaded here, not imported at the top: the page builds itself into #board-app as it loads.
        await import('../../../../webview/board/main');
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'render', version: 1, title: 'T', markdown: '```html\n<div id="app"><button>Go</button></div>\n```' } }));
        await vi.waitFor(() => expect(document.querySelector('section[data-block="w1"] iframe')).not.toBeNull());
        document.querySelector('section[data-block="w1"] iframe')!.dispatchEvent(new Event('load'));
        page = channels.at(-1)!.port2;
    });

    const marks = () => posted.filter((m) => m.type === 'userMark').map((m) => (m.type === 'userMark' ? m.mark : undefined));
    const go: BoardWebElement = { selector: '#app > button', tag: 'button', text: 'Go', html: '<button>Go</button>' };
    const app: BoardWebElement = { selector: '#app', tag: 'div', id: 'app', text: 'Go', html: '<div id="app"><button>Go</button></div>' };
    const pick = (element: BoardWebElement) => page.postMessage({ type: 'pick', element, rect: { left: 0, top: 0, width: 40, height: 20 } });

    it('marks the element an Alt + click picked, replaces it with another, and clears it when picked again or on Escape in the page', async () => {
        pick(go);
        await vi.waitFor(() => expect(marks()).toEqual([{ block: 'w1', kind: 'web', element: go }]));
        pick(app);
        await vi.waitFor(() => expect(marks()).toHaveLength(2));
        pick(app);
        await vi.waitFor(() => expect(marks()).toEqual([{ block: 'w1', kind: 'web', element: go }, { block: 'w1', kind: 'web', element: app }, null]));

        pick(go);
        page.postMessage({ type: 'escape' });
        await vi.waitFor(() => expect(marks().slice(3)).toEqual([{ block: 'w1', kind: 'web', element: go }, null]));
    });
});
