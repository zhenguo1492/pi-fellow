import type { ServerMessage } from '../../shared/protocol';
import { pushTalkLevel } from '../avatarMotion';
import { applyDictationStatus, applyVoiceMicStatus, insertDictatedText } from '../dictation';
import { dismissExtensionUi, showExtensionUiRequest } from '../extensionUi';
import { applyContextBreakdown, applyModelStatus } from '../modelStatus';
import { setPickerCurrentModel, setPickerModels } from '../modelPicker';
import { applySessionList, setSessionPanelOpen } from '../sessionPanel';
import { applyTreePayload, setTreePanelOpen } from '../treePanel';
import { markTuiExited, restoreTuiSnapshot, writeTuiData } from '../tuiView';
import { applyVoiceBarStatus } from '../voiceBar';
import { handleVoiceMessage } from '../voicePanel';
import { pushWave } from '../voiceWave';
import { vscode } from '../vscodeApi';
import { state } from './state';
import { showToast } from './toast';
import { renderChangedFilesBar, renderInlineFileChange } from './changedFiles';
import { removeToolApprovalCard, renderToolApprovalCard } from './toolApproval';
import { showError } from './banners';
import { handleImageFileData } from './attachments';
import { refreshWelcome } from './transcript';
import { setEditorContext } from './composerChips';
import { updateInputArea } from './composer';
import { updateExtensionChromeStrip, updatePlanPanel } from './plan';
import { applyStateSync } from './stateSync';
import { handleAgentEvent } from './agentEvents';

export function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
        case 'ready':
            vscode.postMessage({ type: 'getState' });
            vscode.postMessage({ type: 'getSkills' });
            vscode.postMessage({ type: 'getSlashCommands' });
            vscode.postMessage({ type: 'getModels' });
            break;
        case 'stateSync':
            applyStateSync(msg.state);
            break;
        case 'modelStatus':
            applyModelStatus(msg.status);
            break;
        case 'contextBreakdown':
            applyContextBreakdown(msg.breakdown, msg.error);
            break;
        case 'editorContext':
            setEditorContext(msg.context, msg.enabled);
            break;
        case 'voiceStatus':
            applyVoiceMicStatus(msg.status);
            applyVoiceBarStatus(msg.status);
            updateInputArea();
            break;
        case 'voiceLevel':
            pushWave(msg.source, msg.wave);
            if (msg.source === 'bot') {
                pushTalkLevel(msg.level);
            }
            break;
        case 'voice':
            handleVoiceMessage(msg.message);
            break;
        case 'agentEvent':
            handleAgentEvent(msg.event);
            break;
        case 'models':
            state.availableModels = msg.models ?? [];
            if (msg.current) {
                state.model = msg.current;
                addToRecentModels(msg.current.provider, msg.current.id, msg.current.name);
            }
            if (msg.thinkingLevel) state.thinkingLevel = msg.thinkingLevel;
            setPickerModels(state.availableModels, msg.favorites);
            if (msg.current) setPickerCurrentModel(state.model);
            refreshWelcome();
            break;
        case 'fileChange':
            state.fileChanges.push(msg.change);
            renderChangedFilesBar();
            renderInlineFileChange(msg.change);
            break;
        case 'confirmResult':
            handleConfirmResult(msg.action, msg.confirmed, msg.payload);
            break;
        case 'toolCallPending':
            renderToolApprovalCard(msg.pending);
            break;
        case 'toolCallResolved':
            removeToolApprovalCard(msg.toolCallId);
            break;
        case 'skills':
            state.skills = msg.skills;
            break;
        case 'slashCommands':
            state.slashCommands = msg.commands;
            break;
        case 'error':
            showError(msg.message);
            break;
        case 'extensionUiRequest':
            showExtensionUiRequest(msg.request);
            break;
        case 'extensionUiDismiss':
            dismissExtensionUi(msg.id);
            break;
        case 'piExtensionChrome':
            state.piExtensionChrome = msg.chrome;
            updatePlanPanel();
            updateExtensionChromeStrip();
            break;
        case 'setComposerText': {
            const input = document.getElementById('input') as HTMLTextAreaElement | null;
            if (input && msg.text) {
                input.value = msg.text;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
            }
            break;
        }
        case 'dictationStatus':
            applyDictationStatus(msg.status);
            break;
        case 'dictationText':
            insertDictatedText(msg.text);
            break;
        case 'dictationLevel':
            pushWave('user', msg.wave);
            break;
        case 'toast':
            showToast(msg.message, msg.variant === 'error' ? 'error' : 'info');
            break;
        case 'sessionPanel':
            setSessionPanelOpen(msg.open);
            break;
        case 'sessionTree':
            setTreePanelOpen(msg.open);
            if (msg.data) {
                applyTreePayload(msg.data);
            }
            break;
        case 'imageFileData':
            handleImageFileData(msg.requestId, msg.filePath, msg.dataUrl, msg.error);
            break;
        case 'sessionList':
            applySessionList(msg.data);
            break;
        case 'tuiData':
            writeTuiData(msg.tabId, msg.data);
            break;
        case 'tuiSnapshot':
            restoreTuiSnapshot(msg.tabId, msg.data);
            break;
        case 'tuiExit':
            markTuiExited(msg.tabId, msg.exitCode);
            break;
    }
}

function handleConfirmResult(action: string, confirmed: boolean, payload?: any): void {
    if (!confirmed) return;
    switch (action) {
        case 'restoreCheckpoint':
            if (payload?.messageIndex !== undefined) {
                vscode.postMessage({ type: 'restoreCheckpoint', messageIndex: payload.messageIndex });
            }
            break;
        case 'redoCheckpoint':
            vscode.postMessage({ type: 'redoCheckpoint' });
            break;
    }
}

function addToRecentModels(provider: string, id: string, name?: string): void {
    state.recentModels = state.recentModels.filter(
        m => !(m.id === id && m.provider === provider)
    );
    state.recentModels.unshift({ provider, id, name });
    if (state.recentModels.length > 5) {
        state.recentModels = state.recentModels.slice(0, 5);
    }
}
