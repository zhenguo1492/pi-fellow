/** Tool name → renderer. Unknown tools get the generic args + result card. */
import { astEditRenderer, astGrepRenderer } from './ast';
import { bashRenderer } from './bash';
import { editRenderer } from './edit';
import { lspRenderer } from './lsp';
import { output, resultImages, resultText } from './parts';
import { readRenderer } from './read';
import { globRenderer, grepRenderer } from './search';
import { taskRenderer, todoRenderer } from './task';
import type { ToolRenderer } from './types';
import { argsDigest } from './util';
import { fetchRenderer, webSearchRenderer } from './web';
import { writeRenderer } from './write';

export const genericRenderer: ToolRenderer = {
    summary({ args }) {
        return [argsDigest(args)];
    },

    body({ args, result }) {
        let argText: string;
        try {
            argText = JSON.stringify(args, null, 2) ?? '';
        } catch {
            argText = String(args);
        }
        return [
            argText !== '{}' && output(argText, { lang: 'json', variant: 'code', maxLines: 12, title: 'args' }),
            resultImages(result),
            resultText(result, { maxLines: 10 }),
        ];
    },
};

const RENDERERS: Record<string, ToolRenderer> = {
    bash: bashRenderer,
    read: readRenderer,
    edit: editRenderer,
    apply_patch: editRenderer,
    write: writeRenderer,
    grep: grepRenderer,
    search: grepRenderer,
    glob: globRenderer,
    find: globRenderer,
    ast_grep: astGrepRenderer,
    ast_edit: astEditRenderer,
    lsp: lspRenderer,
    fetch: fetchRenderer,
    web_search: webSearchRenderer,
    task: taskRenderer,
    todo: todoRenderer,
};

export function resolveToolRenderer(name: string): ToolRenderer {
    return RENDERERS[name] ?? genericRenderer;
}
