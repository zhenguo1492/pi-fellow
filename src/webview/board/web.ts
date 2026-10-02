/**
 * Web pages on the board (docs/blackboard.md#web-pages): a ```html block runs in a sandboxed frame
 * (`sandbox="allow-scripts"` without allow-same-origin, its document given as srcdoc), so its scripts
 * run in an opaque origin and reach neither this page, the VS Code API nor the extension. A srcdoc
 * document inherits this page's CSP: its own `<script>` elements get the frame nonce the CSP allows
 * (`data-frame-nonce` on #board-app, src/voiceAgent/blackboard.ts); inline event handlers, scripts
 * added at run time and anything from the network stay blocked.
 *
 * A page is shown like a picture of itself, as a diagram is: its frame is always laid out at the
 * page's natural size, its design width (`<meta name="viewport" content="width=…">`, else the
 * block's width when it is first shown) by its height (declared there too, else its content's at
 * that width), and only scaled (`--ws`, a transform) to its view, which zoom.ts and web.css size as
 * they size a diagram's. The page never reflows when the board or its zoom changes; 100vh in it is
 * its natural height. The browser maps pointer events through the transform, so clicks land on what
 * is painted under them.
 *
 * A script put first in the page reports its content's height and its errors, which go back to the
 * agent like Mermaid's, and forwards what this page must hear but cannot, since a frame's events stay
 * in it: a press (selects the block), Escape (leaves it expanded), Ctrl/Cmd + "+" "−" "0" and wheel
 * (zoom it), a middle-button or Space + left-button drag (pans it), and Alt + click, which picks the
 * element under the pointer for the user's mark (outlined while Alt is held). Everything else, plain
 * clicks, drags, text selection and plain wheel, is the page's.
 *
 * A page talks to this one only through a MessagePort handed to it on each load: no message on the
 * window is taken from a frame (main.ts drops those, origin "null"), so a page cannot pose as the host.
 * The board's script takes the port before any of the page's own listeners can see it (a capturing
 * listener added first, the event stopped there, only from the parent window, through the browser's
 * own functions taken before the page's scripts run), so the page's scripts cannot post on it.
 */
import {
    WEB_ELEMENT_LIMITS,
    WEB_PAGE_MAX_RATIO,
    WEB_PAGE_MIN_HEIGHT,
    WEB_PAGE_WIDTHS,
    WHEEL_NOTCH_PX,
    parseWebElement,
    webPageTitle,
    webPageViewport,
    type BoardWebElement,
} from '../../shared/board';
import { escapeHtml } from '../../shared/html';
import { CHROME_CLASS } from './locate';
import { describeElement } from './webElement';

/** How long a render waits for a page to load (and run its first scripts) before it reports. */
const LOAD_WAIT_MS = 2000;
/** Errors kept per page, so a script failing in a loop cannot grow the report. */
const MAX_ERRORS = 3;
const MAX_ERROR_CHARS = 300;
/** What the port is handed over with: the board's script in the page takes the first such message from its parent. */
const PORT_MESSAGE = 'board-web-port';
/** Most wheel travel, and most pan, taken from one forwarded event, px. */
const MAX_WHEEL_PX = 1000;
const MAX_PAN_PX = 2000;
/** Farthest a picked element's box may reach in its page, px: the widest page at its tallest. */
const MAX_PAGE_PX = WEB_PAGE_WIDTHS.max * WEB_PAGE_MAX_RATIO;
/** A page's width when the block has none to measure (not laid out), px. */
const FALLBACK_WIDTH = 800;
/** A page that declares no height starts this tall for its width (16:9), until it reports its content's. */
const START_RATIO = 9 / 16;

/** A page looks like a page in a browser, whatever VS Code's theme; its own styles come after these. */
const FRAME_STYLE = ':root { color-scheme: light; background: Canvas; color: CanvasText; font-family: system-ui, sans-serif; }';

