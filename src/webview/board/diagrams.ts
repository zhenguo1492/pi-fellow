/**
 * Mermaid diagrams on the board: drawing one into its block (one at a time: Mermaid's render is not
 * reentrant), the error shown in its place when the source does not parse, and the theme that follows
 * VS Code's.
 */
import mermaid from 'mermaid';
import { escapeHtml } from '../../shared/html';

type DiagramTheme = 'dark' | 'default';

function bodyTheme(): DiagramTheme {
    const body = document.body.classList;
    const dark = body.contains('vscode-dark') || (body.contains('vscode-high-contrast') && !body.contains('vscode-high-contrast-light'));
    return dark ? 'dark' : 'default';
}

let theme = bodyTheme();
let renderSeq = 0;
/** Each diagram host's source, to redraw it when the theme changes. */
const sources = new WeakMap<Element, string>();
/** Each diagram host whose last drawing failed: Mermaid's message. */
const failures = new WeakMap<Element, string>();
let drawing: Promise<unknown> = Promise.resolve();

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });

function errorMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    if (err && typeof err === 'object' && 'message' in err) {
        return String(err.message);
    }
    return String(err);
}

/**
 * Puts the drawn SVG in a view (`.board-diagram-view`) that the diagram's own zoom works in
 * (src/webview/board/zoom.ts, sizes in styles/board/diagram.css): Mermaid's width for it
 * (`--natural`) and its proportions (`--ratio`, height / width).
 */
function frame(host: HTMLElement, svgMarkup: string): void {
    host.innerHTML = `<div class="board-diagram-view">${svgMarkup}</div>`;
    const view = host.firstElementChild as HTMLElement;
    const svg = view.querySelector('svg');
    if (!svg) {
        return;
    }
    const attrWidth = svg.getAttribute('width') ?? '';
    const pxWidth = /^[\d.]+(px)?$/.test(attrWidth) ? parseFloat(attrWidth) : 0;
    const box = svg.viewBox.baseVal;
    const aspectWidth = box?.width || pxWidth;
    const aspectHeight = box?.height || parseFloat(svg.getAttribute('height') ?? '') || 0;
    // Mermaid gives the drawing's own width as max-width (its width is 100%); else a width in px, else the viewBox's.
    const natural = parseFloat(svg.style.maxWidth) || pxWidth || aspectWidth;
    if (!(aspectWidth > 0 && aspectHeight > 0 && natural > 0)) {
        return;
    }
    // The view sets the size; Mermaid's height attribute and max-width would keep the SVG from following it.
    svg.removeAttribute('height');
    svg.style.maxWidth = '';
    view.style.setProperty('--natural', `${natural}px`);
    view.style.setProperty('--ratio', String(aspectHeight / aspectWidth));
}

async function draw(host: HTMLElement, source: string): Promise<void> {
    const id = `board-mermaid-${++renderSeq}`;
    try {
        const { svg } = await mermaid.render(id, source);
        frame(host, svg);
        failures.delete(host);
    } catch (err) {
        // A failed render can leave its scratch elements (the svg, its wrapper, a sandbox iframe) in the body.
        for (const stray of [id, `d${id}`, `i${id}`]) {
            document.getElementById(stray)?.remove();
        }
        const message = errorMessage(err);
        failures.set(host, message);
        host.innerHTML =
            `<div class="board-diagram-error">` +
            `<div class="board-diagram-error-title board-chrome">Diagram error</div>` +
            `<pre class="board-diagram-error-message board-chrome">${escapeHtml(message)}</pre>` +
            `<pre class="board-diagram-source">${escapeHtml(source)}</pre>` +
            `</div>`;
    }
}

/** Draws `source` into `host` (an SVG, or the error and the source); resolves when done. */
export function drawDiagram(host: HTMLElement, source: string): Promise<void> {
    sources.set(host, source);
    const done = drawing.then(() => draw(host, source));
    drawing = done;
    return done;
}

/** Mermaid's message when the diagram in `host` failed to draw. */
export function diagramFailure(host: Element): string | undefined {
    return failures.get(host);
}

/**
 * Calls `redraw` with the hosts to draw again whenever VS Code's theme switches between light and dark
 * (VS Code changes the body class).
 */
export function watchDiagramTheme(redraw: () => void): void {
    new MutationObserver(() => {
        const next = bodyTheme();
        if (next === theme) {
            return;
        }
        theme = next;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
        redraw();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

/** Draws `host` again from its source (after a theme change). */
export function redrawDiagram(host: HTMLElement): Promise<void> {
    const source = sources.get(host);
    return source === undefined ? Promise.resolve() : drawDiagram(host, source);
}
