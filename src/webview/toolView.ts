/**
 * Tool cards: status dot, tool name, one-line summary, and a collapsible body
 * rendered by the per-tool renderers in ./toolCards (ported from oh-my-pi
 * collab-web `tool-render`, a1b3b83). Rendering is synchronous DOM, so a card
 * has its final height the moment it is inserted and scroll never jumps.
 */
import { h, inline } from './toolCards/parts';
import { resolveToolRenderer } from './toolCards/registry';
import type { ToolRenderProps, ToolRenderer, ToolResultPayload } from './toolCards/types';
import { cleanOutput, isRecord, splitPathSel } from './toolCards/util';

export interface ToolViewPayload {
    name: string;
    args?: unknown;
    result?: ToolResultPayload;
    running?: boolean;
    /** Streaming output tail while running. */
    partial?: string;
    defaultOpen?: boolean;
    /** Renders this card instead of the registry's renderer for `name` (the Bot view's host tools). */
    renderer?: ToolRenderer;
    /** Header name instead of `name`, which then shows as its tooltip (the Bot view's plain-language labels). */
    label?: string;
}

interface CardState {
    payload: ToolViewPayload;
    open: boolean;
}

/** Everything a card renders, derived from its payload. */
interface CardModel {
    /** Name shown in the header (`xd://<tool>` for device dispatches). */
    label: string;
    renderer: ToolRenderer;
    props: ToolRenderProps;
    /** Model-provided intent (`i` arg). */
    intent: string | undefined;
}

/** Expanded cards by toolCallId; survives the full history rebuilds of updateMessages(). */
const openToolCalls = new Set<string>();
const cards = new WeakMap<HTMLElement, CardState>();
/** Longest streaming tail kept in a running card. */
const PARTIAL_TAIL = 2048;

let openFile: ((filePath: string) => void) | undefined;

/** Normalize a pi tool result (`{content, details}` or a toolResult message) into the renderer contract. */
export function toToolResult(raw: unknown, isError?: boolean): ToolResultPayload | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'object') {
        return { content: [{ type: 'text', text: String(raw) }], isError: isError === true };
    }
    const record = raw as Record<string, unknown>;
    let content: ToolResultPayload['content'];
    if (typeof record.content === 'string') {
        content = [{ type: 'text', text: record.content }];
    } else if (Array.isArray(record.content)) {
        content = record.content;
    } else {
        content = [{ type: 'text', text: JSON.stringify(raw, null, 2) }];
    }
    return { content, details: record.details, isError: isError ?? record.isError === true };
}

/** URLs and internal schemes (`https://`, `skill://`, `artifact://`) are not local files. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Local path a `read` card opens: the agent-resolved absolute path when the
 * result carries one, else the argument without its selector. Relative paths
 * are resolved against the session cwd by the extension host.
 */
function readTargetPath(payload: ToolViewPayload): string | undefined {
    if (payload.name.toLowerCase() !== 'read') return undefined;
    const details = payload.result?.details;
    if (isRecord(details) && typeof details.resolvedPath === 'string' && details.resolvedPath) return details.resolvedPath;
    const args = isRecord(payload.args) ? payload.args : {};
    const rawPath = args.path ?? args.file_path;
    if (typeof rawPath !== 'string' || !rawPath || URL_SCHEME.test(rawPath)) return undefined;
    return splitPathSel(rawPath).path;
}

function cardModel(payload: ToolViewPayload): CardModel {
    const raw = isRecord(payload.args) ? payload.args : {};
    let args = raw;
    let intent: string | undefined;
    // A string `i` is the intent omp adds to every call; a boolean `i` is a real flag (grep).
    if (typeof raw.i === 'string') {
        const { i, ...rest } = raw;
        args = rest;
        intent = i.trim() || undefined;
    }
    // `write` to `xd://<tool>` executes that tool; render it as the tool it ran.
    const details = payload.result?.isError !== true && isRecord(payload.result?.details) ? payload.result.details : null;
    const xdev = isRecord(details?.xdev) && details.xdev.mode === 'execute' ? details.xdev : null;
    if (payload.name === 'write' && payload.result && typeof xdev?.tool === 'string') {
        return {
            label: `xd://${xdev.tool}`,
            renderer: resolveToolRenderer(xdev.tool),
            props: {
                name: xdev.tool,
                args: isRecord(xdev.args) ? xdev.args : {},
                result: { ...payload.result, details: xdev.inner },
                running: payload.running,
            },
            intent,
        };
    }
    return {
        label: payload.label ?? payload.name,
        renderer: payload.renderer ?? resolveToolRenderer(payload.name),
        props: { name: payload.name, args, result: payload.result, running: payload.running },
        intent,
    };
}