/**
 * Runs first in every page. Sends this page its content's height on load and on every change, errors
 * and what the CSP blocked, and `loaded` a moment after load (its first timers have run by then); all
 * held until the port arrives, which is after the page's load event. Forwards presses, Escape, Ctrl/Cmd
 * zoom keys and wheel, pan drags, Alt + click picks and, while Alt is held, the box of the element
 * under the pointer (WebPageInput, `hover`) once it has the port; the zoom keys and wheel are kept
 * from the page, which would zoom the window, and so are a pan drag (no click, no selection) and an
 * Alt + click. Its listeners on the window capture, so they come before the page's own.
 */
const FRAME_SCRIPT = `(() => {
    const apply = Reflect.apply;
    const getter = (type, name) => Object.getOwnPropertyDescriptor(type.prototype, name).get;
    const dataOf = getter(MessageEvent, 'data');
    const sourceOf = getter(MessageEvent, 'source');
    const portsOf = getter(MessageEvent, 'ports');
    const stop = Event.prototype.stopImmediatePropagation;
    const prevent = Event.prototype.preventDefault;
    const capture = Element.prototype.setPointerCapture;
    const postOn = MessagePort.prototype.postMessage;
    const listen = addEventListener;
    const home = parent;
    let port;
    const held = [];
    const send = (message) => (port ? apply(postOn, port, [message]) : held.push(message));
    // Only what the user did: a page's own scripts can dispatch events, but not trusted ones.
    const input = (e, message) => e.isTrusted && port && apply(postOn, port, [message]);
    const swallow = (e) => {
        apply(prevent, e, []);
        apply(stop, e, []);
    };
    listen('message', (e) => {
        const ports = apply(portsOf, e, []);
        if (port || apply(sourceOf, e, []) !== home || apply(dataOf, e, []) !== '${PORT_MESSAGE}' || !ports[0]) return;
        apply(stop, e, []);
        port = ports[0];
        held.splice(0).forEach((message) => apply(postOn, port, [message]));
    }, true);

    // Picking: an Alt + left click picks the element under the pointer (describeElement), its box in
    // the page's own px; the page sees none of the press. While Alt is held, the board outlines the
    // element an Alt + click would pick.
    const describe = ${describeElement};
    const limits = ${JSON.stringify(WEB_ELEMENT_LIMITS)};
    const boxOf = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    let picking;
    let hovered;
    let pointer;
    const hover = (el) => {
        if (el === hovered || !port) return;
        hovered = el;
        apply(postOn, port, [{ type: 'hover', rect: el ? boxOf(el) : null }]);
    };

    // Panning: a middle-button drag, or a left-button drag while Space is held; the page sees none of it.
    let space = false;
    let pan;
    let panned = false;
    listen('pointerdown', (e) => {
        input(e, { type: 'press' });
        panned = false;
        picking = undefined;
        if (e.isTrusted && e.button === 0 && e.altKey && !space && e.target instanceof Element) {
            // Its default withheld: no mouse events follow, so the page's mousedown and mouseup never run.
            swallow(e);
            picking = e.target;
            return;
        }
        if (!e.isTrusted || !(e.button === 1 || (e.button === 0 && space))) return;
        // Its default withheld: no mouse events follow, so no text selection and no middle-button autoscroll.
        swallow(e);
        pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
        panned = true;
        try { apply(capture, e.target, [e.pointerId]); } catch {}
    }, true);
    // How far the pointer is from the point it grabbed, in the page's own px. The board scrolls the
    // page that far after it, so the grabbed point comes back under the pointer: measured on the page,
    // not the screen, it needs no screen scale and corrects itself.
    listen('pointermove', (e) => {
        if (!e.isTrusted) return;
        pointer = { x: e.clientX, y: e.clientY };
        hover(e.altKey && !pan && e.target instanceof Element ? e.target : undefined);
        if (!pan || e.pointerId !== pan.id) return;
        swallow(e);
        input(e, { type: 'pan', dx: e.clientX - pan.x, dy: e.clientY - pan.y });
    }, true);
    listen('pointerout', (e) => {
        if (!e.relatedTarget) hover(undefined);
    }, true);
    const endPan = (e) => {
        if (!pan || e.pointerId !== pan.id) return;
        swallow(e);
        pan = undefined;
    };
    listen('pointerup', endPan, true);
    listen('pointercancel', endPan, true);
    listen('pointerup', (e) => {
        if (picking && e.isTrusted && e.button === 0) swallow(e);
    }, true);
    // The click a pan press would end in is no click on the page.
    for (const type of ['click', 'auxclick']) {
        listen(type, (e) => {
            if (!panned || !e.isTrusted) return;
            panned = false;
            swallow(e);
        }, true);
    }
    // Nor is the click an Alt press ends in: it picks what was pressed.
    listen('click', (e) => {
        if (!picking || !e.isTrusted) return;
        const el = picking;
        picking = undefined;
        swallow(e);
        hover(undefined);
        input(e, { type: 'pick', element: describe(el, limits), rect: boxOf(el) });
    }, true);
    listen('blur', () => {
        space = false;
        hover(undefined);
    });
    listen('keyup', (e) => {
        if (e.key === ' ') space = false;
        if (e.key === 'Alt') hover(undefined);
    }, true);

    listen('keydown', (e) => {
        if (e.key === 'Alt') {
            if (e.isTrusted && pointer) hover(document.elementFromPoint(pointer.x, pointer.y) ?? undefined);
            return;
        }
        if (e.key === ' ') {
            space = e.isTrusted;
            // Space on the page itself would scroll the board (the frame, at its natural size, cannot
            // scroll); on a field or a button it is the page's.
            if (space && (e.target === document.body || e.target === document.documentElement)) apply(prevent, e, []);
            return;
        }
        if (e.key === 'Escape') {
            input(e, { type: 'escape' });
            return;
        }
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const direction = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' ? 1
            : e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract' ? -1
            : e.key === '0' || e.code === 'Numpad0' ? 0 : undefined;
        if (direction !== undefined) {
            apply(prevent, e, []);
            input(e, { type: 'zoomKey', direction });
        }
    }, true);
    listen('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        apply(prevent, e, []);
        // Its travel in px as the board measures it (wheelPx in src/shared/board.ts): lines three to a notch, pages a notch each.
        const px = e.deltaMode === 0 ? e.deltaY : e.deltaMode === 1 ? e.deltaY * ${WHEEL_NOTCH_PX / 3} : e.deltaY * ${WHEEL_NOTCH_PX};
        input(e, { type: 'wheel', deltaPx: px });
    }, { capture: true, passive: false });
    listen('error', (e) => send({ error: e.message || 'Script error' }));
    listen('unhandledrejection', (e) => send({ error: 'Unhandled promise rejection: ' + String(e.reason) }));
    listen('securitypolicyviolation', (e) => {
        const what = e.blockedURI === 'inline'
            ? (e.violatedDirective.startsWith('script-src-attr') ? 'an inline event handler (attach it with addEventListener)' : 'a script added at run time')
            : e.blockedURI === 'eval' ? 'eval or new Function' : e.blockedURI + ' (the page must be self-contained)';
        send({ error: 'Blocked: ' + what });
    });
    let last = -1;
    const size = () => {
        const height = Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, document.body ? document.body.scrollHeight : 0));
        if (height !== last) {
            last = height;
            send({ height });
        }
    };
    listen('load', () => {
        size();
        const sizes = new ResizeObserver(size);
        sizes.observe(document.documentElement);
        if (document.body) sizes.observe(document.body);
        setTimeout(() => send({ loaded: true }), 200);
    });
})();`;

