import { escapeHtml } from '../../shared/html';
import { marked } from 'marked';

// ── Marked config ──

const renderer = new marked.Renderer();

let codeBlockId = 0;
renderer.code = function ({ text, lang }: { text: string; lang?: string | undefined }) {
    const id = `cb-${++codeBlockId}`;
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
    return `<div class="code-block-wrapper">
        <div class="code-block-header">${langLabel}<button class="copy-btn" data-code-id="${id}">Copy</button></div>
        <pre class="code-block-pre" id="${id}"><code class="code-block-code">${escapeHtml(text)}</code></pre>
    </div>`;
};

renderer.codespan = function ({ text }: { text: string }) {
    return `<code>${text}</code>`;
};

marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
});

/** Restart code-block element ids (`cb-1`, `cb-2`, …); call before re-rendering the whole transcript. */
export function resetCodeBlockIds(): void {
    codeBlockId = 0;
}

export function renderMarkdown(text: string): string {
    if (!text) return '';
    return marked.parse(text) as string;
}

/** Render partial streamed markdown, closing an unterminated code fence so it renders as code. */
export function renderStreamingMarkdown(text: string): string {
    if (!text) return '';
    const fenceMatches = text.match(/(?:^|\n)```/g);
    let patchedText = text;
    if (fenceMatches && fenceMatches.length % 2 !== 0) {
        patchedText = text + '\n```';
    }
    return renderMarkdown(patchedText);
}

export function bindCopyButtons(): void {
    document.querySelectorAll('.copy-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).dataset.codeId;
            if (!id) return;
            const codeEl = document.getElementById(id);
            if (!codeEl) return;
            navigator.clipboard.writeText(codeEl.textContent ?? '').then(() => {
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            });
        });
    });
}
