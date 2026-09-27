import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: vi.fn() } }));

import { renderDiffLines } from '../../../../webview/chat/diffCard';

describe('renderDiffLines', () => {
    it('drops ---/+++ file headers and classifies hunk, add, del, and context lines', () => {
        const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n');
        expect(renderDiffLines(diff)).toBe(
            '<div class="diff-line diff-line-hunk">@@ -1,2 +1,2 @@</div>'
            + '<div class="diff-line diff-line-ctx"> keep</div>'
            + '<div class="diff-line diff-line-del">-old</div>'
            + '<div class="diff-line diff-line-add">+new</div>',
        );
    });

    it('treats --/++ lines without a trailing space as del/add, not headers', () => {
        expect(renderDiffLines('---x\n+++y')).toBe(
            '<div class="diff-line diff-line-del">---x</div><div class="diff-line diff-line-add">+++y</div>',
        );
    });

    it('escapes line content', () => {
        expect(renderDiffLines('+<b>&</b>')).toBe('<div class="diff-line diff-line-add">+&lt;b&gt;&amp;&lt;/b&gt;</div>');
    });

    it('renders empty lines as context', () => {
        expect(renderDiffLines('')).toBe('<div class="diff-line diff-line-ctx"></div>');
    });
});