/** A box in a web page's own px (its frame's viewport, before the frame's scale). */
export interface WebPageBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * What a web page forwards from inside its frame. `wheel`: Ctrl/Cmd + wheel travel in px (negative:
 * in). `pan`: how far a pan drag moved since the last, in screen px. `pick`: the element an Alt +
 * click picked, and its box.
 */
export type WebPageInput =
    | { type: 'press' }
    | { type: 'escape' }
    | { type: 'zoomKey'; direction: 1 | -1 | 0 }
    | { type: 'wheel'; deltaPx: number }
    | { type: 'pan'; dx: number; dy: number }
    | { type: 'pick'; element: BoardWebElement; rect: WebPageBox };

let onInput: (section: HTMLElement, input: WebPageInput) => void = () => {};

/** Who acts on what web pages forward (main.ts, into zoom.ts). */
export function onWebPageInput(handler: (section: HTMLElement, input: WebPageInput) => void): void {
    onInput = handler;
}

interface FrameState {
    /** Found in the source: its inline event handlers, which do not run. */
    handlers?: string;
    /** Reported by the page as it runs. */
    errors: string[];
    /** The current load's channel (a reload opens another). */
    port?: MessagePort;
    loaded?: () => void;
    /** The natural size the frame is laid out at, px; `fixedHeight`: declared, so reports do not change it. */
    width: number;
    height: number;
    fixedHeight: boolean;
    /** How far the last report grew the height: a page whose next report grows it as far again follows its frame. */
    lastGrowth: number;
}

