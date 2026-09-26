import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { VoiceViewClientMessage, VoiceViewHostMessage } from '../shared/voiceViewProtocol';

/** The Bot view in VS Code's bottom panel (package.json `viewsContainers.panel`). */
export const VOICE_VIEW_ID = 'oh-my-pi-chater.voice';

/**
 * The Bot view in the bottom panel, next to Terminal (docs/voice-agent-design.md §11.1): a webview
 * view drawing src/webview/voiceView.ts. Always available; its content comes from `VoicePanel`.
 */
export class VoicePanelView implements vscode.WebviewViewProvider, vscode.Disposable {
    private _view: vscode.WebviewView | undefined;
    private readonly _visibility = new vscode.EventEmitter<void>();
    private readonly _messages = new vscode.EventEmitter<VoiceViewClientMessage>();
    readonly onDidChangeVisibility = this._visibility.event;
    readonly onDidReceiveVoiceMessage = this._messages.event;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    isVisible(): boolean {
        return this._view?.visible ?? false;
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this._view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        view.webview.html = this._html(view.webview);
        view.webview.onDidReceiveMessage((msg: ClientMessage) => {
            if (msg.type === 'voice') {
                this._messages.fire(msg.message);
            }
        });
        view.onDidChangeVisibility(() => this._visibility.fire());
        view.onDidDispose(() => {
            if (this._view === view) {
                this._view = undefined;
                this._visibility.fire();
            }
        });
        this._visibility.fire();
    }

    postVoice(message: VoiceViewHostMessage): void {
        void this._view?.webview.postMessage({ type: 'voice', message } satisfies ServerMessage);
    }

    async reveal(preserveFocus: boolean): Promise<void> {
        if (this._view) {
            this._view.show(preserveFocus);
        } else {
            // Not resolved yet (never shown this window): focusing it resolves it.
            await vscode.commands.executeCommand(`${VOICE_VIEW_ID}.focus`);
        }
    }

    dispose(): void {
        this._visibility.dispose();
        this._messages.dispose();
    }

    private _html(webview: vscode.Webview): string {
        const nonce = randomBytes(16).toString('hex');
        const uri = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', ...path));
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${uri('styles', 'main.css')}">
    <link rel="stylesheet" href="${uri('styles', 'voice.css')}">
</head>
<body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${uri('voiceView.js')}"></script>
</body>
</html>`;
    }
}
