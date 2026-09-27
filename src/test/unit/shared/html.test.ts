import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../../shared/html';

describe('escapeHtml', () => {
    it('escapes &, <, >, " and \' for element content and quoted attributes', () => {
        expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    });

    it('escapes existing entities once instead of passing them through', () => {
        expect(escapeHtml('&lt;&quot;')).toBe('&amp;lt;&amp;quot;');
    });
});
