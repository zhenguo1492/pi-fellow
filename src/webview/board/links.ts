/**
 * Links on the board. A webview does not follow them itself, so every link click (the page's and a
 * diagram's) is stopped here and its href handed to the host, which opens files in the editor and web
 * pages in the browser (parseBoardLink in src/shared/board.ts). The href shows as the link's tooltip.
 */
export function initLinks(root: HTMLElement, open: (href: string) => void): void {
    const linkOf = (event: Event) => (event.target instanceof Element ? event.target.closest('a[href]') : null);
    root.addEventListener('click', (event) => {
        const link = linkOf(event);
        if (link) {
            event.preventDefault();
            open(link.getAttribute('href') ?? '');
        }
    });
    // A middle click would otherwise ask the webview to open the link itself.
    root.addEventListener('auxclick', (event) => {
        if (linkOf(event)) {
            event.preventDefault();
        }
    });
    root.addEventListener('mouseover', (event) => {
        const link = linkOf(event);
        if (link && !link.hasAttribute('title')) {
            link.setAttribute('title', link.getAttribute('href') ?? '');
        }
    });
}
