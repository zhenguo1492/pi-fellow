/**
 * Where a board target is on the page: a whole block, code lines, a passage, a diagram node, or a
 * diagram arrow (a sequence message by label or step, a flowchart edge by label). Pi's point resolves
 * its target again at every layout, so it follows re-renders (a theme switch redraws the diagrams) and
 * goes when its block does.
 */
import type { BoardFound, BoardTarget } from '../../shared/board';
import { boardBlock } from './document';
import { arrowRects, codeLineCount, codeLinesRect, diagramArrows, findDiagramTarget, findTextRange } from './locate';
import type { MarkPlace } from './marks';

/**
 * The scrolling box inside a block that marks are clipped to: a code block, a table block, a drawn
 * diagram's view (which pans when zoomed in), or a failed diagram's box.
 */
export function blockScroller(el: HTMLElement, kind: string): Element | undefined {
    return kind === 'table' ? el : (el.querySelector('.board-code-pre, .board-diagram-view') ?? el.querySelector('.board-diagram') ?? undefined);
}

/** Where `target` is now and what it turned out to be, or why it cannot be found. The target's `board` is the host's business. */
export function locateTarget(target: BoardTarget): (MarkPlace & { found: BoardFound }) | { error: string } {
    const block = boardBlock(target.block);
    if (!block) {
        return { error: `No block ${target.block} on this board.` };
    }
    const { el, kind } = block;
    if (kind === 'web' && (target.startLine !== undefined || target.endLine !== undefined || target.text !== undefined)) {
        return { error: `Block ${target.block} is a web page, which runs in its own frame: point at the whole block.` };
    }
    const clip = blockScroller(el, kind);
    const svg = kind === 'diagram' ? el.querySelector('svg') : null;
    if (target.startLine !== undefined || target.endLine !== undefined) {
        const start = target.startLine ?? target.endLine!;
        const end = target.endLine ?? start;
        if (svg) {
            const messages = diagramArrows(svg).filter((a) => a.kind === 'message');
            if (!messages.length) {
                return { error: `Diagram ${target.block} has no sequence messages: steps point only into a sequence diagram. Name a node or an edge label instead.` };
            }
            if (start < 1 || end < start || end > messages.length) {
                return { error: `Diagram ${target.block} has messages 1-${messages.length}; ${start === end ? `step ${start} is` : `steps ${start}-${end} are`} not in it.` };
            }
            return { rects: messages.slice(start - 1, end).flatMap(arrowRects), clip, found: 'message' };
        }
        const code = el.querySelector('.board-code-text');
        if (kind !== 'code' || !code || !clip) {
            return { error: `Block ${target.block} is a ${kind}: lines point only into a code block, steps only into a sequence diagram.` };
        }
        const count = codeLineCount(code);
        if (start < 1 || end < start || end > count) {
            return { error: `Block ${target.block} has lines 1-${count}; lines ${start}-${end} are not in it.` };
        }
        return { rects: [codeLinesRect(code, clip, start, end)], clip, found: 'lines' };
    }
    if (target.text !== undefined) {
        if (svg) {
            const hit = findDiagramTarget(svg, target.text);
            if (!hit) {
                return { error: `No node or arrow label "${target.text}" in diagram ${target.block}.` };
            }
            return 'node' in hit ? { rects: [hit.node.getBoundingClientRect()], clip, found: 'node' } : { rects: arrowRects(hit.arrow), clip, found: hit.arrow.kind };
        }
        // Elsewhere a passage; in a diagram that failed to draw, a passage of the source shown instead.
        const range = findTextRange(el, target.text);
        return range ? { rects: [...range.getClientRects()], clip, found: 'passage' } : { error: `"${target.text}" is not in block ${target.block}.` };
    }
    return { rects: [el.getBoundingClientRect()], found: 'block' };
}
