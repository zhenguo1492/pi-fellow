/**
 * The board webview (docs/blackboard.md): one Markdown document with Pi's point and the user's mark on
 * it. The host (src/voiceAgent/blackboard.ts) sends BoardHostMessage; this page answers with
 * BoardClientMessage. Messages are handled one at a time, so a point waits for the render before it.
 */
import type { BoardBox, BoardClientMessage, BoardFound, BoardHostMessage, BoardMarkStyle, BoardShownDiagram, BoardShownWebPage, BoardTarget } from '../../shared/board';
import { vscode } from '../vscodeApi';
import { watchDiagramTheme } from './diagrams';
import { blockAt, boardBlock, boardSections, redrawDiagrams, renderDocument } from './document';
import { initLinks } from './links';
import { drawnRects, initMarks, layoutMarks, markBoxes, setMark } from './marks';
import { locateTarget } from './pointing';
import { checkUserMark, clearUserMark, currentUserMark, initUserMarks, markWebElement } from './userMarks';
import { isInView, reveal, scrollBoard, visibleBlocks } from './view';
import { onWebPageInput, webAction } from './web';
import {
    applyBlockZooms,
    collapseBlock,
    currentZoom,
    escapeExpanded,
    expandBlock,
    expandedBlock,
    initZoom,
    panBlock,
    restoreZoom,
    selectSection,
    setPageZoom,
    stepPageZoom,
    toggleExpand,
    zoomBlock,
    zoomSelectedByKey,
    zoomSelectedByWheel,
} from './zoom';

function post(message: BoardClientMessage): void {
    vscode.postMessage(message);
}

const app = document.getElementById('board-app')!;
// The overlay is outside the document column, which zooms: marks are drawn in window px at any zoom.
app.innerHTML =
    `<header class="board-header"><h1 class="board-title"></h1>` +
    `<div class="board-zoom" role="group" aria-label="Zoom the board">` +
    `<button type="button" class="board-zoom-out" title="Zoom the page out">−</button>` +
    `<button type="button" class="board-zoom-reset" title="Reset the page zoom to 100%"></button>` +
    `<button type="button" class="board-zoom-in" title="Zoom the page in">+</button></div>` +
    `<button type="button" class="board-edit" title="Open this board's Markdown source beside it">Edit source</button>` +
    `<button type="button" class="board-maximize" aria-pressed="false"></button></header>` +
    `<main class="board-doc"><div class="board-blocks"></div><p class="board-empty">This board is empty.</p></main>` +
    `<div class="board-overlay"></div>`;
const title = app.querySelector<HTMLElement>('.board-title')!;
const blocksEl = app.querySelector<HTMLElement>('.board-blocks')!;
const empty = app.querySelector<HTMLElement>('.board-empty')!;
const maximizeButton = app.querySelector<HTMLButtonElement>('.board-maximize')!;
initZoom(app.querySelector<HTMLElement>('.board-doc')!, app.querySelector<HTMLElement>('.board-zoom-reset')!, (zoom) => post({ type: 'zoomed', zoom }));

/** Codicon-style screen-full (Maximize) and screen-normal (Restore), drawn in the button's color. */
const MAXIMIZE_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>';
const RESTORE_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/></svg>';

/** As the host last said: the board's editor group is maximized, so the button restores it. */
let maximized = false;

function showMaximized(value: boolean): void {
    maximized = value;
    maximizeButton.innerHTML = value ? RESTORE_ICON : MAXIMIZE_ICON;
    const label = value ? 'Restore: show the other editor groups again' : "Maximize: let this board's editor group fill the editor area";
    maximizeButton.title = label;
    maximizeButton.setAttribute('aria-label', label);
    maximizeButton.setAttribute('aria-pressed', String(value));
}
showMaximized(false);

/** Pi's point as asked and what it found; its mark in marks.ts re-locates it at every layout. */
let point: { target: BoardTarget; style: BoardMarkStyle; found: BoardFound } | undefined;

function clearPoint(): void {
    point = undefined;
    setMark('pi', undefined);
}

initMarks(app.querySelector<HTMLElement>('.board-overlay')!, (owner) => {
    if (owner === 'pi') {
        point = undefined;
    } else {
        clearUserMark(true);
    }
});
initUserMarks((mark) => post({ type: 'userMark', mark }));
initLinks(app, (href) => post({ type: 'openLink', href }));

