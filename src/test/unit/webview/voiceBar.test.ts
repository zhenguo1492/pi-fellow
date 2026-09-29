// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceStatus } from '../../../shared/voiceViewProtocol';

const vscode = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('../../../webview/vscodeApi', () => ({ vscode }));

import { applyVoiceBarStatus, bindVoiceBar, setBotViewShown, setVoiceBarBot, setVoiceReadiness, voiceBarHtml } from '../../../webview/voiceBar';

const STT_DOWN = "The speech-to-text service isn't running at 127.0.0.1:8010.";
const TTS_DOWN = 'Text-to-speech is not set up: choose Built-in, a cloud service or your server in Settings → Voice.';
const on = (over: Partial<VoiceStatus> = {}): VoiceStatus => ({ phase: 'listening', starting: false, muted: false, following: false, ...over });

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const tag = (service: 'stt' | 'tts') => $(`[data-service="${service}"]`);
const label = () => $('.voice-bar-label').textContent;

beforeEach(() => {
    document.body.innerHTML = voiceBarHtml;
    applyVoiceBarStatus(undefined);
    // Module state: each test starts with both services working.
    setVoiceReadiness({ stt: { ok: true }, tts: { ok: true } });
    bindVoiceBar();
    vscode.postMessage.mockClear();
});

describe('voice bar with a speech service not working', () => {
    it('starts the voice agent when both services fail, and shows why in two grey tags', () => {
        setVoiceReadiness({ stt: { ok: false, reason: STT_DOWN }, tts: { ok: false, reason: TTS_DOWN } });
        const robot = $<HTMLButtonElement>('[data-act="robot"]');
        expect(robot.getAttribute('aria-disabled')).toBe('false');
        expect($('.voice-bar-robot').classList.contains('is-unavailable')).toBe(false);

        robot.click();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'voiceAgent', action: { type: 'start' } });

        expect(tag('stt').hidden).toBe(false);
        expect(tag('stt').textContent).toBe("Can't hear");
        expect(tag('stt').title).toContain(STT_DOWN);
        expect(tag('tts').hidden).toBe(false);
        expect(tag('tts').textContent).toBe('No voice');
        expect(tag('tts').title).toContain(TTS_DOWN);
    });

    it('opens Settings → Voice from a tag', () => {
        setVoiceReadiness({ stt: { ok: true }, tts: { ok: false, reason: TTS_DOWN } });
        expect(tag('stt').hidden).toBe(true);
        tag('tts').click();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'openSettings', section: 'voice' });
        expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'voiceAgent' }));
    });

    it('shows no tag while a service is still being checked, nor when both work', () => {
        setVoiceReadiness({ stt: { ok: false, checking: true, reason: 'Checking…' }, tts: { ok: true } });
        expect(tag('stt').hidden).toBe(true);
        expect(tag('tts').hidden).toBe(true);
    });

    it('while on, tags what voice mode runs without, and idles as "Online" instead of "Listening" when it cannot hear', () => {
        setVoiceReadiness({ stt: { ok: false, reason: STT_DOWN }, tts: { ok: true } });
        applyVoiceBarStatus(on({ unavailable: { stt: STT_DOWN } }));
        expect(label()).toBe('Online');
        expect($('[data-act="robot"]').title).toMatch(/can't hear you: type to it/);
        expect(tag('stt').hidden).toBe(false);
        expect(tag('tts').hidden).toBe(true);

        applyVoiceBarStatus(on({ phase: 'thinking', unavailable: { stt: STT_DOWN } }));
        expect(label()).toBe('Thinking');
    });

    it('while on without TTS, thinking says the reply shows as text', () => {
        applyVoiceBarStatus(on({ phase: 'thinking', unavailable: { tts: TTS_DOWN } }));
        expect($('[data-act="robot"]').title).toMatch(/shows as text/);
        expect(tag('tts').hidden).toBe(false);
        applyVoiceBarStatus(on({ unavailable: { tts: TTS_DOWN } }));
        expect(label()).toBe('Listening');
    });

    it('while on, a service failing in use tags it live, and a later success clears the tag', () => {
        applyVoiceBarStatus(on({ unavailable: {} }));
        setVoiceReadiness({ stt: { ok: true }, tts: { ok: false, reason: 'The text-to-speech service rejected voice "af_wrong".' } });
        expect(tag('tts').hidden).toBe(false);
        expect(tag('tts').title).toContain('af_wrong');
        expect(tag('stt').hidden).toBe(true);

        setVoiceReadiness({ stt: { ok: true }, tts: { ok: true } });
        expect(tag('tts').hidden).toBe(true);
    });

    it('while on, a microphone the page cannot open shows as "Can\'t hear"', () => {
        setVoiceReadiness({ stt: { ok: true }, tts: { ok: true } });
        applyVoiceBarStatus(on({ unavailable: { stt: "Can't open the microphone (NotFoundError: Requested device not found)." } }));
        expect(tag('stt').hidden).toBe(false);
        expect(tag('stt').title).toContain('NotFoundError');
        expect(label()).toBe('Online');
    });
});

describe('voice bar label', () => {
    it("is the voice agent's name from the settings while offline, and what it is doing while on", () => {
        setVoiceBarBot('Alfred', '<svg></svg>');
        expect(label()).toBe('Alfred');
        applyVoiceBarStatus(on({ phase: 'thinking' }));
        expect(label()).toBe('Thinking');
        applyVoiceBarStatus(undefined);
        setVoiceBarBot('Jeeves', '<svg></svg>');
        expect(label()).toBe('Jeeves');
    });
});

describe('voice bar robot button', () => {
    const toggles = () => vscode.postMessage.mock.calls.filter(([msg]) => msg.type === 'toggleBotView').length;

    it('switches to the Bot view on start and back to the worker view on stop', () => {
        const robot = $<HTMLButtonElement>('[data-act="robot"]');
        setBotViewShown(false);
        robot.click();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'voiceAgent', action: { type: 'start' } });
        expect(toggles()).toBe(1);

        // Starting while already in the Bot view stays there.
        setBotViewShown(true);
        vscode.postMessage.mockClear();
        robot.click();
        expect(toggles()).toBe(0);

        // Stopping from the Bot view goes back to the worker view.
        applyVoiceBarStatus(on());
        robot.click();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'voiceAgent', action: { type: 'stop' } });
        expect(toggles()).toBe(1);

        // Stopping from the worker view stays there.
        setBotViewShown(false);
        vscode.postMessage.mockClear();
        robot.click();
        expect(toggles()).toBe(0);

        // Still starting: no start or stop, but the conversation is shown.
        setBotViewShown(false);
        applyVoiceBarStatus(on({ phase: 'off', starting: true }));
        vscode.postMessage.mockClear();
        robot.click();
        expect(vscode.postMessage.mock.calls).toEqual([[{ type: 'toggleBotView' }]]);
    });
});

describe('voice bar Bot view button in a TUI tab', () => {
    const panel = () => $<HTMLButtonElement>('[data-act="panel"]');

    it('shows the Bot view over the terminal and says the way back leads to the running TUI', () => {
        setBotViewShown(false, true);
        expect(panel().title).toMatch(/^Show the voice agent conversation/);
        panel().click();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'toggleBotView' });

        setBotViewShown(true, true);
        expect(panel().title).toBe('Back to the terminal (TUI); it kept running');
        expect(panel().getAttribute('aria-pressed')).toBe('true');

        setBotViewShown(true, false);
        expect(panel().title).toBe('Back to the worker conversation');
    });
});
