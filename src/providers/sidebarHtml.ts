import * as vscode from 'vscode';

/** The chat webview's document: its scripts and styles under a nonce-only CSP. */
export function getSidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'main.js')
    );
    const toolCardsStyleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'styles', 'toolCards.css')
    );
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'styles', 'main.css')
    );
    const xtermStyleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'styles', 'xterm.css')
    );
    const voiceStyleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'styles', 'voice.css')
    );
    const iconsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'icons')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <link rel="stylesheet" href="${toolCardsStyleUri}">
    <link rel="stylesheet" href="${xtermStyleUri}">
    <link rel="stylesheet" href="${voiceStyleUri}">
    <title>Oh My Pi Chater</title>
</head>
<body>
    <div id="app" data-icons-uri="${iconsUri}"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
