import { vscode } from './vscodeApi';
import { parseDropPathLine, parseUriListLines } from '../shared/dropPaths';
import { readImageFileAsItem, readTextFileAsItem, isLikelyTextFile } from './fileDropReaders';

type FileWithPath = File & { path?: string };

let dropHandledAt = 0;
let lastDropKey = '';

const BOUND_ATTR = 'data-chat-drop-bound';

function getDropHintEl(): HTMLElement | null {
    return document.getElementById('drop-shift-hint');
}

function isExplorerDrag(dt: DataTransfer): boolean {
    const types = Array.from(dt.types);
    return (
        types.includes('text/uri-list') ||
        types.includes('application/vnd.code.uri-list') ||
        types.includes('resourceurls')
    );
}

function isDesktopFileDrag(dt: DataTransfer): boolean {
    return Array.from(dt.types).includes('Files');
}

function updateDropHint(dt: DataTransfer | null): void {
    const hint = getDropHintEl();
    if (!hint) {
        return;
    }
    if (!dt) {
        hint.hidden = true;
        return;
    }
    if (isExplorerDrag(dt) && !isDesktopFileDrag(dt)) {
        hint.innerHTML =
            'Explorer: hold <kbd>Shift</kbd> while dropping · or right-click → <strong>Add to Chat</strong>';
        hint.hidden = false;
        return;
    }
    if (isDesktopFileDrag(dt)) {
        hint.textContent = 'Drop to attach';
        hint.hidden = false;
        return;
    }
    hint.hidden = true;
}

function hideDropHint(): void {
    const hint = getDropHintEl();
    if (hint) {
        hint.hidden = true;
    }
}

/** Drop on the message box only — bind once; reset highlight on dragend. */
export function bindChatFileDrop(): void {
    const container = document.querySelector<HTMLElement>('.input-container');
    if (!container || container.hasAttribute(BOUND_ATTR)) {
        return;
    }
    container.setAttribute(BOUND_ATTR, '1');

    let dragDepth = 0;

    const clearHighlight = () => {
        dragDepth = 0;
        container.classList.remove('drag-over');
        hideDropHint();
    };

    const onDragEnter = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragDepth++;
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'copy';
        }
        container.classList.add('drag-over');
        updateDropHint(e.dataTransfer);
    };

    const onDragOver = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'copy';
        }
        updateDropHint(e.dataTransfer);
    };

    const onDragLeave = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            container.classList.remove('drag-over');
            hideDropHint();
        }
    };

    const onDrop = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        clearHighlight();
        void handleDrop(e);
    };

    container.addEventListener('dragenter', onDragEnter);
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragleave', onDragLeave);
    container.addEventListener('drop', onDrop);

    document.addEventListener('dragend', clearHighlight);
    window.addEventListener('blur', clearHighlight);
}

async function handleDrop(e: DragEvent): Promise<void> {
    const dt = e.dataTransfer;
    if (!dt) {
        return;
    }

    const paths = extractWebviewDropPaths(dt);
    if (paths.length > 0) {
        postDropPaths(paths);
        return;
    }

    const files = dt.files;
    if (files?.length) {
        await handleNativeFiles(files);
        return;
    }

    if (isExplorerDrag(dt)) {
        vscode.postMessage({ type: 'dropAttachFailed', mimeTypes: Array.from(dt.types) });
    }
}

function postDropPaths(paths: string[]): void {
    const key = [...new Set(paths)].sort().join('\0');
    const now = Date.now();
    if (key === lastDropKey && now - dropHandledAt < 400) {
        return;
    }
    lastDropKey = key;
    dropHandledAt = now;
    vscode.postMessage({ type: 'dropFilePaths', paths: [...new Set(paths)] });
}

function extractWebviewDropPaths(dt: DataTransfer): string[] {
    const paths: string[] = [];

    for (const mime of dt.types) {
        let raw = '';
        try {
            raw = dt.getData(mime);
        } catch {
            continue;
        }
        if (!raw) {
            continue;
        }
        if (
            mime === 'text/uri-list' ||
            mime === 'application/vnd.code.uri-list' ||
            mime === 'resourceurls'
        ) {
            paths.push(...parseUriListLines(raw));
            continue;
        }
        if (mime === 'text/plain') {
            for (const line of raw.split(/\r?\n/)) {
                const p = parseDropPathLine(line);
                if (p) {
                    paths.push(p);
                }
            }
        }
    }

    return [...new Set(paths)];
}

async function handleNativeFiles(files: FileList): Promise<void> {
    const paths: string[] = [];
    const imagePromises: Promise<{ mimeType: string; dataBase64: string; name?: string } | null>[] = [];
    const textPromises: Promise<{ name: string; text: string } | null>[] = [];

    for (const file of Array.from(files)) {
        const electronPath = (file as FileWithPath).path;
        if (electronPath) {
            paths.push(electronPath);
            continue;
        }
        if (file.type.startsWith('image/')) {
            imagePromises.push(readImageFileAsItem(file));
        } else if (isLikelyTextFile(file)) {
            textPromises.push(readTextFileAsItem(file));
        }
    }

    if (paths.length > 0) {
        postDropPaths(paths);
    }

    const images = (await Promise.all(imagePromises)).filter(
        (x): x is { mimeType: string; dataBase64: string; name?: string } => x !== null,
    );
    const texts = (await Promise.all(textPromises)).filter(
        (x): x is { name: string; text: string } => x !== null,
    );

    if (images.length > 0) {
        vscode.postMessage({ type: 'addPastedImages', items: images });
    }
    if (texts.length > 0) {
        vscode.postMessage({ type: 'addDroppedTextFiles', files: texts });
    }
}