async function handle(message: BoardHostMessage): Promise<void> {
    switch (message.type) {
        case 'render': {
            title.textContent = message.title;
            document.title = message.title;
            if (message.edited) {
                clearPoint();
            }
            const { changed, errors } = await renderDocument(blocksEl, message.markdown);
            empty.hidden = blocksEl.childElementCount > 0;
            applyBlockZooms();
            watchSizes();
            checkUserMark();
            layoutMarks();
            const first = changed[0]?.getBoundingClientRect();
            if (first && !isInView(first)) {
                reveal(first, 'start');
            }
            post({ type: 'rendered', version: message.version, errors });
            return;
        }
        case 'point': {
            clearPoint();
            const place = locateTarget(message.target);
            if ('error' in place) {
                post({ type: 'pointed', seq: message.seq, error: place.error });
                return;
            }
            // Into the diagram or web page filling the board: it stays, at its zoom (a diagram pans to
            // the target). Elsewhere: the whole board comes back first, then scrolls to it as always.
            const inside = expandedBlock() === message.target.block;
            if (!inside) {
                collapseBlock();
            }
            point = { target: message.target, style: message.style, found: place.found };
            const target = message.target;
            const shown = setMark('pi', {
                style: message.style,
                locate: () => {
                    const now = locateTarget(target);
                    return 'error' in now ? undefined : { ...now, block: boardBlock(target.block)?.el };
                },
            });
            if (shown) {
                reveal(shown.rect, 'center', shown.scroller, !inside);
                // Drawn again where the scroller left it: clipped marks show once scrolled into its view.
                layoutMarks();
            }
            post({ type: 'pointed', seq: message.seq, found: place.found });
            return;
        }
        case 'clearPoint':
            clearPoint();
            return;
        case 'scroll': {
            // Scrolling is the whole board's.
            collapseBlock();
            const error = scrollBoard(message.to);
            post({ type: 'scrolled', seq: message.seq, ...(error ? { error } : {}) });
            return;
        }
        case 'clickAt': {
            const place = locateTarget(message.target);
            if ('error' in place) {
                post({ type: 'clicked', seq: message.seq, error: place.error });
                return;
            }
            // As a user would, scrolled into sight first, then pressed in the middle of its first box
            // (a node, an arrow's label, a passage's first line).
            const header = document.querySelector('.board-header')?.getBoundingClientRect().bottom ?? 0;
            let first = place.rects[0];
            if (first.top < header || first.bottom > window.innerHeight) {
                window.scrollBy({ top: first.top + first.height / 2 - (header + window.innerHeight) / 2, behavior: 'instant' });
                const again = locateTarget(message.target);
                first = 'error' in again ? first : again.rects[0];
            }
            const x = first.left + first.width / 2;
            const y = first.top + first.height / 2;
            const under = document.elementFromPoint(x, y);
            if (!under) {
                post({ type: 'clicked', seq: message.seq, error: `Nothing under ${Math.round(x)}, ${Math.round(y)}.` });
                return;
            }
            const init = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: x, clientY: y, view: window };
            const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
            under.dispatchEvent(new Pointer('pointerdown', { ...init, buttons: 1 }));
            under.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
            const end = { ...init, clientX: x + (message.drag?.dx ?? 0), clientY: y + (message.drag?.dy ?? 0) };
            if (message.drag) {
                // In steps, as a hand moves.
                for (let i = 1; i <= 4; i++) {
                    const at = { ...init, buttons: 1, clientX: x + (message.drag.dx * i) / 4, clientY: y + (message.drag.dy * i) / 4 };
                    under.dispatchEvent(new Pointer('pointermove', at));
                    under.dispatchEvent(new MouseEvent('mousemove', at));
                }
            }
            under.dispatchEvent(new Pointer('pointerup', end));
            under.dispatchEvent(new MouseEvent('mouseup', end));
            under.dispatchEvent(new MouseEvent('click', end));
            // The user's mark is made a tick after mouseup (userMarks.ts).
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            post({ type: 'clicked', seq: message.seq });
            return;
        }
        case 'expand': {
            let error: string | undefined;
            if (message.block === null) {
                collapseBlock();
            } else {
                error = expandBlock(message.block);
            }
            post({ type: 'expanded', seq: message.seq, ...(error ? { error } : {}) });
            return;
        }
        case 'status':
            post({
                type: 'status',
                seq: message.seq,
                visible: visibleBlocks(),
                width: window.innerWidth,
                maximized,
                zoom: currentZoom(),
                expanded: expandedBlock() ?? null,
                scrollY: window.scrollY,
                diagrams: shownDiagrams(),
                webPages: shownWebPages(),
                point: point ? { ...point, rects: drawnRects('pi') ?? 0 } : null,
                userMark: currentUserMark(),
                marks: { pi: markBoxes('pi') ?? null, user: markBoxes('user') ?? null },
            });
            return;
        case 'maximized':
            showMaximized(message.maximized);
            return;
        case 'zoom':
            restoreZoom(message.zoom);
            watchSizes();
            return;
    }
}

