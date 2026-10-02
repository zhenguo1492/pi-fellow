/**
 * Zooming the board by hand (docs/blackboard.md#zoom): the whole page (the header's − / % / + only),
 * and one diagram or web page at a time (its own − / percent / +, or Ctrl/Cmd + wheel and Ctrl/Cmd +
 * "+" "−" "0" once a click selected it); and one of them filling the whole board (its ⤢ button,
 * Escape to go back). Both are zoomed like pictures: a zoomed-in diagram grows up to the board's
 * width and the window's height and pans by dragging beyond that; a web page's frame keeps its
 * natural layout and is only scaled (web.ts, web.css), its view panned by scrolling, a middle-button
 * drag or Space + drag forwarded from the page (panBlock). Zoom is geometric: a press or key multiplies
 * or divides by ZOOM_STEP (on its powers, so 100% comes back exactly), Ctrl/Cmd + wheel and a trackpad
 * pinch zoom continuously in proportion to their travel (src/shared/board.ts). The page
 * zoom is a scale on the document column (fitBoard); the mark overlay sits outside it, so marks drawn
 * from client rects stay on their content at any zoom. The host keeps the zoom for the board
 * (`zoomed`) and gives it back to a new page (`zoom`).
 */
import { BLOCK_ZOOM_RANGE, PAGE_ZOOM_RANGE, clampZoom, wheelPx, zoomByWheel, zoomStep, type BoardBlockKind, type BoardZoom } from '../../shared/board';
import { blockAt, boardBlock, boardSections } from './document';
import { screenScale } from './locate';
import { drawMarksWithin, layoutMarks } from './marks';

/** Space kept free around a diagram grown past the text column, and around an expanded block, window px. */
const BOARD_MARGIN_PX = 16;

/** Zooming pauses this long before the host is told: a wheel spin is one change. */
const REPORT_DELAY_MS = 300;
/** A press on a zoomed diagram that moves this far (px) is a pan, not a click. */
const DRAG_PX = 4;

/** What each zoomable kind is called in the tools' titles and the page's answers. */
const ZOOMABLE: Partial<Record<BoardBlockKind, string>> = { diagram: 'diagram', web: 'web page' };

let doc: HTMLElement;
let label: HTMLElement;
let report: (zoom: BoardZoom) => void;
let page = 1;
let blocks: Record<string, number> = {};
let reportTimer = 0;
/** The press in progress on a zoomed diagram; `panned` once it moved past DRAG_PX. */
let press: { view: HTMLElement; x: number; y: number; left: number; top: number; panned: boolean } | undefined;
/** The last press panned: its mouseup and click are not a mark (userMarks.ts asks). */
let panned = false;
/** The diagram or web page filling the board, and the window's scroll to go back to. */
let expanded: { id: string; section: HTMLElement; scrollY: number } | undefined;
/** The section the user pressed on last (a diagram or a web page): Ctrl/Cmd + wheel and keys zoom it. */
let selected: HTMLElement | undefined;

function changed(): void {
    window.clearTimeout(reportTimer);
    reportTimer = window.setTimeout(() => report(currentZoom()), REPORT_DELAY_MS);
}

export function currentZoom(): BoardZoom {
    return { page, blocks: { ...blocks } };
}

/** Whether the last press on the board dragged a diagram around rather than clicking it. */
export function panDragged(): boolean {
    return panned;
}

/** Zooms the page to `zoom`, keeping the content at the middle of the window where it is. */
export function setPageZoom(zoom: number, tell = true): void {
    const next = clampZoom(PAGE_ZOOM_RANGE, zoom);
    const anchorY = window.innerHeight / 2;
    const before = doc.getBoundingClientRect();
    const share = before.height > 0 ? (anchorY - before.top) / before.height : 0;
    page = next;
    label.textContent = `${Math.round(next * 100)}%`;
    fitBoard();
    const after = doc.getBoundingClientRect();
    // An expanded block fixes the window's scroll; it goes back to where it was on collapse.
    if (before.height > 0 && !expanded) {
        window.scrollBy(0, after.top + share * after.height - anchorY);
    }
    layoutMarks();
    if (tell) {
        changed();
    }
}

/**
 * Lays the page out at its zoom, and says what diagrams and web pages may grow to.
 *
 * The zoom is a `transform: scale()` on the document column (`--board-zoom`), from its top left, on a
 * column laid out 1/zoom as wide (layout.css), so that scaled it fills the window as before. Not CSS
 * `zoom`: see docs/blackboard.md#zoom. While a block is expanded the column is not scaled: a
 * transform would make the column the containing block of the expanded (fixed) block.
 *
 * In the column's own px: the board's width and the window's height below the header, less a margin
 * (`--board-width`, `--board-height`), and where an expanded block starts (`--board-top`). Then
 * which diagram views have more drawing than they show.
 */
