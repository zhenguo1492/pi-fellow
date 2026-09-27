import * as vscode from 'vscode';
import type { PiOAuthLoginCallbacks } from './loadPiCodingAgent';

/** OAuth / login flows using VS Code UI instead of Pi TUI. */
export function createVscodeOAuthCallbacks(): PiOAuthLoginCallbacks {
    return {
        onAuth: (info) => {
            void vscode.env.openExternal(vscode.Uri.parse(info.url));
            const lines = [info.instructions, info.url].filter(Boolean).join('\n');
            void vscode.window.showInformationMessage(
                'Complete sign-in in your browser.',
                'Open URL',
            ).then((choice) => {
                if (choice === 'Open URL') {
                    void vscode.env.openExternal(vscode.Uri.parse(info.url));
                }
            });
            if (lines) {
                void vscode.window.showInformationMessage(lines.slice(0, 200));
            }
        },
        onDeviceCode: (info) => {
            void vscode.window.showInformationMessage(
                `Device code: ${info.userCode}\nOpen: ${info.verificationUri}`,
                'Copy code',
                'Open browser',
            ).then((choice) => {
                if (choice === 'Copy code') {
                    void vscode.env.clipboard.writeText(info.userCode);
                }
                if (choice === 'Open browser') {
                    void vscode.env.openExternal(vscode.Uri.parse(info.verificationUri));
                }
            });
        },
        onPrompt: async (prompt) => {
            const value = await vscode.window.showInputBox({
                title: 'Pi login',
                prompt: prompt.message,
                placeHolder: prompt.placeholder,
                ignoreFocusOut: true,
            });
            if (value === undefined) {
                throw new Error('Login cancelled');
            }
            return value;
        },
        onSelect: async (prompt) => {
            const pick = await vscode.window.showQuickPick(
                prompt.options.map((o) => ({ label: o.label, id: o.id })),
                { title: prompt.message, placeHolder: 'Select an option' },
            );
            return pick?.id;
        },
        onProgress: (message) => {
            void vscode.window.setStatusBarMessage(`Pi login: ${message}`, 3000);
        },
        onManualCodeInput: async () => {
            const value = await vscode.window.showInputBox({
                title: 'Pi login',
                prompt: 'Paste redirect URL or authorization code',
                ignoreFocusOut: true,
            });
            if (!value?.trim()) {
                throw new Error('Login cancelled');
            }
            return value.trim();
        },
    };
}
