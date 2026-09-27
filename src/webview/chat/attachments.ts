import { isImageFilePath } from '../../shared/attachmentMessageDisplay';
import { escapeHtml } from '../../shared/html';
import { renderMessageAttachmentChip } from '../attachmentChipHtml';
import { vscode } from '../vscodeApi';
import { el } from './helpers';
import { scrollIfFollowing } from './scroll';

// ── Image Preview Handling ──

const imageCache = new Map<string, string>();
const pendingImageRequests = new Map<string, (dataUrl?: string, error?: string) => void>();

/** Remembers an image's data URL so later previews of `filePath` skip the host round trip. */
export function cacheImagePreview(filePath: string, dataUrl: string): void {
    imageCache.set(filePath, dataUrl);
}

export function handleImageFileData(
    requestId: string,
    filePath: string,
    dataUrl?: string,
    error?: string,
): void {
    if (dataUrl) {
        imageCache.set(filePath, dataUrl);
    }
    const resolver = pendingImageRequests.get(requestId);
    if (resolver) {
        pendingImageRequests.delete(requestId);
        resolver(dataUrl, error);
    }
}

export function requestImagePreview(filePath: string): Promise<string> {
    const cached = imageCache.get(filePath);
    if (cached) {
        return Promise.resolve(cached);
    }
    return new Promise((resolve, reject) => {
        const requestId = 'img-' + Math.random().toString(36).slice(2, 10);
        pendingImageRequests.set(requestId, (dataUrl, error) => {
            if (dataUrl) {
                resolve(dataUrl);
            } else {
                reject(new Error(error || 'Failed to load image'));
            }
        });
        vscode.postMessage({ type: 'readImageFile', filePath, requestId });
    });
}

// ── Message rendering ──

export function buildMessageAttachmentChips(
    files: Array<{ displayName: string; path: string; dataUrl?: string; startLine?: number; endLine?: number }>,
): HTMLElement {
    const row = el('div', 'message-attachments');
    for (const f of files) {
        const isImg = isImageFilePath(f.path) || Boolean(f.dataUrl);
        const itemWrap = el('div', 'message-attachment-item');
        if (isImg) {
            itemWrap.classList.add('message-attachment-item--image');
        }

        const wrap = document.createElement('div');
        wrap.innerHTML = renderMessageAttachmentChip(
            f.displayName,
            f.path,
            isImg,
            f.startLine && f.endLine ? { startLine: f.startLine, endLine: f.endLine } : undefined,
        );
        const chip = wrap.firstElementChild as HTMLElement;
        if (chip) {
            itemWrap.appendChild(chip);
        }

        if (isImg) {
            const preview = el('div', 'message-image-preview-container');
            preview.style.display = 'none';
            preview.dataset.filepath = f.path;
            if (f.dataUrl) {
                preview.dataset.dataUrl = f.dataUrl;
            }
            preview.innerHTML = `
                <div class="message-image-loading">正在读取图片…</div>
                <img class="message-image-preview" alt="${escapeHtml(f.displayName)}" title="点击收起图片" />
            `;
            itemWrap.appendChild(preview);
        }

        row.appendChild(itemWrap);
    }
    return row;
}

export function bindAttachmentOpenClicks(): void {
    const postOpen = (filePath?: string, chip?: HTMLElement) => {
        if (filePath?.trim()) {
            const startLine = Number(chip?.dataset.startLine) || undefined;
            const endLine = Number(chip?.dataset.endLine) || undefined;
            vscode.postMessage({ type: 'openFile', filePath: filePath.trim(), startLine, endLine });
        }
    };

    document
        .querySelectorAll('.message-attachment-chip[data-filepath]:not([data-open-bound])')
        .forEach((node) => {
            const chip = node as HTMLElement;
            chip.setAttribute('data-open-bound', '1');
            const filePath = chip.dataset.filepath;
            const isImage = chip.dataset.isImage === 'true';

            chip.querySelector('.attachment-open-external')?.addEventListener('click', (e) => {
                e.stopPropagation();
                postOpen(filePath);
            });

            const togglePreview = async () => {
                if (!isImage || !filePath) {
                    postOpen(filePath, chip);
                    return;
                }
                const itemWrap = chip.closest('.message-attachment-item');
                const preview = itemWrap?.querySelector(
                    '.message-image-preview-container',
                ) as HTMLElement | null;
                if (!preview) {
                    postOpen(filePath);
                    return;
                }
                const isOpening = preview.style.display === 'none';
                preview.style.display = isOpening ? 'flex' : 'none';
                chip.classList.toggle('expanded', isOpening);

                if (isOpening) {
                    const img = preview.querySelector(
                        '.message-image-preview',
                    ) as HTMLImageElement | null;
                    const loading = preview.querySelector(
                        '.message-image-loading',
                    ) as HTMLElement | null;
                    if (img && !img.src) {
                        try {
                            const dataUrl =
                                preview.dataset.dataUrl || (await requestImagePreview(filePath));
                            img.src = dataUrl;
                            if (loading) loading.style.display = 'none';
                            scrollIfFollowing();
                        } catch (err: unknown) {
                            if (loading) {
                                const message =
                                    typeof err === 'object' && err !== null && 'message' in err
                                        ? err.message
                                        : undefined;
                                loading.textContent = `无法加载图片: ${message || '未知错误'}`;
                            }
                        }
                    }
                }
            };

            chip.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.attachment-open-external')) {
                    return;
                }
                void togglePreview();
            });

            chip.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void togglePreview();
                }
            });
        });

    document
        .querySelectorAll('.message-image-preview:not([data-click-bound])')
        .forEach((node) => {
            const img = node as HTMLImageElement;
            img.setAttribute('data-click-bound', '1');
            img.addEventListener('click', () => {
                const itemWrap = img.closest('.message-attachment-item');
                const chip = itemWrap?.querySelector('.message-attachment-chip');
                const preview = itemWrap?.querySelector(
                    '.message-image-preview-container',
                ) as HTMLElement | null;
                if (preview) {
                    preview.style.display = 'none';
                    chip?.classList.remove('expanded');
                }
            });
        });

    document.querySelectorAll('.message-image[data-filepath]:not([data-open-bound])').forEach((node) => {
        const img = node as HTMLImageElement;
        img.setAttribute('data-open-bound', '1');
        img.addEventListener('click', () => postOpen(img.dataset.filepath));
    });
}

/**
 * Local path to open for an extracted image: absolute names are used as-is, otherwise the
 * basename (case-insensitive) is looked up among the message's image attachments.
 */
export function resolveImageOpenPath(
    img: { name?: string },
    imagePathsByBase: Map<string, string>,
): string | undefined {
    let filePath = img.name?.trim();
    if (!filePath) {
        return undefined;
    }
    if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) {
        return filePath;
    }
    const base = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? filePath.toLowerCase();
    return imagePathsByBase.get(base) ?? imagePathsByBase.get(filePath.toLowerCase());
}
