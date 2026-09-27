import * as path from 'node:path';
import * as vscode from 'vscode';
import { createVscodeOAuthCallbacks } from './oauthCallbacks';
import { getPiAgentDir, resolveCliTarget } from './piCliPaths';
import { loadPiCodingAgent, loadPiInteractiveHelpers, type PiOAuthLoginCallbacks } from './loadPiCodingAgent';
import type { PiRpcSessionManager } from './rpcSession';
import type { TuiAuthCommand } from '../shared/protocol';
import type { PiChatSession } from './slashCommands';

const BEDROCK_PROVIDER_ID = 'amazon-bedrock';

type AuthType = 'oauth' | 'api_key';

type ProviderOption = {
    id: string;
    name: string;
    authType: AuthType;
};

async function createAuthContext() {
    const pi = await loadPiCodingAgent();
    const authPath = path.join(getPiAgentDir(), 'auth.json');
    const authStorage = pi.AuthStorage.create(authPath);
    const modelRegistry = pi.ModelRegistry.create(authStorage);
    const { isApiKeyLoginProvider } = await loadPiInteractiveHelpers();
    return { authStorage, modelRegistry, isApiKeyLoginProvider };
}

async function getLoginProviderOptions(
    authType: AuthType | undefined,
): Promise<ProviderOption[]> {
    const { authStorage, modelRegistry, isApiKeyLoginProvider } = await createAuthContext();
    const oauthProviders = authStorage.getOAuthProviders();
    const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
    const options: ProviderOption[] = oauthProviders.map((provider) => ({
        id: provider.id,
        name: provider.name,
        authType: 'oauth',
    }));

    const modelProviders = new Set(modelRegistry.getAll().map((model) => model.provider));
    for (const providerId of modelProviders) {
        if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
            continue;
        }
        options.push({
            id: providerId,
            name: modelRegistry.getProviderDisplayName(providerId),
            authType: 'api_key',
        });
    }

    const filtered = authType ? options.filter((option) => option.authType === authType) : options;
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

async function getLogoutProviderOptions(): Promise<ProviderOption[]> {
    const { authStorage, modelRegistry } = await createAuthContext();
    const options: ProviderOption[] = [];
    for (const providerId of authStorage.list()) {
        const credential = authStorage.get(providerId);
        if (!credential) {
            continue;
        }
        options.push({
            id: providerId,
            name: modelRegistry.getProviderDisplayName(providerId),
            authType: credential.type,
        });
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
}

function createOAuthLoginCallbacks(usesCallbackServer: boolean): PiOAuthLoginCallbacks {
    const base = createVscodeOAuthCallbacks();
    if (!usesCallbackServer) {
        return base;
    }

    let manualResolve: ((value: string) => void) | undefined;
    let manualReject: ((error: Error) => void) | undefined;
    const manualCodePromise = new Promise<string>((resolve, reject) => {
        manualResolve = resolve;
        manualReject = reject;
    });

    return {
        ...base,
        onAuth: (info) => {
            base.onAuth(info);
            void vscode.window
                .showInputBox({
                    title: 'Pi login',
                    prompt: 'Paste redirect URL below, or complete login in your browser',
                    ignoreFocusOut: true,
                })
                .then((value) => {
                    if (value?.trim()) {
                        manualResolve?.(value.trim());
                        return;
                    }
                    manualReject?.(new Error('Login cancelled'));
                });
        },
        onManualCodeInput: () => manualCodePromise,
    };
}

async function runOAuthLogin(providerId: string, providerName: string): Promise<void> {
    const { authStorage, modelRegistry } = await createAuthContext();
    const providerInfo = authStorage.getOAuthProviders().find((provider) => provider.id === providerId);
    const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;
    await authStorage.login(providerId, createOAuthLoginCallbacks(usesCallbackServer));
    modelRegistry.refresh();
    vscode.window.showInformationMessage(`Logged in to ${providerName}`);
}

async function runApiKeyLogin(providerId: string, providerName: string): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
        title: `Pi login: ${providerName}`,
        prompt: 'Enter API key',
        password: true,
        ignoreFocusOut: true,
    });
    if (apiKey === undefined) {
        return;
    }
    const trimmed = apiKey.trim();
    if (!trimmed) {
        throw new Error('API key cannot be empty.');
    }
    const { authStorage, modelRegistry } = await createAuthContext();
    authStorage.set(providerId, { type: 'api_key', key: trimmed });
    modelRegistry.refresh();
    vscode.window.showInformationMessage(`Saved API key for ${providerName}`);
}

