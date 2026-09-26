import * as vscode from 'vscode';
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from './rpcTypes';
import type { ExtensionUiRequestPayload } from '../shared/extensionUi';
import type { ServerMessage } from '../shared/protocol';
import type { PiRpcBridge } from './piRpcBridge';
import type { PiExtensionChrome } from './piExtensionChrome';

type PendingDialog = {
    request: ExtensionUiRequestPayload;
    /** Epoch ms the request reached the extension. */
    receivedAt: number;
    resolve: (response: RpcExtensionUIResponse) => void;
    clearTimers: () => void;
};

/**
 * Answers pi RPC extension_ui_request lines on stdin so the CLI subprocess
 * does not block (select / confirm / input / editor).
 */
export class RpcExtensionUiHandler {
    private readonly _pending = new Map<string, PendingDialog>();
    private readonly _pendingListeners = new Set<() => void>();
    private _post: ((msg: ServerMessage) => void) | undefined;
    private _chrome: PiExtensionChrome | undefined;

    constructor(private readonly _bridge: PiRpcBridge) {}

    setChrome(chrome: PiExtensionChrome): void {
        this._chrome = chrome;
    }

    setPost(fn: (msg: ServerMessage) => void): void {
        this._post = fn;
    }

    dispose(): void {
        for (const pending of this._pending.values()) {
            pending.clearTimers();
            pending.resolve({ type: 'extension_ui_response', id: '', cancelled: true });
        }
        this._pending.clear();
        this._firePendingChanged();
        this._pendingListeners.clear();
    }

    /** A dialog started waiting, or stopped waiting (answered, timed out, disposed). */
    onDidChangePending(listener: () => void): { dispose(): void } {
        this._pendingListeners.add(listener);
        return { dispose: () => this._pendingListeners.delete(listener) };
    }

    private _firePendingChanged(): void {
        for (const listener of [...this._pendingListeners]) {
            listener();
        }
    }

    /** Dialogs still waiting for an answer, oldest first. */
    pendingRequests(): Array<ExtensionUiRequestPayload & { receivedAt: number }> {
        return [...this._pending.values()].map((pending) => ({ ...pending.request, receivedAt: pending.receivedAt }));
    }

    /**
     * Answer a pending dialog from the webview or voice control; the first answer wins.
     * Returns false when the request was already answered, timed out, or never existed.
     */
    respond(payload: { id: string; cancelled?: boolean; value?: string; confirmed?: boolean }): boolean {
        const pending = this._pending.get(payload.id);
        if (!pending) {
            return false;
        }
        pending.clearTimers();
        this._pending.delete(payload.id);
        this._firePendingChanged();
        // No-op when the webview answered itself; closes its dialog when voice control answered.
        this._post?.({ type: 'extensionUiDismiss', id: payload.id });

        const { id } = payload;
        if (payload.cancelled) {
            this._bridge.sendExtensionUiResponse({ type: 'extension_ui_response', id, cancelled: true });
        } else if (payload.confirmed !== undefined) {
            this._bridge.sendExtensionUiResponse({ type: 'extension_ui_response', id, confirmed: payload.confirmed });
        } else {
            this._bridge.sendExtensionUiResponse({ type: 'extension_ui_response', id, value: payload.value ?? '' });
        }
        return true;
    }

    handleRequest(req: RpcExtensionUIRequest): void {
        switch (req.method) {
            case 'notify': {
                const t = req.notifyType ?? 'info';
                const msg = req.message;
                if (t === 'error') {
                    void vscode.window.showErrorMessage(msg);
                } else if (t === 'warning') {
                    void vscode.window.showWarningMessage(msg);
                } else {
                    void vscode.window.showInformationMessage(msg);
                }
                return;
            }
            case 'setStatus':
                this._chrome?.setStatus(req.statusKey, req.statusText);
                return;
            case 'setWidget':
                this._chrome?.setWidget(req.widgetKey, req.widgetLines, req.widgetPlacement);
                return;
            case 'setTitle':
                this._chrome?.setTitle(req.title);
                return;
            case 'set_editor_text':
                this._post?.({ type: 'setComposerText', text: req.text });
                return;
            case 'select':
                void this._dialog(req, { title: req.title, options: req.options });
                return;
            case 'confirm':
                void this._dialog(req, { title: req.title, message: req.message });
                return;
            case 'input':
                void this._dialog(req, { title: req.title, placeholder: req.placeholder });
                return;
            case 'editor':
                void this._dialog(req, { title: req.title, prefill: req.prefill });
                return;
            default:
                return;
        }
    }

    private async _dialog(
        req: RpcExtensionUIRequest,
        fields: Omit<ExtensionUiRequestPayload, 'id' | 'method'>,
    ): Promise<void> {
        const method = req.method as ExtensionUiRequestPayload['method'];
        const id = req.id;
        const request: ExtensionUiRequestPayload = { id, method, ...fields };

        if (req.timeout) {
            const timer = setTimeout(() => {
                this._post?.({ type: 'extensionUiDismiss', id });
                this._finish(id, { type: 'extension_ui_response', id, cancelled: true });
            }, req.timeout);
            this._pending.set(id, {
                request,
                receivedAt: Date.now(),
                resolve: (r) => this._bridge.sendExtensionUiResponse(r),
                clearTimers: () => clearTimeout(timer),
            });
        } else {
            this._pending.set(id, {
                request,
                receivedAt: Date.now(),
                resolve: (r) => this._bridge.sendExtensionUiResponse(r),
                clearTimers: () => {},
            });
        }
        this._firePendingChanged();

        if (this._post) {
            this._post({ type: 'extensionUiRequest', request });
        } else {
            await this._fallbackVscodeDialog(req);
        }
    }

    private _finish(id: string, response: RpcExtensionUIResponse): void {
        const pending = this._pending.get(id);
        if (!pending) {
            this._bridge.sendExtensionUiResponse(response);
            return;
        }
        pending.clearTimers();
        this._pending.delete(id);
        this._firePendingChanged();
        pending.resolve(response);
    }

    /** When webview is not ready, use VS Code native dialogs so RPC never deadlocks. */
    private async _fallbackVscodeDialog(req: RpcExtensionUIRequest): Promise<void> {
        const id = req.id;
        try {
            switch (req.method) {
                case 'select': {
                    const pick = await vscode.window.showQuickPick(req.options ?? [], {
                        title: req.title,
                        canPickMany: false,
                    });
                    if (!pick) {
                        this._finish(id, { type: 'extension_ui_response', id, cancelled: true });
                    } else {
                        this._finish(id, { type: 'extension_ui_response', id, value: pick });
                    }
                    return;
                }
                case 'confirm': {
                    const choice = await vscode.window.showInformationMessage(
                        req.message ?? '',
                        { modal: true },
                        'Yes',
                        'No',
                    );
                    this._finish(id, {
                        type: 'extension_ui_response',
                        id,
                        confirmed: choice === 'Yes',
                    });
                    return;
                }
                case 'input':
                case 'editor': {
                    const value = await vscode.window.showInputBox({
                        title: req.title,
                        value: req.method === 'editor' ? req.prefill : undefined,
                        prompt: req.placeholder,
                        ignoreFocusOut: true,
                    });
                    if (value === undefined) {
                        this._finish(id, { type: 'extension_ui_response', id, cancelled: true });
                    } else {
                        this._finish(id, { type: 'extension_ui_response', id, value });
                    }
                    return;
                }
            }
        } catch {
            this._finish(id, { type: 'extension_ui_response', id, cancelled: true });
        }
    }
}
