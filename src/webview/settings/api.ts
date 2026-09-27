import type { SettingsClientMessage } from '../../shared/protocol';

declare function acquireVsCodeApi(): {
    postMessage(message: SettingsClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

/** VS Code allows exactly one acquireVsCodeApi() call per webview. */
export const vscode = acquireVsCodeApi();