function fitBoard(): void {
    const scale = expanded ? 1 : page;
    const header = document.querySelector('.board-header')?.getBoundingClientRect().bottom ?? 0;
    const width = Math.max(document.documentElement.clientWidth - 2 * BOARD_MARGIN_PX, 0);
    const height = Math.max(window.innerHeight - header - 2 * BOARD_MARGIN_PX, 0);
    doc.style.transform = scale === 1 ? '' : `scale(${scale})`;
    doc.style.setProperty('--board-zoom', String(scale));
    doc.style.setProperty('--board-width', `${width / scale}px`);
    doc.style.setProperty('--board-height', `${height / scale}px`);
    doc.style.setProperty('--board-top', `${header / scale}px`);
    doc.style.setProperty('--board-margin', `${BOARD_MARGIN_PX / scale}px`);
    fitHeight();
    for (const view of document.querySelectorAll<HTMLElement>('.board-diagram-view')) {
        view.classList.toggle('can-pan', view.scrollWidth > view.clientWidth + 1 || view.scrollHeight > view.clientHeight + 1);
    }
}

/** A transform leaves the layout as it was: zoomed out, the column's layout reaches below its drawing, and a negative margin gives that back, so the page does not scroll into blank space. */
function fitHeight(): void {
    const scale = expanded ? 1 : page;
    doc.style.marginBottom = scale < 1 ? `${doc.offsetHeight * (scale - 1)}px` : '';
}

export function stepPageZoom(direction: 1 | -1): void {
    setPageZoom(zoomStep(PAGE_ZOOM_RANGE, page, direction));
}

/** A drawn diagram or a web page: what has its own zoom and can fill the board. */
function zoomable(section: HTMLElement, kind: BoardBlockKind): boolean {
    return kind === 'web' || (kind === 'diagram' && !!section.querySelector('.board-diagram-view'));
}

/** Selects section `section` (none: `undefined`), shown as selected; anything not a drawn diagram or a web page ends the selection. */
export function selectSection(section: HTMLElement | undefined): void {
    const block = section ? blockAt(section) : undefined;
    const next = block && block.el === section && zoomable(block.el, block.kind) ? section : undefined;
    if (next === selected) {
        return;
    }
    selected?.classList.remove('is-selected');
    selected = next;
    selected?.classList.add('is-selected');
}

/** The selected block's id while it is on the board and zoomable; a render that rebuilt or removed it ends the selection. */
export function selectedBlock(): string | undefined {
    const id = selected?.dataset.block;
    const block = id === undefined ? undefined : boardBlock(id);
    if (!selected || block?.el !== selected || !zoomable(block.el, block.kind)) {
        selectSection(undefined);
        return undefined;
    }
    return id;
}

/**
 * Shows block `id` at its zoom: the view's `--dz`, the tools' percent, and whether it pans (zoomed in:
 * its view scrolls); a diagram's view also says whether it has more drawing than it shows. A web
 * page's frame is scaled to its stage by web.ts.
 */
function showZoom(id: string): void {
    const el = boardBlock(id)?.el;
    const zoom = blocks[id] ?? 1;
    const view = el?.querySelector<HTMLElement>('.board-diagram-view, .board-web-view');
    if (view) {
        view.style.setProperty('--dz', String(zoom));
        view.classList.toggle('is-zoomed', zoom > 1);
        if (view.classList.contains('board-diagram-view')) {
            view.classList.toggle('can-pan', view.scrollWidth > view.clientWidth + 1 || view.scrollHeight > view.clientHeight + 1);
        }
    }
    const fit = el?.querySelector<HTMLElement>('.board-block-tools [data-zoom="fit"]');
    if (fit) {
        fit.textContent = `${Math.round(zoom * 100)}%`;
    }
}

/** The tools' − / percent / +: zooms block `id` a step in or out, or back to 100%. */
export function zoomBlock(id: string, action: 'in' | 'out' | 'fit'): void {
    setBlockZoom(id, action === 'fit' ? 1 : zoomStep(BLOCK_ZOOM_RANGE, blocks[id] ?? 1, action === 'in' ? 1 : -1));
}

