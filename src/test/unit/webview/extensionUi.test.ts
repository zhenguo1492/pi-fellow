// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscode = vi.hoisted(() => ({ postMessage: vi.fn() }));
const focusTui = vi.fn();
vi.mock('../../../webview/vscodeApi', () => ({ vscode }));

import { dismissExtensionUi, initExtensionUiHost, showExtensionUiRequest } from '../../../webview/extensionUi';

const host = () => document.getElementById('extension-ui-host')!;
let seq = 0;

beforeEach(() => {
    // jsdom does not lay out.
    Element.prototype.scrollIntoView = () => undefined;
    document.body.innerHTML = '<div class="tui-host"><textarea id="term"></textarea></div><div id="extension-ui-host" style="display:none"></div>';
    initExtensionUiHost({ focusTui });
    focusTui.mockClear();
    vscode.postMessage.mockClear();
});

/** Each test answers or dismisses its card: the queue is module state. */
const show = showExtensionUiRequest;

describe('the shared dialog cards', () => {
    it("shows a select's detail lines, such as the command a tool approval would run, and answers by option", () => {
        const id = `c${++seq}`;
        show({ id, method: 'select', title: 'Allow tool: bash', message: 'Command: rm -rf out', options: ['Approve', 'Deny'] });
        expect(host().querySelector('.extension-ui-message')?.textContent).toBe('Command: rm -rf out');
        host().querySelector<HTMLElement>('[data-extension-ui-option="Deny"]')!.click();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'extensionUiResponse', id, value: 'Deny' });
        expect(host().innerHTML).toBe('');
    });

    it('shows a TUI screen card as text, escaped, with a button that shows that tab\'s terminal and no answer', () => {
        const id = `c${++seq}`;
        show({ id, method: 'screen', tabId: 'tab-2', title: 'Ask', message: '╭─ Ask ─╮\n│ <b>Which?</b> │' });
        expect(host().querySelector('.extension-ui-screen')?.textContent).toBe('╭─ Ask ─╮\n│ <b>Which?</b> │');
        expect(host().querySelector('.extension-ui-screen b')).toBeNull();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(vscode.postMessage).not.toHaveBeenCalled();
        host().querySelector<HTMLElement>('[data-extension-ui-show-tui]')!.click();
        expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'showTui', tabId: 'tab-2' });
        // Keys go to the TUI without clicking into it first; the button does not keep the focus itself.
        expect(focusTui).toHaveBeenCalledExactlyOnceWith('tab-2');
        const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        host().querySelector<HTMLElement>('[data-extension-ui-show-tui]')!.dispatchEvent(press);
        expect(press.defaultPrevented).toBe(true);
        dismissExtensionUi(id);
    });

    it("leaves the keys typed into a TUI's terminal to the TUI, and keeps the terminal's focus", () => {
        const term = document.getElementById('term') as HTMLTextAreaElement;
        term.focus();
        const id = `c${++seq}`;
        show({ id, method: 'select', title: 'Pick', options: ['A', 'B'] });
        expect(document.activeElement).toBe(term);
        term.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
        term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(vscode.postMessage).not.toHaveBeenCalled();
        // Outside the terminal the card's keys work.
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
        expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'extensionUiResponse', id, value: 'B' });
    });
});
