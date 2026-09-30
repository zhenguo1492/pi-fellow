import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../../../..');
const stylesDir = join(root, 'src/webview/styles');

function walk(dir: string, ext: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'test' ? [] : walk(path, ext);
        return entry.name.endsWith(ext) ? [path] : [];
    });
}

const styles = walk(stylesDir, '.css').map((path) => ({
    name: relative(stylesDir, path),
    text: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
}));
const source = walk(join(root, 'src'), '.ts').map((path) => readFileSync(path, 'utf8')).join('\n');
const sourceWords = new Set(source.match(/[A-Za-z][\w-]*/g));

/** Selectors only: declaration blocks (and the values in them) removed, innermost first. */
function selectorText(css: string): string {
    let text = css.replace(/url\([^)]*\)/g, '');
    for (let prev = ''; prev !== text; ) {
        prev = text;
        text = text.replace(/\{[^{}]*\}/g, ';');
    }
    return text;
}

describe('webview stylesheets', () => {
    it('use only custom properties that are defined', () => {
        const defined = new Set(styles.flatMap((s) => [...s.text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])));
        // Set from script: element.style.setProperty('--x', …) or inline `style="--x: …"`.
        for (const m of source.matchAll(/['"`](--[\w-]+)['"`]|(--[\w-]+)\s*:/g)) defined.add(m[1] ?? m[2]);
        const undefinedVars = styles.flatMap((s) =>
            [...s.text.matchAll(/var\(\s*(--[\w-]+)/g)]
                .map((m) => m[1])
                .filter((name) => !name.startsWith('--vscode-') && !defined.has(name))
                .map((name) => `${s.name}: ${name}`),
        );
        expect(undefinedVars).toEqual([]);
    });

    it('style only classes the code renders', () => {
        // Classes built from a template, e.g. `tv-status--${status}`.
        const dynamicPrefixes = [...source.matchAll(/([a-z][\w-]*-)\$\{/g)].map((m) => m[1]);
        const external = [
            /^vscode-(light|dark|high-contrast|high-contrast-light)$/, // body classes VS Code sets
            /^hljs-/, // highlight.js tokens (toolCards/util.ts highlight())
        ];
        const unused = styles.flatMap((s) =>
            [...new Set([...selectorText(s.text).matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]))]
                .filter((cls) => !sourceWords.has(cls))
                .filter((cls) => !dynamicPrefixes.some((prefix) => cls.startsWith(prefix)))
                .filter((cls) => !external.some((re) => re.test(cls)))
                .map((cls) => `${s.name}: .${cls}`),
        );
        expect(unused).toEqual([]);
    });
});
