import { bindChatFileDrop } from '../chatFileDrop';
import { bindMicButton, dictationStatusHtml, micButtonHtml } from '../dictation';
import { initExtensionUiHost } from '../extensionUi';
import { bindFileMentionMenu } from '../fileMentionMenu';
import { bindModelPicker } from '../modelPicker';
import { modelStatusEl } from '../modelStatus';
import { onAppShellRebuilt, requestSessionPanelToggle } from '../sessionPanel';
import { focusTui, getTuiHost } from '../tuiView';
import { bindVoiceBar, voiceBarHtml } from '../voiceBar';
import { vscode } from '../vscodeApi';
import { el } from './helpers';
import { iconsBaseUri } from './icons';
import { state } from './state';
import { bindScrollListener, resetUserScroll, scrollToBottom, updateScrollButton } from './scroll';
import { updateChangedFiles } from './changedFiles';
import { updateConnectionBanner } from './banners';
import { updateMessages } from './transcript';
import { bindComposerChips, composerChipsHtml, createComposerChipsMenu, updateComposerChips } from './composerChips';
import { updateInputArea } from './composer';
import { bindComposerInput } from './composerInput';
import { bindPermissionControl, createPermissionMenu, permissionControlHtml, updatePermissionControl } from './permission';
import { syncToolApprovalCards } from './toolApproval';
import { bindTabOverflow, initTabLayoutObserver, updateTabs } from './tabs';
import { updateModeSwitch, updatePlanPanel } from './plan';

/**
 * The Bot view a tab shows in place of its conversation (`TabInfo.botView`). Outside the skeleton:
 * `render()` wipes #app on tab switches and re-inserts this node, so the transcript keeps its scroll
 * position and folds.
 */
export const botHost = document.createElement('div');
botHost.className = 'bot-host';

let skeletonBuilt = false;

/** The app skeleton (header, transcript, composer) exists; incremental updates can patch it. */
export function isSkeletonBuilt(): boolean {
    return skeletonBuilt;
}