function boxOf(el: Element): BoardBox {
    const { left, top, right, bottom } = el.getBoundingClientRect();
    return { left, top, right, bottom };
}

/** Every drawn diagram's view and drawing, for `status`. */
function shownDiagrams(): BoardShownDiagram[] {
    return boardSections().flatMap(({ id, el }) => {
        const view = el.querySelector('.board-diagram-view');
        const drawing = view?.querySelector('svg');
        return view && drawing ? [{ block: id, view: boxOf(view), drawing: boxOf(drawing) }] : [];
    });
}

/** Every web page's view and frame, for `status`. */
function shownWebPages(): BoardShownWebPage[] {
    return boardSections().flatMap(({ id, el }) => {
        const view = el.querySelector('.board-web-view');
        const frame = view?.querySelector('iframe');
        return view && frame ? [{ block: id, view: boxOf(view), frame: boxOf(frame) }] : [];
    });
}

// What a web page forwards from inside its frame, whose keys and presses never reach this page: a
// press selects it, Escape leaves the expanded block (else clears the user's mark, as Escape here
// does), Ctrl/Cmd + keys and wheel zoom the selected one, a middle-button or Space + drag pans it, an
// Alt + click marks the element it picked.
onWebPageInput((section, input) => {
    if (input.type === 'press') {
        selectSection(section);
    } else if (input.type === 'escape') {
        if (!escapeExpanded()) {
            clearUserMark(true);
        }
    } else if (input.type === 'zoomKey') {
        zoomSelectedByKey(input.direction);
    } else if (input.type === 'pan') {
        panBlock(section, input.dx, input.dy);
    } else if (input.type === 'pick') {
        markWebElement(section, input.element, input.rect);
    } else {
        zoomSelectedByWheel(input.deltaPx);
    }
});

let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
    queue = queue.then(task).catch((err: unknown) => console.error('[board]', err));
}

// The host's messages. A web page's frame (web.ts, sandboxed: origin "null") may post here too; it
// talks through its own port, so nothing it posts on the window is taken as the host's.
window.addEventListener('message', (event: MessageEvent<BoardHostMessage>) => event.origin !== 'null' && enqueue(() => handle(event.data)));

app.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    // A diagram's or web page's own − / percent / + / ⤢ (document.ts builds them).
    const tool = button?.closest('.board-block-tools') ? button : null;
    const blockZoom = tool?.dataset.zoom;
    const block = tool ? blockAt(tool) : undefined;
    if (block && blockZoom === 'expand') {
        toggleExpand(block.id);
    } else if (block && (blockZoom === 'in' || blockZoom === 'out' || blockZoom === 'fit')) {
        zoomBlock(block.id, blockZoom);
    } else if (button?.classList.contains('board-zoom-in')) {
        stepPageZoom(1);
    } else if (button?.classList.contains('board-zoom-out')) {
        stepPageZoom(-1);
    } else if (button?.classList.contains('board-zoom-reset')) {
        setPageZoom(1);
    } else if (button?.classList.contains('board-maximize')) {
        post({ type: 'toggleMaximize' });
    } else if (button?.classList.contains('board-edit')) {
        post({ type: 'editSource' });
    } else if (button?.dataset.web) {
        webAction(button);
    } else if (button?.classList.contains('board-copy')) {
        const code = button.closest('.board-code')?.querySelector('.board-code-text');
        void navigator.clipboard.writeText(code?.textContent ?? '').then(() => {
            button.textContent = 'Copied!';
            setTimeout(() => (button.textContent = 'Copy'), 1500);
        });
    }
});

// Marks follow the content: when a block or a diagram's view or drawing changes size (a zoom, a render,
// a resize), and when a code block or diagram scrolls inside (the window's own scroll moves the overlay
// with the document).
let layoutQueued = false;
function queueLayout(): void {
    if (!layoutQueued) {
        layoutQueued = true;
        requestAnimationFrame(() => {
            layoutQueued = false;
            layoutMarks();
        });
    }
}
const sizes = new ResizeObserver(queueLayout);
/** Watches the blocks, every diagram's view and drawing, and every web page's view (new ones after each render or redraw). */
function watchSizes(): void {
    sizes.disconnect();
    sizes.observe(blocksEl);
    for (const el of blocksEl.querySelectorAll('.board-diagram-view, .board-diagram-view > svg, .board-web-view')) {
        sizes.observe(el);
    }
}
watchSizes();
window.addEventListener('resize', queueLayout);
document.addEventListener('scroll', (event) => event.target !== document && queueLayout(), true);
watchDiagramTheme(() =>
    enqueue(async () => {
        await redrawDiagrams();
        applyBlockZooms();
        watchSizes();
        layoutMarks();
    }),
);

post({ type: 'ready' });