/** Shows block `id` at zoom `to`, around the middle of its view, and tells the host once zooming pauses. */
function setBlockZoom(id: string, to: number): void {
    if (to === (blocks[id] ?? 1)) {
        return;
    }
    const view = boardBlock(id)?.el.querySelector<HTMLElement>('.board-diagram-view, .board-web-view');
    // The point in the middle of the view stays there: its share of the drawing (the view's scroll extent) is kept.
    const middle = view && view.scrollWidth > 0 && view.scrollHeight > 0
        ? { x: (view.scrollLeft + view.clientWidth / 2) / view.scrollWidth, y: (view.scrollTop + view.clientHeight / 2) / view.scrollHeight }
        : undefined;
    if (to === 1) {
        delete blocks[id];
    } else {
        blocks[id] = to;
    }
    showZoom(id);
    if (view && middle) {
        view.scrollLeft = middle.x * view.scrollWidth - view.clientWidth / 2;
        view.scrollTop = middle.y * view.scrollHeight - view.clientHeight / 2;
    }
    layoutMarks();
    changed();
}

/**
 * A pan drag forwarded by web page `section`'s frame: the pointer is `dx`, `dy` of the page's own px
 * from the point it grabbed, so its view scrolls the page that far after it.
 */
export function panBlock(section: HTMLElement, dx: number, dy: number): void {
    const view = section.querySelector<HTMLElement>('.board-web-view');
    const frame = view?.querySelector<HTMLElement>('iframe');
    if (!view || !frame?.offsetWidth) {
        return;
    }
    // Page px to the view's own px: the frame's on-screen scale over the view's.
    const scale = frame.getBoundingClientRect().width / frame.offsetWidth / screenScale(view);
    view.scrollLeft -= dx * scale;
    view.scrollTop -= dy * scale;
}

/** Ctrl/Cmd + "+" (1), "−" (-1) or "0" (0), on the board or forwarded by a web page: zooms the selected block, if any. */
export function zoomSelectedByKey(direction: 1 | -1 | 0): void {
    const id = selectedBlock();
    if (id !== undefined) {
        zoomBlock(id, direction === 0 ? 'fit' : direction > 0 ? 'in' : 'out');
    }
}

/** Ctrl/Cmd + wheel travel in px (negative: in), on the board or forwarded by a web page: zooms the selected block in proportion, a step per mouse notch. */
export function zoomSelectedByWheel(deltaPx: number): void {
    const id = selectedBlock();
    if (id !== undefined) {
        setBlockZoom(id, zoomByWheel(BLOCK_ZOOM_RANGE, blocks[id] ?? 1, deltaPx));
    }
}

/**
 * After a render or a redraw: every diagram and web page shows its zoom (a redrawn diagram is new
 * SVG); the zoom of a block no longer on the board is dropped, and the host told (`tell`).
 */
export function applyBlockZooms(tell = true): void {
    const present = new Set(boardSections().map(({ id }) => id));
    const gone = Object.keys(blocks).filter((id) => !present.has(id) || !ZOOMABLE[boardBlock(id)!.kind]);
    for (const id of gone) {
        delete blocks[id];
    }
    for (const id of present) {
        if (ZOOMABLE[boardBlock(id)!.kind]) {
            showZoom(id);
        }
    }
    // A render that rebuilt or removed the expanded block ends its expansion, and its selection.
    if (expanded && boardBlock(expanded.id)?.el !== expanded.section) {
        collapseBlock();
    }
    selectedBlock();
    if (gone.length && tell) {
        changed();
    }
}

/** The diagram or web page filling the board, if any. */
export function expandedBlock(): string | undefined {
    return expanded?.id;
}

/**
 * Shows diagram or web page `id` alone, filling the board below the header, at its own zoom; returns
 * why not (not a drawn diagram or a web page). Marks elsewhere are hidden until it collapses.
 */
export function expandBlock(id: string): string | undefined {
    const block = boardBlock(id);
    if (!block || !zoomable(block.el, block.kind)) {
        return block?.kind === 'diagram' ? `Diagram ${id} did not draw, so it cannot fill the board.` : `No diagram or web page ${id} on this board.`;
    }
    if (expanded?.id === id) {
        return undefined;
    }
    const scrollY = expanded?.scrollY ?? window.scrollY;
    if (expanded) {
        showExpanded(expanded.section, false);
    }
    expanded = { id, section: block.el, scrollY };
    showExpanded(block.el, true);
    document.body.classList.add('board-expanded');
    fitBoard();
    drawMarksWithin(block.el);
    return undefined;
}

/** Back to the whole board, at the scroll it had before the block filled it. */
export function collapseBlock(): void {
    if (!expanded) {
        return;
    }
    const { section, scrollY } = expanded;
    expanded = undefined;
    showExpanded(section, false);
    document.body.classList.remove('board-expanded');
    fitBoard();
    window.scrollTo({ top: scrollY, behavior: 'instant' });
    drawMarksWithin(undefined);
}

