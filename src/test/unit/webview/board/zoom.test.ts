// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardClientMessage, BoardHostMessage } from '../../../../shared/board';

const posted = vi.hoisted(() => [] as BoardClientMessage[]);
vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: (m: BoardClientMessage) => posted.push(m) } }));
// Mermaid needs a real layout engine: a diagram is drawn as its view with one node, as diagrams.ts frames it.
vi.mock('../../../../webview/board/diagrams', () => ({
    drawDiagram: async (host: HTMLElement) => {
        host.innerHTML = '<div class="board-diagram-view"><svg viewBox="0 0 100 40"><g class="node" id="flowchart-A-0"><text>Alpha</text></g></svg></div>';
    },
    diagramFailure: () => undefined,
    redrawDiagram: async () => {},
    watchDiagramTheme: () => {},
}));

function fromHost(message: BoardHostMessage): void {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
}

async function status(seq: number): Promise<Extract<BoardClientMessage, { type: 'status' }>> {
    fromHost({ type: 'status', seq });
    return vi.waitFor(() => {
        const reply = posted.find((m) => m.type === 'status' && m.seq === seq);
        if (reply?.type !== 'status') {
            throw new Error(`no status ${seq} yet`);
        }
        return reply;
    });
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T & Element>(selector)!;
const pageZoom = () => [$('.board-zoom-reset').textContent, $('.board-doc').style.transform];
const diagram = () => {
    const view = $('section[data-block="d1"] .board-diagram-view');
    return [view.style.getPropertyValue('--dz'), view.classList.contains('is-zoomed'), $('section[data-block="d1"] [data-zoom="fit"]').textContent];
};
const key = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(event);
    return event;
};
/** Waits until the last `zoomed` the page sent the host (once zooming paused) is `zoom`. */
const reported = (zoom: unknown) =>
    vi.waitFor(() => {
        const report = posted.findLast((m) => m.type === 'zoomed');
        expect(report?.type === 'zoomed' ? report.zoom : undefined).toEqual(zoom);
    });

