// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceStatus } from '../../../../shared/voiceViewProtocol';

const vscode = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('../../../../webview/vscodeApi', () => ({ vscode }));

import { handleSendButtonClick, updateInputArea } from '../../../../webview/chat/composer';
import { state } from '../../../../webview/chat/state';
import { applyVoiceBarStatus, setBotViewShown } from '../../../../webview/voiceBar';

const on: VoiceStatus = { phase: 'listening', starting: false, muted: false, following: false };
const starting: VoiceStatus = { phase: 'off', starting: true, muted: false, following: false };

const input = () => document.getElementById('input') as HTMLTextAreaElement;
const sendBtn = () => document.getElementById('btn-send') as HTMLButtonElement;

function type(text: string): void {
    input().value = text;
    updateInputArea();
}

beforeEach(() => {
    document.body.innerHTML = `
        <div class="input-area">
            <textarea id="input"></textarea>
            <button id="btn-attach"></button>
            <button id="btn-steer"></button>
            <button id="btn-send"><span class="composer-btn-icon--send"></span><span class="composer-btn-icon--stop"></span></button>
        </div>`;
    state.isStreaming = false;
    state.pendingAttachments = [];
    setBotViewShown(true);
    applyVoiceBarStatus(undefined);
    vscode.postMessage.mockClear();
});

describe('Bot view composer', () => {
    it.each([
        ['voice mode off (a text chat)', undefined],
        ['voice mode connecting', starting],
        ['voice mode on (like speech)', on],
    ])('sends typed text to the voice agent with %s', (_name, status) => {
        applyVoiceBarStatus(status);
        type('  fix the tests  ');

        expect(input().disabled).toBe(false);
        expect(input().placeholder).toBe('Talk to the voice agent…');
        expect(sendBtn().disabled).toBe(false);
        expect(sendBtn().title).toBe('Send to the voice agent (Enter)');

        handleSendButtonClick();
        expect(vscode.postMessage.mock.calls).toEqual([[{ type: 'voiceAgent', action: { type: 'send', text: 'fix the tests' } }]]);
        expect(input().value).toBe('');
    });

    it('sends to the voice agent, not the worker, while the worker is running; empty, the button still stops the worker', () => {
        state.isStreaming = true;
        type('what is it doing?');
        handleSendButtonClick();
        expect(vscode.postMessage.mock.calls).toEqual([[{ type: 'voiceAgent', action: { type: 'send', text: 'what is it doing?' } }]]);

        vscode.postMessage.mockClear();
        updateInputArea();
        expect(sendBtn().title).toBe('Stop (Esc)');
        handleSendButtonClick();
        expect(vscode.postMessage.mock.calls).toEqual([[{ type: 'abort' }]]);
    });

    it('sends nothing when there is nothing to send', () => {
        type('   ');
        expect(sendBtn().disabled).toBe(true);
        handleSendButtonClick();
        expect(vscode.postMessage).not.toHaveBeenCalled();
    });
});

describe('worker conversation composer', () => {
    it('sends to the worker whatever voice mode does', () => {
        for (const status of [undefined, on]) {
            setBotViewShown(false);
            applyVoiceBarStatus(status);
            vscode.postMessage.mockClear();
            type('fix the tests');
            expect(input().placeholder).toBe('Ask Pi anything...');
            handleSendButtonClick();
            expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'prompt', text: 'fix the tests', attachments: [] });
            expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'voiceAgent' }));
        }
    });
});
