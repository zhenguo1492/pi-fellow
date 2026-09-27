import * as vscode from 'vscode';
import { VOICE_OFFLINE_SEND_HINT, voiceIsOn, type VoiceStatus } from '../shared/voiceViewProtocol';
import type { VoiceInput } from '../voice/voiceInput';
import type { SidebarHost } from './sidebarHost';
import type { MessageHandlers } from './sidebarMessageHandlers';
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
    ) {}

    get voiceStatus(): VoiceStatus | undefined {
        return this._voiceStatus;
    }

    /** The active tab shows the Bot view (never while it shows its TUI). */
    showsBotView(): boolean {
        const tab = this._host.tabs.get(this._host.activeTabId);
        return !!tab && !tab.tuiMode && tab.botView;
    }

    /** The Bot view with the voice agent offline: the composer takes no text, typed or dictated. */
    composerLocked(): boolean {
        return this.showsBotView() && !voiceIsOn(this._voiceStatus);
    }

    /** The mic button and Ctrl+Alt+M: no new dictation while the composer is locked; stopping always works. */
    async toggleDictation(): Promise<void> {
        if (!this._voiceInput.isRecording && this.composerLocked()) {
            this._host.post({ type: 'toast', message: VOICE_OFFLINE_SEND_HINT, variant: 'error' });
            return;
        }
        await this._voiceInput.toggle();
    }

    isBotViewVisible(): boolean {
        return !!this._view()?.visible && this.showsBotView();
    }

    /** Shows the Bot view in the active tab and reveals the chat; `onlyIfWorkerUnused` leaves a tab the worker has used alone. */
    async showBotView(preserveFocus: boolean, options: { onlyIfWorkerUnused?: boolean } = {}): Promise<void> {
        const tab = this._host.activeTab;
        // Same rule as restoring a session: no worker message yet means the tab is the voice agent's.
        if (options.onlyIfWorkerUnused && (!tab || tab.isStreaming || tab.session.messages.length > 0)) {
            return;
        }
        // A tab showing its TUI has no Bot view; the voice agent still runs from its bar.
        if (tab && !tab.botView && !tab.tuiMode) {
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
        if (!tab.tuiMode) tab.botView = !tab.botView;
        if (tabId === this._host.activeTabId) {
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

    handlers(): MessageHandlers {
        return {
            toggleDictation: async () => {
                await this.toggleDictation();
            },
            toggleBotView: (msg) => {
                this._toggleBotView(msg.tabId ?? this._host.activeTabId);
            },
        };
    }
}
