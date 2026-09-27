const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/**
 * Escape text for interpolation into HTML: element content (including `<textarea>`)
 * and single- or double-quoted attribute values. Escapes `&`, `<`, `>`, `"` and `'`.
 */
export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}
