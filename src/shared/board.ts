/**
 * Blackboards (docs/blackboard.md): the Markdown document on a board, split into blocks with ids the
 * voice agent points at, the messages between the extension host and the board webview, and the
 * contracts between the board, the host tools and the voice turn message. Pure; no I/O, no DOM.
 */
import { Lexer, type Links, type Token, type Tokens } from 'marked';

// ── The document ──

/**
 * `html`: raw HTML in the Markdown, shown as text. `web`: a ```html fence, a live web page in a
 * sandboxed frame (prototypes, interactive and animated demos).
 */
export type BoardBlockKind = 'heading' | 'paragraph' | 'list' | 'table' | 'quote' | 'code' | 'diagram' | 'web' | 'html';

/** Id prefix per kind; ids number each kind in document order (`p1`, `p2`, `d1`, …). */
const ID_PREFIX: Record<BoardBlockKind, string> = {
    heading: 'h',
    paragraph: 'p',
    list: 'l',
    table: 't',
    quote: 'q',
    code: 'c',
    diagram: 'd',
    web: 'w',
    html: 'x',
};

export interface BoardBlock {
    id: string;
    kind: BoardBlockKind;
    /** The block's Markdown source, as written. */
    raw: string;
    /** The marked token, for rendering. */
    token: Token;
    /** code / diagram / web: the fenced language (`mermaid` for a diagram, `html` for a web page); undefined without one. */
    lang?: string;
}

export interface BoardDocument {
    blocks: BoardBlock[];
    /** Reference-style link definitions, which the renderer needs for `[text][ref]`. */
    links: Links;
}

const LEX_OPTIONS = { gfm: true, breaks: true } as const;

/** One top-level token: a block with an id, or something between blocks (blank lines, link definitions, rules). */
interface Piece {
    token: Token;
    block?: BoardBlock;
}

function kindOf(token: Token): BoardBlockKind | undefined {
    switch (token.type) {
        case 'heading':
            return 'heading';
        case 'paragraph':
        case 'text':
            return 'paragraph';
        case 'list':
            return 'list';
        case 'table':
            return 'table';
        case 'blockquote':
            return 'quote';
        case 'code': {
            const lang = ((token as Tokens.Code).lang ?? '').trim().split(/\s+/, 1)[0].toLowerCase();
            return lang === 'mermaid' ? 'diagram' : lang === 'html' ? 'web' : 'code';
        }
        case 'html':
            return 'html';
        default:
            // space, hr, def: nothing to point at.
            return undefined;
    }
}

function lex(markdown: string): { pieces: Piece[]; links: Links } {
    const tokens = Lexer.lex(markdown, LEX_OPTIONS);
    const counters = new Map<BoardBlockKind, number>();
    const pieces = tokens.map((token): Piece => {
        const kind = kindOf(token);
        if (!kind) {
            return { token };
        }
        const n = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, n);
        const lang = token.type === 'code' ? (token as Tokens.Code).lang?.trim() || undefined : undefined;
        return { token, block: { id: `${ID_PREFIX[kind]}${n}`, kind, raw: token.raw, token, ...(lang ? { lang } : {}) } };
    });
    return { pieces, links: tokens.links };
}

export function parseBoard(markdown: string): BoardDocument {
    const { pieces, links } = lex(markdown);
    return { blocks: pieces.flatMap((p) => (p.block ? [p.block] : [])), links };
}

/** Joins two stretches of Markdown with one blank line, so neither's last block runs into the other's first. */
function joinMarkdown(before: string, after: string): string {
    const head = before.replace(/\s+$/, '');
    const tail = after.replace(/^\s*\n/, '').replace(/\s+$/, '');
    return head && tail ? `${head}\n\n${tail}\n` : head || tail ? `${head || tail}\n` : '';
}

export function appendToBoard(markdown: string, addition: string): string {
    return joinMarkdown(markdown, addition);
}

/** The document with block `id` replaced by `replacement` (which may hold several blocks, or none: removed). Throws for an unknown id. */
export function replaceBoardBlock(markdown: string, id: string, replacement: string): string {
    const { pieces } = lex(markdown);
    const at = pieces.findIndex((p) => p.block?.id === id);
    if (at < 0) {
        throw new Error(`No block ${id} on this board.`);
    }
    const before = pieces.slice(0, at).map((p) => p.token.raw).join('');
    const after = pieces.slice(at + 1).map((p) => p.token.raw).join('');
    return joinMarkdown(joinMarkdown(before, replacement), after);
}

