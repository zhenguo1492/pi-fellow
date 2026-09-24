import { FitAddon } from '@xterm/addon-fit';
import { type ITheme, Terminal } from '@xterm/xterm';
import type { ClientMessage } from '../shared/protocol';
import { vscode } from './vscodeApi';

interface TuiPane {
    el: HTMLDivElement;
    term: Terminal;
    fit: FitAddon;
    /** Host has been asked to start (or re-attach to) this tab's TUI. */
    started: boolean;
    /** TUI process ended; next keypress restarts it. */
    exited: boolean;
}

const panes = new Map<string, TuiPane>();
let activeTabId = '';

/**
 * Terminal host. Kept outside the rebuildable skeleton: `render()` wipes #app on tab switches,
 * so it re-inserts this node, and xterm instances survive with their screen state.
 */
const host = document.createElement('div');
host.className = 'tui-host';

function post(message: ClientMessage): void {
    vscode.postMessage(message);
}

function cssVar(name: string): string | undefined {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
}

/** Terminal palette from the active VS Code theme (the same variables the integrated terminal uses). */
function readTheme(): ITheme {
    const ansi = (name: string) => cssVar(`--vscode-terminal-ansi${name}`);
    return {
        // Same surface and text color as the chat view (`--bg` / `--fg` in main.css).
        background: cssVar('--bg'),
        foreground: cssVar('--fg'),
        cursor: cssVar('--vscode-terminalCursor-foreground'),
        selectionBackground: cssVar('--vscode-terminal-selectionBackground'),
        black: ansi('Black'),
        red: ansi('Red'),
        green: ansi('Green'),
        yellow: ansi('Yellow'),
        blue: ansi('Blue'),
        magenta: ansi('Magenta'),
        cyan: ansi('Cyan'),
        white: ansi('White'),
        brightBlack: ansi('BrightBlack'),
        brightRed: ansi('BrightRed'),
        brightGreen: ansi('BrightGreen'),
        brightYellow: ansi('BrightYellow'),
        brightBlue: ansi('BrightBlue'),
        brightMagenta: ansi('BrightMagenta'),
        brightCyan: ansi('BrightCyan'),
        brightWhite: ansi('BrightWhite'),
    };
}

// VS Code swaps theme classes on <body>; keep terminals in step.
new MutationObserver(() => {
    const theme = readTheme();
    for (const pane of panes.values()) {
        pane.term.options.theme = theme;
    }
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

/** Fit the pane to its box; start the TUI on first fit, otherwise report the new size. */
function fitPane(tabId: string, pane: TuiPane): void {
    if (!pane.el.isConnected || pane.el.clientWidth === 0 || pane.el.clientHeight === 0) {
        return;
    }
    pane.fit.fit();
    const { cols, rows } = pane.term;
    if (pane.started) {
        post({ type: 'tuiResize', tabId, cols, rows });
    } else {
        pane.started = true;
        post({ type: 'tuiStart', tabId, cols, rows });
    }
}

let fitFrame = 0;
new ResizeObserver(() => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
        const pane = panes.get(activeTabId);
        if (pane) fitPane(activeTabId, pane);
    });
}).observe(host);

function createPane(tabId: string): TuiPane {
    const el = document.createElement('div');
    el.className = 'tui-pane';
    host.appendChild(el);
    // Chat typography: `--chat-font` size and `--font-mono` (the chat's code font), since a TUI grid
    // needs monospace. Line height sits below `--chat-line` (1.5): the DOM renderer draws box-drawing
    // glyphs from the font, so taller rows break the TUI's vertical borders into dashes.
    const fontSize = Number.parseFloat(cssVar('--chat-font') ?? '');
    const term = new Terminal({
        fontFamily: cssVar('--font-mono') ?? 'monospace',
        fontSize: Number.isFinite(fontSize) ? fontSize : 11.5,
        lineHeight: 1.2,
        theme: readTheme(),
        cursorBlink: true,
        scrollback: 5000,
        macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const pane: TuiPane = { el, term, fit, started: false, exited: false };
    term.onData((data) => {
        if (pane.exited) {
            pane.exited = false;
            pane.started = false;
            term.reset();
            fitPane(tabId, pane);
            return;
        }
        post({ type: 'tuiInput', tabId, data });
    });
    panes.set(tabId, pane);
    return pane;
}

function disposePane(tabId: string): void {
    const pane = panes.get(tabId);
    if (!pane) return;
    pane.term.dispose();
    pane.el.remove();
    panes.delete(tabId);
}

/** Node to (re)insert into #app after each skeleton rebuild. */
export function getTuiHost(): HTMLElement {
    return host;
}

/** Show the active tab's terminal (TUI mode), or drop every terminal (chat mode). */
export function syncTuiView(enabled: boolean, tabIds: string[], active: string): void {
    document.getElementById('app')?.classList.toggle('tui-mode', enabled);
    if (!enabled) {
        for (const id of [...panes.keys()]) disposePane(id);
        activeTabId = '';
        return;
    }
    for (const id of [...panes.keys()]) {
        if (!tabIds.includes(id)) disposePane(id);
    }
    activeTabId = active;
    const pane = panes.get(active) ?? createPane(active);
    for (const [id, p] of panes) {
        p.el.classList.toggle('tui-pane--active', id === active);
    }
    requestAnimationFrame(() => {
        fitPane(active, pane);
        pane.term.focus();
    });
}

export function writeTuiData(tabId: string, data: string): void {
    panes.get(tabId)?.term.write(data);
}

/** Replace the pane's content with the host's full screen + scrollback of the running TUI. */
export function restoreTuiSnapshot(tabId: string, data: string): void {
    const pane = panes.get(tabId);
    if (!pane) return;
    pane.exited = false;
    pane.term.reset();
    pane.term.write(data);
}

export function markTuiExited(tabId: string, exitCode: number): void {
    const pane = panes.get(tabId);
    if (!pane || pane.exited) return;
    pane.exited = true;
    pane.term.write(`\r\n\x1b[2m[TUI exited with code ${exitCode} — press any key to restart]\x1b[0m\r\n`);
}