/** Rebuilds #app from scratch (first load, tab switch) and repopulates every dynamic section. */
export function render(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = '';
    skeletonBuilt = false;

    // Header: tab-strip (dynamic) + header-right (static)
    const header = el('div', 'header');
    const tabStrip = el('div', 'tab-strip');
    header.appendChild(tabStrip);

    const tabOverflow = el('div', 'tab-overflow');
    tabOverflow.id = 'tab-overflow';
    tabOverflow.hidden = true;
    tabOverflow.innerHTML = `
        <button type="button" class="tab-overflow-btn" id="btn-tab-overflow" title="All conversations" aria-label="Choose conversation" aria-haspopup="menu" aria-expanded="false">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 5.5l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="tab-overflow-count" aria-hidden="true"></span>
        </button>
        <div class="tab-overflow-menu" id="tab-overflow-menu" role="menu" hidden></div>
    `;
    header.appendChild(tabOverflow);

    const modeSwitch = el('div', 'mode-switch');
    modeSwitch.id = 'mode-switch';
    header.appendChild(modeSwitch);

    const headerActions = el('div', 'header-right');
    headerActions.innerHTML = `
        <button class="icon-btn" id="btn-new-tab" title="New Agent"><img class="header-icon-img" src="${iconsBaseUri()}/new.svg" alt="new"></button>
        <button class="icon-btn" id="btn-tui"><img class="header-icon-img" alt=""></button>
        <button class="icon-btn" id="btn-sessions" title="Resume session"><img class="header-icon-img" src="${iconsBaseUri()}/history.svg" alt="resume session"></button>
        <button class="icon-btn" id="btn-settings" title="Settings"><img class="header-icon-img" src="${iconsBaseUri()}/settings.svg" alt="settings"></button>
    `;
    header.appendChild(headerActions);
    app.appendChild(header);
    // Over the conversation (and the TUI), as the Bot view's header is over its transcript.
    app.appendChild(modelStatusEl);
    app.appendChild(getTuiHost());

    // Messages container (persistent, children managed by updateMessages)
    const messagesContainer = el('div', 'messages');
    messagesContainer.id = 'messages';
    const pendingMessages = el('div', 'pending-messages');
    pendingMessages.id = 'pending-messages';
    pendingMessages.style.display = 'none';
    messagesContainer.appendChild(pendingMessages);
    const streamingContainer = el('div', 'streaming-message message-group-assistant');
    streamingContainer.id = 'streaming-message';
    const streamActivity = el('div', 'stream-activity stream-activity--idle');
    streamActivity.id = 'stream-activity';
    streamActivity.setAttribute('aria-live', 'polite');
    streamActivity.setAttribute('aria-atomic', 'true');
    streamActivity.innerHTML =
        '<span class="stream-activity-dot" aria-hidden="true"></span><span class="stream-activity-label"></span>';
    streamingContainer.appendChild(streamActivity);
    messagesContainer.appendChild(streamingContainer);
    const spacer = el('div', 'messages-spacer');
    messagesContainer.appendChild(spacer);
    app.appendChild(messagesContainer);
    app.appendChild(botHost);

    // Scroll-to-bottom button (static)
    const scrollWrap = el('div', 'scroll-btn-wrap');
    const scrollBtn = el('button', 'scroll-bottom-btn');
    scrollBtn.id = 'btn-scroll-bottom';
    scrollBtn.title = 'Scroll to bottom';
    scrollBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3L8 13M8 13L3 8M8 13L13 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    scrollWrap.appendChild(scrollBtn);
    app.appendChild(scrollWrap);

    // Input container: changed-files slot + queued section + slash menu + input-area (persistent textarea) + footer
    const inputContainer = el('div', 'input-container');
    // The voice agent's tool belt: the header of the input box, above everything else in it.
    inputContainer.insertAdjacentHTML('afterbegin', voiceBarHtml);
    const planPanel = el('div', 'plan-panel');
    planPanel.id = 'plan-panel';
    inputContainer.appendChild(planPanel);
    const chromeStrip = el('div', 'extension-chrome-strip');
    chromeStrip.id = 'extension-chrome-strip';
    chromeStrip.style.display = 'none';
    inputContainer.appendChild(chromeStrip);
    const extensionUiHost = el('div', 'extension-ui-host');
    extensionUiHost.id = 'extension-ui-host';
    extensionUiHost.style.display = 'none';
    inputContainer.appendChild(extensionUiHost);
    // Voice-agent changes waiting for approval: in the input box, so the Bot view shows them too.
    const toolApprovalHost = el('div', 'tool-approval-host');
    toolApprovalHost.id = 'tool-approval-host';
    inputContainer.appendChild(toolApprovalHost);
    const queuedSection = document.createElement('details');
    queuedSection.className = 'queued-section';
    queuedSection.id = 'queued-section';
    queuedSection.style.display = 'none';
    inputContainer.appendChild(queuedSection);
    const slashMenu = el('div', 'slash-menu');
    slashMenu.id = 'slash-menu';
    slashMenu.style.display = 'none';
    inputContainer.appendChild(slashMenu);
    const atMenu = el('div', 'at-menu');
    atMenu.id = 'at-menu';
    atMenu.style.display = 'none';
    inputContainer.appendChild(atMenu);
    const modelPicker = el('div', 'model-picker');
    modelPicker.id = 'model-picker';
    modelPicker.hidden = true;
    modelPicker.innerHTML =
        '<div id="model-list" class="model-list" role="listbox" aria-label="Favorite models" tabindex="-1"></div>';
    inputContainer.appendChild(modelPicker);
    inputContainer.appendChild(createPermissionMenu());
    inputContainer.appendChild(createComposerChipsMenu());
    const dropShiftHint = el('div', 'drop-shift-hint');
    dropShiftHint.id = 'drop-shift-hint';
    dropShiftHint.hidden = true;
    inputContainer.appendChild(dropShiftHint);
    const composerEditBanner = el('div', 'composer-edit-banner');
    composerEditBanner.id = 'composer-edit-banner';
    composerEditBanner.style.display = 'none';
    inputContainer.appendChild(composerEditBanner);
    // Image chips (in the footer below the input) toggle this preview panel above the input row.
    const attachmentPreview = el('div', 'attachment-preview');
    attachmentPreview.id = 'attachment-preview';
    attachmentPreview.hidden = true;
    attachmentPreview.title = 'Click to close preview';
    inputContainer.appendChild(attachmentPreview);
    const area = el('div', 'input-area');
    area.innerHTML = `
        <div class="composer-toolbar">
            <div class="composer-toolbar-left">
                <button id="btn-attach" class="composer-action-btn composer-action-btn--ghost" type="button" title="Attach files · @ paths · Shift+drop from Explorer">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 8.5L7.2 14.8a3.5 3.5 0 01-5-5l6.8-6.8a2.5 2.5 0 013.5 3.5L5.7 12.3a1.5 1.5 0 01-2.1-2.1l6.1-6.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                </button>
            </div>
            <textarea id="input" placeholder="Ask Pi anything..." rows="1"></textarea>
            <div class="composer-toolbar-right">${micButtonHtml}
                <button id="btn-steer" class="composer-action-btn composer-action-btn--ghost" type="button" title="Steer (Ctrl+Enter)" hidden>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <button id="btn-send" class="composer-action-btn composer-action-btn--primary" type="button" title="Send (Enter)" aria-label="Send message">
                    <span class="composer-btn-icon composer-btn-icon--send" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2.5v11M8 2.5L4 6.5M8 2.5l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                    <span class="composer-btn-icon composer-btn-icon--stop" aria-hidden="true" hidden><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg></span>
                </button>
            </div>
        </div>
        <div class="composer-footer">
            <button id="btn-model" class="composer-model-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
                <span class="composer-model-label" id="model-chip-label"></span>
                <svg class="dropdown-chevron" width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 10.5l5-5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>${composerChipsHtml}${dictationStatusHtml}${permissionControlHtml}
        </div>`;
    inputContainer.appendChild(area);
    app.appendChild(inputContainer);
    bindComposerChips();

    // Bind stable event listeners (these elements persist for the lifetime of the skeleton)
    bindStableEvents();
    initTabLayoutObserver();
    initExtensionUiHost({ focusTui });
    bindScrollListener();
    scrollBtn.addEventListener('click', () => {
        resetUserScroll();
        scrollToBottom(true);
        updateScrollButton();
    });

    skeletonBuilt = true;

    onAppShellRebuilt();

    // Populate all dynamic sections
    updateTabs();
    updateModeSwitch();
    updatePlanPanel();
    updateMessages();
    updateInputArea();
    updatePermissionControl();
    syncToolApprovalCards();
    updateComposerChips();
    updateConnectionBanner();
    updateChangedFiles();
    scrollToBottom();
    updateTuiToggle();
}

