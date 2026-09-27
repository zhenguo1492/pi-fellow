let cachedIconsBaseUri: string | undefined;

/** Base URI of the bundled icon assets (`#app[data-icons-uri]`), read once on first use. */
export function iconsBaseUri(): string {
    if (cachedIconsBaseUri === undefined) {
        cachedIconsBaseUri = document.getElementById('app')?.dataset.iconsUri ?? '';
    }
    return cachedIconsBaseUri;
}
