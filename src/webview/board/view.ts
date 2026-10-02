/**
 * The board's viewport: the window scrolls, under a sticky header. Bringing things into view, the
 * host's scroll commands, and which blocks are in view.
 */
import type { BoardScrollTo } from '../../shared/board';
import { boardBlock, boardSections } from './document';
import { screenScale } from './locate';

/** Share of the visible height one "up"/"down" scrolls. */
const PAGE_SHARE = 0.8;

/** The top of the visible document area, below the sticky header. */
function viewTop(): number {
    return document.querySelector('.board-header')?.getBoundingClientRect().bottom ?? 0;
}

/** Whether any of `rect` (viewport coordinates) is in view. */
export function isInView(rect: DOMRect): boolean {
    return rect.bottom > viewTop() && rect.top < window.innerHeight && rect.height > 0;
}

/** How far `scroller` can scroll by `want` (window px) along one axis, in its own px, within its range. */
function innerScroll(want: number, position: number, extent: number, client: number, scale: number): number {
    return Math.min(Math.max(position + want / scale, 0), Math.max(extent - client, 0)) - position;
}

/**
 * Scrolls so `rect` (viewport coordinates) is in view when it is not fully: centered, or at the top
 * (`start`); taller than the view, its top at the top. A `scroller` (code block, wide table, a diagram
 * zoomed in) first scrolls so the rect is centered in it where it is outside it, sideways and up/down.
 * `page` false: only the scroller moves (an expanded diagram fills a board that does not scroll).
 */
export function reveal(rect: DOMRect, where: 'center' | 'start', scroller?: Element, page = true): void {
    let target = rect;
    if (scroller) {
        const box = scroller.getBoundingClientRect();
        // Scroll offsets are in the scroller's own px, smaller than window px by the page's zoom.
        const scale = scroller instanceof HTMLElement ? screenScale(scroller) : 1;
        const outX = scroller.scrollWidth > scroller.clientWidth && (rect.left < box.left || rect.right > box.right);
        const outY = scroller.scrollHeight > scroller.clientHeight && (rect.top < box.top || rect.bottom > box.bottom);
        const left = outX ? innerScroll(rect.left - box.left - Math.max(0, (box.width - rect.width) / 2), scroller.scrollLeft, scroller.scrollWidth, scroller.clientWidth, scale) : 0;
        const top = outY ? innerScroll(rect.top - box.top - Math.max(0, (box.height - rect.height) / 2), scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight, scale) : 0;
        if (left || top) {
            // At once, not smoothly: the mark is laid out against the new scroll right after (a smooth
            // scroll would leave it clipped until animation frames run, which they may not in a hidden page).
            scroller.scrollBy({ left, top, behavior: 'instant' });
            // Where the rect is now, for the window's scroll below.
            target = new DOMRect(rect.left - left * scale, rect.top - top * scale, rect.width, rect.height);
        }
    }
    const top = viewTop();
    const height = window.innerHeight - top;
    if (!page || (target.top >= top && target.bottom <= window.innerHeight)) {
        return;
    }
    const gap = where === 'center' && target.height < height ? (height - target.height) / 2 : 8;
    window.scrollTo({ top: window.scrollY + target.top - top - gap, behavior: 'smooth' });
}

/** Carries out the host's `scroll`; returns an error for an unknown block. */
export function scrollBoard(to: BoardScrollTo): string | undefined {
    const page = (window.innerHeight - viewTop()) * PAGE_SHARE;
    if (to === 'up' || to === 'down') {
        window.scrollBy({ top: to === 'up' ? -page : page, behavior: 'smooth' });
    } else if (to === 'top') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (to === 'bottom') {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    } else {
        const block = boardBlock(to.block);
        if (!block) {
            return `No block ${to.block} on this board.`;
        }
        const rect = block.el.getBoundingClientRect();
        window.scrollTo({ top: window.scrollY + rect.top - viewTop() - 8, behavior: 'smooth' });
    }
    return undefined;
}

/** Ids of the blocks at least partly in view, top first. */
export function visibleBlocks(): string[] {
    return boardSections()
        .filter(({ el }) => isInView(el.getBoundingClientRect()))
        .map(({ id }) => id);
}
