/**
 * Blackboards (docs/blackboard.md): the voice agent's boards as editor tabs. Each board is a Markdown
 * file in its voice context's board folder, drawn by one WebviewPanel (src/webview/board.ts); this
 * module keeps the folder's index, the panels, the agent's writes and points, the user's marks and
 * saved source edits.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    appendToBoard,
    defaultMarkStyle,
    describeBoardEdit,
    diagramType,
    formatOutline,
    parseBoard,
    parseBoardLink,
    parseBoardZoom,
    replaceBoardBlock,
    type BoardClientMessage,
    type BoardContextSource,
    type BoardEditNotice,
    type BoardHands,
    type BoardHostMessage,
    type BoardListing,
    type BoardMarkStyle,
    type BoardMoveTo,
    type BoardTarget,
    type BoardUserMark,
    type BoardUserMarkInfo,
    type BoardViewRequest,
    type BoardWriteRequest,
    type BoardZoom,
} from '../shared/board';
import { escapeHtml } from '../shared/html';
import type { Tokens } from 'marked';

const VIEW_TYPE = 'oh-my-pi-chater.board';
const INDEX_FILE = 'index.json';
/** The first render parses the whole board bundle (marked, highlight.js, Mermaid). */
const RENDER_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 3_000;
/** How long a moved board's tab may take to show up in its new group. */
const MOVE_SETTLE_MS = 2_000;

interface BoardEntry {
    id: string;
    title: string;
    /** Open when its context was last left; the user closing the tab clears it. */
    open: boolean;
    /** How the user zoomed its page, given back to the next page that shows it; absent: never zoomed. */
    zoom?: BoardZoom;
}

interface BoardIndex {
    current?: string;
    boards: BoardEntry[];
}

type BoardReply = Extract<BoardClientMessage, { seq: number }>;
type RenderErrors = Extract<BoardClientMessage, { type: 'rendered' }>['errors'];
/** none: open when closed, leave an open tab where it is. keep: open or reveal without the focus. take: with the focus. */
type Reveal = 'none' | 'keep' | 'take';

/** <dirname(sessionFile)>/boards/<basename(sessionFile, '.jsonl')> */
export function boardFolder(sessionFile: string): string {
    return path.join(path.dirname(sessionFile), 'boards', path.basename(sessionFile, '.jsonl'));
}

/** Removes <sessionDir>/boards/<name> folders whose <name>.jsonl is not in keptSessionFiles. */
export async function pruneBoardFolders(sessionDir: string, keptSessionFiles: readonly string[]): Promise<void> {
    const root = path.join(sessionDir, 'boards');
    const kept = new Set(keptSessionFiles.map((file) => path.resolve(file)));
    let names: string[];
    try {
        names = await fs.readdir(root);
    } catch {
        return;
    }
    await Promise.all(
        names
            .filter((name) => !kept.has(path.resolve(sessionDir, `${name}.jsonl`)))
            .map((name) => fs.rm(path.join(root, name), { recursive: true, force: true })),
    );
}

function boardFile(folder: string, id: string): string {
    return path.resolve(folder, `${id}.md`);
}

async function readBoard(file: string): Promise<string> {
    try {
        return await fs.readFile(file, 'utf8');
    } catch {
        return '';
    }
}

async function loadIndex(folder: string): Promise<BoardIndex> {
    try {
        const raw = JSON.parse(await fs.readFile(path.join(folder, INDEX_FILE), 'utf8')) as Partial<BoardIndex>;
        const boards = Array.isArray(raw.boards)
            ? raw.boards
                  .filter((b) => b && typeof b.id === 'string' && typeof b.title === 'string')
                  .map((b) => {
                      const zoom = parseBoardZoom(b.zoom);
                      return { id: b.id, title: b.title, open: b.open === true, ...(zoom ? { zoom } : {}) };
                  })
            : [];
        return typeof raw.current === 'string' ? { current: raw.current, boards } : { boards };
    } catch {
        return { boards: [] };
    }
}

function label(entry: { id: string; title: string }): string {
    return `Board ${entry.id} "${entry.title}"`;
}