function buildBody(model: CardModel): HTMLElement {
    return h('div', 'tv-body', model.intent && h('div', 'tv-intent', model.intent), ...(model.renderer.body?.(model.props) ?? []));
}

function toggleCard(view: HTMLElement, head: HTMLElement, state: CardState): void {
    state.open = !state.open;
    head.setAttribute('aria-expanded', String(state.open));
    const id = view.dataset.toolCallId;
    if (id && state.open) openToolCalls.add(id);
    else if (id) openToolCalls.delete(id);
    if (state.open) head.after(buildBody(cardModel(state.payload)));
    else view.querySelector(':scope > .tv-body')?.remove();
}

/** Streaming tail below the body while the tool runs; removed once a result arrives. */
function syncPartial(view: HTMLElement, payload: ToolViewPayload): void {
    let pre = view.querySelector<HTMLPreElement>(':scope > .tv-partial');
    const text = payload.running && !payload.result && payload.partial ? cleanOutput(payload.partial) : '';
    if (!text) {
        pre?.remove();
        return;
    }
    if (!pre) {
        pre = h('pre', 'tv-partial');
        view.append(pre);
    }
    pre.textContent = text.length > PARTIAL_TAIL ? `…${text.slice(-PARTIAL_TAIL)}` : text;
    pre.scrollTop = pre.scrollHeight;
}

function renderCard(view: HTMLElement, state: CardState): void {
    const { payload } = state;
    view.dataset.toolName = payload.name;
    const filePath = readTargetPath(payload);
    if (filePath) view.dataset.filepath = filePath;
    else delete view.dataset.filepath;

    const model = cardModel(payload);
    const isError = payload.result?.isError === true;
    let status = 'pending';
    if (isError) status = 'err';
    else if (payload.result) status = 'ok';
    const indicator = payload.running ? h('span', 'tv-spin') : h('span', `tv-status tv-status--${status}`);
    if (payload.running) indicator.setAttribute('aria-label', 'running');
    else indicator.setAttribute('aria-hidden', 'true');
    const chevron = h('span', 'tv-chev');
    chevron.setAttribute('aria-hidden', 'true');

    const head = h(
        'button',
        'tv-head',
        indicator,
        h('span', 'tv-name', model.label),
        inline('span', 'tv-sum', model.renderer.summary(model.props)),
        chevron,
    );
    head.type = 'button';
    head.setAttribute('aria-expanded', String(state.open));
    if (model.intent) head.title = model.intent;
    else if (payload.label) head.title = payload.name;
    head.addEventListener('click', (event) => {
        const path = view.dataset.filepath;
        if (path && openFile && event.target instanceof Element && event.target.closest('.tv-path')) {
            openFile(path);
            return;
        }
        toggleCard(view, head, state);
    });

    view.className = isError ? 'tv-card tv-card--error' : 'tv-card';
    view.replaceChildren(head);
    if (state.open) view.append(buildBody(model));
    syncPartial(view, payload);
}

export function createToolView(toolCallId: string, payload: ToolViewPayload): HTMLElement {
    const view = document.createElement('div');
    if (toolCallId) view.dataset.toolCallId = toolCallId;
    const state = { payload, open: payload.defaultOpen ?? (toolCallId !== '' && openToolCalls.has(toolCallId)) };
    cards.set(view, state);
    renderCard(view, state);
    return view;
}

/** Merge a patch into the card's payload (live streaming updates); open state is kept. */
export function updateToolView(view: HTMLElement, patch: Partial<ToolViewPayload>): void {
    const state = cards.get(view);
    if (!state) return;
    state.payload = { ...state.payload, ...patch };
    // Output chunks only move the streaming tail; keep the header and an open body intact.
    if (Object.keys(patch).every((key) => key === 'partial')) syncPartial(view, state.payload);
    else renderCard(view, state);
}

/** Clicking a `read` card's path opens the file instead of toggling the card. */
export function installToolViewInteractions(openFileHandler: (filePath: string) => void): void {
    openFile = openFileHandler;
}
