import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Which editors and preview commands can show a file, found in the installed extensions' manifests
 * (`vscode.extensions.all`), so the voice agent can open diagrams and previews without knowing any
 * extension by name, and how a picked preview command is run without hanging on it. No `vscode`
 * import: PairHands passes the extensions and VS Code's command runner in.
 *
 * Custom editors are opened the same way whoever contributes them (`vscode.openWith`), so every
 * extension's are offered. Preview commands are not: each extension expects its own arguments and
 * state, and third-party ones proved unreliable (MermaidChart's did nothing, or never returned).
 * So only VS Code's built-in extensions' preview commands, such as the Markdown preview, are
 * offered unless the user turns on the discoverPreviewCommands setting.
 */

/** The part of a `vscode.Extension` read here. */
export interface ExtensionManifest {
    id: string;
    packageJSON: unknown;
    /** Shipped with VS Code, like the Markdown preview, rather than installed. */
    builtin: boolean;
}

export interface ViewerOptions {
    /** Also offer preview commands of installed (third-party) extensions. */
    thirdPartyCommands: boolean;
}

export interface Viewer {
    /** A custom editor's viewType, or a command id. */
    id: string;
    kind: 'editor' | 'command';
    label: string;
    /** Id of the extension that contributes it, or `built-in`. */
    extension: string;
    /** A custom editor's priority for text files: default, option or builtin. */
    priority?: string;
}

export interface FileViewers {
    /** Workspace-relative, for messages. */
    path: string;
    languageId: string | undefined;
    editors: Viewer[];
    commands: Viewer[];
}

/** VS Code's own text editor; `vscode.openWith` takes it as `default`. */
export const TEXT_EDITOR: Viewer = { id: 'default', kind: 'editor', label: 'Text Editor', extension: 'built-in' };

/** Preview commands listed at most; the rest are noise for a voice model. */
const MAX_COMMANDS = 8;
/** The editor title bar: a command there is the file's main preview. */
const TITLE_MENUS: Record<string, true> = { 'editor/title': true, 'editor/title/context': true };
/** Custom editor priorities, in the order they are listed. */
const PRIORITY_ORDER: Record<string, number> = { default: 0, builtin: 1, option: 2 };

/**
 * Whether a custom editor selector's `filenamePattern` matches `filePath`, as VS Code matches it:
 * against the file name, or the whole path when the pattern has a `/`; case-insensitive.
 */
export function matchesFilenamePattern(pattern: string, filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const target = pattern.includes('/') ? normalized : path.posix.basename(normalized);
    return globToRegExp(pattern.toLowerCase()).test(target.toLowerCase());
}

/** The language VS Code would give `filePath` from the extensions' `contributes.languages`, by name, pattern, then longest extension. */
export function languageOf(extensions: readonly ExtensionManifest[], filePath: string): string | undefined {
    const name = path.posix.basename(filePath.replace(/\\/g, '/')).toLowerCase();
    let best: { id: string; score: number } | undefined;
    for (const extension of extensions) {
        for (const language of arrayAt(valueAt(extension.packageJSON, 'contributes'), 'languages')) {
            const id = stringAt(language, 'id');
            const score = languageScore(language, name);
            if (id && score > 0 && (!best || score > best.score)) {
                best = { id, score };
            }
        }
    }
    return best?.id;
}

/** How well a `contributes.languages` entry claims file name `name` (lower case): 0 not at all. */
function languageScore(language: unknown, name: string): number {
    if (arrayAt(language, 'filenames').some((f) => typeof f === 'string' && f.toLowerCase() === name)) {
        return 3000;
    }
    if (arrayAt(language, 'filenamePatterns').some((p) => typeof p === 'string' && matchesFilenamePattern(p, name))) {
        return 2000;
    }
    let score = 0;
    for (const ext of arrayAt(language, 'extensions')) {
        if (typeof ext === 'string' && ext && name.endsWith(ext.toLowerCase())) {
            score = Math.max(score, 1000 + ext.length);
        }
    }
    return score;
}

/**
 * The custom editors whose selector matches the file, then the text editor, and the commands with
 * "preview" in their name or title that the contributing extension offers for this file (see
 * commandRanks), best first; of commands with the same title only the best is kept. Commands come
 * from built-in extensions only, unless `options.thirdPartyCommands`.
 */
export function findViewers(
    extensions: readonly ExtensionManifest[],
    filePath: string,
    languageId: string | undefined,
    options: ViewerOptions,
): Pick<FileViewers, 'editors' | 'commands'> {
    const editors: Viewer[] = [];
    const commands: Array<Viewer & { rank: number }> = [];
    const file = fileFacts(filePath, languageId);
    const name = file.filename.toLowerCase();
    for (const extension of extensions) {
        const contributed = valueAt(extension.packageJSON, 'contributes');
        let editsFile = false;
        for (const editor of arrayAt(contributed, 'customEditors')) {
            const viewType = stringAt(editor, 'viewType');
            if (!viewType || !selectorMatches(arrayAt(editor, 'selector'), filePath)) {
                continue;
            }
            editsFile = true;
            if (editors.some((e) => e.id === viewType)) {
                continue;
            }
            const priority = valueAt(editor, 'priority');
            editors.push({
                id: viewType,
                kind: 'editor',
                label: readableTitle(stringAt(editor, 'displayName')) ?? viewType,
                extension: extension.id,
                // A string, or per editor kind in VS Code's own manifests.
                priority: typeof priority === 'string' ? priority : stringAt(priority, 'textEditor'),
            });
        }
        if (!extension.builtin && !options.thirdPartyCommands) {
            continue;
        }
        const forFile =
            editsFile ||
            arrayAt(contributed, 'languages').some((l) => (languageId !== undefined && stringAt(l, 'id') === languageId) || languageScore(l, name) > 0);
        const ranks = commandRanks(contributed, file, forFile);
        for (const command of arrayAt(contributed, 'commands')) {
            const id = stringAt(command, 'command');
            const rank = id === undefined ? undefined : ranks.get(id);
            if (!id || rank === undefined || id.startsWith('_') || commands.some((c) => c.id === id)) {
                continue;
            }
            const title = readableTitle(stringAt(command, 'title'));
            // A word of the command's own name or title: not its prefix (`imagePreview.reopenAsText`), nor inside one (`appReview`).
            const words = `${id.slice(id.lastIndexOf('.') + 1)} ${title ?? ''}`.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
            if (!words.some((word) => word.startsWith('preview'))) {
                continue;
            }
            const category = readableTitle(stringAt(command, 'category'));
            const label = title ? (category ? `${category}: ${title}` : title) : id;
            commands.push({ id, kind: 'command', label, extension: extension.id, rank });
        }
    }
    // Extensions' defaults for the file, then VS Code's built-in ones, then those offered as an option.
    editors.sort((a, b) => (PRIORITY_ORDER[a.priority ?? ''] ?? 1) - (PRIORITY_ORDER[b.priority ?? ''] ?? 1));
    editors.push(TEXT_EDITOR);
    commands.sort((a, b) => a.rank - b.rank);
    // Same title, same preview: a right-click variant would only tempt the model into the weaker one.
    const best = commands.filter((c, i) => commands.findIndex((o) => o.label.toLowerCase() === c.label.toLowerCase()) === i);
    return { editors, commands: best.slice(0, MAX_COMMANDS).map(({ rank: _, ...viewer }) => viewer) };
}

/** list_viewers' answer: compact, one viewer per line, ids first since open_with takes them. */
export function formatViewers(viewers: FileViewers): string {
    const line = (v: Viewer) => `- ${v.id}: ${v.label} [${v.extension}${v.priority ? `, ${v.priority}` : ''}]`;
    return [
        `${viewers.path}${viewers.languageId ? ` (language ${viewers.languageId})` : ''}`,
        'Editors:',
        ...viewers.editors.map(line),
        viewers.commands.length > 0 ? 'Preview commands:' : 'Preview commands: none',
        ...viewers.commands.map(line),
        'Open one with open_with, passing its id as viewer.',
    ].join('\n');
}

export type Settled<T> = { status: 'done'; value: T } | { status: 'failed'; error: unknown } | { status: 'timeout' };

/** How `work` ended within `ms`, or `timeout` while it keeps going: an extension's command may never return. */
export async function settleWithin<T>(work: PromiseLike<T>, ms: number): Promise<Settled<T>> {
    const timeout: Settled<T> = { status: 'timeout' };
    const stop = new AbortController();
    try {
        return await Promise.race([
            Promise.resolve(work).then(
                (value): Settled<T> => ({ status: 'done', value }),
                (error: unknown): Settled<T> => ({ status: 'failed', error }),
            ),
            // Aborted once the race is decided; that rejection goes nowhere.
            sleep(ms, timeout, { signal: stop.signal }).catch(() => timeout),
        ]);
    } finally {
        stop.abort();
    }
}

export type PreviewRun = { status: 'shown'; withUri: boolean } | { status: 'unchanged' } | { status: 'timeout' } | { status: 'failed'; error: string };

/**
 * Runs a preview command while the file is the active editor: first with its uri, then, if that
 * throws or shows nothing new, with no arguments, as its menu or the palette runs it, since many
 * act on the active editor only. Each call gets `timeoutMs`; one still running then is left
 * running and not called again, so the user never gets two previews.
 */
export async function runPreviewCommand(
    execute: (...args: unknown[]) => PromiseLike<unknown>,
    uri: unknown,
    /** Whether a new editor or panel appeared since before the first call. */
    showedSomething: () => Promise<boolean>,
    timeoutMs: number,
): Promise<PreviewRun> {
    let failure: unknown;
    let ranCleanly = false;
    for (const args of [[uri], []]) {
        // A synchronous throw is a failure too.
        const run = await settleWithin(Promise.resolve().then(() => execute(...args)), timeoutMs);
        if (run.status === 'timeout') {
            return { status: 'timeout' };
        }
        if (run.status === 'failed') {
            failure ??= run.error;
            continue;
        }
        ranCleanly = true;
        if (await showedSomething()) {
            return { status: 'shown', withUri: args.length > 0 };
        }
    }
    return ranCleanly ? { status: 'unchanged' } : { status: 'failed', error: failure instanceof Error ? failure.message : String(failure) };
}

function selectorMatches(selectors: unknown[], filePath: string): boolean {
    return selectors.some((selector) => {
        const pattern = stringAt(selector, 'filenamePattern');
        const exclude = stringAt(selector, 'excludeFileNamePattern');
        return pattern !== undefined && matchesFilenamePattern(pattern, filePath) && !(exclude && matchesFilenamePattern(exclude, filePath));
    });
}

/**
 * How the extension offers each of its commands for this file, lower first: 0 on the editor title
 * bar, 1 in the command palette, 2 only in a context menu or elsewhere; absent when not for this
 * file. A command no command palette `when` restricts shows in the palette for every file, so it
 * counts as 1 when the extension is `forFile` (it contributes the file's language or an editor for
 * it). Commands the palette hides (`when: false`) or whose id names a context menu are right-click
 * variants of another command: 2 more.
 */
function commandRanks(contributed: unknown, file: FileFacts, forFile: boolean): Map<string, number> {
    const ranks = new Map<string, number>();
    const restricted = new Set<string>();
    const hidden = new Set<string>();
    const menus = valueAt(contributed, 'menus');
    for (const [menu, entries] of Object.entries(menus && typeof menus === 'object' ? menus : {})) {
        if (!Array.isArray(entries)) {
            continue;
        }
        const rank = Object.hasOwn(TITLE_MENUS, menu) ? 0 : menu === 'commandPalette' ? 1 : 2;
        for (const entry of entries) {
            const when = stringAt(entry, 'when');
            // The alternative command (Alt+click) shows under the same condition.
            const ids = [stringAt(entry, 'command'), stringAt(entry, 'alt')].filter((id): id is string => id !== undefined);
            if (menu === 'commandPalette' && when !== undefined) {
                for (const id of ids) {
                    restricted.add(id);
                    if (when.trim() === 'false') {
                        hidden.add(id);
                    }
                }
            }
            if (!when || !whenMatchesFile(when, file)) {
                continue;
            }
            for (const id of ids) {
                if ((ranks.get(id) ?? Infinity) > rank) {
                    ranks.set(id, rank);
                }
            }
        }
    }
    if (forFile) {
        for (const command of arrayAt(contributed, 'commands')) {
            const id = stringAt(command, 'command');
            if (id && !restricted.has(id) && (ranks.get(id) ?? Infinity) > 1) {
                ranks.set(id, 1);
            }
        }
    }
    for (const [id, rank] of ranks) {
        if (hidden.has(id) || /contextmenu/i.test(id)) {
            ranks.set(id, rank + 2);
        }
    }
    return ranks;
}

interface FileFacts {
    languageId: string | undefined;
    extname: string;
    filename: string;
    path: string;
}

function fileFacts(filePath: string, languageId: string | undefined): FileFacts {
    const normalized = filePath.replace(/\\/g, '/');
    return { languageId, extname: path.posix.extname(normalized), filename: path.posix.basename(normalized), path: filePath };
}

/** The context keys a menu uses to say which files it is for, as VS Code sets them for this file. */
function fileKey(key: string, file: FileFacts): string | undefined | null {
    switch (key) {
        case 'resourceLangId':
        case 'editorLangId':
            return file.languageId;
        case 'resourceExtname':
            return file.extname;
        case 'resourceFilename':
            return file.filename;
        case 'resourcePath':
            return file.path;
        default:
            return null;
    }
}

/**
 * Whether a `when` clause is meant for this file: it tests the file's language, extension or name
 * and passes, and nothing it says about the file fails. Other context keys (focus, views, settings)
 * are unknown here and neither pass nor fail it. Three-valued: undefined is unknown.
 */
function whenMatchesFile(when: string, facts: FileFacts): boolean {
    let tokens: string[] = [];
    let i = 0;
    let hit = false;
    const peek = () => tokens[i];
    const next = () => tokens[i++];
    const parseOr = (): boolean | undefined => {
        let value = parseAnd();
        while (peek() === '||') {
            next();
            const right = parseAnd();
            value = value === true || right === true ? true : value === false && right === false ? false : undefined;
        }
        return value;
    };
    const parseAnd = (): boolean | undefined => {
        let value = parseUnary();
        while (peek() === '&&') {
            next();
            const right = parseUnary();
            value = value === false || right === false ? false : value === true && right === true ? true : undefined;
        }
        return value;
    };
    const parseUnary = (): boolean | undefined => {
        const token = next();
        if (token === '!') {
            const value = parseUnary();
            return value === undefined ? undefined : !value;
        }
        if (token === '(') {
            const value = parseOr();
            if (next() !== ')') {
                throw new Error('unbalanced');
            }
            return value;
        }
        if (token === undefined || Object.hasOwn(OPERATORS, token)) {
            throw new Error('unexpected');
        }
        const op = peek();
        if (op === 'in' || (op === 'not' && tokens[i + 1] === 'in')) {
            i += op === 'in' ? 2 : 3;
            return undefined;
        }
        if (!op || !Object.hasOwn(COMPARISONS, op)) {
            return token === 'true' ? true : token === 'false' ? false : undefined;
        }
        next();
        const raw = next();
        if (raw === undefined) {
            throw new Error('missing value');
        }
        const actual = fileKey(token, facts);
        if (actual === null || actual === undefined) {
            return undefined;
        }
        let result: boolean | undefined;
        if (op === '=~') {
            const regex = parseRegex(raw);
            result = regex ? regex.test(actual) : undefined;
        } else if (op === '==' || op === '===' || op === '!=' || op === '!==') {
            const expected = /^(['"]).*\1$/s.test(raw) ? raw.slice(1, -1) : raw;
            result = op.startsWith('=') ? actual === expected : actual !== expected;
        }
        // `==`, `===` and `=~` say what the clause is for; `!=` passing says nothing.
        if (result === true && op.startsWith('=')) {
            hit = true;
        }
        return result;
    };
    try {
        tokens = tokenize(when);
        const value = parseOr();
        return i === tokens.length && value !== false && hit;
    } catch {
        return false;
    }
}

const COMPARISONS: Record<string, true> = { '==': true, '===': true, '!=': true, '!==': true, '=~': true, '<': true, '<=': true, '>': true, '>=': true };
const OPERATORS: Record<string, true> = { ...COMPARISONS, '&&': true, '||': true, '!': true, '(': true, ')': true };

/** Splits a when clause into operators, words, quoted strings, and the regex literal after `=~`. */
function tokenize(when: string): string[] {
    const tokens: string[] = [];
    let i = 0;
    while (i < when.length) {
        const c = when[i];
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        const three = when.slice(i, i + 3);
        const two = when.slice(i, i + 2);
        if (three === '===' || three === '!==') {
            tokens.push(three);
            i += 3;
        } else if (['&&', '||', '==', '!=', '=~', '<=', '>='].includes(two)) {
            tokens.push(two);
            i += 2;
            if (two === '=~') {
                while (/\s/.test(when[i] ?? '')) {
                    i++;
                }
                if (when[i] === '/') {
                    let j = i + 1;
                    while (j < when.length && when[j] !== '/') {
                        j += when[j] === '\\' ? 2 : 1;
                    }
                    j++;
                    while (/[a-z]/i.test(when[j] ?? '')) {
                        j++;
                    }
                    tokens.push(when.slice(i, j));
                    i = j;
                }
            }
        } else if ('!()<>'.includes(c)) {
            tokens.push(c);
            i++;
        } else if (c === "'" || c === '"') {
            const end = when.indexOf(c, i + 1);
            if (end < 0) {
                throw new Error('unterminated string');
            }
            tokens.push(when.slice(i, end + 1));
            i = end + 1;
        } else {
            let j = i;
            while (j < when.length && !/[\s!()<>=&|'"]/.test(when[j])) {
                j++;
            }
            if (j === i) {
                throw new Error(`unexpected ${c}`);
            }
            tokens.push(when.slice(i, j));
            i = j;
        }
    }
    return tokens;
}

function parseRegex(raw: string): RegExp | undefined {
    const match = /^\/(.*)\/([a-z]*)$/is.exec(raw);
    try {
        return match ? new RegExp(match[1], match[2].replace(/[gy]/g, '')) : undefined;
    } catch {
        return undefined;
    }
}

/** A glob as VS Code writes them: `*`, `?`, `**`, `{a,b}` and `[...]`. */
function globToRegExp(glob: string): RegExp {
    let re = '';
    let braces = 0;
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                i++;
                if (glob[i + 1] === '/') {
                    i++;
                    re += '(?:.*/)?';
                } else {
                    re += '.*';
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '{') {
            braces++;
            re += '(?:';
        } else if (c === '}' && braces > 0) {
            braces--;
            re += ')';
        } else if (c === ',' && braces > 0) {
            re += '|';
        } else if (c === '[' && glob.indexOf(']', i + 2) > 0) {
            const end = glob.indexOf(']', i + 2);
            const body = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
            re += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
            i = end;
        } else {
            re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
    }
    try {
        return new RegExp(`^${re}$`);
    } catch {
        return /$^/;
    }
}

/** An untranslated `%key%` placeholder says nothing to the model. */
function readableTitle(title: string | undefined): string | undefined {
    return title && !/^%.*%$/.test(title) ? title : undefined;
}

function valueAt(value: unknown, key: string): unknown {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function arrayAt(value: unknown, key: string): unknown[] {
    const found = valueAt(value, key);
    return Array.isArray(found) ? found : [];
}

function stringAt(value: unknown, key: string): string | undefined {
    const found = valueAt(value, key);
    return typeof found === 'string' ? found : undefined;
}
