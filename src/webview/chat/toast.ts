import { el } from './helpers';

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, variant: 'info' | 'error' = 'info'): void {
    let toast = document.getElementById('chat-toast');
    if (!toast) {
        toast = el('div', 'chat-toast');
        toast.id = 'chat-toast';
        document.getElementById('app')?.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = `chat-toast chat-toast--${variant}`;
    toast.style.display = '';
    clearTimeout(toastTimer ?? undefined);
    toastTimer = setTimeout(() => {
        toast!.style.display = 'none';
    }, 2200);
}

/** Copy trimmed text to the clipboard and confirm with a toast; no-op for blank text. */
export function copyPlainText(text: string): void {
    const t = text.trim();
    if (!t) {
        return;
    }
    void navigator.clipboard.writeText(t).then(() => {
        showToast('Copied to clipboard');
    });
}
