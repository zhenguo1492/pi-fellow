// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '../../../shared/protocol';

const vscode = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('../../../webview/vscodeApi', () => ({ vscode }));

import { bindModelPicker, setPickerCurrentModel, setPickerModels, setPickerTarget, setVoicePickerModel } from '../../../webview/modelPicker';

const sonnet: ModelInfo = { provider: 'anthropic', id: 'claude-sonnet', name: 'Sonnet' };
const haiku: ModelInfo = { provider: 'anthropic', id: 'claude-haiku', name: 'Haiku' };
const flash: ModelInfo = { provider: 'google', id: 'gemini-flash', name: 'Flash' };

const chipLabel = () => document.getElementById('model-chip-label')!.textContent;
const rowNames = () => [...document.querySelectorAll('.model-item-name')].map((el) => el.textContent);
const checkedRow = () => document.querySelector('.model-item.active .model-item-name')?.textContent;
/** Opens the list and clicks the row named `name`; returns what the click posted. */
function pick(name: string): unknown[] {
    document.getElementById('btn-model')!.click();
    vscode.postMessage.mockClear();
    const row = [...document.querySelectorAll<HTMLElement>('.model-item')].find((el) => el.querySelector('.model-item-name')!.textContent === name);
    row!.click();
    return vscode.postMessage.mock.calls.map(([message]) => message);
}

beforeEach(() => {
    // jsdom does not lay out.
    Element.prototype.scrollIntoView = () => undefined;
    document.body.innerHTML = `
        <div id="model-picker" hidden><div id="model-list" tabindex="-1"></div></div>
        <textarea id="input"></textarea>
        <button id="btn-model"><span id="model-chip-label"></span></button>`;
    setPickerTarget('worker');
    setPickerModels([sonnet, haiku, flash], ['anthropic/claude-sonnet', 'anthropic/claude-haiku']);
    setPickerCurrentModel(sonnet);
    setVoicePickerModel({ setting: '', model: 'anthropic/claude-sonnet', thinking: 'off' });
    bindModelPicker();
    vscode.postMessage.mockClear();
});

describe('composer model chip: the worker and the voice agent keep separate models', () => {
    it('in the Bot view, a pick sets the voice agent’s model and leaves the worker’s', () => {
        setPickerTarget('voice');
        expect(chipLabel()).toBe('Sonnet');
        expect(document.getElementById('btn-model')!.classList.contains('voice-model')).toBe(true);

        expect(pick('Haiku')).toEqual([{ type: 'voiceAgent', action: { type: 'model', model: 'anthropic/claude-haiku' } }]);
        expect(chipLabel()).toBe('Haiku');

        setPickerTarget('worker');
        expect(chipLabel()).toBe('Sonnet');
        expect(document.getElementById('btn-model')!.classList.contains('voice-model')).toBe(false);
    });

    it('a worker pick and the chat’s model updates leave the voice agent’s choice', () => {
        setVoicePickerModel({ setting: 'anthropic/claude-haiku', model: 'anthropic/claude-haiku', thinking: 'off' });

        expect(pick('Haiku')).toEqual([{ type: 'setModel', provider: 'anthropic', modelId: 'claude-haiku' }]);
        setPickerCurrentModel(flash);
        expect(chipLabel()).toBe('Flash');

        setPickerTarget('voice');
        expect(chipLabel()).toBe('Haiku');
        document.getElementById('btn-model')!.click();
        expect(checkedRow()).toBe('Haiku');
    });

    it('following the chat, lists only models, none ticked, and the chip names the model running', () => {
        setPickerTarget('voice');
        document.getElementById('btn-model')!.click();

        expect(rowNames()).toEqual(['Sonnet', 'Haiku']);
        expect(checkedRow()).toBeUndefined();
        expect(chipLabel()).toBe('Sonnet');
    });

    it('shows a voice model set outside the favorites as the chosen one', () => {
        setVoicePickerModel({ setting: 'google/gemini-flash', model: 'google/gemini-flash', thinking: 'off' });
        setPickerTarget('voice');
        document.getElementById('btn-model')!.click();

        expect(rowNames()).toEqual(['Flash', 'Sonnet', 'Haiku']);
        expect(checkedRow()).toBe('Flash');
    });

    it('closes the open list when the composer switches between the worker and the voice agent', () => {
        document.getElementById('btn-model')!.click();
        expect(document.getElementById('model-picker')!.hidden).toBe(false);

        setPickerTarget('voice');
        expect(document.getElementById('model-picker')!.hidden).toBe(true);
    });
});
