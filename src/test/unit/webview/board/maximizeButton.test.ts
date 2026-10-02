// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoardClientMessage, BoardHostMessage } from '../../../../shared/board';

const posted = vi.hoisted(() => [] as BoardClientMessage[]);
vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: (m: BoardClientMessage) => posted.push(m) } }));
// Mermaid needs a real layout engine; this page draws no diagrams.
vi.mock('../../../../webview/board/diagrams', () => ({
    drawDiagram: async () => {},
    diagramFailure: () => undefined,
    redrawDiagram: async () => {},
    watchDiagramTheme: () => {},
}));

/** A host message, as the extension posts it; the page handles it in its queue. */
function fromHost(message: BoardHostMessage): void {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
}

/** The page's status reply to request `seq`. */
async function status(seq: number): Promise<Extract<BoardClientMessage, { type: 'status' }>> {
    fromHost({ type: 'status', seq });
    return vi.waitFor(() => {
        const reply = posted.find((m) => m.type === 'status' && m.seq === seq);
        if (reply?.type !== 'status') {
            throw new Error(`no status ${seq} yet`);
        }
        return reply;
    });
}

describe('board page: the Maximize / Restore button', () => {
    /** What the icon button says: its tooltip and accessible name, and whether it shows pressed. */
    const shown = () => [button.title, button.getAttribute('aria-label'), button.getAttribute('aria-pressed'), button.textContent];
    let button: HTMLButtonElement;

    beforeAll(async () => {
        document.body.innerHTML = '<div id="board-app"></div>';
        globalThis.ResizeObserver ??= class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as unknown as typeof ResizeObserver;
        // Loaded here, not imported at the top: the page builds itself into #board-app as it loads.
        await import('../../../../webview/board/main');
        button = document.querySelector<HTMLButtonElement>('.board-header .board-maximize')!;
    });

    it('sits in the header after the zoom and Edit source as an icon, and asks the host to toggle, without editing the source', () => {
        expect([...document.querySelectorAll('.board-header button')].map((b) => b.className)).toEqual(['board-zoom-out', 'board-zoom-reset', 'board-zoom-in', 'board-edit', 'board-maximize']);
        expect(button.querySelector('svg')).not.toBeNull();
        expect(shown()).toEqual(["Maximize: let this board's editor group fill the editor area", "Maximize: let this board's editor group fill the editor area", 'false', '']);
        posted.length = 0;
        button.click();
        expect(posted).toEqual([{ type: 'toggleMaximize' }]);
    });

    it('shows the Restore icon while the host says the board is maximized, and says so in its status', async () => {
        const maximizeIcon = button.innerHTML;
        fromHost({ type: 'maximized', maximized: true });
        await vi.waitFor(() => expect(shown()).toEqual(['Restore: show the other editor groups again', 'Restore: show the other editor groups again', 'true', '']));
        expect(button.innerHTML).not.toBe(maximizeIcon);
        expect((await status(1)).maximized).toBe(true);
        posted.length = 0;
        button.click();
        expect(posted).toEqual([{ type: 'toggleMaximize' }]);

        fromHost({ type: 'maximized', maximized: false });
        await vi.waitFor(() => expect([shown()[2], button.innerHTML]).toEqual(['false', maximizeIcon]));
        expect((await status(2)).maximized).toBe(false);
    });
});
