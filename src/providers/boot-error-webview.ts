import * as vscode from 'vscode';

/** Minimal sidebar when Pi SDK or session init fails — panel is not blank. */
export function createBootErrorWebviewProvider(message: string): vscode.WebviewViewProvider {
    return {
        resolveWebviewView(webviewView: vscode.WebviewView): void {
            const esc = message
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            webviewView.webview.options = { enableScripts: false };
            webviewView.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 16px;
    line-height: 1.5;
    font-size: 13px;
  }
  h2 { font-size: 14px; margin: 0 0 8px; }
  code { font-size: 12px; }
</style>
</head>
<body>
  <h2>Oh My Pi Chater could not start</h2>
  <p>${esc}</p>
  <p>Open <strong>Output → Oh My Pi Chater</strong> for details, then reinstall the VSIX or run <code>npm install</code> in the extension folder.</p>
</body>
</html>`;
        },
    };
}
