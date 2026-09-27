import { beforeEach, describe, it, expect } from 'vitest';
import { renderMarkdown, renderStreamingMarkdown, resetCodeBlockIds } from '../../../../webview/chat/markdown';

function codeBlockIds(html: string): string[] {
    return [...html.matchAll(/<pre class="code-block-pre" id="([^"]+)"/g)].map((m) => m[1]);
}

describe('renderMarkdown', () => {
    beforeEach(() => {
        resetCodeBlockIds();
    });

    it('returns empty string for empty input', () => {
        expect(renderMarkdown('')).toBe('');
        expect(renderStreamingMarkdown('')).toBe('');
    });

    it('wraps fenced code with an escaped language label and escaped code', () => {
        const html = renderMarkdown('```a<b>\nif (x < 1 && y > 2) {}\n```');
        expect(html).toContain('<div class="code-block-wrapper">');
        expect(html).toContain('<span class="code-lang">a&lt;b&gt;</span>');
        expect(html).toContain('<code class="code-block-code">if (x &lt; 1 &amp;&amp; y &gt; 2) {}</code>');
        expect(html).toContain('<button class="copy-btn" data-code-id="cb-1">Copy</button>');
    });

    it('omits the language label when the fence has no language', () => {
        expect(renderMarkdown('```\nplain\n```')).not.toContain('code-lang');
    });

    it('numbers code blocks increasingly across renders until reset', () => {
        expect(codeBlockIds(renderMarkdown('```\na\n```\n\n```\nb\n```'))).toEqual(['cb-1', 'cb-2']);
        expect(codeBlockIds(renderMarkdown('```\nc\n```'))).toEqual(['cb-3']);
        resetCodeBlockIds();
        expect(codeBlockIds(renderMarkdown('```\nd\n```'))).toEqual(['cb-1']);
    });

    it('renders inline code as a bare <code> without consuming a code-block id', () => {
        expect(renderMarkdown('use `foo_bar` here')).toBe('<p>use <code>foo_bar</code> here</p>\n');
        expect(codeBlockIds(renderMarkdown('```\nx\n```'))).toEqual(['cb-1']);
    });

    it('turns single newlines into line breaks', () => {
        expect(renderMarkdown('line1\nline2')).toBe('<p>line1<br>line2</p>\n');
    });
});

describe('renderStreamingMarkdown', () => {
    beforeEach(() => {
        resetCodeBlockIds();
    });

    it('closes an unterminated fence so the partial code renders as a code block', () => {
        const html = renderStreamingMarkdown('text\n```js\nconst x = 1;');
        expect(html).toContain('<span class="code-lang">js</span>');
        expect(html).toContain('<code class="code-block-code">const x = 1;</code>');
    });

    it('renders balanced fences exactly like renderMarkdown', () => {
        const text = 'intro\n```\ncode\n```\nafter';
        const streamed = renderStreamingMarkdown(text);
        resetCodeBlockIds();
        expect(streamed).toBe(renderMarkdown(text));
    });

    it('does not count inline triple backticks mid-line as a fence', () => {
        const text = 'see ```inline``` here';
        const streamed = renderStreamingMarkdown(text);
        resetCodeBlockIds();
        expect(streamed).toBe(renderMarkdown(text));
    });
});
