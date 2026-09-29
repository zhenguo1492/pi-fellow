/** Extension UI dialog bridged to the sidebar webview (plan_mode_question, etc.). */

export type ExtensionUiMethod = 'select' | 'confirm' | 'input' | 'editor';

export interface ExtensionUiRequestPayload {
    id: string;
    method: ExtensionUiMethod;
    title?: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    prefill?: string;
}

/** What a dialog asks, without the id its answer goes back with. */
export type ExtensionUiQuestion = Omit<ExtensionUiRequestPayload, 'id'>;

/**
 * A dialog card in the webview: a question to answer, or (`screen`) a tab's TUI waiting on something
 * no card can answer, shown as its screen text with a button that shows the TUI.
 */
export type ExtensionUiCard = ExtensionUiRequestPayload | { id: string; method: 'screen'; tabId: string; title: string; message: string };

export interface ExtensionUiResponsePayload {
    id: string;
    cancelled?: boolean;
    value?: string;
    confirmed?: boolean;
}

/**
 * Where a card's answer goes. The cards are one UI; a chat tab's worker gets the answer back over RPC
 * (`RpcExtensionUiHandler`), a tab showing its TUI gets it typed in as keys (`TuiDialogs`). False when
 * the dialog is no longer waiting.
 */
export interface ExtensionUiAnswerer {
    respond(payload: ExtensionUiResponsePayload): boolean;
}