/** Header toggle shows where a click goes: terminal icon in chat mode, chat icon in TUI mode. */
export function updateTuiToggle(): void {
    const btn = document.getElementById('btn-tui');
    const icon = btn?.querySelector('img');
    if (!btn || !icon) return;
    const label = state.tuiMode ? 'Switch to chat view' : 'Switch to terminal (TUI) view';
    btn.title = label;
    icon.alt = label;
    icon.src = `${iconsBaseUri()}/${state.tuiMode ? 'chat' : 'terminal'}.svg`;
}

// ── Events ──

function bindStableEvents(): void {
    const newTabBtn = document.getElementById('btn-new-tab');
    const tuiBtn = document.getElementById('btn-tui');
    const sessionsBtn = document.getElementById('btn-sessions');
    const settingsBtn = document.getElementById('btn-settings');

    bindComposerInput();

    bindChatFileDrop();
    bindFileMentionMenu();
    bindModelPicker();
    bindMicButton();
    bindPermissionControl();
    bindVoiceBar();

    newTabBtn?.addEventListener('click', () =>
        vscode.postMessage({ type: 'createTab', backend: state.activeBackend }),
    );

    bindTabOverflow();
    tuiBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'toggleTuiMode' });
    });
    sessionsBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        requestSessionPanelToggle();
    });
    settingsBtn?.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
}
