import * as vscode from 'vscode';

/** Starred models as `provider/id`, in starring order (`oh-my-pi-chater.favoriteModels`). */
export function readFavoriteModels(): string[] {
    const raw = vscode.workspace.getConfiguration('oh-my-pi-chater').get<unknown>('favoriteModels');
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
}

/** Star/unstar at the scope that currently defines the list (workspace override, else user). */
export async function toggleFavoriteModel(key: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('oh-my-pi-chater');
    const current = readFavoriteModels();
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    const target =
        config.inspect('favoriteModels')?.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
    await config.update('favoriteModels', next, target);
}
