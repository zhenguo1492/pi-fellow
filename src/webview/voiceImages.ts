/**
 * The image card under a user's message in the Bot view (voicePanel.ts): the images attached in
 * the composer. Closed, it is a strip of thumbnails and a count; a click opens it to larger tiles,
 * and a click on a tile shows that image full size over the view (the viewer), from where it also
 * opens in an editor tab. Thumbnails and tiles have fixed sizes (voice.css), so a card has its final
 * height when it is inserted and images loading never move the transcript.
 */
import { escapeHtml } from '../shared/html';
import type { ClientMessage } from '../shared/protocol';
import type { VoiceImage } from '../shared/voiceViewProtocol';
import { requestImagePreview } from './chat/attachments';
import { vscode } from './vscodeApi';

/** Thumbnails on a closed card; the images after them are counted on one more. */
const STRIP_MAX = 4;

function imgHtml(image: VoiceImage): string {
    // Outside the folders the webview may load from, the host reads the file (loadImageFiles).
    const source = image.src ? `src="${escapeHtml(image.src)}"` : `data-path="${escapeHtml(image.path)}"`;
    return `<img ${source} alt="${escapeHtml(image.name)}" draggable="false">`;
}

/** The card's markup; empty without images. `open`: the larger tiles, else the thumbnail strip. */
export function imageCardHtml(images: readonly VoiceImage[], open: boolean): string {
    if (images.length === 0) {
        return '';
    }
    const count = `${images.length} image${images.length === 1 ? '' : 's'}`;
    if (!open) {
        const thumbs = images
            .slice(0, STRIP_MAX)
            .map((image) => `<span class="vp-img-thumb">${imgHtml(image)}</span>`)
            .join('');
        const more = images.length > STRIP_MAX ? `<span class="vp-img-thumb vp-img-more">+${images.length - STRIP_MAX}</span>` : '';
        const title = escapeHtml(`${images.map((image) => image.name).join('\n')}\nClick to show larger`);
        return `<div class="vp-imgs"><button type="button" class="vp-imgs-toggle" aria-expanded="false" title="${title}">${thumbs}${more}<span class="vp-imgs-n">${count}</span></button></div>`;
    }
    const tiles = images
        .map((image, i) => {
            const name = escapeHtml(image.name);
            return `<button type="button" class="vp-img-tile" data-index="${i}" title="${name}\nClick to view full size">${imgHtml(image)}<span class="vp-img-name">${name}</span></button>`;
        })
        .join('');
    return `<div class="vp-imgs open"><button type="button" class="vp-imgs-toggle" aria-expanded="true" title="Show as thumbnails"><span class="vp-imgs-car">▼</span><span class="vp-imgs-n">${count}</span></button><div class="vp-imgs-grid${images.length === 1 ? ' one' : ''}">${tiles}</div></div>`;
}

/** Loads the images in `container` that have no webview URI from the host, once each. */
export function loadImageFiles(container: ParentNode): void {
    for (const img of container.querySelectorAll<HTMLImageElement>('img[data-path]:not([src]):not([data-loading])')) {
        img.dataset.loading = '';
        // A file that cannot be read keeps its tile, with the image's name in it.
        requestImagePreview(img.dataset.path!).then(
            (url) => {
                img.src = url;
            },
            () => {},
        );
    }
}

// ── The viewer: one image full size over the Bot view ──

const viewer = document.createElement('div');
viewer.className = 'vp-lightbox';
viewer.hidden = true;
viewer.tabIndex = -1;
viewer.setAttribute('role', 'dialog');
viewer.setAttribute('aria-modal', 'true');
viewer.setAttribute('aria-label', 'Image');
viewer.innerHTML =
    '<div class="vp-lb-bar"><span class="vp-lb-name"></span><span class="vp-lb-pos"></span>' +
    '<button type="button" class="vp-lb-btn" data-lb="open" title="Open the image in an editor tab">Open in editor</button>' +
    '<button type="button" class="vp-lb-btn" data-lb="close" title="Close (Escape)" aria-label="Close">✕</button></div>' +
    '<div class="vp-lb-stage"><button type="button" class="vp-lb-nav" data-lb="prev" title="Previous image (←)" aria-label="Previous image">‹</button>' +
    '<img class="vp-lb-img" alt="" draggable="false">' +
    '<button type="button" class="vp-lb-nav" data-lb="next" title="Next image (→)" aria-label="Next image">›</button></div>';
const viewerImg = viewer.querySelector<HTMLImageElement>('.vp-lb-img')!;
const viewerName = viewer.querySelector<HTMLElement>('.vp-lb-name')!;
const viewerPos = viewer.querySelector<HTMLElement>('.vp-lb-pos')!;

/** The images of the message shown, and which of them; undefined while the viewer is closed. */
let shown: { images: readonly VoiceImage[]; index: number } | undefined;
/** Focus goes back here when the viewer closes. */
let returnFocus: HTMLElement | undefined;

/** Puts the viewer in the Bot view, which it covers while open. */
export function mountImageViewer(host: HTMLElement): void {
    host.appendChild(viewer);
}

/** Shows image `index` of a message's `images` full size. */
export function showImage(images: readonly VoiceImage[], index: number): void {
    if (images.length === 0) {
        return;
    }
    if (!shown && document.activeElement instanceof HTMLElement) {
        returnFocus = document.activeElement;
    }
    const at = ((index % images.length) + images.length) % images.length;
    shown = { images, index: at };
    const image = images[at];
    viewerName.textContent = image.name;
    viewerName.title = image.path;
    viewerImg.alt = image.name;
    viewerPos.textContent = images.length > 1 ? `${at + 1} / ${images.length}` : '';
    for (const nav of viewer.querySelectorAll<HTMLElement>('.vp-lb-nav')) {
        nav.hidden = images.length < 2;
    }
    if (image.src) {
        viewerImg.src = image.src;
    } else {
        viewerImg.removeAttribute('src');
        requestImagePreview(image.path).then(
            (url) => {
                // Still the image shown: stepping on may have moved past it.
                if (shown?.images[shown.index] === image) {
                    viewerImg.src = url;
                }
            },
            () => {},
        );
    }
    viewer.hidden = false;
    viewer.focus();
}

export function closeImageViewer(): void {
    if (!shown) {
        return;
    }
    shown = undefined;
    viewer.hidden = true;
    viewerImg.removeAttribute('src');
    returnFocus?.focus();
    returnFocus = undefined;
}

viewer.addEventListener('click', (e) => {
    const action = (e.target as Element).closest<HTMLElement>('[data-lb]')?.dataset.lb;
    if (!shown) {
        return;
    }
    if (action === 'prev' || action === 'next') {
        showImage(shown.images, shown.index + (action === 'next' ? 1 : -1));
    } else if (action === 'open') {
        vscode.postMessage({ type: 'openFile', filePath: shown.images[shown.index].path } satisfies ClientMessage);
    } else if (action === 'close' || e.target === viewer || (e.target as Element).classList.contains('vp-lb-stage')) {
        // The backdrop around the image closes it too.
        closeImageViewer();
    }
});

viewer.addEventListener('keydown', (e) => {
    if (!shown) {
        return;
    }
    if (e.key === 'Escape') {
        closeImageViewer();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && shown.images.length > 1) {
        showImage(shown.images, shown.index + (e.key === 'ArrowRight' ? 1 : -1));
    } else {
        return;
    }
    // Escape elsewhere in the view stops a read aloud; here it only closes the image.
    e.preventDefault();
    e.stopPropagation();
});
