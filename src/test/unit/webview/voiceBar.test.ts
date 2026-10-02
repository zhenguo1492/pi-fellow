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
    setBotViewShown(false);
    // Module state: each test starts with both services working.
    setVoiceReadiness({ stt: { ok: true }, tts: { ok: true } });
    bindVoiceBar();
    vscode.postMessage.mockClear();
});

describe('voice bar with a speech service not working', () => {
    it('starts the voice agent when both services fail, and shows why in two grey tags', () => {
        setVoiceReadiness({ stt: { ok: false, reason: STT_DOWN }, tts: { ok: false, reason: TTS_DOWN } });
        const call = $<HTMLButtonElement>('[data-act="call"]');
        expect(call.getAttribute('aria-disabled')).toBe('false');

        call.click();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'voiceAgent', action: { type: 'start' } });

        expect(tag('stt').hidden).toBe(false);
        expect(tag('stt').textContent).toBe("Can't hear");
        expect(tag('stt').title).toContain(STT_DOWN);
        expect(tag('tts').hidden).toBe(false);
        expect(tag('tts').textContent).toBe('No voice');
        expect(tag('tts').title).toContain(TTS_DOWN);
    });

    it("opens Settings → Voice at the tag's service", () => {
        setVoiceReadiness({ stt: { ok: true }, tts: { ok: false, reason: TTS_DOWN } });
        expect(tag('stt').hidden).toBe(true);
        tag('tts').click();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'openSettings', section: 'tts' });
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
        expect($('[data-act="view"]').title).toMatch(/can't hear you: type to it/);
        expect(tag('stt').hidden).toBe(false);
        expect(tag('tts').hidden).toBe(true);

        applyVoiceBarStatus(on({ phase: 'thinking', unavailable: { stt: STT_DOWN } }));
        expect(label()).toBe('Thinking');
    });

    it('while on without TTS, thinking says the reply shows as text', () => {
        applyVoiceBarStatus(on({ phase: 'thinking', unavailable: { tts: TTS_DOWN } }));
        expect($('[data-act="view"]').title).toMatch(/shows as text/);
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

describe('voice bar phone button', () => {
    const call = () => $<HTMLButtonElement>('[data-act="call"]');

    it('calls while voice mode is off, hangs up while it is on, and does nothing while it connects; never switches the view', () => {
        call().click();
        expect(vscode.postMessage.mock.calls).toEqual([[{ type: 'voiceAgent', action: { type: 'start' } }]]);
        expect(call().getAttribute('aria-pressed')).toBe('false');

        applyVoiceBarStatus(on({ phase: 'off', starting: true }));
        vscode.postMessage.mockClear();
        call().click();
        expect(vscode.postMessage).not.toHaveBeenCalled();
        expect(call().getAttribute('aria-disabled')).toBe('true');

        applyVoiceBarStatus(on());
        expect(call().getAttribute('aria-pressed')).toBe('true');
        expect(call().getAttribute('aria-label')).toBe('Hang up');
        call().click();
        expect(vscode.postMessage.mock.calls).toEqual([[{ type: 'voiceAgent', action: { type: 'stop' } }]]);
    });

    it('swaps the handset for a hung-up one while voice mode is on, and back once it is off', () => {
        const callIcon = call().innerHTML;
        expect(callIcon).toContain('<svg');

        applyVoiceBarStatus(on({ phase: 'off', starting: true }));
        expect(call().innerHTML).toBe(callIcon);

        applyVoiceBarStatus(on({ phase: 'speaking' }));
        const hangUpIcon = call().innerHTML;
        expect(hangUpIcon).not.toBe(callIcon);
        expect(call().title).toMatch(/^Hang up/);

        applyVoiceBarStatus(on({ phase: 'off' }));
        expect(call().innerHTML).toBe(callIcon);
        expect(call().getAttribute('aria-pressed')).toBe('false');
        expect(call().title).toMatch(/^Call /);
    });
});

describe('voice bar avatar button', () => {
    const view = () => $<HTMLButtonElement>('[data-act="view"]');

    it('switches the Bot view, whether voice mode is on or off, and never starts or stops it', () => {
        for (const status of [undefined, on(), on({ phase: 'off', starting: true })]) {
            applyVoiceBarStatus(status);
            vscode.postMessage.mockClear();
            view().click();
            expect(vscode.postMessage.mock.calls).toEqual([[{ type: 'toggleBotView' }]]);
        }
    });

    it('says where a click leads: the Bot view, back to the running TUI, or back to the worker conversation', () => {
        setBotViewShown(false, true);
        expect(view().title).toMatch(/^Show the conversation with/);

        setBotViewShown(true, true);
        expect(view().title).toBe('Back to the terminal (TUI); it kept running');

        setBotViewShown(true, false);
        expect(view().title).toBe('Back to the worker conversation');
    });

    it("shows π and the worker's backend in the Bot view whatever voice mode does, and the voice agent again on the way back", () => {
        setVoiceBarBot('Bob', '<img class="av-img" alt="Bob">');
        const robot = $('.voice-bar-robot');
        for (const status of [undefined, on(), on({ phase: 'off', starting: true }), on({ phase: 'speaking' })]) {
            applyVoiceBarStatus(status);
            setBotViewShown(true, false, 'omp');
            expect(label()).toBe('OMP');
            expect(robot.querySelector('img')).toBeNull();
            expect(robot.classList.contains('av-motion')).toBe(false);
            setBotViewShown(true, true, 'pi');
            expect(label()).toBe('Pi');
            setBotViewShown(false, false, 'omp');
            expect(label()).not.toMatch(/^(OMP|Pi)$/);
            expect(robot.querySelector('img.av-img')).not.toBeNull();
        }
    });
});
