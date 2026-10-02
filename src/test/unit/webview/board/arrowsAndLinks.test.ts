// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { initLinks } from '../../../../webview/board/links';
import { diagramArrows, findDiagramTarget } from '../../../../webview/board/locate';

/** Mermaid 12's shapes, trimmed: a message's texts come just before its line; an edge's label shares its data-id. */
function svg(inner: string): SVGSVGElement {
    const host = document.createElement('div');
    host.innerHTML = `<svg id="m1" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
    return host.querySelector('svg')!;
}

const SEQUENCE = svg(
    '<g><rect class="actor" name="AI"></rect><text class="actor">AI</text></g>' +
        '<text class="messageText">ask</text><line class="messageLine0" data-et="message" data-id="i0"></line>' +
        '<g><rect class="note"></rect><text class="noteText">a note</text></g>' +
        '<text class="messageText">show_me</text><text class="messageText">写内容</text><line class="messageLine1" data-et="message" data-id="i2"></line>' +
        '<text class="messageText">AI</text><path class="messageLine0" data-et="message" data-id="i3"></path>',
);

const FLOWCHART = svg(
    '<g class="node" id="m1-flowchart-Client-0"><foreignObject><span>Client</span></foreignObject></g>' +
        '<path data-et="edge" data-id="L_Client_Server_0"></path><path data-et="edge" data-id="L_Server_Token_0"></path>' +
        '<g class="edgeLabels"><g class="edgeLabel"><g class="label" data-id="L_Client_Server_0"><foreignObject><span>sends token</span></foreignObject></g></g>' +
        '<g class="edgeLabel"><g class="label" data-id="L_Server_Token_0"><foreignObject></foreignObject></g></g></g>',
);

describe('diagram arrows', () => {
    it('pairs each sequence message with the label lines drawn before it, numbering steps without notes', () => {
        expect(diagramArrows(SEQUENCE).map(({ kind, text, step, line }) => ({ kind, text, step, id: line.getAttribute('data-id') }))).toEqual([
            { kind: 'message', text: 'ask', step: 1, id: 'i0' },
            { kind: 'message', text: 'show_me 写内容', step: 2, id: 'i2' },
            { kind: 'message', text: 'AI', step: 3, id: 'i3' },
        ]);
    });

    it('pairs a flowchart edge with its label by data-id and leaves unlabeled edges out', () => {
        expect(diagramArrows(FLOWCHART).map(({ kind, text, line }) => ({ kind, text, id: line.getAttribute('data-id') }))).toEqual([
            { kind: 'edge', text: 'sends token', id: 'L_Client_Server_0' },
        ]);
    });

    it('finds a node before an arrow with the same label, and an arrow by its label or part of it', () => {
        expect(findDiagramTarget(SEQUENCE, 'AI')).toEqual({ node: SEQUENCE.querySelector('g') });
        const whole = findDiagramTarget(SEQUENCE, 'show_me 写内容');
        expect(whole && 'arrow' in whole && whole.arrow.step).toBe(2);
        const part = findDiagramTarget(FLOWCHART, 'Token');
        expect(part && 'arrow' in part && part.arrow.text).toBe('sends token');
        expect(findDiagramTarget(FLOWCHART, 'client')).toEqual({ node: FLOWCHART.querySelector('g.node') });
        expect(findDiagramTarget(FLOWCHART, 'nowhere')).toBeUndefined();
    });
});

describe('board links', () => {
    it('hands every link click to the host instead of following it', () => {
        const root = document.createElement('div');
        root.innerHTML = '<p><a href="src/shared/board.ts#L12"><code>board.ts</code></a> <a href="https://example.com/x">web</a> <a>no href</a></p>';
        document.body.append(root);
        const open = vi.fn();
        initLinks(root, open);
        const clicks = [...root.querySelectorAll('a, code')].map((el) => {
            const event = new MouseEvent('click', { bubbles: true, cancelable: true });
            el.dispatchEvent(event);
            return event.defaultPrevented;
        });
        expect(open.mock.calls).toEqual([['src/shared/board.ts#L12'], ['src/shared/board.ts#L12'], ['https://example.com/x']]);
        expect(clicks).toEqual([true, true, true, false]);
        root.remove();
    });
});
