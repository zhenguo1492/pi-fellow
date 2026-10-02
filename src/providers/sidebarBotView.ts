import * as vscode from 'vscode';
import { voiceIsOn, type VoiceStatus } from '../shared/voiceViewProtocol';
import type { VoiceInput } from '../voice/voiceInput';
import type { SidebarHost } from './sidebarHost';
import type { MessageHandlers } from './sidebarMessageHandlers';
import { tabReady } from './sidebarTabState';
import type { SidebarTabs } from './sidebarTabs';

/** The Bot view a tab shows in place of its conversation, and the composer mic it shares with voice mode. */
export class SidebarBotView {
    /** `isBotViewVisible()` when last checked; a change fires `onDidChangeBotViewVisibility`. */
    private _botViewShown = false;
    /** The voice agent's last state; while it is on (or starting) it owns the microphone, so dictation is off. */
    private _voiceStatus: VoiceStatus | undefined;

    constructor(
        private readonly _host: SidebarHost,
        private readonly _view: () => vscode.WebviewView | undefined,
        private readonly _voiceInput: VoiceInput,
        private readonly _tabs: SidebarTabs,
        private readonly _botViewVisibility: vscode.EventEmitter<void>,
        /** Starts voice mode, as the phone button's `start` does. */
        private readonly _startVoice: () => void,
    ) {}

    get voiceStatus(): VoiceStatus | undefined {
        return this._voiceStatus;
    }

    /** The active tab shows the Bot view; in a TUI tab, in place of the terminal, whose TUI keeps running. */
    showsBotView(): boolean {
        const tab = this._host.tabs.get(this._host.activeTabId);
        return !!tab && tab.botView;
    }

    /** The mic button and the Toggle Voice Input command. */
    async toggleDictation(): Promise<void> {
        await this._voiceInput.toggle();
    }

    /**
     * The Bot view's content is on screen: the active tab shows it, or every tab is closed and the
     * chat's empty state shows its intro (which needs the snapshots' engines).
     */
    isBotViewVisible(): boolean {
        return !!this._view()?.visible && (this.showsBotView() || !this._host.activeTab);
    }

    /** Shows the Bot view in the active tab and reveals the chat; `onlyIfWorkerUnused` leaves a tab the worker has used alone. */
    async showBotView(preserveFocus: boolean, options: { onlyIfWorkerUnused?: boolean } = {}): Promise<void> {
        const tab = this._host.activeTab;
        // Same rule as restoring a session: no worker message yet means the tab is the voice agent's.
        // A TUI tab's messages are in its TUI, not in the idle RPC session: it keeps showing the terminal.
        if (options.onlyIfWorkerUnused && (!tab || tab.tuiMode || tab.isStreaming || tab.session.messages.length > 0)) {
            return;
        }
        if (tab && !tab.botView) {
            tab.botView = true;
            this._host.sendStateSync();
        }
        const view = this._view();
        if (view) {
            view.show(preserveFocus);
        } else {
            // Not resolved yet (never shown this window): focusing it resolves it.
            await vscode.commands.executeCommand('oh-my-pi-chater.chat.focus');
        }
    }

    private _toggleBotView(tabId: string): void {
        const tab = this._host.tabs.get(tabId);
        if (!tab) return;
        // A TUI tab toggles between its terminal and the Bot view; the TUI keeps running behind it.
        tab.botView = !tab.botView;
        if (tabId === this._host.activeTabId) {
            this._host.sendStateSync();
        } else {
            this._tabs.switchTab(tabId);
        }
    }

    /** A fallback dialog card's button: the tab's terminal, not the Bot view over it, in view. */
    private _showTui(tabId: string): void {
        const tab = this._host.tabs.get(tabId);
        if (!tab?.tuiMode) return;
        tab.botView = false;
        if (tabId === this._host.activeTabId) {
            // The sync also focuses the terminal.
            this._host.sendStateSync();
        } else {
            this._tabs.switchTab(tabId);
        }
    }

    syncBotViewVisibility(): void {
        const shown = this.isBotViewVisible();
        if (shown !== this._botViewShown) {
            this._botViewShown = shown;
            this._botViewVisibility.fire();
        }
    }

    /** Voice mode owns the microphone while on or starting: stop dictation; the composer mic shows its level instead. */
    setVoiceStatus(status: VoiceStatus): void {
        const wasOn = voiceIsOn(this._voiceStatus);
        const on = voiceIsOn(status);
        this._voiceStatus = status;
        if (on !== wasOn) {
            void this._voiceInput.setBlocked(on);
        }
        this._host.post({ type: 'voiceStatus', status });
    }

    /**
     * The empty state's Call button: a call needs a tab, so a new one first, then voice mode once its
     * worker is up. Nothing when the user closed the tab or moved to another one meanwhile; a worker
     * that failed to start rejects, and the chat shows the error.
     */
    private async _callInNewTab(): Promise<void> {
        const tab = await this._tabs.createTab();
        await tabReady(tab);
        if (this._host.activeTab === tab) {
            this._startVoice();
        }
    }

    handlers(): MessageHandlers {
        return {
            toggleDictation: async () => {
                await this.toggleDictation();
            },
            toggleBotView: (msg) => {
                this._toggleBotView(msg.tabId ?? this._host.activeTabId);
            },
            showTui: (msg) => {
                this._showTui(msg.tabId);
            },
            callInNewTab: () => this._callInNewTab(),
        };
    }
}
