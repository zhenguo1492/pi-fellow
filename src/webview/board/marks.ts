/**
 * The marks drawn over the board: Pi's point (the voice agent's color, tag "Pi") and the user's mark
 * (the user's color, tag "You"), at most one each. They live in an overlay above the document (outside
 * the zoomed column) and are drawn from the marked content's client rects, found again on every
 * layout: zoom, pan, inner scroll, resize, render.
 */
import type { BoardBox, BoardMarkStyle } from '../../shared/board';

export type MarkOwner = 'pi' | 'user';

export interface MarkPlace {
    rects: DOMRect[];
    /** A scrolling box (code block, diagram view, table) the mark is clipped to. */
    clip?: Element;
    /** The block's section: while one diagram fills the board, marks elsewhere are not drawn. */
    block?: Element;
}

export interface MarkSpec {
    style: BoardMarkStyle;
    /** Where the marked content is now; undefined when it is gone. */
    locate(): MarkPlace | undefined;
}

interface Mark {
    spec: MarkSpec;
    el: HTMLElement;
    /** Viewport rects drawn last: what a click on the mark hits. */
    drawn: DOMRect[];
}

const TAG: Record<MarkOwner, string> = { pi: 'Pi', user: 'You' };
/** Padding around a highlighted line box and a boxed union, px. */
const HIGHLIGHT_PAD = 2;
const BOX_PAD = 5;

let overlay: HTMLElement;
let onGone: (owner: MarkOwner) => void;
const marks: Partial<Record<MarkOwner, Mark>> = {};
/** The section filling the board (an expanded diagram): content elsewhere is under it, so its marks are not drawn. */
let within: Element | undefined;

/** `layer`: an absolutely positioned, pointer-events: none element at the document's top left. */
export function initMarks(layer: HTMLElement, gone: (owner: MarkOwner) => void): void {
    overlay = layer;
    onGone = gone;
}

/** A section fills the board (undefined: none does); marks are drawn again. */
export function drawMarksWithin(section: Element | undefined): void {
    within = section;
    layoutMarks();
}

function boxOf(rects: DOMRect[]): BoardBox | null {
    if (!rects.length) {
        return null;
    }
    const all = union(rects);
    return { left: all.left, top: all.top, right: all.right, bottom: all.bottom };
}

/**
 * Where `owner`'s mark is on screen, measured from the pieces the overlay really holds (the tag left
 * out; null: nothing drawn), and the visible part of the content it marks (clipped to its block's
 * scrolling box, as the mark is; null: none). Measured, not the rects it meant to draw: a wrong origin
 * shows as a gap between the two.
 */
export function markBoxes(owner: MarkOwner): { box: BoardBox | null; targetBox: BoardBox | null } | undefined {
    const mark = marks[owner];
    if (!mark) {
        return undefined;
    }
    const pieces = [...mark.el.querySelectorAll('.board-mark-fill, .board-mark-underline, .board-mark-box')].map((el) => el.getBoundingClientRect());
    const place = mark.spec.locate();
    const clip = place?.clip?.getBoundingClientRect();
    const target = lineBoxes(place?.rects ?? []).flatMap((r) => (clip ? (intersect(r, clip) ?? []) : [r]));
    return { box: boxOf(pieces), targetBox: boxOf(target) };
}

function intersect(a: DOMRect, b: DOMRect): DOMRect | undefined {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : undefined;
}

function union(rects: DOMRect[]): DOMRect {
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    return new DOMRect(left, top, Math.max(...rects.map((r) => r.right)) - left, Math.max(...rects.map((r) => r.bottom)) - top);
}

/** One box per line: a range's rects (one per element and text run) merged where they share a line. */
function lineBoxes(rects: DOMRect[]): DOMRect[] {
    const lines: DOMRect[] = [];
    for (const rect of [...rects].filter((r) => r.width > 0 && r.height > 0).sort((a, b) => a.top - b.top || a.left - b.left)) {
        const at = lines.findIndex((line) => Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top) > Math.min(line.height, rect.height) / 2);
        if (at >= 0) {
            lines[at] = union([lines[at], rect]);
        } else {
            lines.push(rect);
        }
    }
    return lines;
}