// ── Describing it to the model ──

const EXCERPT_CHARS = 60;

function excerpt(text: string): string {
    const plain = text
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return plain.length > EXCERPT_CHARS ? `${plain.slice(0, EXCERPT_CHARS - 1)}…` : plain;
}

/** One line per block: its id, kind and what it holds, e.g. `d1 diagram sequenceDiagram, 9 lines`. */
export function describeBlock(block: BoardBlock): string {
    const token = block.token;
    switch (block.kind) {
        case 'heading':
            return `${block.id} heading "${excerpt((token as Tokens.Heading).text)}"`;
        case 'paragraph':
        case 'html':
            return `${block.id} ${block.kind} "${excerpt((token as Tokens.Paragraph).text)}"`;
        case 'quote':
            return `${block.id} quote "${excerpt((token as Tokens.Blockquote).text)}"`;
        case 'list':
            return `${block.id} list, ${(token as Tokens.List).items.length} items: "${excerpt((token as Tokens.List).items[0]?.text ?? '')}"…`;
        case 'table':
            return `${block.id} table, ${(token as Tokens.Table).rows.length} rows: ${(token as Tokens.Table).header.map((c) => excerpt(c.text)).join(' | ')}`;
        case 'code':
        case 'diagram':
        case 'web': {
            const source = (token as Tokens.Code).text;
            const lines = source === '' ? 0 : source.split('\n').length;
            if (block.kind === 'web') {
                const title = webPageTitle(source);
                const { width, height } = webPageViewport(source);
                const size = width ? (height ? `, ${width}×${height}` : `, ${width} wide`) : '';
                return `${block.id} web page${title ? ` "${excerpt(title)}"` : ''}${size}, ${lines} lines`;
            }
            const what = block.kind === 'diagram' ? ` ${diagramType(source)}` : block.lang ? ` ${block.lang}` : '';
            return `${block.id} ${block.kind}${what}, ${lines} lines`;
        }
    }
}

/** A Mermaid diagram's type, its first word: flowchart, sequenceDiagram, classDiagram, … */
export function diagramType(source: string): string {
    return source.trim().split(/\s+/, 1)[0];
}

/** What a web page is called: its `<title>`, else its first h1–h3, as text; undefined without either. */
export function webPageTitle(source: string): string | undefined {
    const found = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source) ?? /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(source);
    const text = found?.[1]
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return text || undefined;
}

/** Narrowest and widest design width a web page may declare, px. */
export const WEB_PAGE_WIDTHS = { min: 240, max: 7680 } as const;
/** A web page is at most this many times as tall as it is wide, and at least WEB_PAGE_MIN_HEIGHT px. */
export const WEB_PAGE_MAX_RATIO = 8;
export const WEB_PAGE_MIN_HEIGHT = 40;

/**
 * The design size a web page declares in `<meta name="viewport" content="width=1280, height=720">`,
 * bounded (WEB_PAGE_WIDTHS, WEB_PAGE_MAX_RATIO); a height only with a width. `device-width` and
 * the like declare nothing.
 */