async function refreshRpcSessionAfterAuth(manager?: PiChatSession): Promise<void> {
    const rpc = manager as PiRpcSessionManager | undefined;
    if (!rpc || typeof rpc.reloadPiAgentResources !== 'function' || !rpc.isReady) {
        return;
    }
    await rpc.reloadPiAgentResources();
}

/**
 * omp exposes neither the pi Node SDK nor /login over RPC; its own TUI picker (subscriptions and
 * API keys, with logged-in marks) is the only full login UI. Hand off to the chat's TUI mode.
 * Returns false for pi, which logs in through the VS Code pickers below.
 */
async function promptOmpTuiAuth(command: TuiAuthCommand, manager?: PiChatSession): Promise<boolean> {
    if ((manager?.backend ?? resolveCliTarget().backend) !== 'omp') {
        return false;
    }
    await vscode.commands.executeCommand('oh-my-pi-chater.promptTuiAuth', command);
    return true;
}

/** Configure provider auth via VS Code UI (same result as terminal `pi` /login). */
export async function runPiAuthLogin(manager?: PiChatSession): Promise<void> {
    if (await promptOmpTuiAuth('login', manager)) {
        return;
    }

    const authMethod = await vscode.window.showQuickPick(
        [
            { label: 'Use a subscription', authType: 'oauth' as const },
            { label: 'Use an API key', authType: 'api_key' as const },
        ],
        { title: 'Pi login', placeHolder: 'Select authentication method' },
    );
    if (!authMethod) {
        return;
    }

    const providers = await getLoginProviderOptions(authMethod.authType);
    if (providers.length === 0) {
        const msg =
            authMethod.authType === 'oauth'
                ? 'No subscription providers available.'
                : 'No API key providers available.';
        vscode.window.showWarningMessage(msg);
        return;
    }

    const pick = await vscode.window.showQuickPick(
        providers.map((provider) => ({
            label: provider.name,
            description: provider.authType === 'oauth' ? 'OAuth / subscription' : 'API key',
            provider,
        })),
        { title: 'Pi login', placeHolder: 'Select provider to configure' },
    );
    if (!pick) {
        return;
    }

    const { provider } = pick;
    try {
        if (provider.authType === 'oauth') {
            await runOAuthLogin(provider.id, provider.name);
        } else if (provider.id === BEDROCK_PROVIDER_ID) {
            vscode.window.showInformationMessage(
                'Amazon Bedrock setup requires extra fields. Open ~/.pi/agent/auth.json or run `pi` in a terminal for the full Bedrock wizard.',
            );
            await vscode.commands.executeCommand('oh-my-pi-chater.openSettings');
            return;
        } else {
            await runApiKeyLogin(provider.id, provider.name);
        }
        await refreshRpcSessionAfterAuth(manager);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== 'Login cancelled') {
            vscode.window.showErrorMessage(`Login failed: ${msg}`);
        }
    }
}

/** Remove stored credentials (same as terminal `pi` /logout). */
export async function runPiAuthLogout(manager?: PiChatSession): Promise<void> {
    if (await promptOmpTuiAuth('logout', manager)) {
        return;
    }

    const providers = await getLogoutProviderOptions();
    if (providers.length === 0) {
        vscode.window.showInformationMessage(
            'No stored credentials to remove. /logout only removes credentials saved by /login.',
        );
        return;
    }

    const pick = await vscode.window.showQuickPick(
        providers.map((provider) => ({
            label: provider.name,
            description: provider.authType === 'oauth' ? 'OAuth' : 'API key',
            provider,
        })),
        { title: 'Pi logout', placeHolder: 'Select provider to log out' },
    );
    if (!pick) {
        return;
    }

    try {
        const { authStorage, modelRegistry } = await createAuthContext();
        authStorage.logout(pick.provider.id);
        modelRegistry.refresh();
        const message =
            pick.provider.authType === 'oauth'
                ? `Logged out of ${pick.provider.name}`
                : `Removed stored API key for ${pick.provider.name}`;
        vscode.window.showInformationMessage(message);
        await refreshRpcSessionAfterAuth(manager);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Logout failed: ${msg}`);
    }
}