/**
 * Escape, on the board or forwarded by a web page: leaves the expanded block, which goes back to 100%
 * in the board whatever it was zoomed to while expanded; false (nothing done) when none is expanded.
 */
export function escapeExpanded(): boolean {
    if (!expanded) {
        return false;
    }
    const { id } = expanded;
    collapseBlock();
    if (blocks[id] !== undefined) {
        zoomBlock(id, 'fit');
    }
    return true;
}

function showExpanded(section: HTMLElement, on: boolean): void {
    section.classList.toggle('is-expanded', on);
    const button = section.querySelector<HTMLElement>('.board-block-tools [data-zoom="expand"]');
    if (button) {
        const what = ZOOMABLE[blockAt(section)?.kind ?? 'diagram'] ?? 'diagram';
        button.setAttribute('aria-pressed', String(on));
        button.textContent = on ? '⤡' : '⤢';
        button.title = on ? 'Back to the whole board (Esc)' : `Show only this ${what}, filling the board (Esc to go back)`;
    }
}

/** The ⤢ button: fills the board with block `id`, or goes back when it already does. */
export function toggleExpand(id: string): void {
    if (expanded?.id === id) {
        collapseBlock();
    } else {
        expandBlock(id);
    }
}

/** The host's zoom for a new page: taken on without telling it back (a stale block id goes with the next report). */
export function restoreZoom(zoom: BoardZoom): void {
    blocks = { ...zoom.blocks };
    applyBlockZooms(false);
    setPageZoom(zoom.page, false);
}

function keyDirection(event: KeyboardEvent): 1 | -1 | 0 | undefined {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return undefined;
    }
    if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
        return 1;
    }
    if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') {
        return -1;
    }
    return event.key === '0' || event.code === 'Numpad0' ? 0 : undefined;
}

/** `column`: the zoomed document; `percent`: the header's percent button. `tell`: the zoom to keep, once zooming pauses. */
export function initZoom(column: HTMLElement, percent: HTMLElement, tell: (zoom: BoardZoom) => void): void {
    doc = column;
    label = percent;
    report = tell;
    label.textContent = '100%';
    fitBoard();
    window.addEventListener('resize', fitBoard);
    // The column's height changes with its content; zoomed out, what its layout takes below the drawing is given back.
    new ResizeObserver(fitHeight).observe(doc);

    // Escape leaves an expanded block, and only that: the user's mark (userMarks.ts, whose listener comes later) stays.
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && escapeExpanded()) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    });

    // A press on a drawn diagram or a web page (its tools included) selects it; a press anywhere else
    // ends the selection. A press inside a web page's frame does not reach this page: web.ts forwards it.
    document.addEventListener('pointerdown', (event) => {
        selectSection(event.target instanceof Node ? blockAt(event.target)?.el : undefined);
    });

    // Ctrl/Cmd + keys and wheel zoom the selected block, never the page. Stopped here, before the
    // window, selected or not: VS Code's webview frame passes keys and wheel on to the workbench, which
    // would zoom the whole window.
    document.addEventListener('keydown', (event) => {
        const direction = keyDirection(event);
        if (direction === undefined) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        zoomSelectedByKey(direction);
    });
    document.addEventListener(
        'wheel',
        (event) => {
            if (!(event.ctrlKey || event.metaKey)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            zoomSelectedByWheel(wheelPx(event.deltaY, event.deltaMode));
        },
        { passive: false },
    );

    // Panning a zoomed diagram: the press may start on a node; only a move past DRAG_PX makes it a pan.
    document.addEventListener('pointerdown', (event) => {
        panned = false;
        const target = event.target instanceof Element ? event.target : null;
        const view = target?.closest<HTMLElement>('.board-diagram-view.is-zoomed');
        if (event.button !== 0 || !view || target?.closest('button')) {
            return;
        }
        press = { view, x: event.clientX, y: event.clientY, left: view.scrollLeft, top: view.scrollTop, panned: false };
    });
    window.addEventListener('pointermove', (event) => {
        if (!press) {
            return;
        }
        const dx = event.clientX - press.x;
        const dy = event.clientY - press.y;
        if (!press.panned && Math.hypot(dx, dy) < DRAG_PX) {
            return;
        }
        if (!press.panned) {
            press.panned = true;
            panned = true;
            press.view.classList.add('is-panning');
        }
        // Scroll offsets are in the view's own px; the pointer moves in window px.
        const scale = screenScale(press.view);
        press.view.scrollLeft = press.left - dx / scale;
        press.view.scrollTop = press.top - dy / scale;
    });
    const release = () => {
        press?.view.classList.remove('is-panning');
        press = undefined;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
}