const frames = new WeakMap<HTMLIFrameElement, FrameState>();

/**
 * The document a frame shows for `source`: the board's style and script first, `nonce` on the page's
 * own inline scripts; `handlers`: its inline event handlers (`onclick on <button>`), which do not run.
 */
export function frameDocument(source: string, nonce: string): { html: string; handlers: string[] } {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    for (const script of doc.querySelectorAll('script:not([src])')) {
        script.setAttribute('nonce', nonce);
    }
    const handlers = new Set<string>();
    for (const el of doc.querySelectorAll('*')) {
        for (const attr of el.attributes) {
            if (/^on/i.test(attr.name)) {
                handlers.add(`${attr.name} on <${el.localName}>`);
            }
        }
    }
    const style = doc.createElement('style');
    style.textContent = FRAME_STYLE;
    const script = doc.createElement('script');
    script.setAttribute('nonce', nonce);
    script.textContent = FRAME_SCRIPT;
    doc.head.prepend(style, script);
    return { html: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`, handlers: [...handlers] };
}

/** A box as a page sent it, bounded to the largest page; undefined when it is not one. */
function pageBoxOf(value: unknown): WebPageBox | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const box = value as Record<string, unknown>;
    const [left, top, width, height] = [box.left, box.top, box.width, box.height].map((v, i) =>
        typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, i < 2 ? -MAX_PAGE_PX : 0), MAX_PAGE_PX) : undefined,
    );
    return left === undefined || top === undefined || width === undefined || height === undefined ? undefined : { left, top, width, height };
}

/** A forwarded input as the page sent it, checked; undefined for anything else. */
function inputOf(data: Record<string, unknown>): WebPageInput | undefined {
    const bounded = (value: unknown, max: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, -max), max) : undefined);
    switch (data.type) {
        case 'press':
        case 'escape':
            return { type: data.type };
        case 'zoomKey':
            return data.direction === 1 || data.direction === -1 || data.direction === 0 ? { type: 'zoomKey', direction: data.direction } : undefined;
        case 'wheel': {
            const deltaPx = bounded(data.deltaPx, MAX_WHEEL_PX);
            return deltaPx === undefined ? undefined : { type: 'wheel', deltaPx };
        }
        case 'pan': {
            const dx = bounded(data.dx, MAX_PAN_PX);
            const dy = bounded(data.dy, MAX_PAN_PX);
            return dx === undefined || dy === undefined ? undefined : { type: 'pan', dx, dy };
        }
        case 'pick': {
            const element = parseWebElement(data.element);
            const rect = pageBoxOf(data.rect);
            return element && rect ? { type: 'pick', element, rect } : undefined;
        }
        default:
            return undefined;
    }
}

/**
 * Outlines in a page's stage the element an Alt + click would pick (`box` in the page's px, scaled
 * as the frame is, by web.css); undefined hides the outline.
 */
function showHover(frame: HTMLIFrameElement, box: WebPageBox | undefined): void {
    const outline = frame.parentElement?.querySelector<HTMLElement>('.board-web-hover');
    if (!outline) {
        return;
    }
    outline.hidden = !box;
    if (box) {
        outline.style.setProperty('--hover-left', String(box.left));
        outline.style.setProperty('--hover-top', String(box.top));
        outline.style.setProperty('--hover-width', String(box.width));
        outline.style.setProperty('--hover-height', String(box.height));
    }
}

/** Lays the frame out at its natural size: `--natural` (width), `--natural-height`, `--ratio` (height / width), on its view. */
function showNaturalSize(frame: HTMLIFrameElement, state: FrameState): void {
    const view = frame.closest<HTMLElement>('.board-web-view')!;
    view.style.setProperty('--natural', `${state.width}px`);
    view.style.setProperty('--natural-height', `${state.height}px`);
    view.style.setProperty('--ratio', String(state.height / state.width));
}

/**
 * A height the page reported, its content's at its natural width. Followed (bounded) unless the page
 * declared one. A page as tall as its frame plus something (100vh and a margin) reports a little more
 * every time its frame grows: once a report grows it by as much as the last one did, it is that
 * feedback, and the frame stays as it is.
 */
function takeHeight(frame: HTMLIFrameElement, state: FrameState, reported: number): void {
    if (state.fixedHeight) {
        return;
    }
    const height = Math.min(Math.max(Math.ceil(reported), WEB_PAGE_MIN_HEIGHT), state.width * WEB_PAGE_MAX_RATIO);
    const growth = height - state.height;
    if (growth === 0 || (growth > 0 && growth === state.lastGrowth)) {
        return;
    }
    state.lastGrowth = Math.max(growth, 0);
    state.height = height;
    showNaturalSize(frame, state);
}

/**
 * What a page sent through its port. Pages are untrusted: only a height, an error, an input or a
 * hovered box is taken, checked and bounded.
 */
function fromPage(frame: HTMLIFrameElement, state: FrameState, data: unknown): void {
    if (!data || typeof data !== 'object') {
        return;
    }
    const message = data as Record<string, unknown>;
    if (message.type === 'hover') {
        showHover(frame, pageBoxOf(message.rect));
        return;
    }
    const input = inputOf(message);
    if (input) {
        const section = frame.closest<HTMLElement>('section.board-block');
        if (section) {
            onInput(section, input);
        }
        return;
    }
    const { height, error, loaded } = message;
    if (typeof height === 'number' && Number.isFinite(height)) {
        takeHeight(frame, state, height);
    }
    if (typeof error === 'string' && state.errors.length < MAX_ERRORS) {
        const text = error.slice(0, MAX_ERROR_CHARS);
        if (!state.errors.includes(text)) {
            state.errors.push(text);
        }
    }
    if (loaded === true) {
        state.loaded?.();
        state.loaded = undefined;
    }
}

/**
 * Fills a web block's section: a header (the page's title, Reload, Source, and `toolsHtml`: its zoom
 * and expand), the frame in its view, and the source as `sourceHtml` shows it (a highlighted code
 * block), hidden. Returns what starts the page once the section is on the board, where its width can
 * be measured; that resolves once the page has loaded, or after LOAD_WAIT_MS.
 */
export function buildWebPage(section: HTMLElement, source: string, sourceHtml: string, toolsHtml: string): () => Promise<void> {
    const title = webPageTitle(source) ?? 'Web page';
    section.innerHTML =
        `<div class="board-web">` +
        `<div class="board-web-header ${CHROME_CLASS}"><span class="board-web-title">${escapeHtml(title)}</span>` +
        `<button type="button" data-web="reload" title="Run the page again from the start">Reload</button>` +
        `<button type="button" data-web="source" aria-pressed="false" title="Show the page's HTML source">Source</button>${toolsHtml}</div>` +
        `<div class="board-web-body"><div class="board-web-view"><div class="board-web-stage">` +
        `<iframe class="board-web-frame" sandbox="allow-scripts"></iframe><div class="board-web-hover" hidden></div></div></div></div>` +
        `<div class="board-web-source" hidden>${sourceHtml}</div>` +
        `</div>`;
    const frame = section.querySelector<HTMLIFrameElement>('.board-web-frame')!;
    frame.title = title;
    const nonce = document.getElementById('board-app')?.dataset.frameNonce ?? '';
    const { html, handlers } = frameDocument(source, nonce);
    return () => {
        const declared = webPageViewport(source);
        const measured = section.querySelector<HTMLElement>('.board-web-body')!.clientWidth;
        const width = declared.width ?? (measured > 0 ? Math.min(Math.max(measured, WEB_PAGE_WIDTHS.min), WEB_PAGE_WIDTHS.max) : FALLBACK_WIDTH);
        const state: FrameState = {
            errors: [],
            width,
            height: declared.height ?? Math.round(width * START_RATIO),
            fixedHeight: declared.height !== undefined,
            lastGrowth: 0,
        };
        if (handlers.length) {
            state.handlers = `inline event handlers do not run on a board (${handlers.slice(0, 3).join(', ')}${handlers.length > 3 ? ', …' : ''}): attach them with addEventListener in a <script>`;
        }
        frames.set(frame, state);
        showNaturalSize(frame, state);
        // The frame's scale: its stage's width (its view's, zoomed) over its natural width.
        const stage = frame.parentElement!;
        new ResizeObserver(([entry]) => stage.style.setProperty('--ws', String(entry.contentRect.width / state.width))).observe(stage);
        // Each load is a new document: it gets a port of its own.
        frame.addEventListener('load', () => {
            showHover(frame, undefined);
            state.port?.close();
            const channel = new MessageChannel();
            state.port = channel.port1;
            channel.port1.onmessage = (event) => fromPage(frame, state, event.data);
            frame.contentWindow?.postMessage(PORT_MESSAGE, '*', [channel.port2]);
        });
        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(resolve, LOAD_WAIT_MS);
        state.loaded = () => {
            clearTimeout(timer);
            resolve();
        };
        frame.srcdoc = html;
        return promise;
    };
}

/** What went wrong in a web block's page so far, one message; undefined when nothing did. */
export function webFailure(section: Element): string | undefined {
    const frame = section.querySelector<HTMLIFrameElement>('.board-web-frame');
    const state = frame ? frames.get(frame) : undefined;
    const all = state ? [...(state.handlers ? [state.handlers] : []), ...state.errors] : [];
    return all.length ? all.join('; ') : undefined;
}

/** A web block's header button: Reload runs the page again (its errors start over), Source swaps the page and its HTML. */
export function webAction(button: HTMLButtonElement): void {
    const web = button.closest('.board-web');
    const frame = web?.querySelector<HTMLIFrameElement>('.board-web-frame');
    const state = frame && frames.get(frame);
    if (!web || !frame || !state) {
        return;
    }
    if (button.dataset.web === 'reload') {
        state.errors = [];
        state.lastGrowth = 0;
        // Setting srcdoc again loads the page anew, at the same natural width.
        frame.srcdoc = frame.srcdoc;
    } else if (button.dataset.web === 'source') {
        const showSource = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(showSource));
        web.querySelector<HTMLElement>('.board-web-body')!.hidden = showSource;
        web.querySelector<HTMLElement>('.board-web-source')!.hidden = !showSource;
    }
}