function piece(className: string, rect: DOMRect, origin: DOMRect): HTMLElement {
    const el = document.createElement('div');
    el.className = className;
    el.style.left = `${rect.left - origin.left}px`;
    el.style.top = `${rect.top - origin.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    return el;
}

function draw(owner: MarkOwner, mark: Mark, place: MarkPlace): void {
    const clip = place.clip?.getBoundingClientRect();
    const hidden = within !== undefined && place.block !== undefined && !within.contains(place.block);
    const lines = hidden ? [] : lineBoxes(place.rects).flatMap((r) => (clip ? (intersect(r, clip) ?? []) : [r]));
    mark.el.replaceChildren();
    mark.drawn = [];
    if (!lines.length) {
        return;
    }
    const origin = overlay.getBoundingClientRect();
    const style = mark.spec.style;
    const all = union(lines);
    if (style === 'box') {
        const box = new DOMRect(all.left - BOX_PAD, all.top - BOX_PAD, all.width + 2 * BOX_PAD, all.height + 2 * BOX_PAD);
        mark.el.append(piece('board-mark-box', box, origin));
        mark.drawn = [box];
    } else if (style === 'highlight') {
        mark.drawn = lines.map((r) => new DOMRect(r.left - HIGHLIGHT_PAD, r.top - HIGHLIGHT_PAD / 2, r.width + 2 * HIGHLIGHT_PAD, r.height + HIGHLIGHT_PAD));
        mark.el.append(...mark.drawn.map((r) => piece('board-mark-fill', r, origin)));
    } else {
        mark.el.append(...lines.map((r) => piece('board-mark-underline', new DOMRect(r.left, r.bottom, r.width, 2), origin)));
        mark.drawn = lines;
    }
    const tag = document.createElement('span');
    tag.className = 'board-mark-tag';
    tag.textContent = TAG[owner];
    // Pi's tag at the right end, the user's at the left (the stylesheet lifts both above the mark), so
    // both show when they mark the same thing.
    const extent = union(mark.drawn);
    tag.style.top = `${extent.top - origin.top}px`;
    tag.style.left = `${(owner === 'pi' ? extent.right : extent.left) - origin.left}px`;
    mark.el.append(tag);
}

/**
 * Replaces `owner`'s mark (undefined: removes it). Returns what it covers in viewport coordinates,
 * with the scroller it is clipped to, for bringing it into view; undefined when nothing was drawn.
 */
export function setMark(owner: MarkOwner, spec: MarkSpec | undefined): { rect: DOMRect; scroller?: Element } | undefined {
    marks[owner]?.el.remove();
    delete marks[owner];
    const place = spec?.locate();
    if (!spec || !place) {
        return undefined;
    }
    const el = document.createElement('div');
    el.className = `board-mark board-mark--${owner}`;
    overlay.append(el);
    const mark: Mark = { spec, el, drawn: [] };
    marks[owner] = mark;
    draw(owner, mark, place);
    const rects = lineBoxes(place.rects);
    return rects.length ? { rect: union(rects), scroller: place.clip } : undefined;
}

/** How many rectangles of `owner`'s mark are drawn now (0: none, or all clipped away); undefined without a mark. */
export function drawnRects(owner: MarkOwner): number | undefined {
    return marks[owner]?.drawn.length;
}

/** Whether a point (viewport coordinates) is on `owner`'s mark: its pieces measured now, which a scroll since the last layout moved. */
export function isOnMark(owner: MarkOwner, x: number, y: number): boolean {
    const pieces = marks[owner]?.el.querySelectorAll('.board-mark-fill, .board-mark-underline, .board-mark-box') ?? [];
    return [...pieces].some((el) => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
}

/** Redraws both marks where their content is now; a mark whose content is gone is removed and reported. */
export function layoutMarks(): void {
    for (const owner of Object.keys(TAG) as MarkOwner[]) {
        const mark = marks[owner];
        if (!mark) {
            continue;
        }
        const place = mark.spec.locate();
        if (place) {
            draw(owner, mark, place);
        } else {
            mark.el.remove();
            delete marks[owner];
            onGone(owner);
        }
    }
}
