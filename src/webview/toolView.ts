/**
 * Tool cards rendered by the vendored `<omp-tool-view>` web component
 * (media/omp-tool-views.js, oh-my-pi collab-web `tool-render`).
 *
 * The bundle registers the element before main.js runs. Payloads are handed
 * over through the element's `data` property; each assignment re-renders.
 */

export interface ToolResultPayload {
    content: Array<{ type: string; [key: string]: unknown }>;
    details?: unknown;
    isError?: boolean;
}

export interface ToolViewPayload {
    name: string;
    args?: unknown;
    result?: ToolResultPayload;
    running?: boolean;
    /** Streaming output tail while running. */
    partial?: string;
    defaultOpen?: boolean;
}

type ToolViewElement = HTMLElement & { data: ToolViewPayload };

/** Expanded cards by toolCallId; survives the full history rebuilds of updateMessages(). */
const openToolCalls = new Set<string>();
/** Last payload per element, so live updates can patch it. */
const payloads = new WeakMap<HTMLElement, ToolViewPayload>();

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

/** A trailing `:chunk` that reads as an omp read selector: line ranges, `raw`, `conflicts`. */
const READ_SEL_CHUNK = /^(raw|conflicts|\d+(?:[-+]\d*)?(?:,\d+(?:[-+]\d*)?)*)$/i;
/** URLs and internal schemes (`https://`, `skill://`, `artifact://`) are not local files. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Strip up to two selector chunks (`path:50-100:raw`), mirroring tool-render's read.tsx. */
function stripReadSelector(rawPath: string): string {
    let filePath = rawPath;
    for (let i = 0; i < 2; i++) {
        const idx = filePath.lastIndexOf(':');
        if (idx <= 0 || !READ_SEL_CHUNK.test(filePath.slice(idx + 1))) break;
        filePath = filePath.slice(0, idx);
    }
    return filePath;
}

/**
 * Local path a `read` card opens: the agent-resolved absolute path when the
 * result carries one, else the argument without its selector. Relative paths
 * are resolved against the session cwd by the extension host.
 */
function readTargetPath(payload: ToolViewPayload): string | undefined {
    if (payload.name.toLowerCase() !== 'read') return undefined;
    const details = payload.result?.details as Record<string, unknown> | undefined;
    if (typeof details?.resolvedPath === 'string' && details.resolvedPath) return details.resolvedPath;
    const args = payload.args as Record<string, unknown> | undefined;
    const rawPath = args?.path ?? args?.file_path;
    if (typeof rawPath !== 'string' || !rawPath || URL_SCHEME.test(rawPath)) return undefined;
    return stripReadSelector(rawPath);
}

export function createToolView(toolCallId: string, payload: ToolViewPayload): HTMLElement {
    const view = document.createElement('omp-tool-view');
    if (toolCallId) view.dataset.toolCallId = toolCallId;
    view.dataset.toolName = payload.name;
    setToolViewData(view, payload);
    return view;
}

function setToolViewData(view: HTMLElement, payload: ToolViewPayload): void {
    payloads.set(view, payload);
    const filePath = readTargetPath(payload);
    if (filePath) {
        view.dataset.filepath = filePath;
    } else {
        delete view.dataset.filepath;
    }
    const id = view.dataset.toolCallId;
    const open = payload.defaultOpen ?? (id !== undefined && openToolCalls.has(id));
    (view as ToolViewElement).data = { ...payload, defaultOpen: open };
}

/** Merge a patch into the element's current payload (live streaming updates). */
export function updateToolView(view: HTMLElement, patch: Partial<ToolViewPayload>): void {
    const current = payloads.get(view);
    if (!current) return;
    setToolViewData(view, { ...current, ...patch });
}

/**
 * Document-level capture listeners run before React's root listener on the
 * element: remember expand state, and turn a read card's path into an
 * open-file link instead of a toggle.
 */
export function installToolViewInteractions(openFile: (filePath: string) => void): void {
    document.addEventListener(
        'click',
        (event) => {
            const target = event.target as Element | null;
            const view = target?.closest('omp-tool-view') as HTMLElement | null;
            if (!view) return;
            const head = target!.closest('.tv-head');
            if (!head) return;

            const filePath = view.dataset.filepath;
            if (filePath && target!.closest('.tv-path')) {
                event.preventDefault();
                event.stopPropagation();
                openFile(filePath);
                return;
            }

            const id = view.dataset.toolCallId;
            if (!id) return;
            if (head.getAttribute('aria-expanded') === 'true') {
                openToolCalls.delete(id);
            } else {
                openToolCalls.add(id);
            }
        },
        true,
    );
}
