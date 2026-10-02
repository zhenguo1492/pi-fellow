/**
 * The board's document: one `<section data-block data-kind>` per block of `parseBoard`, updated by key
 * so a block whose id and source are unchanged keeps its DOM (no flicker, no diagram redraw).
 */
import { Marked, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import { parseBoard, type BoardBlockKind } from '../../shared/board';
import { escapeHtml } from '../../shared/html';
import { diagramFailure, drawDiagram, redrawDiagram } from './diagrams';
import { CHROME_CLASS } from './locate';
import { buildWebPage, webFailure } from './web';

interface RenderedBlock {
    /** The block's source without trailing whitespace, which depends on what follows the block. */
    raw: string;
    kind: BoardBlockKind;
    el: HTMLElement;
}

function codeHtml(text: string, lang: string | undefined): string {
    const language = (lang ?? '').trim().split(/\s+/, 1)[0].toLowerCase();
    const body = language && hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text);
    return (
        `<div class="board-code">` +
        `<div class="board-code-header ${CHROME_CLASS}"><span class="board-code-lang">${escapeHtml(language)}</span>` +
        `<button type="button" class="board-copy">Copy</button></div>` +
        `<pre class="board-code-pre"><code class="board-code-text">${body}</code></pre>` +
        `</div>`
    );
}

/**
 * A diagram's or web page's own zoom and expand (src/webview/board/zoom.ts): over a diagram's top
 * right corner, in a web page's header; shown on hover, selection or focus.
 */
function blockToolsHtml(what: 'diagram' | 'web page'): string {
    return (
        `<div class="board-block-tools ${CHROME_CLASS}">` +
        `<button type="button" data-zoom="out" title="Zoom this ${what} out">−</button>` +
        `<button type="button" data-zoom="fit" title="${what === 'diagram' ? 'Fit this diagram to its block' : 'Back to 100%'}">100%</button>` +
        `<button type="button" data-zoom="in" title="Zoom this ${what} in${what === 'diagram' ? '; drag to pan' : ''}">+</button>` +
        `<button type="button" data-zoom="expand" aria-pressed="false" title="Show only this ${what}, filling the board (Esc to go back)">⤢</button>` +
        `</div>`
    );
}

/** Raw HTML shows as the text it is, like the chat's prompts (renderMarkdownLiteralHtml). */
const markdown = new Marked({
    gfm: true,
    breaks: true,
    renderer: { html: ({ text }) => escapeHtml(text), code: ({ text, lang }) => codeHtml(text, lang) },
});

let blocks = new Map<string, RenderedBlock>();

export interface DocumentUpdate {
    /** Sections added or redrawn, in document order. */
    changed: HTMLElement[];
    /** Diagrams that failed to draw (kept ones included). */
    errors: { block: string; message: string }[];
}

/** Brings `container` to `source`: new and changed blocks are built (diagrams drawn), the rest kept. */
export async function renderDocument(container: HTMLElement, source: string): Promise<DocumentUpdate> {
    const doc = parseBoard(source);
    const next = new Map<string, RenderedBlock>();
    const changed: HTMLElement[] = [];
    const drawn: Promise<void>[] = [];
    /** Web pages, started once on the board: their natural width is the block's, measured there. */
    const pages: (() => Promise<void>)[] = [];
    for (const block of doc.blocks) {
        const old = blocks.get(block.id);
        const raw = block.raw.trimEnd();
        if (old && old.raw === raw) {
            next.set(block.id, old);
            continue;
        }
        const el = document.createElement('section');
        el.className = 'board-block';
        el.dataset.block = block.id;
        el.dataset.kind = block.kind;
        if (block.kind === 'diagram') {
            const host = document.createElement('div');
            host.className = 'board-diagram';
            host.innerHTML = `<div class="board-diagram-pending ${CHROME_CLASS}">Drawing the diagram…</div>`;
            el.innerHTML = blockToolsHtml('diagram');
            el.append(host);
            drawn.push(drawDiagram(host, (block.token as Tokens.Code).text));
        } else if (block.kind === 'web') {
            const source = (block.token as Tokens.Code).text;
            pages.push(buildWebPage(el, source, codeHtml(source, 'html'), blockToolsHtml('web page')));
        } else {
            el.innerHTML = markdown.parser(Object.assign([block.token], { links: doc.links }));
        }
        next.set(block.id, { raw, kind: block.kind, el });
        changed.push(el);
    }
    const kept = new Set([...next.values()].map((b) => b.el));
    for (const child of [...container.children]) {
        if (!kept.has(child as HTMLElement)) {
            child.remove();
        }
    }
    let cursor = container.firstElementChild;
    for (const { el } of next.values()) {
        if (el === cursor) {
            cursor = cursor.nextElementSibling;
        } else {
            container.insertBefore(el, cursor);
        }
    }
    blocks = next;
    drawn.push(...pages.map((start) => start()));
    await Promise.all(drawn);
    const errors = [...next.entries()].flatMap(([block, { el, kind }]) => {
        const message = kind === 'diagram' ? diagramFailure(el.querySelector('.board-diagram')!) : kind === 'web' ? webFailure(el) : undefined;
        return message === undefined ? [] : [{ block, message }];
    });
    return { changed, errors };
}

/** Draws every diagram again (the theme changed). */
export async function redrawDiagrams(): Promise<void> {
    const hosts = [...blocks.values()].flatMap(({ el, kind }) => (kind === 'diagram' ? [el.querySelector<HTMLElement>('.board-diagram')!] : []));
    await Promise.all(hosts.map((host) => redrawDiagram(host)));
}

export function boardBlock(id: string): { el: HTMLElement; kind: BoardBlockKind } | undefined {
    return blocks.get(id);
}

/** The section and block id holding `node`, if any. */
export function blockAt(node: Node): { id: string; el: HTMLElement; kind: BoardBlockKind } | undefined {
    const el = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('section.board-block');
    const id = el?.dataset.block;
    const block = id === undefined ? undefined : blocks.get(id);
    return block && block.el === el ? { id: id!, el, kind: block.kind } : undefined;
}

export function boardSections(): { id: string; el: HTMLElement }[] {
    return [...blocks.entries()].map(([id, { el }]) => ({ id, el }));
}