describe('board page: zoom', () => {
    /** What reached the window, where VS Code's webview frame listens to pass keys and wheel on to the workbench. */
    const reachedWindow: string[] = [];

    beforeAll(async () => {
        document.body.innerHTML = '<div id="board-app"></div>';
        // jsdom has no scrolling: the page's scroll calls do nothing here.
        window.scrollTo = () => {};
        window.scrollBy = () => {};
        globalThis.ResizeObserver ??= class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as unknown as typeof ResizeObserver;
        // Loaded here, not imported at the top: the page builds itself into #board-app as it loads.
        await import('../../../../webview/board/main');
        window.addEventListener('keydown', (e) => reachedWindow.push(`key ${e.key}`));
        window.addEventListener('wheel', (e) => reachedWindow.push(`wheel ${e.deltaY}`));
        fromHost({ type: 'render', version: 1, title: 'T', markdown: '# T\n\n```mermaid\nflowchart LR\nA\n```' });
        await vi.waitFor(() => expect(posted.some((m) => m.type === 'rendered')).toBe(true));
    });

    beforeEach(() => {
        posted.length = 0;
        reachedWindow.length = 0;
    });

    it('puts − / percent / + before Edit source and Maximize, and steps the page zoom by 1.1× from 30% to 300%', () => {
        expect([...document.querySelectorAll('.board-header button')].map((b) => b.textContent || b.getAttribute('aria-label')?.split(':')[0])).toEqual(['−', '100%', '+', 'Edit source', 'Maximize']);
        $('.board-zoom-in').click();
        expect(pageZoom()).toEqual(['110%', 'scale(1.1)']);
        $('.board-zoom-in').click();
        expect(pageZoom()).toEqual(['121%', 'scale(1.21)']);
        for (let i = 0; i < 20; i++) $('.board-zoom-in').click();
        expect(pageZoom()).toEqual(['300%', 'scale(3)']);
        $('.board-zoom-reset').click();
        expect(pageZoom()).toEqual(['100%', '']);
        for (let i = 0; i < 20; i++) $('.board-zoom-out').click();
        expect(pageZoom()).toEqual(['30%', 'scale(0.3)']);
        $('.board-zoom-reset').click();
    });

    it('zooms only the diagram a click selected with Ctrl/Cmd + wheel, "+", "−", "0"; unselected they zoom nothing, and never reach VS Code', async () => {
        const section = $('section[data-block="d1"]');
        const ctrlWheel = (deltaY: number) => {
            const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY });
            document.body.dispatchEvent(event);
            return event;
        };
        const pressOn = (el: Element) => el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));

        // Nothing selected: neither the page nor a diagram zooms, and VS Code does not zoom the window.
        expect(ctrlWheel(-100).defaultPrevented).toBe(true);
        expect(key({ key: '=', ctrlKey: true }).defaultPrevented).toBe(true);
        expect([pageZoom(), diagram(), section.classList.contains('is-selected')]).toEqual([['100%', ''], ['1', false, '100%'], false]);

        // A press on the diagram selects it; the page zoom stays where it is.
        pressOn($('section[data-block="d1"] g.node'));
        expect(section.classList.contains('is-selected')).toBe(true);
        ctrlWheel(-100);
        expect([pageZoom()[0], diagram()]).toEqual(['100%', ['1.1', true, '110%']]);
        // A mouse notch is 1.1×; a trackpad pinch's small deltas zoom a little each, in proportion.
        ctrlWheel(25);
        expect(diagram()).toEqual(['1.074099', true, '107%']);
        for (let i = 0; i < 3; i++) ctrlWheel(25);
        expect(diagram()[2]).toBe('100%');
        // Keys step 1.1× from there, on the steps' grid.
        key({ key: '+', metaKey: true });
        key({ key: '=', ctrlKey: true });
        expect(diagram()).toEqual(['1.21', true, '121%']);
        key({ key: '-', ctrlKey: true });
        expect(diagram()).toEqual(['1.1', true, '110%']);
        key({ key: '0', ctrlKey: true });
        expect([pageZoom()[0], diagram()]).toEqual(['100%', ['1', false, '100%']]);
        // Without the modifier, or with Alt, it is typing; a plain wheel scrolls: left alone.
        expect(key({ key: '=' }).defaultPrevented).toBe(false);
        expect(key({ key: '=', ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
        document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }));
        expect(diagram()).toEqual(['1', false, '100%']);

        // A press elsewhere ends the selection: Ctrl + wheel zooms nothing again.
        pressOn($('section[data-block="h1"]'));
        expect(section.classList.contains('is-selected')).toBe(false);
        ctrlWheel(-100);
        expect([pageZoom(), diagram()]).toEqual([['100%', ''], ['1', false, '100%']]);
        expect(reachedWindow).toEqual(['key =', 'key =', 'wheel 100']);
        await reported({ page: 1, blocks: {} });
    });

    it("zooms one diagram with its own buttons by 1.1×, 10% to 800%, and tells the host once zooming pauses", async () => {
        const tool = (zoom: string) => $<HTMLButtonElement>(`section[data-block="d1"] [data-zoom="${zoom}"]`);
        expect(diagram()).toEqual(['1', false, '100%']);
        tool('in').click();
        tool('in').click();
        expect(diagram()).toEqual(['1.21', true, '121%']);
        expect(pageZoom()[0]).toBe('100%');
        for (let i = 0; i < 30; i++) tool('in').click();
        expect(diagram()).toEqual(['8', true, '800%']);
        await reported({ page: 1, blocks: { d1: 8 } });
        for (let i = 0; i < 60; i++) tool('out').click();
        expect(diagram()).toEqual(['0.1', false, '10%']);
        tool('fit').click();
        expect(diagram()).toEqual(['1', false, '100%']);
        await reported({ page: 1, blocks: {} });
        expect(posted.filter((m) => m.type === 'zoomed')).toHaveLength(2);
    });

    it('pans a zoomed diagram by dragging without marking what the drag ended on; a click still marks the node', async () => {
        $<HTMLButtonElement>('section[data-block="d1"] [data-zoom="in"]').click();
        const node = $('section[data-block="d1"] g.node');
        const press = (type: string, x: number) => node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 10 }));
        press('pointerdown', 10);
        press('pointermove', 30);
        expect($('.board-diagram-view').classList.contains('is-panning')).toBe(true);
        press('pointerup', 30);
        press('mouseup', 30);
        expect($('.board-diagram-view').classList.contains('is-panning')).toBe(false);
        // A jiggle under the drag distance is still a click.
        press('pointerdown', 10);
        press('pointermove', 12);
        press('pointerup', 12);
        press('mouseup', 12);
        await vi.waitFor(() => expect(posted.filter((m) => m.type === 'userMark')).toEqual([{ type: 'userMark', mark: { block: 'd1', kind: 'diagram', node: 'Alpha' } }]));
        $<HTMLButtonElement>('section[data-block="d1"] [data-zoom="fit"]').click();
    });

    it('fills the board with one diagram from its ⤢ button; Escape or the button goes back, and Escape then leaves the mark alone', async () => {
        const expand = $<HTMLButtonElement>('section[data-block="d1"] [data-zoom="expand"]');
        const state = () => [$('section[data-block="d1"]').classList.contains('is-expanded'), document.body.classList.contains('board-expanded'), expand.getAttribute('aria-pressed')];
        expect(state()).toEqual([false, false, 'false']);
        expand.click();
        expect(state()).toEqual([true, true, 'true']);
        expand.click();
        expect(state()).toEqual([false, false, 'false']);

        // The user's mark (made by an earlier test) survives an Escape that only leaves the expanded diagram.
        expand.click();
        key({ key: 'Escape' });
        expect(state()).toEqual([false, false, 'false']);
        await vi.waitFor(() => expect(posted.some((m) => m.type === 'userMark')).toBe(false));
        key({ key: 'Escape' });
        expect(posted.filter((m) => m.type === 'userMark')).toEqual([{ type: 'userMark', mark: null }]);
    });

    it('leaves an expanded, zoomed diagram with Escape at 100%, and tells the host', async () => {
        $<HTMLButtonElement>('section[data-block="d1"] [data-zoom="expand"]').click();
        const zoomIn = $<HTMLButtonElement>('section[data-block="d1"] [data-zoom="in"]');
        zoomIn.click();
        zoomIn.click();
        expect(diagram()).toEqual(['1.21', true, '121%']);
        key({ key: 'Escape' });
        expect([$('section[data-block="d1"]').classList.contains('is-expanded'), diagram()]).toEqual([false, ['1', false, '100%']]);
        await reported({ page: 1, blocks: {} });
    });

    it("expands on the host's word; Pi's point inside keeps it and its zoom, a point elsewhere brings the board back", async () => {
        fromHost({ type: 'expand', seq: 10, block: 'p1' });
        await vi.waitFor(() => expect(posted.find((m) => m.type === 'expanded')).toEqual({ type: 'expanded', seq: 10, error: 'No diagram or web page p1 on this board.' }));
        $<HTMLButtonElement>('section[data-block="d1"] [data-zoom="in"]').click();
        fromHost({ type: 'expand', seq: 11, block: 'd1' });
        fromHost({ type: 'point', seq: 12, target: { block: 'd1', text: 'Alpha' }, style: 'box' });
        const inside = await status(13);
        expect([inside.expanded, inside.zoom.blocks, inside.point?.found]).toEqual(['d1', { d1: 1.1 }, 'node']);
        fromHost({ type: 'point', seq: 14, target: { block: 'h1' }, style: 'highlight' });
        const outside = await status(15);
        expect([outside.expanded, outside.point?.target.block, $('section[data-block="d1"]').classList.contains('is-expanded')]).toEqual([null, 'h1', false]);
        $<HTMLButtonElement>('section[data-block="d1"] [data-zoom="fit"]').click();
    });

    it("takes on the host's zoom for a new page without sending it back, and reports its zoom in status", async () => {
        fromHost({ type: 'zoom', zoom: { page: 1.5, blocks: { d1: 2, d9: 3 } } });
        await vi.waitFor(() => expect(pageZoom()).toEqual(['150%', 'scale(1.5)']));
        // d9 is not on this board any more.
        expect(diagram()).toEqual(['2', true, '200%']);
        expect((await status(1)).zoom).toEqual({ page: 1.5, blocks: { d1: 2 } });
        // A render that removes the diagram drops its zoom, and the host learns of it.
        fromHost({ type: 'render', version: 2, title: 'T', markdown: '# T' });
        await reported({ page: 1.5, blocks: {} });
        expect(posted.some((m) => m.type === 'zoomed' && m.zoom.blocks.d1)).toBe(false);
    });

    it('gives a web page its own zoom and ⤢ in its header; what its frame forwards selects, zooms and leaves it expanded', async () => {
        $('.board-zoom-reset').click();
        // The frame's own script does not run here: the test is the page, on the port the board hands it.
        const channels: MessageChannel[] = [];
        const Real = globalThis.MessageChannel;
        globalThis.MessageChannel = class extends Real {
            constructor() {
                super();
                channels.push(this);
            }
        };
        try {
            fromHost({ type: 'render', version: 3, title: 'T', markdown: '# T\n\n```html\n<title>Stack</title>\n<p>demo</p>\n```' });
            await vi.waitFor(() => expect(posted.some((m) => m.type === 'rendered' && m.version === 3)).toBe(true), { timeout: 4000 });
            const section = $('section[data-block="w1"]');
            const frame = $<HTMLIFrameElement>('section[data-block="w1"] iframe');
            if (!channels.length) {
                frame.dispatchEvent(new Event('load'));
            }
            const fromPage = channels.at(-1)!.port2;
            const view = $('section[data-block="w1"] .board-web-view');
            const web = () => [view.style.getPropertyValue('--dz'), $('section[data-block="w1"] [data-zoom="fit"]').textContent];
            const tool = (zoom: string) => $<HTMLButtonElement>(`section[data-block="w1"] .board-web-header [data-zoom="${zoom}"]`);
            expect([...section.querySelectorAll('.board-web-header button')].map((b) => b.textContent)).toEqual(['Reload', 'Source', '−', '100%', '+', '⤢']);

            // Its buttons step it like a diagram; the host keeps it by block id.
            tool('in').click();
            expect(web()).toEqual(['1.1', '110%']);
            await reported({ page: 1, blocks: { w1: 1.1 } });
            // Zoomed in, its view scrolls: a pan drag forwarded from the page moves it after the pointer,
            // page px converted by the frame's on-screen scale (here half its own size; jsdom lays out nothing).
            expect(view.classList.contains('is-zoomed')).toBe(true);
            Object.defineProperty(frame, 'offsetWidth', { value: 800 });
            frame.getBoundingClientRect = () => new DOMRect(0, 0, 400, 225);
            Object.defineProperty(view, 'scrollLeft', { value: 100, writable: true });
            Object.defineProperty(view, 'scrollTop', { value: 100, writable: true });
            fromPage.postMessage({ type: 'pan', dx: -40, dy: 10 });
            fromPage.postMessage({ type: 'pan', dx: 'far', dy: 10 });
            await vi.waitFor(() => expect([view.scrollLeft, view.scrollTop]).toEqual([120, 95]));

            // A press inside the frame selects it, and its Ctrl/Cmd keys and wheel zoom it; nonsense is ignored.
            fromPage.postMessage({ type: 'press' });
            await vi.waitFor(() => expect(section.classList.contains('is-selected')).toBe(true));
            fromPage.postMessage({ type: 'zoomKey', direction: 5 });
            fromPage.postMessage({ type: 'zoomKey', direction: 1 });
            await vi.waitFor(() => expect(web()).toEqual(['1.21', '121%']));
            // Its wheel comes through as travel, zooming in proportion: half a notch out is 1.1^-0.5.
            fromPage.postMessage({ type: 'wheel', deltaPx: 50 });
            await vi.waitFor(() => expect(web()).toEqual(['1.15369', '115%']));

            // ⤢ fills the board with it; the host's status says so, and Pi's point at it keeps it there.
            tool('expand').click();
            expect([section.classList.contains('is-expanded'), document.body.classList.contains('board-expanded'), tool('expand').getAttribute('aria-pressed')]).toEqual([true, true, 'true']);
            fromHost({ type: 'point', seq: 20, target: { block: 'w1' }, style: 'highlight' });
            const shown = await status(21);
            expect([shown.expanded, shown.point?.found, shown.zoom.blocks, shown.webPages.map((p) => p.block)]).toEqual(['w1', 'block', { w1: 1.15369 }, ['w1']]);

            // Escape pressed inside the frame, which the board page never hears, comes through its port:
            // back to the board, at 100%.
            fromPage.postMessage({ type: 'escape' });
            await vi.waitFor(() => expect([section.classList.contains('is-expanded'), document.body.classList.contains('board-expanded'), web()]).toEqual([false, false, ['1', '100%']]));
            await reported({ page: 1, blocks: {} });

            // board_view expand and collapse take it too.
            fromHost({ type: 'expand', seq: 22, block: 'w1' });
            await vi.waitFor(() => expect(section.classList.contains('is-expanded')).toBe(true));
            fromHost({ type: 'expand', seq: 23, block: null });
            await vi.waitFor(() => expect(section.classList.contains('is-expanded')).toBe(false));
            fromPage.close();
        } finally {
            globalThis.MessageChannel = Real;
        }
    });
});
