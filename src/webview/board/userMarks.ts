/**
 * The user's mark: a selection inside one block, a click on a code line, a diagram node or a diagram
 * arrow (a sequence message, a labeled flowchart edge), or an Alt + click on an element in a web page,
 * drawn in the user's color and sent to the host for the next voice turn. Clicking the mark again (in
 * a web page, Alt + clicking its element again) or Escape clears it; plain clicks elsewhere leave it alone.
 */
import type { BoardUserMark, BoardWebElement } from '../../shared/board';
import { blockAt, boardBlock } from './document';
import { arrowRects, codeLineAt, codeLinesRect, codeRangeLines, diagramArrowAt, diagramArrows, diagramNodeAt, diagramNodeName, findDiagramTarget } from './locate';
import { isOnMark, setMark, type MarkPlace } from './marks';
import { blockScroller } from './pointing';
import type { WebPageBox } from './web';
import { panDragged } from './zoom';

/** The marked block's section when marked: a render that rebuilds it (or removes it) ends the mark. */
let markedSection: HTMLElement | undefined;
let current: BoardUserMark | null = null;
let post: (mark: BoardUserMark | null) => void;

function mark(message: BoardUserMark, el: HTMLElement, style: 'highlight' | 'box', locate: () => MarkPlace | undefined): void {
    markedSection = el;
    current = message;
    setMark('user', {
        style,
        locate: () => {
            const place = locate();
            return place && { ...place, block: el };
        },
    });
    post(message);
}

/** Removes the user's mark; `tell`: the host learns of it (not when the mark's block is already gone). */
export function clearUserMark(tell: boolean): void {
    if (!markedSection) {
        return;
    }
    markedSection = undefined;
    current = null;
    setMark('user', undefined);
    if (tell) {
        post(null);
    }
}

/** After a render: ends the mark when its block was removed or rebuilt, and tells the host. */
export function checkUserMark(): void {
    const id = markedSection?.dataset.block;
    if (markedSection && (id === undefined || boardBlock(id)?.el !== markedSection)) {
        clearUserMark(true);
    }
}

/** The user's mark as sent to the host, null when there is none. */
export function currentUserMark(): BoardUserMark | null {
    return current;
}

function markSelection(selection: Selection): boolean {
    const text = selection.toString().trim();
    if (selection.isCollapsed || !text) {
        return false;
    }
    const range = selection.getRangeAt(0).cloneRange();
    const block = blockAt(range.startContainer);
    if (!block || blockAt(range.endContainer)?.el !== block.el) {
        return true;
    }
    const code = block.kind === 'code' ? block.el.querySelector('.board-code-text') : null;
    const lines = code ? codeRangeLines(code, range) : {};
    const clip = blockScroller(block.el, block.kind);
    mark({ block: block.id, kind: block.kind, text, ...lines }, block.el, 'highlight', () =>
        range.startContainer.isConnected ? { rects: [...range.getClientRects()], clip } : undefined,
    );
    return true;
}

function markClick(target: Element, x: number, y: number): void {
    const block = blockAt(target);
    if (!block) {
        return;
    }
    const clip = blockScroller(block.el, block.kind);
    const code = block.kind === 'code' ? target.closest('.board-code-pre')?.querySelector('.board-code-text') : null;
    if (code && clip) {
        const line = codeLineAt(code, y);
        if (line !== undefined) {
            mark({ block: block.id, kind: block.kind, startLine: line, endLine: line }, block.el, 'highlight', () =>
                code.isConnected ? { rects: [codeLinesRect(code, clip, line, line)], clip } : undefined,
            );
        }
        return;
    }
    const svg = block.kind === 'diagram' ? target.closest('svg') : null;
    if (!svg) {
        return;
    }
    // An arrow's label before the node test, which would take a message's text for a node.
    const onArrowLabel = diagramArrows(svg).some((a) => a.labels.some((l) => l.contains(target)));
    const node = onArrowLabel ? undefined : diagramNodeAt(target, svg);
    // Found again by name, step or label: a theme switch redraws the diagram into new elements.
    if (node) {
        const name = diagramNodeName(node, svg);
        mark({ block: block.id, kind: block.kind, node: name }, block.el, 'box', () => {
            const now = block.el.querySelector('svg');
            const hit = now === svg ? { node } : now && findDiagramTarget(now, name);
            return hit && 'node' in hit && hit.node.isConnected ? { rects: [hit.node.getBoundingClientRect()], clip } : undefined;
        });
        return;
    }
    const arrow = diagramArrowAt(target, svg, x, y);
    if (arrow) {
        const { step, text } = arrow;
        mark({ block: block.id, kind: block.kind, message: text, ...(step !== undefined ? { step } : {}) }, block.el, 'box', () => {
            const now = block.el.querySelector('svg');
            const again = now === svg ? arrow : now && diagramArrows(now).find((a) => (step !== undefined ? a.step === step : a.kind === 'edge' && a.text === text));
            return again && again.line.isConnected ? { rects: arrowRects(again), clip } : undefined;
        });
    }
}

/**
 * An element the user Alt + clicked in a web page (web.ts): `box` in the page's own px, drawn through
 * its frame's scale, so the mark follows a zoom or expand. Picking the marked element again clears it.
 */
export function markWebElement(section: HTMLElement, element: BoardWebElement, box: WebPageBox): void {
    const block = blockAt(section);
    if (!block || block.kind !== 'web') {
        return;
    }
    if (markedSection === section && current?.element?.selector === element.selector) {
        clearUserMark(true);
        return;
    }
    const frame = section.querySelector<HTMLIFrameElement>('.board-web-frame');
    const clip = section.querySelector('.board-web-view') ?? undefined;
    mark({ block: block.id, kind: block.kind, element }, section, 'box', () => {
        if (!frame?.isConnected) {
            return undefined;
        }
        // The frame is laid out at the page's natural size and scaled: its box on screen over its layout
        // width. Not laid out (its Source shown instead), the mark stays, drawn nowhere.
        const shown = frame.getBoundingClientRect();
        const scale = shown.width / frame.offsetWidth;
        const rects = frame.offsetWidth > 0 ? [new DOMRect(shown.left + box.left * scale, shown.top + box.top * scale, box.width * scale, box.height * scale)] : [];
        return { rects, clip };
    });
}

/** Listens for the user's marks on the board; `send` posts a mark (or `null`: cleared) to the host. */
export function initUserMarks(send: (mark: BoardUserMark | null) => void): void {
    post = send;
    document.addEventListener('mouseup', (event) => {
        // A press that panned a zoomed diagram (zoom.ts) is no click on what it ended over.
        if (event.button !== 0 || panDragged() || !(event.target instanceof Element) || event.target.closest('button, a, .board-header')) {
            return;
        }
        const target = event.target;
        // After the default action, which collapses a selection clicked inside.
        setTimeout(() => {
            const selection = document.getSelection();
            if (selection && markSelection(selection)) {
                return;
            }
            if (markedSection && isOnMark('user', event.clientX, event.clientY)) {
                clearUserMark(true);
                return;
            }
            markClick(target, event.clientX, event.clientY);
        }, 0);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            clearUserMark(true);
        }
    });
}
