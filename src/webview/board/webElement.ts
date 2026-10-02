/**
 * What the board's script in a web page (web.ts) says about the element the user Alt+clicked. It runs
 * inside the page, put there as its source (`${describeElement}`): it must use nothing from outside
 * itself, `limits` included (WEB_ELEMENT_LIMITS, passed in).
 */
import type { BoardWebElement, WEB_ELEMENT_LIMITS } from '../../shared/board';

/**
 * `el` described: a CSS selector that finds it (from the nearest ancestor, or itself, whose id is
 * unique in the page, else from body: tag, its first three classes, and `:nth-of-type` where siblings
 * share the tag), its tag, id, classes, text and outerHTML, each cut to `limits`.
 */
export function describeElement(el: Element, limits: typeof WEB_ELEMENT_LIMITS): BoardWebElement {
    const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
    // A CSS identifier: anything but letters, digits, _, - and non-ASCII escaped; a leading digit by its code point.
    const ident = (name: string) =>
        name.replace(/[^\w\u00a0-\uffff-]/g, (c) => `\\${c}`).replace(/^(-?)(\d)/, (_all, dash: string, digit: string) => `${dash}\\3${digit} `);
    const doc = el.ownerDocument;
    const parts: string[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
        if (node.id && doc.querySelectorAll(`#${ident(node.id)}`).length === 1) {
            parts.unshift(`#${ident(node.id)}`);
            break;
        }
        if (node === doc.body || node === doc.documentElement) {
            parts.unshift(node.localName);
            break;
        }
        const tag = node.localName;
        const classes = [...node.classList].slice(0, 3).map((c) => `.${ident(c)}`).join('');
        const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.localName === tag) : [];
        parts.unshift(`${ident(tag)}${classes}${same.length > 1 ? `:nth-of-type(${same.indexOf(node) + 1})` : ''}`);
    }
    const classes = [...el.classList].slice(0, limits.classes).map((c) => cut(c, limits.className));
    const text = cut((el.textContent ?? '').replace(/\s+/g, ' ').trim(), limits.text);
    return {
        selector: cut(parts.join(' > '), limits.selector),
        tag: cut(el.localName, limits.tag),
        ...(el.id ? { id: cut(el.id, limits.id) } : {}),
        ...(classes.length ? { classes } : {}),
        ...(text ? { text } : {}),
        html: cut(el.outerHTML.replace(/\s+/g, ' '), limits.html),
    };
}
