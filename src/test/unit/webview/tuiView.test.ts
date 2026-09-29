// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** xterm stood in for: its keyboard focus is a textarea inside the pane, as the real one's is. */
vi.mock('@xterm/xterm', () => ({
    Terminal: class {
        options: Record<string, unknown> = {};
        private _textarea: HTMLTextAreaElement | undefined;
        open(el: HTMLElement): void {
            this._textarea = document.createElement('textarea');
            el.appendChild(this._textarea);
        }
        loadAddon(): void {}
        onData(): void {}
        write(): void {}
        reset(): void {}
        dispose(): void {}
        focus(): void {
            this._textarea?.focus();
        }
    },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss(): void {} } }));
vi.mock('../../../webview/vscodeApi', () => ({ vscode: { postMessage: vi.fn() } }));
// jsdom has no ResizeObserver, which tuiView sets up as it loads; frames run at once here.
vi.hoisted(() => {
    Object.assign(globalThis, {
        ResizeObserver: class {
            observe(): void {}
        },
        requestAnimationFrame: (callback: () => void) => {
            callback();
            return 0;
        },
    });
});

import { focusTui, getTuiHost, syncTuiView } from '../../../webview/tuiView';

const terminal = (tabId: string) => getTuiHost().querySelectorAll<HTMLTextAreaElement>('.tui-pane textarea')[['tab-1', 'tab-2'].indexOf(tabId)];

beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div><textarea id="input"></textarea>';
    document.getElementById('app')!.appendChild(getTuiHost());
});

describe('tuiView focus', () => {
    it('focuses the terminal it shows, and hands focus to the composer when the Bot view covers it', () => {
        syncTuiView(['tab-1'], 'tab-1', true);
        expect(document.activeElement).toBe(terminal('tab-1'));
        syncTuiView(['tab-1'], 'tab-1', false);
        expect(document.activeElement).toBe(document.getElementById('input'));
    });

    it("focuses a tab's terminal on request only while it is the one shown", () => {
        syncTuiView(['tab-1', 'tab-2'], 'tab-1', true);
        syncTuiView(['tab-1', 'tab-2'], 'tab-2', true);
        document.getElementById('input')!.focus();
        focusTui('tab-1');
        expect(document.activeElement).toBe(document.getElementById('input'));
        focusTui('tab-2');
        expect(document.activeElement).toBe(terminal('tab-2'));

        syncTuiView(['tab-1', 'tab-2'], 'tab-2', false);
        focusTui('tab-2');
        expect(document.activeElement).toBe(document.getElementById('input'));
    });
});
