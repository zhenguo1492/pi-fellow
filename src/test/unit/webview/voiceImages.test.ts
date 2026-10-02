// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceEntry, VoiceImage, VoiceViewState } from '../../../shared/voiceViewProtocol';

const vscode = vi.hoisted(() => {
    // jsdom has no ResizeObserver; the Bot view re-measures clamped turns with one.
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    return { postMessage: vi.fn() };
});
vi.mock('../../../webview/vscodeApi', () => ({ vscode }));

import { handleImageFileData } from '../../../webview/chat/attachments';
import { handleVoiceMessage, mountVoicePanel } from '../../../webview/voicePanel';

const engines: VoiceViewState['engines'] = {
    running: false,
    llm: { setting: '', thinking: 'off' },
    stt: { url: 'http://127.0.0.1:8010', model: 'whisper', language: 'auto' },
    tts: { engine: 'built-in', url: '', model: 'kokoro', voice: 'af', speed: 1, language: 'auto' },
};

const image = (name: string, src?: string): VoiceImage => ({ name, path: `/store/pasted-attachments/${name}`, ...(src ? { src } : {}) });

let session = 0;
/** A new session per test: the view drops what it showed of the last one. */
function show(entries: VoiceEntry[], id = `s${session}`): void {
    handleVoiceMessage({
        type: 'state',
        state: { phase: 'off', engines, session: { id, title: 'Task', startedAt: 0, readonly: false }, entries, proposals: [], research: [], requests: [], debug: false },
    });
}

function said(images: VoiceImage[], text = 'what is wrong here?'): VoiceEntry {
    return { kind: 'user', id: 'u1', at: 1, text, source: 'text', images };
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const viewer = () => $('.vp-lightbox')!;
const key = (k: string) => {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    viewer().dispatchEvent(event);
    return event;
};

beforeAll(() => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountVoicePanel(host);
});

beforeEach(() => {
    session++;
    key('Escape');
    vscode.postMessage.mockClear();
});

describe('Bot view image card', () => {
    it('shows the images under the message, not as "[name]" in its text, closed to a strip of thumbnails and a count', () => {
        const images = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png'].map((name) => image(name, `https://res/${name}`));
        show([said(images)]);
        expect($('.vp-turn.user .vp-body')!.textContent).toBe('what is wrong here?');
        const toggle = $<HTMLButtonElement>('.vp-imgs-toggle')!;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect($$('.vp-img-thumb img').map((img) => img.getAttribute('src'))).toEqual(['https://res/a.png', 'https://res/b.png', 'https://res/c.png', 'https://res/d.png']);
        expect($('.vp-img-more')!.textContent).toBe('+2');
        expect($('.vp-imgs-n')!.textContent).toBe('6 images');
        expect($$('.vp-img-tile')).toEqual([]);
    });

    it('opens to every image as a tile, and stays open through the next snapshots of the conversation', () => {
        const images = [image('a.png', 'https://res/a.png'), image('b.png', 'https://res/b.png')];
        show([said(images)]);
        $<HTMLButtonElement>('.vp-imgs-toggle')!.click();
        expect($('.vp-imgs-toggle')!.getAttribute('aria-expanded')).toBe('true');
        expect($$('.vp-img-tile').map((tile) => tile.textContent)).toEqual(['a.png', 'b.png']);

        const reply: VoiceEntry = { kind: 'assistant', id: 'a1', at: 2, text: 'A null check.', tools: [], done: true };
        show([said(images), reply], `s${session}`);
        expect($$('.vp-img-tile')).toHaveLength(2);

        $<HTMLButtonElement>('.vp-imgs-toggle')!.click();
        expect($$('.vp-img-tile')).toEqual([]);
        expect($$('.vp-img-thumb')).toHaveLength(2);
    });

    it('escapes the names and paths it puts in the markup', () => {
        show([said([{ name: '<img src=x onerror=alert(1)>.png', path: '/p/"><b>.png' }])]);
        $<HTMLButtonElement>('.vp-imgs-toggle')!.click();
        expect($('.vp-imgs b')).toBeNull();
        expect($$('.vp-imgs img')).toHaveLength(1);
        expect($('.vp-img-name')!.textContent).toBe('<img src=x onerror=alert(1)>.png');
        expect($('.vp-imgs img')!.getAttribute('data-path')).toBe('/p/"><b>.png');
    });

    it('reads an image the webview cannot load from the host once, however many snapshots draw it', async () => {
        const outside = { name: 'shot.png', path: '/home/me/Desktop/shot.png' };
        show([said([outside])]);
        show([said([outside])], `s${session}`);
        const reads = vscode.postMessage.mock.calls.filter(([m]) => m.type === 'readImageFile');
        expect(reads).toEqual([[{ type: 'readImageFile', filePath: outside.path, requestId: expect.any(String) }]]);

        handleImageFileData(reads[0][0].requestId, outside.path, 'data:image/png;base64,AAAA');
        await Promise.resolve();
        expect($('.vp-img-thumb img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    });
});

describe('Bot view image viewer', () => {
    const images = [image('a.png', 'https://res/a.png'), image('b.png', 'https://res/b.png'), image('c.png', 'https://res/c.png')];

    function openTile(index: number): void {
        show([said(images)]);
        $<HTMLButtonElement>('.vp-imgs-toggle')!.click();
        $$('.vp-img-tile')[index].click();
    }

    it('shows a clicked tile full size, steps through the message’s images with the arrows, and closes on Escape alone', () => {
        openTile(1);
        expect(viewer().hidden).toBe(false);
        expect($('.vp-lb-img')!.getAttribute('src')).toBe('https://res/b.png');
        expect($('.vp-lb-pos')!.textContent).toBe('2 / 3');

        key('ArrowRight');
        key('ArrowRight');
        expect($('.vp-lb-name')!.textContent).toBe('a.png');
        expect($('.vp-lb-pos')!.textContent).toBe('1 / 3');
        key('ArrowLeft');
        expect($('.vp-lb-name')!.textContent).toBe('c.png');

        const escapes = vi.fn();
        document.addEventListener('keydown', escapes);
        const escape = key('Escape');
        document.removeEventListener('keydown', escapes);
        expect(viewer().hidden).toBe(true);
        expect(escape.defaultPrevented).toBe(true);
        expect(escapes).not.toHaveBeenCalled();
    });

    it('opens the image shown in an editor tab', () => {
        openTile(2);
        $<HTMLButtonElement>('[data-lb="open"]')!.click();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'openFile', filePath: '/store/pasted-attachments/c.png' });
        expect(viewer().hidden).toBe(false);
    });

    it('closes on the backdrop but not on the image, and has no arrows for a single image', () => {
        show([said([images[0]])]);
        $<HTMLButtonElement>('.vp-imgs-toggle')!.click();
        $$('.vp-img-tile')[0].click();
        expect($$('.vp-lb-nav').every((nav) => nav.hidden)).toBe(true);
        expect($('.vp-lb-pos')!.textContent).toBe('');

        $<HTMLImageElement>('.vp-lb-img')!.click();
        expect(viewer().hidden).toBe(false);
        $('.vp-lb-stage')!.click();
        expect(viewer().hidden).toBe(true);
    });
});