export function webPageViewport(source: string): { width?: number; height?: number } {
    const meta = /<meta\b[^>]*\bname\s*=\s*["']?viewport\b[^>]*>/i.exec(source)?.[0];
    const content = meta ? /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/i.exec(meta) : null;
    const value = content ? (content[1] ?? content[2] ?? content[3] ?? '') : '';
    const number = (key: string) => {
        const found = new RegExp(`(?:^|[\\s,;])${key}\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*(?:$|[\\s,;])`, 'i').exec(value);
        return found ? Math.round(Number(found[1])) : undefined;
    };
    const rawWidth = number('width');
    if (rawWidth === undefined) {
        return {};
    }
    const width = Math.min(Math.max(rawWidth, WEB_PAGE_WIDTHS.min), WEB_PAGE_WIDTHS.max);
    const rawHeight = number('height');
    return rawHeight === undefined ? { width } : { width, height: Math.min(Math.max(rawHeight, WEB_PAGE_MIN_HEIGHT), width * WEB_PAGE_MAX_RATIO) };
}

export function formatOutline(doc: BoardDocument): string {
    return doc.blocks.length ? doc.blocks.map(describeBlock).join('\n') : '(empty)';
}

/** What a saved edit changed, by block id: e.g. `changed p2, d1; added c3; removed l1`. */
export function describeBoardEdit(before: string, after: string): string {
    const old = new Map(parseBoard(before).blocks.map((b) => [b.id, b.raw.trim()]));
    const next = new Map(parseBoard(after).blocks.map((b) => [b.id, b.raw.trim()]));
    const changed = [...next].filter(([id, raw]) => old.has(id) && old.get(id) !== raw).map(([id]) => id);
    const added = [...next.keys()].filter((id) => !old.has(id));
    const removed = [...old.keys()].filter((id) => !next.has(id));
    const parts = [
        changed.length ? `changed ${changed.join(', ')}` : '',
        added.length ? `added ${added.join(', ')}` : '',
        removed.length ? `removed ${removed.join(', ')}` : '',
    ].filter(Boolean);
    return parts.length ? parts.join('; ') : 'no block changed';
}

/** Lines of show_me content that still count as short: shown as a card in the Bot view history, not on a board. */
export const SHORT_SHOW_LINES = 5;

/**
 * Whether a show_me call is a card in the Bot view history rather than a board write: short content
 * (no diagram or web page, at most SHORT_SHOW_LINES lines, fences not counted) with no board or mode
 * asked for. The host tool and the Bot view both decide with this, so a card and its call always agree.
 */
export function showMeIsCard(args: { markdown: string; board?: unknown; mode?: unknown }): boolean {
    if (args.board !== undefined || (args.mode !== undefined && args.mode !== 'append')) {
        return false;
    }
    if (parseBoard(args.markdown).blocks.some((b) => b.kind === 'diagram' || b.kind === 'web')) {
        return false;
    }
    const lines = args.markdown
        .trim()
        .split('\n')
        .filter((line) => !/^\s*(```|~~~)/.test(line));
    return lines.length <= SHORT_SHOW_LINES;
}

/**
 * showMeIsCard for a show_me call as the Bot view records it. Without its markdown the model is still
 * writing the call: it counts as a board write until its arguments say otherwise.
 */
export function showMeCallIsCard(args: Record<string, unknown>): boolean {
    return typeof args.markdown === 'string' && showMeIsCard({ markdown: args.markdown, board: args.board, mode: args.mode });
}

/**
 * The part of show_me markdown still being written whose blocks are whole: up to the last blank line
 * outside a code fence, or the end of the last closed fence. A board preview draws only that, so a
 * half-written diagram or table never shows as an error.
 */
export function completeBlocks(markdown: string): string {
    let fence: { char: string; length: number } | undefined;
    let safe = 0;
    let offset = 0;
    for (const line of markdown.split('\n')) {
        const end = offset + line.length + 1;
        // The last line has no line break yet: it may still grow.
        if (end > markdown.length) {
            break;
        }
        const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (fence) {
            if (marker && marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) {
                fence = undefined;
                safe = end;
            }
        } else if (marker) {
            fence = { char: marker[0], length: marker.length };
        } else if (!line.trim()) {
            safe = end;
        }
        offset = end;
    }
    return markdown.slice(0, safe);
}

// ── Pointing ──

export type BoardMarkStyle = 'highlight' | 'underline' | 'box';

/**
 * A place on a board. Neither lines nor text: the whole block. Lines: 1-based, inclusive: code lines
 * in a code block, or message steps in a sequence diagram (the messages in the order written, notes
 * not counted, as `autonumber` numbers them). Text: a passage in the block; in a diagram a node by id
 * or label, else an arrow by its label (a sequence message, a flowchart edge label).
 */
export interface BoardTarget {
    /** Board id; undefined: the current board. */
    board?: string;
    block: string;
    startLine?: number;
    endLine?: number;
    text?: string;
}

/** The style a marker gets: a passage underlined, a diagram node or arrow boxed, a block, code lines or message steps highlighted. */
export function defaultMarkStyle(target: BoardTarget, kind: BoardBlockKind | undefined): BoardMarkStyle {
    if (target.text !== undefined) {
        return kind === 'diagram' ? 'box' : 'underline';
    }
    return 'highlight';
}

/** What a point found on the board: its target resolved to a block, code lines, a passage, a diagram node, a sequence message or a flowchart edge. */
export type BoardFound = 'block' | 'lines' | 'passage' | 'node' | 'message' | 'edge';

/**
 * What the user marked on a board: a selection, a code line, a diagram node, a diagram arrow (a
 * sequence message, a flowchart edge label), or an element in a web page.
 */
export interface BoardUserMark {
    block: string;
    kind: BoardBlockKind;
    /** The selected text. */
    text?: string;
    /** Code blocks: the lines clicked or selected, 1-based. */
    startLine?: number;
    endLine?: number;
    /** Diagrams: the node's label (its id when it has no label). */
    node?: string;
    /** Diagrams: the label of the arrow clicked, a sequence message or a flowchart edge. */
    message?: string;
    /** Sequence diagrams: that message's step, 1-based. */
    step?: number;
    /** Web pages: the element Alt+clicked in the page. */
    element?: BoardWebElement;
}

/** An element the user Alt+clicked in a web page, as the board's script in the page describes it. */
export interface BoardWebElement {
    /** Finds it in the page: from its nearest ancestor (or itself) with a unique id, else from body, by tag, classes and :nth-of-type. */
    selector: string;
    tag: string;
    id?: string;
    classes?: string[];
    /** Its text, whitespace collapsed, cut short. */
    text?: string;
    /** Its outerHTML, whitespace collapsed, cut short. */
    html: string;
}

/** How long each part of a picked web page element may be, in characters (`classes`: how many). */
export const WEB_ELEMENT_LIMITS = { selector: 400, tag: 40, id: 100, classes: 8, className: 60, text: 160, html: 400 } as const;

/** `text` cut to `max` characters, the last one an ellipsis when cut. */
function cutText(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A picked element as a web page sent it (pages are untrusted): checked and cut to
 * WEB_ELEMENT_LIMITS; undefined when it is not one.
 */
export function parseWebElement(value: unknown): BoardWebElement | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const { selector, tag, id, classes, text, html } = value as Record<string, unknown>;
    if (typeof selector !== 'string' || !selector.trim() || typeof tag !== 'string' || !tag || typeof html !== 'string') {
        return undefined;
    }
    const limits = WEB_ELEMENT_LIMITS;
    const names = Array.isArray(classes) ? classes.filter((c): c is string => typeof c === 'string' && c !== '').slice(0, limits.classes) : [];
    return {
        selector: cutText(selector, limits.selector),
        tag: cutText(tag, limits.tag),
        ...(typeof id === 'string' && id ? { id: cutText(id, limits.id) } : {}),
        ...(names.length ? { classes: names.map((c) => cutText(c, limits.className)) } : {}),
        ...(typeof text === 'string' && text ? { text: cutText(text, limits.text) } : {}),
        html: cutText(html, limits.html),
    };
}

/** A box in the board page's window coordinates (CSS px). */
export interface BoardBox {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** Pi's point as the board draws it: what it was asked, what that turned out to be, and how many rectangles it covers on screen. */
export interface BoardShownPoint {
    target: BoardTarget;
    style: BoardMarkStyle;
    found: BoardFound;
    rects: number;
}

/**
 * Where a mark is on screen: `box` around the pieces the overlay holds, as measured (null: nothing
 * drawn); `targetBox` around the content it marks (null: none found).
 */
export interface BoardMarkBoxes {
    box: BoardBox | null;
    targetBox: BoardBox | null;
}

/** A drawn diagram as the page lays it out: its view (the box it is seen through) and its drawing. */
export interface BoardShownDiagram {
    block: string;
    view: BoardBox;
    drawing: BoardBox;
}

/** A web page as the page lays it out: its view (the box it shows in) and its frame (the page itself, scaled by its zoom). */
export interface BoardShownWebPage {
    block: string;
    view: BoardBox;
    frame: BoardBox;
}

// ── Host ↔ board webview ──

export type BoardScrollTo = 'up' | 'down' | 'top' | 'bottom' | { block: string };

/**
 * How the user zoomed a board page: the whole page (1 = 100%), and single diagrams and web pages by
 * block id (1 = as first shown; ids at 1 are left out).
 */
export interface BoardZoom {
    page: number;
    blocks: Record<string, number>;
}

export interface ZoomRange {
    min: number;
    max: number;
}

/** Zoom range of the whole page (the header's − / +), 30%–300%. */
export const PAGE_ZOOM_RANGE: ZoomRange = { min: 0.3, max: 3 };
/** Zoom range of one diagram or web page, 10%–800% of its fitted (100%) size. */
export const BLOCK_ZOOM_RANGE: ZoomRange = { min: 0.1, max: 8 };
/** One − / + press or Ctrl/Cmd + "+" / "−": the zoom is multiplied or divided by this. */
export const ZOOM_STEP = 1.1;
/** Wheel travel of one mouse notch, px: Ctrl/Cmd + wheel zooms by ZOOM_STEP per notch, in proportion to the travel. */
export const WHEEL_NOTCH_PX = 100;

/** A zoom within `range`, rounded to 6 decimals so steps there and back come out exact. */
export function clampZoom(range: ZoomRange, zoom: number): number {
    return Math.round(Math.min(Math.max(zoom, range.min), range.max) * 1e6) / 1e6;
}

/**
 * One step up (`direction` 1) or down (-1) from `current`: the next power of ZOOM_STEP that way, so a
 * zoom on that grid (100% included) is multiplied or divided by ZOOM_STEP and one off it (after a
 * wheel) lands back on it; within `range`.
 */
export function zoomStep(range: ZoomRange, current: number, direction: 1 | -1): number {
    const at = Math.log(current) / Math.log(ZOOM_STEP);
    const n = direction > 0 ? Math.floor(at + 1e-3) + 1 : Math.ceil(at - 1e-3) - 1;
    return clampZoom(range, ZOOM_STEP ** n);
}

/** `current` zoomed by `deltaPx` of Ctrl/Cmd + wheel travel (negative: in), continuously: ZOOM_STEP per WHEEL_NOTCH_PX; within `range`. */
export function zoomByWheel(range: ZoomRange, current: number, deltaPx: number): number {
    return clampZoom(range, current * ZOOM_STEP ** (-deltaPx / WHEEL_NOTCH_PX));
}

/** A wheel event's travel in px: lines count three to a notch, pages a notch each. */
export function wheelPx(deltaY: number, deltaMode: number): number {
    return deltaMode === 0 ? deltaY : deltaMode === 1 ? (deltaY * WHEEL_NOTCH_PX) / 3 : deltaY * WHEEL_NOTCH_PX;
}

/** A zoom as received (from the page or an index file): clamped to its range, or undefined when it is not one. */
export function parseBoardZoom(value: unknown): BoardZoom | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const { page, blocks } = value as Partial<BoardZoom>;
    const clamp = (range: ZoomRange, z: unknown) => (typeof z === 'number' && Number.isFinite(z) && z > 0 ? clampZoom(range, z) : undefined);
    const pageZoom = clamp(PAGE_ZOOM_RANGE, page);
    if (pageZoom === undefined) {
        return undefined;
    }
    const kept = Object.entries(blocks && typeof blocks === 'object' ? blocks : {}).flatMap(([id, z]) => {
        const zoom = clamp(BLOCK_ZOOM_RANGE, z);
        return zoom === undefined || zoom === 1 ? [] : [[id, zoom] as const];
    });
    return { page: pageZoom, blocks: Object.fromEntries(kept) };
}

export type BoardHostMessage =
    /** The whole document; `edited`: the user saved its source, so Pi's point is cleared (ids may have moved). */
    | { type: 'render'; version: number; title: string; markdown: string; edited?: boolean }
    | { type: 'point'; seq: number; target: BoardTarget; style: BoardMarkStyle }
    | { type: 'clearPoint' }
    | { type: 'scroll'; seq: number; to: BoardScrollTo }
    /** Asks which blocks are in view. */
    | { type: 'status'; seq: number }
    /** Shows diagram or web page `block` alone, filling the board (null: back to the whole board); answered with `expanded`. */
    | { type: 'expand'; seq: number; block: string | null }
    /** Whether the board's editor group is maximized (by its button or board_view): the header button reads Restore or Maximize. */
    | { type: 'maximized'; maximized: boolean }
    /** The zoom the page had when it was last shown (sent after the first render of a new page): the page takes it on. */
    | { type: 'zoom'; zoom: BoardZoom }
    /**
     * The user's press at the middle of `target`'s first box, as the user makes it: the pointer and
     * mouse events go to what is under that point; a click, or with `drag` a press moved by dx, dy
     * (window px) before it is let go. What the end-to-end tests use for the user's clicks and pans,
     * which the extension host cannot make in a webview; answered with `clicked`.
     */
    | { type: 'clickAt'; seq: number; target: BoardTarget; drag?: { dx: number; dy: number } };

export type BoardClientMessage =
    | { type: 'ready' }
    /** After a render: diagrams that failed, with Mermaid's message, and web pages that reported errors. */
    | { type: 'rendered'; version: number; errors: { block: string; message: string }[] }
    /** `error`: why the target could not be found. */
    | { type: 'pointed'; seq: number; error?: string; found?: BoardFound }
    | { type: 'scrolled'; seq: number; error?: string }
    | { type: 'expanded'; seq: number; error?: string }
    | { type: 'clicked'; seq: number; error?: string }
    /**
     * Block ids at least partly in view, top first, and the marks as drawn now: Pi's point (with how
     * many rectangles it covers on screen) and the user's mark; null when there is none. `marks`: where
     * each mark is on screen and what it marks. `width`: the page's width in CSS px, which grows when
     * the board's editor group is maximized. `maximized`: what the header button shows (true: it reads
     * Restore). `zoom`: the page's and its diagrams' and web pages' zoom. `expanded`: the diagram or web
     * page shown alone, filling the board. `scrollY`: the window's scroll. `diagrams`: every drawn
     * diagram's view and drawing. `webPages`: every web page's view and frame.
     */
    | {
          type: 'status';
          seq: number;
          visible: string[];
          point: BoardShownPoint | null;
          userMark: BoardUserMark | null;
          marks: { pi: BoardMarkBoxes | null; user: BoardMarkBoxes | null };
          width: number;
          maximized: boolean;
          zoom: BoardZoom;
          expanded: string | null;
          scrollY: number;
          diagrams: BoardShownDiagram[];
          webPages: BoardShownWebPage[];
      }
    /** The user marked something, or cleared their mark (`null`). */
    | { type: 'userMark'; mark: BoardUserMark | null }
    /** The "Edit source" button. */
    | { type: 'editSource' }
    /** The header's Maximize / Restore button: maximize the board's editor group, or restore it when the board is maximized. */
    | { type: 'toggleMaximize' }
    /** A link in the document was clicked: its href as written; the host decides what it opens. */
    | { type: 'openLink'; href: string }
    /** The user zoomed the page, a diagram or a web page (sent once the zooming pauses): the host keeps it for the board. */
    | { type: 'zoomed'; zoom: BoardZoom };

// ── Links ──

/** What a link on a board opens: a web page in the browser, a file in the editor (at a line), or nothing. */
export type BoardLink = { kind: 'web'; url: string } | { kind: 'file'; path: string; line?: number; endLine?: number } | { kind: 'none' };

/**
 * What a board link opens. http(s) goes to the browser. A path (workspace-relative or absolute, or a
 * file: URL) is a file, at lines when it ends in `#L12`, `#L12-L20`, `:12`, `:12-20` or `:12:5` (line
 * and column). In-page anchors and every other scheme (mailto:, command:, javascript:, …) open nothing.
 */
export function parseBoardLink(href: string): BoardLink {
    let text = href.trim();
    if (!text || text.startsWith('#')) {
        return { kind: 'none' };
    }
    if (/^https?:\/\//i.test(text)) {
        return URL.canParse(text) ? { kind: 'web', url: new URL(text).href } : { kind: 'none' };
    }
    let line: number | undefined;
    let endLine: number | undefined;
    const hash = text.indexOf('#');
    if (hash >= 0) {
        const anchor = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(text.slice(hash + 1));
        if (anchor) {
            line = Number(anchor[1]);
            endLine = anchor[2] === undefined ? undefined : Number(anchor[2]);
        }
        // Any other anchor (a heading) opens the file at its top.
        text = text.slice(0, hash);
    } else {
        const suffix = /^(.+?):(\d+)(?:-(\d+)|:\d+)?$/.exec(text);
        if (suffix) {
            text = suffix[1];
            line = Number(suffix[2]);
            endLine = suffix[3] === undefined ? undefined : Number(suffix[3]);
        }
    }
    let path: string;
    if (/^file:/i.test(text)) {
        if (!URL.canParse(text)) {
            return { kind: 'none' };
        }
        path = decodeURIComponent(new URL(text).pathname);
        // file:///C:/x on Windows
        path = /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) {
        return { kind: 'none' };
    } else {
        try {
            path = decodeURIComponent(text);
        } catch {
            path = text;
        }
    }
    if (!path) {
        return { kind: 'none' };
    }
    const lines = line !== undefined && line >= 1 ? { line, ...(endLine !== undefined && endLine > line ? { endLine } : {}) } : {};
    return { kind: 'file', path, ...lines };
}

// ── Host tools ──

export interface BoardWriteRequest {
    markdown: string;
    title?: string;
    /** A board id, or `new`; undefined: the current board, a new one when there is none. */
    board?: string;
    /** append (default): at the end. replace: the whole board. block: replace `block` (empty markdown removes it). */
    mode: 'append' | 'replace' | 'block';
    block?: string;
}

/** maximize: the board's editor group fills the editor area; restore: undoes it. expand: one diagram or web page fills the board; collapse: the whole board again. */
export type BoardViewAction = 'open' | 'close' | 'focus' | 'move' | 'maximize' | 'restore' | 'expand' | 'collapse' | 'scroll' | 'list' | 'looking';
/** main: the editor group of the user's code (the first group when there is none); the others as VS Code's editor groups go. */
export type BoardMoveTo = 'main' | 'left' | 'right' | 'beside' | 'window';

export interface BoardViewRequest {
    action: BoardViewAction;
    /** Board id; undefined: the current board. */
    board?: string;
    /** move; open: where it opens */
    to?: BoardMoveTo;
    /** scroll */
    where?: BoardScrollTo;
    /** expand: the diagram or web page block */
    block?: string;
}

/** The boards as the host tools use them; each resolves with a report for the model and throws on failure. */
export interface BoardHands {
    /**
     * Resolves once the board is written and its drawing started, without waiting for the page to draw it.
     * Report starts with `Board <id> ` (the Bot view's board card reads the id from it).
     */
    write(request: BoardWriteRequest): Promise<string>;
    point(target: BoardTarget, style: BoardMarkStyle | undefined): Promise<string>;
    view(request: BoardViewRequest): Promise<string>;
    /** What drawings started by `write` reported after it returned (Mermaid and web page script errors); each is handed out once. */
    takeLateResults(): string[];
    /**
     * The model is still writing a show_me call that goes on a board: draws its whole blocks so far on
     * the board it would write, without writing anything yet. Its `end` says what came of it.
     */
    preview(request: BoardWriteRequest): BoardPreview;
}

/** A board write drawn while its call streams: on the board it targets, nothing written to its file or index. */
export interface BoardPreview {
    /** The call's arguments as written so far; its markdown may stop mid-block. */
    update(request: BoardWriteRequest): void;
    /**
     * Ends it. `next`: the write the call turned into, about to run: when it writes the same board, the
     * preview's tab stays for it. Otherwise (or with no write: the call was dropped) the board goes
     * back to what it showed, and a tab the preview opened closes.
     */
    end(next?: BoardWriteRequest): void;
}

// ── The voice turn message ──

export interface BoardUserMarkInfo {
    board: string;
    title: string;
    mark: BoardUserMark;
    /** Made after the user's last selection in the editor, so "this" means it. */
    latest: boolean;
}

export interface BoardEditNotice {
    board: string;
    title: string;
    /** describeBoardEdit */
    summary: string;
    /** formatOutline of the saved document */
    outline: string;
}

export interface BoardListing {
    id: string;
    title: string;
    open: boolean;
    current: boolean;
}

/** What each voice turn tells the model about the boards. */
export interface BoardContextSource {
    /** The user's current mark, if any. */
    userMark(): BoardUserMarkInfo | undefined;
    /** Saves of a board's source since last asked; each is handed out once. */
    takeEdits(): BoardEditNotice[];
    /** The voice conversation's boards, for the first message in a context (join or resume). */
    list(): BoardListing[];
}
