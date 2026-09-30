/**
 * The Bot view's cards for the voice agent's host tools (src/voiceAgent/hostTools.ts). Its own
 * lookups (read, grep, glob, web_search) are the worker's tools and use the registry's renderers.
 */
import { copyPlainText } from '../chat/toast';
import { bashRenderer } from './bash';
import { badges, codeBlock, diffBlock, h, invalidArg, note, output, pathText, resultText } from './parts';
import type { Child, ToolRenderer } from './types';
import { display, languageFromPath, normalizeWs, num, resultTextOf, str, truncate } from './util';

/** Longest argument shown whole in the header; longer or multi-line ones also go in the body. */
const SUMMARY_CHARS = 100;

/** The argument the header shows, first match wins; a call with none shows its result's first line. */
const PRIMARY_ARGS = ['path', 'command', 'message', 'question', 'value', 'text', 'source', 'mode', 'action', 'expression', 'configuration', 'terminal', 'description'];

/** Shown in the header with the path, as its line range. */
const PATH_LINE_ARGS: Record<string, true> = { startLine: true, endLine: true, line: true };

function primaryArg(args: Record<string, unknown>): string | undefined {
    return PRIMARY_ARGS.find((key) => str(args[key])?.trim());
}

function fitsSummary(text: string): boolean {
    return text.length <= SUMMARY_CHARS && !text.includes('\n');
}

/** Any host tool: its main argument in the header; the rest as badges or, when long, blocks; then the result. */
const hostToolRenderer: ToolRenderer = {
    summary({ args, result }) {
        const key = primaryArg(args);
        if (key === 'path') {
            return [pathText(str(args.path) ?? '', num(args.startLine) ?? num(args.line), num(args.endLine))];
        }
        const text = key ? (str(args[key]) ?? '') : (resultTextOf(result).trim().split('\n', 1)[0] ?? '');
        return [truncate(normalizeWs(text), SUMMARY_CHARS)];
    },

    body({ args, result }) {
        const key = primaryArg(args);
        const flags: string[] = [];
        const blocks: Child[] = [];
        for (const [name, value] of Object.entries(args)) {
            const text = display(value);
            if (!text || (key === 'path' && (name === 'path' || PATH_LINE_ARGS[name]))) continue;
            if (!fitsSummary(text)) blocks.push(output(text, { title: name, maxLines: 12 }));
            else if (name !== key) flags.push(`${name}=${text}`);
        }
        return [badges(flags), ...blocks, resultText(result, { maxLines: 14 })];
    },
};

/** The call only starts the job: the card shows its findings, in full, once it settles. */
const researchRenderer: ToolRenderer = {
    summary({ args }) {
        return [truncate(normalizeWs(str(args.question) ?? ''), SUMMARY_CHARS)];
    },

    body({ args, result, running }) {
        const question = str(args.question);
        return [
            question && !fitsSummary(question) && output(question, { title: 'question', maxLines: 12 }),
            running
                ? note(undefined, 'Researching in the background; the findings show here when it finishes.')
                : resultText(result, { title: result?.isError === true ? 'error' : 'findings', maxLines: Infinity }),
        ];
    },
};

/** Typed into the user's editor: oldText out, newText in. */
const editFileRenderer: ToolRenderer = {
    summary({ args }) {
        const path = str(args.path);
        return [path ? pathText(path) : invalidArg('path')];
    },

    body({ args, result }) {
        const rows = (text: string, sign: string) => (text ? text.split('\n').map((line) => sign + line) : []);
        const diff = [...rows(str(args.oldText) ?? '', '-'), ...rows(str(args.newText) ?? '', '+')];
        const nearLine = num(args.nearLine);
        return [badges([nearLine !== null && `near line ${nearLine}`]), diff.length > 0 && diffBlock(diff.join('\n')), resultText(result)];
    },
};

const createFileRenderer: ToolRenderer = {
    summary: editFileRenderer.summary,

    body({ args, result }) {
        const path = str(args.path) ?? '';
        return [codeBlock(str(args.content) ?? '', languageFromPath(path)), resultText(result)];
    },
};

/** Lines a show_text card shows before "more lines". */
const SHOWN_LINES = 40;

/** Text shown instead of spoken: open from the start, highlighted when it has a language, with a Copy button. */
const showTextRenderer: ToolRenderer = {
    summary({ args }) {
        const text = str(args.text) ?? '';
        const title = str(args.title)?.trim() || str(args.language)?.trim() || text.trim().split('\n', 1)[0];
        return [truncate(normalizeWs(title ?? ''), SUMMARY_CHARS)];
    },

    body({ args, result }) {
        const text = str(args.text) ?? '';
        const lang = str(args.language)?.trim() || null;
        let shown: HTMLElement | null = null;
        if (text) {
            shown = output(text, { lang, variant: lang ? 'code' : 'plain', maxLines: SHOWN_LINES });
            const copy = h('button', 'tv-copy', 'copy');
            copy.type = 'button';
            copy.title = 'Copy to the clipboard';
            copy.addEventListener('click', () => copyPlainText(text));
            shown.append(copy);
        }
        return [shown, result?.isError === true && resultText(result)];
    },
};

const RENDERERS: Record<string, ToolRenderer> = {
    research: researchRenderer,
    edit_file: editFileRenderer,
    create_file: createFileRenderer,
    run_in_terminal: bashRenderer,
    show_text: showTextRenderer,
};

export function voiceToolRenderer(name: string): ToolRenderer {
    return RENDERERS[name] ?? hostToolRenderer;
}
