import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePiCliInvocation } from './piCliPaths';

/** pi-ai `OAuthLoginCallbacks`: how `AuthStorage.login` drives the sign-in UI. */
export interface PiOAuthLoginCallbacks {
    onAuth(info: { url: string; instructions?: string }): void;
    onDeviceCode?(info: { userCode: string; verificationUri: string }): void;
    onPrompt(prompt: { message: string; placeholder?: string }): Promise<string>;
    onSelect?(prompt: { message: string; options: Array<{ id: string; label: string }> }): Promise<string | undefined>;
    onProgress?(message: string): void;
    onManualCodeInput?(): Promise<string>;
}

interface PiAuthStorage {
    getOAuthProviders(): Array<{ id: string; name: string; usesCallbackServer?: boolean }>;
    /** Providers with stored credentials. */
    list(): string[];
    get(providerId: string): { type: 'oauth' | 'api_key' } | undefined;
    set(providerId: string, credential: { type: 'api_key'; key: string }): void;
    login(providerId: string, callbacks: PiOAuthLoginCallbacks): Promise<void>;
    logout(providerId: string): void;
}

interface PiModelRegistry {
    getAll(): Array<{ provider: string }>;
    getProviderDisplayName(providerId: string): string;
    refresh(): void;
}

/**
 * The part of pi-coding-agent's `index.js` the VS Code /login and /logout flows use. This is the
 * synchronous auth API of pi <= 0.80; pi 0.81 replaced it (no `getOAuthProviders`/`login`).
 */
export interface PiCodingAgentModule {
    AuthStorage: { create(authPath: string): PiAuthStorage };
    ModelRegistry: { create(authStorage: PiAuthStorage): PiModelRegistry };
}

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
