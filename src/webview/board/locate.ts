/**
 * Finding things in a rendered board block: a passage of text, a code line, a diagram node, a diagram
 * arrow (a sequence message, a flowchart edge). DOM only; no board state, so pointing (Pi) and marking
 * (the user) share it.
 */

/** Elements the board adds around content (code headers, buttons): never part of a passage. */
export const CHROME_CLASS = 'board-chrome';

interface Position {
    node: Text;
    offset: number;
}

/** Whitespace runs collapsed to one space, leading and trailing whitespace dropped. */
function normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** Lower-cased char by char, so indexes match the original (a char whose lower case is longer stays as it is). */
function lowerSameLength(text: string): string {
    let out = '';
    for (const ch of text) {
        const lower = ch.toLowerCase();
        out += lower.length === ch.length ? lower : ch;
    }
    return out;
}

function contentTextNodes(root: Element): Text[] {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement?.closest(`.${CHROME_CLASS}`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push(node as Text);
    }
    return nodes;
}

/**
 * The range of `text` in the rendered text of `root`, whitespace-normalized on both sides: exact first,
 * then case-insensitive, then with Markdown emphasis/code marks dropped from `text` (the model quotes
 * the source, the page shows it rendered).
 */
export function findTextRange(root: Element, text: string): Range | undefined {
    const needles = [normalize(text), normalize(text.replace(/[*_`~]+/g, ''))].filter((n, i, all) => n && all.indexOf(n) === i);
    if (!needles.length) {
        return undefined;
    }
    let hay = '';
    const positions: Position[] = [];
    let afterSpace = true;
    for (const node of contentTextNodes(root)) {
        const data = node.data;
        for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            if (/\s/.test(ch)) {
                if (!afterSpace) {
                    hay += ' ';
                    positions.push({ node, offset: i });
                    afterSpace = true;
                }
            } else {
                hay += ch;
                positions.push({ node, offset: i });
                afterSpace = false;
            }
        }
    }
    const hayLower = lowerSameLength(hay);
    for (const needle of needles) {
        let at = hay.indexOf(needle);
        if (at < 0) {
            at = hayLower.indexOf(lowerSameLength(needle));
        }
        if (at >= 0) {
            const start = positions[at];
            const end = positions[at + needle.length - 1];
            const range = root.ownerDocument.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset + 1);
            return range;
        }
    }
    return undefined;
}

/**
 * How many window px one of `el`'s own px is: the page's zoom, a scale on the column (zoom.ts). Its
 * scroll offsets and computed lengths are in its own px, client rects in window px. 1 where nothing
 * is laid out (jsdom).
 */
export function screenScale(el: HTMLElement): number {
    return el.offsetWidth > 0 ? el.getBoundingClientRect().width / el.offsetWidth : 1;
}

// ── Code lines ──
// A code block never wraps and has a fixed line height, so line N's box follows from geometry. The
// line height is in the element's own px; client rects are in window px, larger by the page's zoom.

export function codeLineCount(code: Element): number {
    return (code.textContent ?? '').split('\n').length;
}

function lineHeightPx(code: Element): number {
    return parseFloat(getComputedStyle(code).lineHeight) * (code instanceof HTMLElement ? screenScale(code) : 1);
}

/** The 1-based line under `clientY` in a code element, or undefined outside its lines. */
export function codeLineAt(code: Element, clientY: number): number | undefined {
    // The stylesheet gives code a fixed line height in px.
    const line = Math.floor((clientY - code.getBoundingClientRect().top) / lineHeightPx(code)) + 1;
    return line >= 1 && line <= codeLineCount(code) ? line : undefined;
}

/** The box of lines `start`..`end` (1-based, inclusive), as wide as the visible part of the code block. */
export function codeLinesRect(code: Element, scroller: Element, start: number, end: number): DOMRect {
    const top = code.getBoundingClientRect().top;
    const lineHeight = lineHeightPx(code);
    const box = scroller.getBoundingClientRect();
    return new DOMRect(box.left, top + (start - 1) * lineHeight, box.width, (end - start + 1) * lineHeight);
}

/** Line numbers (1-based) where `range` starts and ends in `code`; a boundary outside it clamps to the first/last line. */
export function codeRangeLines(code: Element, range: Range): { startLine: number; endLine: number } {
    const lineOf = (node: Node, offset: number, fallback: number): number => {
        if (!code.contains(node)) {
            return fallback;
        }
        const before = code.ownerDocument.createRange();
        before.setStart(code, 0);
        before.setEnd(node, offset);
        return before.toString().split('\n').length;
    };
    const last = codeLineCount(code);
    const startLine = lineOf(range.startContainer, range.startOffset, 1);
    // A selection ending right after a newline (a whole-line drag) ends on the line before.
    const endText = range.toString();
    const endLine = lineOf(range.endContainer, range.endOffset, last) - (endText.endsWith('\n') && endText.length > 1 ? 1 : 0);
    return { startLine, endLine: Math.max(startLine, Math.min(endLine, last)) };
}

// ── Diagram nodes ──
// Mermaid draws each node as a group: flowchart `g.node` (id `flowchart-A-12`), class `g.node`
// (`classId-Animal-3`), state `g.node` (`state-Idle-4`), ER `g.node` / `.er.entityBox`
// (`entity-CUSTOMER-5`), sequence actors a group with `rect.actor` (attribute `name`) and a label.

const NODE_SELECTOR = 'g.node, g.cluster, g.actor-man, g.entityBox, g.er, g.stateGroup, g.classGroup';

/** Elements holding a label: SVG text (not nested in another) and HTML labels in foreignObject. */
function labelElements(svg: SVGSVGElement): Element[] {
    return [...svg.querySelectorAll('text, foreignObject')].filter(
        (el) => !el.parentElement?.closest('text, foreignObject') && !el.closest('defs, marker') && normalize(el.textContent ?? ''),
    );
}

/** The mermaid id without the diagram's own id in front (Mermaid prefixes some ids with the svg id). */
function localId(el: Element, svg: SVGSVGElement): string {
    const prefix = svg.id ? `${svg.id}-` : '';
    return prefix && el.id.startsWith(prefix) ? el.id.slice(prefix.length) : el.id;
}

/**
 * The node a label or node part belongs to: the nearest Mermaid node group, else the nearest group
 * holding a shape and no other label (a sequence actor's box and name, not its lifeline), else the
 * element itself (a message text).
 */
function nodeOf(el: Element, svg: SVGSVGElement): Element {
    const group = el.closest(NODE_SELECTOR);
    if (group && svg.contains(group) && group !== svg) {
        return group;
    }
    for (let up: Element | null = el; up && up !== svg; up = up.parentElement) {
        if (up.tagName.toLowerCase() !== 'g') {
            continue;
        }
        const labels = [...up.querySelectorAll('text, foreignObject')].filter((l) => normalize(l.textContent ?? ''));
        if (labels.length > 1) {
            break;
        }
        if (up.querySelector('rect, circle, ellipse, polygon, path')) {
            return up;
        }
    }
    return el;
}

// ── Diagram arrows ──
// A sequence message is its line or path (`[data-et="message"]`, in drawing order) with the
// `text.messageText` elements Mermaid draws just before it, one per label line. A flowchart edge (and
// any diagram drawn by Mermaid's unified renderer) is its path (`[data-et="edge"][data-id]`) with the
// `.label` of the same `data-id`; edges without a label cannot be named and are left out.

export interface DiagramArrow {
    kind: 'message' | 'edge';
    line: Element;
    labels: Element[];
    /** The label, whitespace-normalized. */
    text: string;
    /** Messages: 1-based, in the order written (notes do not count), as `autonumber` numbers them. */
    step?: number;
}

export function diagramArrows(svg: SVGSVGElement): DiagramArrow[] {
    const arrows: DiagramArrow[] = [];
    let labels: Element[] = [];
    for (const el of svg.querySelectorAll('text.messageText, [data-et="message"]')) {
        if (el.matches('text')) {
            labels.push(el);
            continue;
        }
        const text = normalize(labels.map((l) => l.textContent ?? '').join(' '));
        arrows.push({ kind: 'message', line: el, labels, text, step: arrows.length + 1 });
        labels = [];
    }
    const edgeLabels = [...svg.querySelectorAll('.label[data-id]')];
    for (const line of svg.querySelectorAll('[data-et="edge"][data-id]')) {
        const label = edgeLabels.find((l) => l.getAttribute('data-id') === line.getAttribute('data-id'));
        const text = normalize(label?.textContent ?? '');
        if (label && text) {
            arrows.push({ kind: 'edge', line, labels: [label], text });
        }
    }
    return arrows;
}

/** Thinnest box an arrow's line is marked with, px: a straight line's own box has no height. */
const ARROW_MIN_PX = 6;

/** What marks an arrow: its label and its line, the line widened to ARROW_MIN_PX. */
export function arrowRects(arrow: DiagramArrow): DOMRect[] {
    const r = arrow.line.getBoundingClientRect();
    const w = Math.max(r.width, ARROW_MIN_PX);
    const h = Math.max(r.height, ARROW_MIN_PX);
    return [...arrow.labels.map((l) => l.getBoundingClientRect()), new DOMRect(r.left - (w - r.width) / 2, r.top - (h - r.height) / 2, w, h)];
}

/**
 * What `text` names in a diagram: a node (a Mermaid id, a `-`-separated segment of an element id, or a
 * sequence actor's `name`), else a label equal to it (trimmed, case-insensitive), a node's before an
 * arrow's, else a label containing it, again a node's first. Several node hits at one level (a sequence
 * actor drawn at the top and the bottom): the topmost, then leftmost; several arrows: the first drawn.
 */
export function findDiagramTarget(svg: SVGSVGElement, text: string): { node: Element } | { arrow: DiagramArrow } | undefined {
    const want = normalize(text);
    if (!want) {
        return undefined;
    }
    const lower = want.toLowerCase();
    const arrows = diagramArrows(svg);
    const arrowLabels = arrows.flatMap((a) => a.labels);
    const idHolders = [...svg.querySelectorAll('g[id]')].filter((el) => !el.closest('defs, marker') && !/(^|\s)edge/.test(el.getAttribute('class') ?? ''));
    const labels = labelElements(svg)
        .filter((el) => !arrowLabels.some((l) => l.contains(el)))
        .map((el) => ({ el, text: normalize(el.textContent ?? '').toLowerCase() }));
    const levels: (() => Element[] | DiagramArrow | undefined)[] = [
        () => idHolders.filter((el) => localId(el, svg) === want),
        () => idHolders.filter((el) => `-${localId(el, svg)}-`.includes(`-${want}-`)),
        () => [...svg.querySelectorAll(':not(line)[name]')].filter((el) => el.getAttribute('name') === want),
        () => labels.filter((l) => l.text === lower).map((l) => l.el),
        () => arrows.find((a) => a.text.toLowerCase() === lower),
        () => labels.filter((l) => l.text.includes(lower)).map((l) => l.el),
        () => arrows.find((a) => a.text.toLowerCase().includes(lower)),
    ];
    for (const level of levels) {
        const hit = level();
        if (hit && !Array.isArray(hit)) {
            return { arrow: hit };
        }
        const hits = (hit ?? []).map((el) => ({ node: nodeOf(el, svg), box: el.getBoundingClientRect() }));
        if (hits.length) {
            hits.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
            return { node: hits[0].node };
        }
    }
    return undefined;
}

/** An arrow the user clicks is within this many px of its line (lines are a pixel or two wide). */
const ARROW_HIT_PX = 6;

/** How far (window px) the point is from a line or path, sampled every few px along it; Infinity when it cannot be measured. */
function distanceToStroke(line: Element, x: number, y: number): number {
    const geo = line as SVGGeometryElement;
    // Both absent in jsdom.
    const ctm = typeof geo.getTotalLength === 'function' && typeof geo.getScreenCTM === 'function' ? geo.getScreenCTM() : null;
    if (!ctm) {
        return Infinity;
    }
    const total = geo.getTotalLength();
    const samples = Math.max(1, Math.ceil(total / 3));
    let best = Infinity;
    for (let i = 0; i <= samples; i++) {
        const p = geo.getPointAtLength((total * i) / samples).matrixTransform(ctm);
        best = Math.min(best, Math.hypot(p.x - x, p.y - y));
    }
    return best;
}

/** The arrow the user clicked: on its label, or within ARROW_HIT_PX of its line. */
export function diagramArrowAt(target: Element, svg: SVGSVGElement, x: number, y: number): DiagramArrow | undefined {
    const arrows = diagramArrows(svg);
    const onLabel = arrows.find((a) => a.line === target || a.labels.some((l) => l.contains(target)));
    if (onLabel) {
        return onLabel;
    }
    const near = arrows.map((arrow) => ({ arrow, d: distanceToStroke(arrow.line, x, y) })).filter((a) => a.d <= ARROW_HIT_PX);
    near.sort((a, b) => a.d - b.d);
    return near[0]?.arrow;
}

/** The node the user clicked on, or undefined for arrows and empty space. */
export function diagramNodeAt(target: Element, svg: SVGSVGElement): Element | undefined {
    const group = target.closest(NODE_SELECTOR);
    if (group && svg.contains(group) && group !== svg) {
        return group;
    }
    const label = target.closest('text, foreignObject');
    if (label && svg.contains(label)) {
        return nodeOf(label, svg);
    }
    // A sequence actor's box: the group holding it and its name.
    if (target.matches('rect[name], rect.actor')) {
        return nodeOf(target, svg);
    }
    return undefined;
}

/**
 * What names a node for the model and for finding it again: its label, else its Mermaid id
 * (`flowchart-A-12` → `A`).
 */
export function diagramNodeName(node: Element, svg: SVGSVGElement): string {
    const labels = node.matches('text, foreignObject') ? [node] : [...node.querySelectorAll('text, foreignObject')];
    const label = labels.map((l) => normalize(l.textContent ?? '')).find(Boolean);
    if (label) {
        return label;
    }
    const segments = localId(node, svg).split('-');
    return segments.length > 2 && /^\d+$/.test(segments[segments.length - 1]) ? segments.slice(1, -1).join('-') : segments.join('-');
}
