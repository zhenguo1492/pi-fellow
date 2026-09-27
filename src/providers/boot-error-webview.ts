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

const OMP_INSTALL_URL = 'https://omp.sh';
const PI_INSTALL_URL = 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent';

/** Sidebar shown when neither omp nor pi is installed: how to install one, then reload. */
export function createCliMissingWebviewProvider(): vscode.WebviewViewProvider {
    const reloadUri = 'command:workbench.action.reloadWindow';
    const cliPathUri = `command:workbench.action.openSettings?${encodeURIComponent(JSON.stringify('oh-my-pi-chater.cliPath'))}`;
    return {
        resolveWebviewView(webviewView: vscode.WebviewView): void {
            webviewView.webview.options = { enableScripts: false, enableCommandUris: true };
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
  h3 { font-size: 13px; margin: 16px 0 4px; }
  pre {
    margin: 4px 0;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  a { color: var(--vscode-textLink-foreground); }
  .button {
    display: inline-block;
    margin-top: 16px;
    padding: 4px 12px;
    border-radius: 2px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    text-decoration: none;
  }
  .button:hover { background: var(--vscode-button-hoverBackground); }
  .muted { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h2>Install omp or pi to start chatting</h2>
  <p>Oh My Pi Chater drives an agent CLI, and neither <code>omp</code> nor <code>pi</code> was found on this machine. Install one of them:</p>
  <h3>omp (Oh My Pi, recommended) — <a href="${OMP_INSTALL_URL}">omp.sh</a></h3>
  <pre>curl -fsSL https://omp.sh/install | sh</pre>
  <pre>bun install -g @oh-my-pi/pi-coding-agent</pre>
  <h3>pi — <a href="${PI_INSTALL_URL}">npm</a></h3>
  <pre>npm install -g @earendil-works/pi-coding-agent</pre>
  <a class="button" href="${reloadUri}">Reload Window</a>
  <p class="muted">Installed already but VS Code can't see it (e.g. launched from the desktop without your shell PATH)? Set <a href="${cliPathUri}">oh-my-pi-chater.cliPath</a> to the executable, then reload.</p>
</body>
</html>`;
        },
    };
}