function titleFromHeading(markdown: string): string | undefined {
    const heading = parseBoard(markdown).blocks.find((b) => b.kind === 'heading');
    const text = heading && (heading.token as Tokens.Heading).text.replace(/[*_`~]+/g, '').trim();
    return text ? text.slice(0, 80) : undefined;
}

/** `kind`: the block's, when known: lines in a diagram are message steps. */
function describeTarget(target: BoardTarget, kind?: string): string {
    if (target.startLine !== undefined) {
        const end = target.endLine ?? target.startLine;
        const unit = kind === 'diagram' ? 'step' : 'line';
        return end === target.startLine ? `${target.block} ${unit} ${target.startLine}` : `${target.block} ${unit}s ${target.startLine}-${end}`;
    }
    return target.text !== undefined ? `"${target.text}" in ${target.block}` : target.block;
}

/** Resolves once `ready()` holds, checked on every tab change, or after `ms` either way. */
function tabsSettled(ready: () => boolean, ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (ready()) {
        resolve();
        return promise;
    }
    const subscriptions: vscode.Disposable[] = [];
    const done = () => {
        clearTimeout(timer);
        subscriptions.forEach((s) => s.dispose());
        resolve();
    };
    const timer = setTimeout(done, ms);
    subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(() => ready() && done()),
        vscode.window.tabGroups.onDidChangeTabGroups(() => ready() && done()),
    );
    return promise;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * The board page. A web block's frame (src/webview/board/web.ts) is a srcdoc document, which inherits
 * this CSP: its scripts run with `frameNonce`, a nonce of their own, and it loads nothing else (no
 * network). srcdoc is not checked against frame-src, so frames need no source of their own.
 */
function boardHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'board.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'styles', 'board.css'));
    const nonce = getNonce();
    const frameNonce = getNonce();
    const csp = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${csp} 'unsafe-inline'; img-src ${csp} data: blob:; font-src ${csp} data:; script-src 'nonce-${nonce}' 'nonce-${frameNonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>${escapeHtml(title)}</title>
</head>
<body>
    <div id="board-app" data-frame-nonce="${frameNonce}"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** One board's tab: what it shows and the requests waiting for its webview's replies. */
class BoardPanel {
    /** The document the board shows: what we last wrote or the user last saved, so a save of our own text is no edit. */
    markdown: string;
    /** The user's mark and when it was made (Blackboards' clock). */
    mark: { mark: BoardUserMark; at: number } | undefined;
    /** Disposed by a context switch or shutdown, not by the user: the index keeps it open. */
    quiet = false;
    /** The zoom the user left its page at (kept by the host, since a new page starts at 100%). */
    zoom: BoardZoom | undefined;
    private ready = false;
    /** Its editor group is maximized: the page's header button reads Restore. */
    private maximized = false;
    private version = 0;
    private edited = false;
    private seq = 0;
    private queue: BoardHostMessage[] = [];
    private renders: { version: number; resolve: (errors: RenderErrors | undefined) => void }[] = [];
    private readonly requests = new Map<number, (reply: BoardReply | undefined) => void>();

    constructor(
        readonly panel: vscode.WebviewPanel,
        readonly folder: string,
        readonly id: string,
        public title: string,
        markdown: string,
    ) {
        this.markdown = markdown;
    }

    get file(): string {
        return boardFile(this.folder, this.id);
    }

    retitle(title: string): void {
        this.title = title;
        this.panel.title = `Board · ${title}`;
    }

    /** Sends the document; resolves with its diagram errors once drawn, undefined when the board did not confirm in time. */
    render(markdown: string, edited = false): Promise<RenderErrors | undefined> {
        this.markdown = markdown;
        this.edited = edited;
        const version = ++this.version;
        if (this.ready) {
            void this.panel.webview.postMessage(this.renderMessage());
        }
        const { promise, resolve } = Promise.withResolvers<RenderErrors | undefined>();
        const timer = setTimeout(() => {
            this.renders = this.renders.filter((r) => r.version !== version);
            resolve(undefined);
        }, RENDER_TIMEOUT_MS);
        this.renders.push({
            version,
            resolve: (errors) => {
                clearTimeout(timer);
                resolve(errors);
            },
        });
        return promise;
    }

    /** Resolves with the webview's reply, undefined when it did not answer in time or the tab closed. */
    request(build: (seq: number) => BoardHostMessage): Promise<BoardReply | undefined> {
        const seq = ++this.seq;
        // Before the webview is ready the reply also waits for the first load.
        const timeout = this.ready ? REQUEST_TIMEOUT_MS : RENDER_TIMEOUT_MS;
        const { promise, resolve } = Promise.withResolvers<BoardReply | undefined>();
        const timer = setTimeout(() => {
            this.requests.delete(seq);
            resolve(undefined);
        }, timeout);
        this.requests.set(seq, (reply) => {
            clearTimeout(timer);
            resolve(reply);
        });
        const message = build(seq);
        if (this.ready) {
            void this.panel.webview.postMessage(message);
        } else {
            this.queue.push(message);
        }
        return promise;
    }

    clearPoint(): void {
        // A webview that is not ready yet has no point to clear.
        if (this.ready) {
            void this.panel.webview.postMessage({ type: 'clearPoint' } satisfies BoardHostMessage);
        }
    }

    /** Keeps the page's Maximize / Restore button in step; a page not ready yet gets it with its first render. */
    showMaximized(maximized: boolean): void {
        this.maximized = maximized;
        if (this.ready) {
            void this.panel.webview.postMessage({ type: 'maximized', maximized } satisfies BoardHostMessage);
        }
    }

    receive(message: BoardClientMessage): void {
        switch (message.type) {
            case 'ready': {
                // Also after the webview was recreated (moved to another window): it starts blank.
                this.ready = true;
                void this.panel.webview.postMessage(this.renderMessage());
                if (this.maximized) {
                    void this.panel.webview.postMessage({ type: 'maximized', maximized: true } satisfies BoardHostMessage);
                }
                if (this.zoom) {
                    void this.panel.webview.postMessage({ type: 'zoom', zoom: this.zoom } satisfies BoardHostMessage);
                }
                const queued = this.queue;
                this.queue = [];
                for (const m of queued) {
                    void this.panel.webview.postMessage(m);
                }
                return;
            }
            case 'rendered': {
                const done = this.renders.filter((r) => r.version <= message.version);
                this.renders = this.renders.filter((r) => r.version > message.version);
                for (const r of done) {
                    r.resolve(message.errors);
                }
                return;
            }
            case 'pointed':
            case 'scrolled':
            case 'expanded':
            case 'clicked':
            case 'status': {
                const resolve = this.requests.get(message.seq);
                this.requests.delete(message.seq);
                resolve?.(message);
                return;
            }
        }
    }

    /** The tab closed: nothing more will answer, and nothing more is sent. */
    cancel(): void {
        this.ready = false;
        for (const r of this.renders) {
            r.resolve(undefined);
        }
        this.renders = [];
        for (const resolve of this.requests.values()) {
            resolve(undefined);
        }
        this.requests.clear();
    }

    private renderMessage(): BoardHostMessage {
        return { type: 'render', version: this.version, title: this.title, markdown: this.markdown, ...(this.edited ? { edited: true } : {}) };
    }
}

export class Blackboards implements BoardHands, BoardContextSource, vscode.Disposable {
    /** Open board tabs of any voice context, by board file. */
    private readonly panels = new Map<string, BoardPanel>();
    /** Board folder indexes, loaded once and kept authoritative in memory. */
    private readonly indexes = new Map<string, Promise<BoardIndex>>();
    private readonly indexWrites = new Map<string, Promise<void>>();
    private bound: { sessionFile: string; folder: string; index?: BoardIndex } | undefined;
    /** Saved source edits not yet handed to a turn; `before`: the board before the first of them. */
    private edits: { before: string; notice: BoardEditNotice }[] = [];
    /** Orders user marks against editor selections. */
    private clock = 0;
    private editorSelectionAt = 0;
    private disposing = false;
    /**
     * The board whose editor group this module maximized (its button or board_view), until restored,
     * moved, closed, or another group activated (VS Code then restores it itself). Change it only with
     * setMaximized, which keeps the boards' buttons in step.
     */
    private maximized: BoardPanel | undefined;
    private readonly disposables: vscode.Disposable[];

    constructor(
        private readonly options: {
            extensionUri: vscode.Uri;
            following: () => boolean;
            log: (line: string) => void;
            /** Web links on a board; default vscode.env.openExternal (tests record them instead). */
            openExternal?: (uri: vscode.Uri) => Thenable<boolean>;
        },
    ) {
        this.disposables = [
            vscode.workspace.onDidSaveTextDocument((doc) => this.sourceSaved(doc)),
            vscode.window.onDidChangeTextEditorSelection((e) => {
                if (e.textEditor.document.uri.scheme === 'file' && e.selections.some((s) => !s.isEmpty)) {
                    this.editorSelectionAt = ++this.clock;
                }
            }),
            // Activating another editor group ends a maximized one (VS Code restores it on its own).
            vscode.window.tabGroups.onDidChangeTabGroups(() => {
                if (this.maximized && vscode.window.tabGroups.activeTabGroup.viewColumn !== this.maximized.panel.viewColumn) {
                    this.setMaximized(undefined);
                }
            }),
        ];
    }

    /** Voice context whose boards the tools write/point at: its omp session file; boards live in boardFolder(sessionFile). reopen: reopen the boards that were open when it was last left. undefined: none bound. */
    async bindSession(sessionFile: string | undefined, reopen: boolean): Promise<void> {
        const folder = sessionFile === undefined ? undefined : boardFolder(sessionFile);
        if (this.bound?.folder !== folder) {
            const old = this.bound?.folder;
            for (const board of [...this.panels.values()]) {
                if (board.folder === old) {
                    board.quiet = true;
                    board.panel.dispose();
                }
            }
            this.edits = [];
            this.bound = sessionFile !== undefined && folder !== undefined ? { sessionFile, folder } : undefined;
        }
        if (folder === undefined) {
            return;
        }
        const index = await this.index(folder);
        const bound = this.bound;
        if (bound?.folder !== folder) {
            return;
        }
        bound.index = index;
        if (reopen) {
            for (const entry of index.boards.filter((b) => b.open)) {
                await this.show(folder, index, entry, 'none');
            }
        }
    }

    /** A speech marker: points when it can, logs when not; brings the board into view (without focus) only while following(). */
    pointAnchor(target: BoardTarget): void {
        this.pointAt(target, undefined, false).catch((err: unknown) =>
            this.options.log(`Board point ${target.board ?? ''}/${describeTarget(target)} failed: ${err instanceof Error ? err.message : String(err)}`),
        );
    }

    /** Clears Pi's point on every board (voice stop, the clearHighlight command). */
    clearPoint(): void {
        for (const board of this.panels.values()) {
            board.clearPoint();
        }
    }

    /** Bot view board card: opens board `id` of any voice context. */
    async openFromHistory(sessionFile: string, id: string): Promise<void> {
        const folder = boardFolder(sessionFile);
        const index = await this.index(folder);
        const entry = index.boards.find((b) => b.id === id);
        if (!entry) {
            throw new Error(`Board ${id} no longer exists.`);
        }
        await this.show(folder, index, entry, 'take');
        if (folder === this.bound?.folder) {
            await this.setCurrent(folder, index, id);
        }
    }

    // ── BoardHands ──

    async write(request: BoardWriteRequest): Promise<string> {
        const { folder, index } = await this.requireBound();
        const creating = request.board === 'new' || (request.board === undefined && !index.boards.some((b) => b.id === index.current));
        if (creating && request.mode === 'block') {
            throw new Error('Mode block rewrites a block of an existing board; name the board or use append.');
        }
        // Ids are never reused: boards are never dropped from the index.
        const newId = `b${Math.max(0, ...index.boards.map((b) => Number(b.id.slice(1)) || 0)) + 1}`;
        const entry = creating ? { id: newId, title: '', open: true } : this.entryOf(index, request.board);
        const file = boardFile(folder, entry.id);
        const dirty = vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === file);
        if (!creating && dirty) {
            throw new Error(`The user is editing ${label(entry)}'s source and has unsaved changes. Wait until they save it, then write again.`);
        }
        const before = creating ? '' : await readBoard(file);
        let markdown: string;
        let happened: string;
        switch (request.mode) {
            case 'replace':
                markdown = appendToBoard('', request.markdown);
                happened = creating ? 'written' : 'replaced the whole board';
                break;
            case 'block': {
                const block = request.block;
                if (!block) {
                    throw new Error('Mode block needs the id of the block to rewrite.');
                }
                try {
                    markdown = replaceBoardBlock(before, block, request.markdown);
                } catch (err) {
                    throw new Error(`${err instanceof Error ? err.message : String(err)} Its blocks:\n${formatOutline(parseBoard(before))}`);
                }
                happened = request.markdown.trim() ? `rewrote block ${block}` : `removed block ${block}`;
                break;
            }
            default: {
                markdown = appendToBoard(before, request.markdown);
                const added = parseBoard(markdown).blocks.length - parseBoard(before).blocks.length;
                happened = creating ? 'written' : `appended ${added} block${added === 1 ? '' : 's'}`;
            }
        }
        const title = request.title?.trim();
        if (creating) {
            entry.title = title || titleFromHeading(markdown) || 'Board';
            index.boards.push(entry);
        } else if (title && title !== entry.title) {
            entry.title = title;
            happened += `, renamed "${title}"`;
        }
        entry.open = true;
        index.current = entry.id;
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(file, markdown);
        await this.saveIndex(folder, index);

        const board = await this.show(folder, index, entry, this.options.following() ? 'keep' : 'none', markdown);
        board.retitle(entry.title);
        const errors = await board.render(markdown);
        const doc = parseBoard(markdown);
        const report = [`${label(entry)}: ${happened}.`, formatOutline(doc)];
        if (!errors) {
            report.push('Rendering was not confirmed: the board did not answer in time.');
        } else {
            for (const e of errors) {
                const web = doc.blocks.find((b) => b.id === e.block)?.kind === 'web';
                const what = web ? `${e.block} reported: ${e.message}. Fix the HTML` : `${e.block} did not render: ${e.message}. Fix the Mermaid source`;
                report.push(`${what} and rewrite it with show_me mode "block", block "${e.block}".`);
            }
        }
        return report.join('\n');
    }

    point(target: BoardTarget, style: BoardMarkStyle | undefined): Promise<string> {
        return this.pointAt(target, style, true);
    }

    async view(request: BoardViewRequest): Promise<string> {
        const { folder, index } = await this.requireBound();
        if (request.action === 'list') {
            return index.boards.length
                ? index.boards
                      .map((b) => {
                          const state = this.panels.has(boardFile(folder, b.id)) ? 'open' : 'closed';
                          return `${b.id} "${b.title}" (${state}${b.id === index.current ? ', current' : ''})`;
                      })
                      .join('\n')
                : 'No boards yet.';
        }
        if (request.action === 'looking') {
            return this.looking(folder);
        }
        const entry = this.entryOf(index, request.board);
        switch (request.action) {
            case 'close': {
                const board = this.panels.get(boardFile(folder, entry.id));
                if (!board) {
                    return `${label(entry)} is already closed.`;
                }
                board.panel.dispose();
                return `${label(entry)} closed.`;
            }
            case 'open': {
                const board = await this.show(folder, index, entry, 'keep');
                await this.setCurrent(folder, index, entry.id);
                if (request.to) {
                    return `${label(entry)} is open, ${await this.move(board, request.to)}.`;
                }
                return `${label(entry)} is open.`;
            }
            case 'focus':
                await this.show(folder, index, entry, 'take');
                await this.setCurrent(folder, index, entry.id);
                return `${label(entry)} has the focus.`;
            case 'move': {
                if (!request.to) {
                    throw new Error('Move needs where to: main, left, right, beside or window.');
                }
                const board = await this.show(folder, index, entry, 'none');
                await this.setCurrent(folder, index, entry.id);
                return `${label(entry)} ${await this.move(board, request.to)}.`;
            }
            case 'maximize': {
                const board = await this.show(folder, index, entry, 'take');
                await this.setCurrent(folder, index, entry.id);
                if (!(await this.maximize(board))) {
                    return `${label(entry)} already fills the editor area: it is in the only editor group. It has the focus.`;
                }
                return `${label(entry)} is maximized: its editor group fills the editor area, the other groups are hidden until restored. It has the focus.`;
            }
            case 'restore':
                return (await this.restore())
                    ? 'Restored: the editor groups show side by side again.'
                    : 'No board was maximized by you or its Maximize button, so nothing was restored. The user can restore an editor group with the button in its tab bar.';
            case 'expand':
            case 'collapse': {
                const block = request.action === 'expand' ? request.block : undefined;
                let what = 'diagram';
                if (request.action === 'expand') {
                    const markdown = this.panels.get(boardFile(folder, entry.id))?.markdown ?? (await readBoard(boardFile(folder, entry.id)));
                    const found = parseBoard(markdown).blocks.find((b) => b.id === block);
                    if (found?.kind !== 'diagram' && found?.kind !== 'web') {
                        throw new Error(
                            `Expand needs a diagram or web page block of ${label(entry)}${block ? `; ${block} is ${found ? `a ${found.kind}` : 'not on it'}` : ''}. Its blocks:\n${formatOutline(parseBoard(markdown))}`,
                        );
                    }
                    what = found.kind === 'web' ? 'Web page' : 'Diagram';
                }
                const board = await this.show(folder, index, entry, 'keep');
                await this.setCurrent(folder, index, entry.id);
                const reply = await board.request((seq) => ({ type: 'expand', seq, block: block ?? null }));
                if (!reply) {
                    throw new Error(`${label(entry)} did not answer; the block may not have ${block ? 'filled the board' : 'gone back'}.`);
                }
                if (reply.type === 'expanded' && reply.error) {
                    throw new Error(reply.error);
                }
                return block
                    ? `${what} ${block} fills ${label(entry)}, alone; its zoom is kept. Pointing into it keeps it; pointing elsewhere brings the whole board back.`
                    : `${label(entry)} shows all its blocks again.`;
            }
            case 'scroll': {
                const where = request.where;
                if (!where) {
                    throw new Error('Scroll needs where: up, down, top, bottom or a block.');
                }
                const board = await this.show(folder, index, entry, 'keep');
                await this.setCurrent(folder, index, entry.id);
                const reply = await board.request((seq) => ({ type: 'scroll', seq, to: where }));
                if (!reply) {
                    throw new Error(`${label(entry)} did not answer; the scroll may not have happened.`);
                }
                if (reply.type === 'scrolled' && reply.error) {
                    throw new Error(reply.error);
                }
                return `${label(entry)} scrolled ${typeof where === 'string' ? where : `to ${where.block}`}.`;
            }
        }
    }

    /** What board `id` (default: the current one) of the bound context draws now: blocks in view, Pi's point and the user's mark; undefined when it is closed or does not answer. */
    async shown(id?: string): Promise<Extract<BoardClientMessage, { type: 'status' }> | undefined> {
        const { folder, index } = await this.requireBound();
        const board = this.panels.get(boardFile(folder, this.entryOf(index, id).id));
        const reply = await board?.request((seq) => ({ type: 'status', seq }));
        return reply?.type === 'status' ? reply : undefined;
    }

    // ── BoardContextSource ──

    userMark(): BoardUserMarkInfo | undefined {
        const folder = this.bound?.folder;
        let best: BoardPanel | undefined;
        for (const board of this.panels.values()) {
            if (board.folder === folder && board.mark && (!best?.mark || board.mark.at > best.mark.at)) {
                best = board;
            }
        }
        return best?.mark && { board: best.id, title: best.title, mark: best.mark.mark, latest: best.mark.at > this.editorSelectionAt };
    }

    takeEdits(): BoardEditNotice[] {
        const notices = this.edits.map((e) => e.notice);
        this.edits = [];
        return notices;
    }

    list(): BoardListing[] {
        const bound = this.bound;
        if (!bound?.index) {
            return [];
        }
        const index = bound.index;
        return index.boards.map((b) => ({
            id: b.id,
            title: b.title,
            open: this.panels.has(boardFile(bound.folder, b.id)),
            current: b.id === index.current,
        }));
    }

    dispose(): void {
        // Shutting down is not the user closing the tabs: the index keeps them open for the next session.
        this.disposing = true;
        for (const board of [...this.panels.values()]) {
            board.panel.dispose();
        }
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    // ── Internals ──

    private async requireBound(): Promise<{ folder: string; index: BoardIndex }> {
        const folder = this.bound?.folder;
        if (folder === undefined) {
            throw new Error('No voice conversation is active, so there are no boards.');
        }
        return { folder, index: await this.index(folder) };
    }

    private index(folder: string): Promise<BoardIndex> {
        let loading = this.indexes.get(folder);
        if (!loading) {
            loading = loadIndex(folder);
            this.indexes.set(folder, loading);
        }
        return loading;
    }

    private saveIndex(folder: string, index: BoardIndex): Promise<void> {
        const next = (this.indexWrites.get(folder) ?? Promise.resolve())
            .then(async () => {
                await fs.mkdir(folder, { recursive: true });
                await fs.writeFile(path.join(folder, INDEX_FILE), JSON.stringify(index, null, 2));
            })
            .catch((err: unknown) => this.options.log(`Board index ${folder}: ${err instanceof Error ? err.message : String(err)}`));
        this.indexWrites.set(folder, next);
        return next;
    }

    private async setCurrent(folder: string, index: BoardIndex, id: string): Promise<void> {
        if (index.current !== id) {
            index.current = id;
            await this.saveIndex(folder, index);
        }
    }

    /** The board `id`, else the current one; throws naming the boards there are. */
    private entryOf(index: BoardIndex, id: string | undefined): BoardEntry {
        const wanted = id ?? index.current;
        const entry = index.boards.find((b) => b.id === wanted);
        if (entry) {
            return entry;
        }
        if (!index.boards.length) {
            throw new Error('There are no boards yet; write one with show_me.');
        }
        throw new Error(`${wanted === undefined ? 'There is no current board' : `There is no board ${wanted}`}. Boards: ${index.boards.map((b) => `${b.id} "${b.title}"`).join(', ')}.`);
    }

    /** Opens the board's tab when closed (in the active editor group, without the focus unless `take`) and marks it open. */
    private async show(folder: string, index: BoardIndex, entry: BoardEntry, reveal: Reveal, markdown?: string): Promise<BoardPanel> {
        const file = boardFile(folder, entry.id);
        let board = this.panels.get(file);
        if (board) {
            if (reveal !== 'none') {
                board.panel.reveal(board.panel.viewColumn, reveal === 'keep');
            }
        } else {
            const text = markdown ?? (await readBoard(file));
            board = this.panels.get(file) ?? this.createPanel(folder, entry, text, reveal !== 'take');
        }
        if (!entry.open) {
            entry.open = true;
            await this.saveIndex(folder, index);
        }
        return board;
    }

    private createPanel(folder: string, entry: BoardEntry, markdown: string, preserveFocus: boolean): BoardPanel {
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            `Board · ${entry.title}`,
            // The group of the user's code, in front of it: not a new group each time (board_view moves it).
            { viewColumn: vscode.ViewColumn.Active, preserveFocus },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'out')],
            },
        );
        const board = new BoardPanel(panel, folder, entry.id, entry.title, markdown);
        board.zoom = entry.zoom;
        this.panels.set(board.file, board);
        panel.webview.onDidReceiveMessage((message: BoardClientMessage) => this.received(board, message));
        panel.onDidDispose(() => this.closed(board));
        panel.webview.html = boardHtml(panel.webview, this.options.extensionUri, `Board · ${entry.title}`);
        return board;
    }

    private received(board: BoardPanel, message: BoardClientMessage): void {
        switch (message.type) {
            case 'userMark':
                board.mark = message.mark ? { mark: message.mark, at: ++this.clock } : undefined;
                return;
            case 'editSource':
                void this.editSource(board).catch((err: unknown) =>
                    this.options.log(`Board ${board.id} source: ${err instanceof Error ? err.message : String(err)}`),
                );
                return;
            case 'openLink':
                void this.openLink(board, message.href).catch((err: unknown) =>
                    this.options.log(`Board ${board.id} link ${message.href}: ${err instanceof Error ? err.message : String(err)}`),
                );
                return;
            case 'zoomed': {
                const zoom = parseBoardZoom(message.zoom);
                board.zoom = zoom;
                void this.index(board.folder)
                    .then((index) => {
                        const entry = index.boards.find((b) => b.id === board.id);
                        if (!entry) {
                            return;
                        }
                        // 100% everywhere is no zoom to keep.
                        if (zoom && (zoom.page !== 1 || Object.keys(zoom.blocks).length)) {
                            entry.zoom = zoom;
                        } else {
                            delete entry.zoom;
                        }
                        return this.saveIndex(board.folder, index);
                    })
                    .catch((err: unknown) => this.options.log(`Board ${board.id} zoom: ${err instanceof Error ? err.message : String(err)}`));
                return;
            }
            case 'toggleMaximize':
                void this.toggleMaximize(board).catch((err: unknown) =>
                    this.options.log(`Board ${board.id} maximize: ${err instanceof Error ? err.message : String(err)}`),
                );
                return;
            default:
                board.receive(message);
        }
    }

    /** The page's Maximize / Restore button: what board_view maximize and restore do. */
    private async toggleMaximize(board: BoardPanel): Promise<void> {
        if (this.maximized === board) {
            await this.restore();
        } else if (!(await this.maximize(board))) {
            vscode.window.setStatusBarMessage('The board already fills the editor area: it is the only editor group.', 4000);
        }
    }

    /**
     * Maximizes the board's editor group (`workbench.action.toggleMaximizeEditorGroup`, which acts on
     * the active group, so the board takes the focus; activating it also restores any other maximized
     * group). False when its group is the only one: it fills the editor area already.
     */
    private async maximize(board: BoardPanel): Promise<boolean> {
        board.panel.reveal(board.panel.viewColumn, false);
        if (vscode.window.tabGroups.all.length < 2) {
            return false;
        }
        if (this.maximized !== board) {
            await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
            this.setMaximized(board);
        }
        return true;
    }

    /** Undoes maximize; false when no board is maximized by it (VS Code offers no way to ask about the user's own). */
    private async restore(): Promise<boolean> {
        if (!this.maximized) {
            return false;
        }
        this.setMaximized(undefined);
        await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
        return true;
    }

    private setMaximized(board: BoardPanel | undefined): void {
        if (this.maximized === board) {
            return;
        }
        this.maximized?.showMaximized(false);
        this.maximized = board;
        board?.showMaximized(true);
    }

    /** A link clicked on a board: a web page to the browser, a file (at its lines) in a text editor next to the board, anything else nowhere. */
    private async openLink(board: BoardPanel, href: string): Promise<void> {
        const link = parseBoardLink(href);
        if (link.kind === 'none') {
            this.options.log(`Board ${board.id}: link ${href} opens nothing (not a web page or a file).`);
            return;
        }
        if (link.kind === 'web') {
            await (this.options.openExternal ?? vscode.env.openExternal)(vscode.Uri.parse(link.url, true));
            return;
        }
        const folders = vscode.workspace.workspaceFolders ?? [];
        const candidates = path.isAbsolute(link.path) ? [link.path] : folders.map((f) => path.join(f.uri.fsPath, link.path));
        let found: { uri: vscode.Uri; type: vscode.FileType } | undefined;
        for (const candidate of candidates) {
            const uri = vscode.Uri.file(candidate);
            const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => undefined);
            if (stat) {
                found = { uri, type: stat.type };
                break;
            }
        }
        if (!found) {
            const where = path.isAbsolute(link.path) ? '' : folders.length ? ' in the workspace' : ' (no workspace folder is open to look in)';
            const message = `Board link: ${link.path} was not found${where}.`;
            this.options.log(`Board ${board.id}: ${message}`);
            void vscode.window.showWarningMessage(message);
            return;
        }
        if (found.type & vscode.FileType.Directory) {
            await vscode.commands.executeCommand('revealInExplorer', found.uri);
            return;
        }
        // In the group of the code next to the board, else beside it.
        const column = vscode.window.visibleTextEditors.find((e) => e.viewColumn !== undefined && e.viewColumn !== board.panel.viewColumn)?.viewColumn ?? vscode.ViewColumn.Beside;
        const selection = link.line === undefined ? undefined : new vscode.Range(link.line - 1, 0, (link.endLine ?? link.line) - 1, 0);
        await vscode.window.showTextDocument(found.uri, { viewColumn: column, preview: true, ...(selection ? { selection } : {}) });
    }

    private closed(board: BoardPanel): void {
        if (this.panels.get(board.file) === board) {
            this.panels.delete(board.file);
        }
        // Closed: its page gets nothing more, so no setMaximized.
        if (this.maximized === board) {
            this.maximized = undefined;
        }
        board.cancel();
        if (this.disposing || board.quiet) {
            return;
        }
        void this.index(board.folder).then((index) => {
            const entry = index.boards.find((b) => b.id === board.id);
            if (entry?.open && !this.panels.has(board.file)) {
                entry.open = false;
                return this.saveIndex(board.folder, index);
            }
        });
    }

    private async editSource(board: BoardPanel): Promise<void> {
        const file = board.file;
        await fs.mkdir(board.folder, { recursive: true });
        // Its file is gone only when deleted by hand: recreate it from what the board shows.
        await fs.writeFile(file, board.markdown, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'EEXIST') {
                throw err;
            }
        });
        await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }

    private sourceSaved(doc: vscode.TextDocument): void {
        if (doc.uri.scheme !== 'file') {
            return;
        }
        const board = this.panels.get(path.resolve(doc.uri.fsPath));
        const markdown = doc.getText();
        if (!board || markdown === board.markdown) {
            return;
        }
        if (board.folder === this.bound?.folder) {
            const pending = this.edits.find((e) => e.notice.board === board.id);
            const before = pending?.before ?? board.markdown;
            const notice: BoardEditNotice = {
                board: board.id,
                title: board.title,
                summary: describeBoardEdit(before, markdown),
                outline: formatOutline(parseBoard(markdown)),
            };
            if (pending) {
                pending.notice = notice;
            } else {
                this.edits.push({ before, notice });
            }
        }
        void board.render(markdown, true);
    }

    private async pointAt(target: BoardTarget, style: BoardMarkStyle | undefined, explicit: boolean): Promise<string> {
        const { folder, index } = await this.requireBound();
        const entry = this.entryOf(index, target.board);
        const file = boardFile(folder, entry.id);
        const open = this.panels.get(file);
        const markdown = open?.markdown ?? (await readBoard(file));
        const doc = parseBoard(markdown);
        const block = doc.blocks.find((b) => b.id === target.block);
        if (!block) {
            throw new Error(`${label(entry)} has no block ${target.block}. Its blocks:\n${formatOutline(doc)}`);
        }
        if (block.kind === 'web' && (target.startLine !== undefined || target.endLine !== undefined || target.text !== undefined)) {
            throw new Error(`${block.id} is a web page, which runs in its own frame: point at the whole block (⟦board:${block.id}⟧).`);
        }
        if (target.startLine !== undefined || target.endLine !== undefined) {
            const start = target.startLine ?? target.endLine ?? 1;
            const end = target.endLine ?? start;
            if (block.kind === 'diagram') {
                // Steps: the board counts the messages it drew and checks the range.
                if (diagramType((block.token as Tokens.Code).text) !== 'sequenceDiagram') {
                    throw new Error(`Steps only point into a sequence diagram's messages; ${block.id} is a ${diagramType((block.token as Tokens.Code).text)}. Name a node or an edge label instead.`);
                }
            } else if (block.kind !== 'code') {
                throw new Error(`Lines only point into code blocks (and steps into sequence diagrams); ${block.id} is a ${block.kind}. Point at the block or a passage in it.`);
            } else {
                const count = (block.token as Tokens.Code).text.split('\n').length;
                if (start < 1 || end < start || end > count) {
                    throw new Error(`${block.id} has lines 1-${count}; lines ${start}-${end} are not in it.`);
                }
            }
        }
        const follow = explicit || this.options.following();
        if (!open && !follow) {
            throw new Error(`${label(entry)} is closed and Follow Pi is off.`);
        }
        const board = await this.show(folder, index, entry, follow ? 'keep' : 'none', markdown);
        if (explicit || !open) {
            await this.setCurrent(folder, index, entry.id);
        }
        const markStyle = style ?? defaultMarkStyle(target, block.kind);
        const reply = await board.request((seq) => ({ type: 'point', seq, target: { ...target, board: entry.id }, style: markStyle }));
        if (!reply) {
            throw new Error(`${label(entry)} did not answer; the mark may not show.`);
        }
        if (reply.type === 'pointed' && reply.error) {
            throw new Error(reply.error);
        }
        const found = reply.type === 'pointed' && reply.found ? `, a ${reply.found}` : '';
        return `Pointed at ${describeTarget(target, block.kind)}${found} on board ${entry.id} (${markStyle}).`;
    }

    /**
     * Moves the board's tab; returns how it went, for the report. VS Code moves a webview into another
     * group as a preview tab, which would replace the preview tab there (the user's file) and later be
     * replaced itself by the next file opened with a single click: the target group's preview text tab
     * is pinned first, and the board after, when it is the active editor.
     */
    private async move(board: BoardPanel, to: BoardMoveTo): Promise<string> {
        const column = board.panel.viewColumn ?? vscode.ViewColumn.One;
        // Moving it activates another group, which ends a maximized one.
        this.setMaximized(undefined);
        let target: vscode.ViewColumn;
        let report: string;
        switch (to) {
            case 'main': {
                // The group of the user's code: the active text editor's, else a visible one's; not a board's source.
                const code = [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors].find(
                    (e) => e?.viewColumn !== undefined && e.document.uri.scheme === 'file' && !this.panels.has(path.resolve(e.document.uri.fsPath)),
                );
                target = code?.viewColumn ?? vscode.ViewColumn.One;
                if (target === column) {
                    board.panel.reveal(column, true);
                    return 'is in the main editor group already';
                }
                report = 'moved to the main editor group, in front of the code there';
                break;
            }
            case 'left':
                if (column <= vscode.ViewColumn.One) {
                    throw new Error('The board is already in the leftmost editor group.');
                }
                target = column - 1;
                report = 'moved left';
                break;
            case 'right':
                // A column past the last group opens a new group to the right.
                target = column + 1;
                report = 'moved right';
                break;
            case 'beside':
                target = vscode.ViewColumn.Beside;
                report = 'moved beside';
                break;
            case 'window':
                board.panel.reveal(column, false);
                await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
                return 'moved to a new window';
        }
        const preview = vscode.window.tabGroups.all.find((g) => g.viewColumn === target)?.activeTab;
        if (preview?.isPreview && preview.input instanceof vscode.TabInputText) {
            await vscode.window.showTextDocument(preview.input.uri, { viewColumn: target, preview: false, preserveFocus: true });
        }
        const tabOf = () =>
            vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputWebview && t.label === board.panel.title);
        const source = tabOf()?.group;
        board.panel.reveal(target, true);
        // The tab model follows the move a moment later. The board can be pinned (keepEditor acts on the
        // active editor) once it is the active tab of the active group: moved into the group that has
        // the focus, or its old group closed, emptied. Not while the old group keeps the focus.
        const landed = () => {
            const tab = tabOf();
            return tab && tab.group !== source ? tab : undefined;
        };
        await tabsSettled(() => {
            const tab = landed();
            return tab !== undefined && tab.isActive && (tab.group.isActive || (source !== undefined && vscode.window.tabGroups.all.includes(source) && source.isActive));
        }, MOVE_SETTLE_MS);
        const moved = landed();
        if (moved?.isPreview && moved.isActive && moved.group.isActive) {
            await vscode.commands.executeCommand('workbench.action.keepEditor');
        }
        return report;
    }

    private async looking(folder: string): Promise<string> {
        const visible = [...this.panels.values()]
            .filter((b) => b.folder === folder && b.panel.visible)
            .sort((a, b) => Number(b.panel.active) - Number(a.panel.active));
        if (!visible.length) {
            return 'No board is in view.';
        }
        const lines = await Promise.all(
            visible.map(async (board) => {
                const reply = await board.request((seq) => ({ type: 'status', seq }));
                const where = `${label(board)}${board.panel.active ? ', the active tab' : ', visible'}${board === this.maximized ? ', maximized' : ''}`;
                if (reply?.type !== 'status') {
                    return `${where}: which blocks are in view is unknown (no answer).`;
                }
                const expandedKind = reply.expanded ? parseBoard(board.markdown).blocks.find((b) => b.id === reply.expanded)?.kind : undefined;
                const blocks = reply.expanded
                    ? `${expandedKind === 'web' ? 'web page' : 'diagram'} ${reply.expanded} alone, filling the board`
                    : reply.visible.length
                      ? `blocks ${reply.visible.join(', ')} in view`
                      : 'no block in view';
                const point = reply.point ? `; you point at ${describeTarget(reply.point.target)}, a ${reply.point.found}` : '';
                const marked = reply.userMark;
                const what = marked?.element
                    ? ` element ${marked.element.selector}`
                    : marked?.node
                      ? ` node "${marked.node}"`
                      : marked?.message !== undefined
                        ? ` ${marked.step !== undefined ? `message ${marked.step} ` : 'arrow '}"${marked.message}"`
                        : marked?.text
                          ? ` "${marked.text}"`
                          : '';
                const mark = marked ? `; the user marked ${marked.block}${what}` : '';
                const zoomed = Object.entries(reply.zoom.blocks).map(([id, z]) => `${id} at ${Math.round(z * 100)}%`);
                const zoom =
                    reply.zoom.page !== 1 || zoomed.length
                        ? `; the user zoomed ${[reply.zoom.page !== 1 ? `the page to ${Math.round(reply.zoom.page * 100)}%` : '', ...zoomed].filter(Boolean).join(', ')}`
                        : '';
                return `${where}: ${blocks}${point}${mark}${zoom}.`;
            }),
        );
        return lines.join('\n');
    }
}
