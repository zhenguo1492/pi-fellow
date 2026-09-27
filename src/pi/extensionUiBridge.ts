import type { ExtensionUiResponsePayload } from '../shared/extensionUi';
import type { ServerMessage } from '../shared/protocol';

type PendingDialog = {
    resolve: (value: unknown) => void;
    clearTimers: () => void;
};

/**
 * Remnant of the bundled-SDK dialog bridge (its `attach`/`createContext` fed pi-coding-agent's
 * ExtensionUIContext). RPC sessions answer dialogs through `RpcExtensionUiHandler`; nothing
 * registers dialogs here anymore. Kept only for the sidebar's remaining references.
 */
export class ExtensionUiBridge {
    private _post: ((msg: ServerMessage) => void) | undefined;
    private readonly _pending = new Map<string, PendingDialog>();

    setPost(fn: (msg: ServerMessage) => void): void {
        this._post = fn;
    }

    handleResponse(payload: ExtensionUiResponsePayload): void {
        const pending = this._pending.get(payload.id);
        if (!pending) {
            return;
        }
        pending.clearTimers();
        this._pending.delete(payload.id);

        if (payload.cancelled) {
            pending.resolve(undefined);
            return;
        }

        switch (true) {
            case payload.confirmed !== undefined:
                pending.resolve(payload.confirmed);
                break;
            default:
                pending.resolve(payload.value);
        }
    }
}
