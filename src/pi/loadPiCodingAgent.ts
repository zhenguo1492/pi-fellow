import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePiCliInvocation } from './piCliPaths';

export type PiCodingAgentModule = typeof import('@earendil-works/pi-coding-agent');

let cached: Promise<PiCodingAgentModule> | undefined;

/** cli.js of the user's `pi` install; the Node SDK does not exist for the omp binary. */
async function resolvePiCliJs(): Promise<string> {
    const invocation = await resolvePiCliInvocation();
    if (invocation.backend === 'omp') {
        throw new Error(
            'This action uses the pi Node SDK, which the omp backend does not ship. Run `omp` in a terminal for it, or set oh-my-pi-chater.backend to "pi".',
        );
    }
    return invocation.cliJsPath;
}

/** Load pi-coding-agent from the same install as the user's `pi` CLI (not bundled in the extension). */
export async function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
    if (!cached) {
        cached = (async () => {
            const indexPath = path.join(path.dirname(await resolvePiCliJs()), 'index.js');
            return import(pathToFileURL(indexPath).href) as Promise<PiCodingAgentModule>;
        })();
        // Do not pin a rejection (e.g. omp active) — allow retry after the backend changes.
        cached.catch(() => {
            cached = undefined;
        });
    }
    return cached;
}

export async function loadPiInteractiveHelpers(): Promise<{
    isApiKeyLoginProvider: (
        providerId: string,
        oauthProviderIds: Set<string>,
    ) => boolean;
}> {
    const modulePath = path.join(path.dirname(await resolvePiCliJs()), 'modes/interactive/interactive-mode.js');
    const mod = (await import(pathToFileURL(modulePath).href)) as {
        isApiKeyLoginProvider: (
            providerId: string,
            oauthProviderIds: Set<string>,
        ) => boolean;
    };
    return { isApiKeyLoginProvider: mod.isApiKeyLoginProvider };
}
