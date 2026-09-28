/**
 * The text of a Bot view message as it is read aloud and translated. Pure; shared by the extension
 * host and the Bot view.
 */

/** A code anchor the voice model writes (`⟦path:12-20⟧`, codeAnchors.ts), with the spaces before it. */
const ANCHOR = /[ \t]*⟦[^⟦⟧\n]{1,300}⟧/g;
const SILENT = /<silent\s*\/>/g;

/** Fenced blocks (an unclosed fence runs to the end) and inline code: never translated. */
export const CODE_SPAN = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;

/** The message without code anchors or the `<silent/>` marker: what is read aloud and translated. */
export function messagePlainText(text: string): string {
    return text.replace(ANCHOR, '').replace(SILENT, '').trim();
}

/** Anchors and `<silent/>` blanked out with spaces: offsets into the result are offsets into `text`. */
export function blankUnspoken(text: string): string {
    return text.replace(ANCHOR, (m) => ' '.repeat(m.length)).replace(SILENT, (m) => ' '.repeat(m.length));
}
