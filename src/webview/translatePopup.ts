/**
 * The floating translation of one sentence (Alt+right-click, sentencePick.ts) into the
 * `translateTo` language, after EchoRead's translation panel (echo-read-edge
 * src/content/components/TranslationPanel.tsx): under the sentence, or above it when there is more
 * room there, its arrow at the end of the sentence, which stays highlighted while it is open. It
 * floats over the whole webview and keeps within the area the sentence scrolls in; it follows the
 * sentence as that scrolls or is drawn again, and closes once the sentence is no longer shown.
 * Escape, a press outside it, or × close it.
 */
import { translationLanguage, type TranslationLanguage } from '../shared/translationLanguages';
import type { VoiceTranslation } from '../shared/voiceViewProtocol';
import { paintSentence, type PickedSentence } from './sentencePick';

/** Kept from the edges of the scrolled area, and between the sentence and the panel (the arrow). */
const MARGIN_PX = 8;
const GAP_PX = 9;
/** A translation that never comes back (the webview was hidden when it did) fails after this long. */
const TIMEOUT_MS = 30_000;
/** Translations kept by language and sentence, so asking again shows them at once. */
const CACHE_SIZE = 200;

export interface TranslationPopup {
    open(sentence: PickedSentence): void;
    /** The host's answer to request `requestId`. */
    answer(requestId: number, result: VoiceTranslation): void;
    /** Follows the sentence after the page was drawn again. */
    refresh(): void;
    close(): void;
    isOpen(): boolean;
}

export interface TranslationPopupOptions {
    /** The language to translate into now (a Google code, `voiceAgent.translateTo`). */
    target(): string;
    /** Asks the host to translate `text` into `to`. */
    request(requestId: number, text: string, to: string): void;
}

/** The box the sentence scrolls in: its nearest scrolling ancestor, else the window. */
function scrollArea(range: Range): DOMRect {
    for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
        const { overflowY } = getComputedStyle(el);
        if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
            return el.getBoundingClientRect();
        }
    }
    return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

export function createTranslationPopup(options: TranslationPopupOptions): TranslationPopup {
    const el = document.createElement('div');
    el.className = 'sentence-tp';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Translation');
    el.innerHTML =
        '<div class="sentence-tp-head"><span class="sentence-tp-title"></span><button type="button" class="sentence-tp-close" title="Close" aria-label="Close translation">×</button></div><div class="sentence-tp-body"></div><span class="sentence-tp-arrow" aria-hidden="true"></span>';
    document.body.append(el);
    const titleEl = el.querySelector<HTMLElement>('.sentence-tp-title')!;
    const bodyEl = el.querySelector<HTMLElement>('.sentence-tp-body')!;
    const arrowEl = el.querySelector<HTMLElement>('.sentence-tp-arrow')!;

    /** By `<language>\u0000<sentence>`. */
    const cache = new Map<string, Exclude<VoiceTranslation, { error: string }>>();
    let shown: { sentence: PickedSentence; language: TranslationLanguage; key: string; requestId: number; timer: number } | undefined;
    let nextRequestId = 1;
    let frame = 0;

    const setResult = (result: VoiceTranslation | undefined, language: TranslationLanguage): void => {
        bodyEl.dataset.state = !result ? 'loading' : 'error' in result ? 'error' : 'done';
        bodyEl.textContent = !result
            ? 'Translating…'
            : 'error' in result
              ? result.error
              : 'alreadyInTarget' in result
                ? `Already in ${language.name}.`
                : result.text;
    };

    const close = (): void => {
        if (shown) {
            clearTimeout(shown.timer);
            shown = undefined;
            el.hidden = true;
            paintSentence('vp-sentence-pinned', undefined);
        }
    };

    /** Places the panel by the sentence, measured now; closes it once the sentence is gone. */
    const place = (): void => {
        const range = shown?.sentence.surface.rangeOf(shown.sentence);
        if (!range) {
            close();
            return;
        }
        paintSentence('vp-sentence-pinned', range);
        const rects = range.getClientRects();
        const box = range.getBoundingClientRect();
        const view = scrollArea(range);
        // Scrolled out of its area (or hidden with its view): hidden until it is back.
        const visible = rects.length > 0 && box.bottom > view.top && box.top < view.bottom && view.width > 0;
        el.style.visibility = visible ? '' : 'hidden';
        if (!visible) {
            return;
        }
        el.style.maxHeight = '';
        el.style.maxWidth = `${Math.max(120, view.width - 2 * MARGIN_PX)}px`;
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        const last = rects[rects.length - 1];
        const anchorX = last.left + last.width / 2;
        const left = Math.max(view.left + MARGIN_PX, Math.min(anchorX - width / 2, view.right - width - MARGIN_PX));
        const below = view.bottom - box.bottom - GAP_PX - MARGIN_PX;
        const above = box.top - view.top - GAP_PX - MARGIN_PX;
        const up = below < height && above > below;
        const room = Math.max(60, up ? above : below);
        el.style.maxHeight = `${room}px`;
        el.style.left = `${left}px`;
        el.style.top = `${up ? box.top - GAP_PX - Math.min(height, room) : box.bottom + GAP_PX}px`;
        el.classList.toggle('up', up);
        arrowEl.style.left = `${Math.max(10, Math.min(anchorX - left, width - 10))}px`;
    };
    const schedule = (): void => {
        if (shown) {
            frame ||= requestAnimationFrame(() => {
                frame = 0;
                place();
            });
        }
    };

    const answer = (requestId: number, result: VoiceTranslation): void => {
        if (!shown || shown.requestId !== requestId) {
            return; // for a panel closed or replaced since
        }
        clearTimeout(shown.timer);
        if (!('error' in result)) {
            cache.delete(shown.key);
            cache.set(shown.key, result);
            for (const oldest of cache.keys()) {
                if (cache.size <= CACHE_SIZE) {
                    break;
                }
                cache.delete(oldest);
            }
        }
        setResult(result, shown.language);
        place();
    };

    el.querySelector('.sentence-tp-close')!.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && shown) {
            close();
        }
    });
    // A press anywhere else closes it; the Alt+right-click that opens the next one comes after.
    document.addEventListener('mousedown', (e) => {
        if (shown && !el.contains(e.target as Node)) {
            close();
        }
    });
    // Scroll events do not bubble; captured, every scrolled area reports here.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);

    return {
        open(sentence) {
            close();
            const language = translationLanguage(options.target());
            const key = `${language.code}\u0000${sentence.source}`;
            const requestId = nextRequestId++;
            const cached = cache.get(key);
            const timer = cached ? 0 : window.setTimeout(() => answer(requestId, { error: 'No answer came back.' }), TIMEOUT_MS);
            shown = { sentence, language, key, requestId, timer };
            titleEl.textContent = `Translation · ${language.native}`;
            setResult(cached, language);
            el.hidden = false;
            place();
            if (!cached) {
                options.request(requestId, sentence.source, language.code);
            }
        },
        answer,
        refresh: schedule,
        close,
        isOpen: () => shown !== undefined,
    };
}
