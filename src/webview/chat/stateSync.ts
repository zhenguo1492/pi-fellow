import type { SerializedAgentState } from '../../shared/protocol';
import { applyVoiceMicStatus, setSttCheck } from '../dictation';
import { setPickerCurrentModel } from '../modelPicker';
import { syncTuiView } from '../tuiView';
import { applyVoiceBarStatus, setBotViewShown, setVoiceReadiness } from '../voiceBar';
import { state } from './state';
import { resetUserScroll, scrollToBottom, updateScrollButton } from './scroll';
import { updateChangedFiles } from './changedFiles';
import { updateConnectionBanner, updateTuiAuthBanner } from './banners';
import { updatePendingMessagesInChat } from './pendingMessages';
import { updateMessages } from './transcript';
import { setStreamPhase, updateStreamingUI } from './streaming';
import { updateQueuedMessageBanner } from './queuedBanner';
import { updateAttachmentsStrip } from './composerChips';
import { clearComposerEdit, getComposerEdit, restoreComposerDraft, stashComposerDraft, updateInputArea } from './composer';
import { updateTabs } from './tabs';
import { updateModeSwitch, updatePlanPanel } from './plan';
import { updateEffortControl, updatePermissionControl } from './permission';
import { syncToolApprovalCards } from './toolApproval';
import { isSkeletonBuilt, render, updateTuiToggle } from './layout';

export function applyStateSync(s: SerializedAgentState): void {
    const prevTab = state.activeTabId;
    const tabSwitched = prevTab !== (s.activeTabId ?? '');
    if (tabSwitched) stashComposerDraft(prevTab);
    const prevStreamingText = state.streamingText;
    const prevStreamingThinking = state.streamingThinking;
    const prevIsThinking = state.isThinking;
    state.messages = s.messages ?? [];
    state.isStreaming = s.isStreaming;
    state.model = s.model;
    state.thinkingLevel = s.thinkingLevel;
    state.tools = s.tools ?? [];
    state.sessionId = s.sessionId;
    state.sessionName = s.sessionName;
    state.contextUsage = s.contextUsage;
    state.sessionTokens = s.sessionTokens;
    state.fileChanges = s.fileChanges ?? [];
    state.rollbackPoint = s.rollbackPoint ?? null;
    state.tabs = s.tabs ?? [];
    state.activeTabId = s.activeTabId ?? '';
    state.streamingText = s.streamingText ?? '';
    state.streamingThinking = s.streamingThinking ?? '';
    state.isThinking = s.isThinking ?? false;
    state.thinkingStartTime = s.thinkingStartTime ?? 0;
    state.streamingThinkingDuration = s.streamingThinkingDuration ?? 0;
    // During live streaming the webview often has fresher partial text than RPC stateSync.
    if (s.isStreaming && !tabSwitched) {
        if (prevStreamingText.length > state.streamingText.length) {
            state.streamingText = prevStreamingText;
        }
        if (prevStreamingThinking.length > state.streamingThinking.length) {
            state.streamingThinking = prevStreamingThinking;
        }
        if (prevIsThinking && !state.isThinking) {
            state.isThinking = prevIsThinking;
        }
    }
    state.queuedMessages = s.queuedMessages ?? [];
    state.steeringMessages = s.steeringMessages ?? [];
    state.followUpMessages = s.followUpMessages ?? [];
    state.pendingAttachments = s.pendingAttachments ?? [];
    state.planMode = s.planMode ?? state.planMode;
    state.piExtensionChrome = s.piExtensionChrome ?? state.piExtensionChrome;
    state.permissionLevel = s.permissionLevel ?? state.permissionLevel;
    state.pendingToolApprovals = s.pendingToolApprovals ?? [];
    state.connectionStatus = s.connectionStatus ?? { phase: 'idle' };
    state.restoringHistory = s.restoringHistory ?? false;
    if (s.activeBackend) {
        state.activeBackend = s.activeBackend;
    }
    state.tuiMode = state.tabs.some((t) => t.isActive && t.tuiMode);
    state.tuiAuthPrompt = s.tuiAuthPrompt;
    if (s.voiceReadiness) {
        setSttCheck(s.voiceReadiness.stt);
        setVoiceReadiness(s.voiceReadiness);
    }
    applyVoiceMicStatus(s.voice);
    applyVoiceBarStatus(s.voice);
    // The composer talks to what the tab shows and is locked in the Bot view while voice is off.
    const botView = !state.tuiMode && state.tabs.some((t) => t.isActive && t.botView);
    setBotViewShown(botView);

    if (tabSwitched || !isSkeletonBuilt()) {
        render();
        if (tabSwitched) restoreComposerDraft(state.activeTabId);
        resetUserScroll();
        scrollToBottom(true);
        updateScrollButton();
    } else {
        updateTabs();
        updateStreamingUI();
        updateMessages();
        updateInputArea();
        updatePermissionControl();
        syncToolApprovalCards();
        updateModeSwitch();
        updateChangedFiles();
        updateQueuedMessageBanner();
        updatePendingMessagesInChat();
        updateAttachmentsStrip();
        updateConnectionBanner();
        updatePlanPanel();
        updateScrollButton();
    }
    // Clear only the incoming tab's edit context, after restoring its draft.
    if (botView && getComposerEdit()) {
        clearComposerEdit();
    }
    if (state.isStreaming) {
        if (state.isThinking) {
            setStreamPhase('thinking');
        } else if (state.streamingText) {
            setStreamPhase('writing');
        } else {
            setStreamPhase('waiting');
        }
    } else {
        setStreamPhase('idle');
    }
    updateTuiAuthBanner();
    setPickerCurrentModel(state.model);
    updateEffortControl();
    updateTuiToggle();
    syncTuiView(state.tabs.filter((t) => t.tuiMode).map((t) => t.id), state.activeTabId);
    document.getElementById('app')?.classList.toggle('bot-mode', botView);
}
