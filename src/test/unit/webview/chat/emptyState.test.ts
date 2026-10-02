// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedAgentState } from '../../../../shared/protocol';
import type { VoiceViewState } from '../../../../shared/voiceViewProtocol';

const vscode = vi.hoisted(() => {
    // jsdom has no ResizeObserver; the Bot view re-measures clamped turns with one.
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    return { postMessage: vi.fn() };
});
vi.mock('../../../../webview/vscodeApi', () => ({ vscode }));
// xterm needs a canvas jsdom lacks; with no tab there is no terminal anyway.
vi.mock('../../../../webview/tuiView', () => ({ getTuiHost: () => document.createElement('div'), focusTui: () => {}, syncTuiView: () => {} }));

import { applyStateSync } from '../../../../webview/chat/stateSync';
import { handleVoiceMessage } from '../../../../webview/voicePanel';

/** What the host sends once every tab is closed (`SidebarProvider.sendStateSync`). */
const noTabs: SerializedAgentState = {
    messages: [],
    isStreaming: false,
    tools: [],
    tabs: [],
    activeTabId: '',
    activeBackend: 'omp',
    voiceReadiness: { stt: { ok: true }, tts: { ok: false, reason: 'No TTS server at 127.0.0.1:8881.' } },
};

const engines: VoiceViewState['engines'] = {
    running: false,
    llm: { setting: '', thinking: 'off' },
    stt: { url: 'http://127.0.0.1:8010', model: 'org/whisper-large', language: 'auto' },
    tts: { engine: 'custom', url: 'http://127.0.0.1:8881/v1', model: 'kokoro', voice: 'af', speed: 1, language: 'auto' },
};

const emptyState = () => document.querySelector<HTMLElement>('#app .no-tabs')!;
const button = (label: string) => [...emptyState().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);

beforeAll(() => {
    document.body.innerHTML = '<div id="app"></div>';
    applyStateSync(noTabs);
});

beforeEach(() => {
    vscode.postMessage.mockClear();
});

const voiceState = (phase: VoiceViewState['phase']): VoiceViewState => ({
    phase,
    engines,
    session: { id: '', title: 'Voice', startedAt: 0, readonly: false },
    entries: [],
    proposals: [],
    research: [],
    requests: [],
    debug: false,
});

describe('chat with every tab closed', () => {
    it("shows the Bot view's intro with its Call button, then Open worker and Resume a session", () => {
        expect(document.getElementById('app')!.classList.contains('no-tabs-mode')).toBe(true);
        const intro = emptyState().querySelector('.vp-intro')!;
        expect(intro.querySelector('.vp-welcome-title')!.textContent).toBe('Bot');
        expect(intro.querySelector('.vp-welcome-sub')!.textContent).toContain('Your voice pair programmer');
        expect(intro.querySelectorAll('.vp-welcome-list li')).toHaveLength(5);
        expect([...emptyState().querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Call Bot', 'Open worker', 'Resume a session']);
        // No input box to type in: the Bot view's note about a text chat is left out.
        expect(emptyState().querySelector('.vp-welcome-hint')).toBeNull();
    });

    it('calls in a new tab, opens a new worker tab of the current backend, or the resume panel', () => {
        button('Call Bot')!.click();
        button('Open worker')!.click();
        button('Resume a session')!.click();
        expect(vscode.postMessage.mock.calls).toEqual([[{ type: 'callInNewTab' }], [{ type: 'createTab', backend: 'omp' }], [{ type: 'toggleSessionPanel' }]]);
    });

    it("shows the speech services once the host's snapshot brings the engines, and a click on one opens its settings", () => {
        expect(emptyState().querySelector('.vp-svc')).toBeNull();

        handleVoiceMessage({ type: 'state', state: voiceState('off') });
        const rows = [...emptyState().querySelectorAll<HTMLElement>('.vp-svc')];
        expect(rows.map((r) => [r.dataset.service, r.dataset.state])).toEqual([
            ['stt', 'ok'],
            ['tts', 'bad'],
        ]);
        expect(rows[0].querySelector('.vp-svc-v')!.textContent).toBe('whisper-large · 127.0.0.1:8010');
        expect(rows[1].querySelector('.vp-svc-why')!.textContent).toBe('No TTS server at 127.0.0.1:8881.');

        rows[1].click();
        expect(vscode.postMessage.mock.calls).toEqual([[{ type: 'openSettings', section: 'tts' }]]);
    });

    it('leaves the Call button out while voice mode is on, and brings it back when it stops', () => {
        handleVoiceMessage({ type: 'state', state: voiceState('listening') });
        expect([...emptyState().querySelectorAll('button:not(.vp-svc)')].map((b) => b.textContent?.trim())).toEqual(['Open worker', 'Resume a session']);

        handleVoiceMessage({ type: 'state', state: voiceState('off') });
        expect(button('Call Bot')).toBeDefined();
    });
});
