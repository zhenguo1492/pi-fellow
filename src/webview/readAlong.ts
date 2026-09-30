/**
 * The picked text (a sentence, a paragraph, a selection) and the read-along of it, after
 * EchoRead's click-to-listen (echo-read-edge src/content/modules/click-to-listen.ts). What an Alt
 * gesture picks (Alt+click, Alt+right-click, with Shift a paragraph) or Read aloud reads becomes
 * the region: it stays shaded until a press away from it, Escape, or another pick. While it is
 * read aloud, the sentence being read is highlighted, moving on as the host reports each sentence
 * starting (`VoiceReplay.part`). The region is one playback control: a click on its text pauses
 * or resumes the read, or reads it again once nothing reads it; a double-click on a word reads on
 * from that word's sentence, from about that word (by characters: the TTS gives no word timings);
 * a right-click translates it. Unlike EchoRead, the click waits out the double-click window, so a
 * double-click never pauses first. A press away from the region, or Escape, also stops the read.
 * A click with a selection made in the region (a drag) is left alone, so text there can still be
 * selected.
 */
import type { VoiceReplay, VoiceViewClientMessage } from '../shared/voiceViewProtocol';
import { paintSentence, type PickedSentence } from './sentencePick';

/** A second press this soon after a click, and this close to it, makes a double-click (EchoRead's window). */
export const DOUBLE_CLICK_MS = 350;
export const CLICK_SLOP_PX = 4;

export interface ClickTimers {
    set(run: () => void, ms: number): number;
    clear(id: number): void;
}

/**
 * Tells a click from a double-click: a click acts only once {@link DOUBLE_CLICK_MS} has passed
 * with no second press near it; a second press that soon and near makes a double-click, and the
 * click never acts. A press that ends further than {@link CLICK_SLOP_PX} away is a drag: neither.
 */
export class ClickGate {
    private _last: { x: number; y: number; at: number } | undefined;
    private _down: { x: number; y: number; double: boolean } | undefined;
    private _timer = 0;

    constructor(
        private readonly _on: { click(): void; double(x: number, y: number): void },
        private readonly _timers: ClickTimers = { set: (run, ms) => window.setTimeout(run, ms), clear: (id) => window.clearTimeout(id) },
    ) {}

    /** A press at (`x`, `y`) at time `at` (ms): true when it makes a double-click (keep the browser from selecting the word). */
    press(x: number, y: number, at: number): boolean {
        const last = this._last;
        const double = last !== undefined && at - last.at <= DOUBLE_CLICK_MS && Math.hypot(x - last.x, y - last.y) <= CLICK_SLOP_PX;
        this._down = { x, y, double };
        return double;
    }

    /** The press came up at (`x`, `y`) at time `at`. */
    release(x: number, y: number, at: number): void {
        const down = this._down;
        this._down = undefined;
        if (!down || Math.hypot(x - down.x, y - down.y) > CLICK_SLOP_PX) {
            return;
        }
        if (down.double) {
            this.cancel();
            this._on.double(x, y);
            return;
        }
        // A click elsewhere while one waits: that one was a click after all.
        if (this._timer) {
            this._timers.clear(this._timer);
            this._timer = 0;
            this._on.click();
        }
        this._last = { x, y, at };
        this._timer = this._timers.set(() => {
            this._timer = 0;
            this._on.click();
        }, DOUBLE_CLICK_MS);
    }

    /** Forgets the presses so far; a click waiting never acts. */
    cancel(): void {
        if (this._timer) {
            this._timers.clear(this._timer);
            this._timer = 0;
        }
        this._last = undefined;
        this._down = undefined;
    }
}

/** Letters and digits of a word; Chinese and Japanese characters are words of their own. */
const WORD = /[\p{L}\p{N}'’_-]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Where a double-click at `offset` of `text` reads on from: the sentence (of `parts`, their
 * `[start, end)` in `text`) it is in, and how far into it the word under it starts, as a fraction
 * of the sentence's characters. Between sentences, the next one from its start; after them all, nothing.
 */
export function seekPoint(text: string, parts: ReadonlyArray<readonly [number, number]>, offset: number): { part: number; fraction: number } | undefined {
    let part = parts.findIndex(([start, end]) => offset >= start && offset < end);
    if (part < 0) {
        part = parts.findIndex(([start]) => start >= offset);
        return part < 0 ? undefined : { part, fraction: 0 };
    }
    const [start, end] = parts[part];
    let word = offset;
    while (word > start && WORD.test(text[word - 1]) && !CJK.test(text[word - 1])) {
        word--;
    }
    return { part, fraction: (word - start) / (end - start) };
}

export interface ReadAlong {
    /** `sentence` is sent to be read aloud: it becomes the region (the read's once the host reads it). */
    start(sentence: PickedSentence): void;
    /** `sentence` becomes the region, not read (Alt+right-click); a read of other text stops. */
    select(sentence: PickedSentence): void;
    /** The host's read now (`sentenceActions.replay`). */
    update(replay: VoiceReplay | undefined): void;
    /** Finds the highlighted text again after a surface was drawn. */
    refresh(): void;
    /** A region is shown: it needs finding again when the page is drawn. */
    shown(): boolean;
    /** Forgets the region, stopping its read (the gestures were turned off). */
    clear(): void;
}

export interface ReadAlongActions {
    post(message: VoiceViewClientMessage): void;
    /** Reads `sentence` aloud (from `fraction` into its sentence `part`, else from its start). */
    read(sentence: PickedSentence, from?: { part: number; fraction: number }): void;
    translate(sentence: PickedSentence): void;
}

/** Whether (`x`, `y`) is on the text of `range` (its line boxes, with a little of the gap between lines). */
function onText(range: Range, x: number, y: number): boolean {
    return [...range.getClientRects()].some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 4 && y <= r.bottom + 4);
}

/** The characters of `region`'s text before the point (`node`, `offset`) in it. */
function charsBefore(region: Range, node: Node, offset: number): number {
    const before = document.createRange();
    before.setStart(region.startContainer, region.startOffset);
    before.setEnd(node, offset);
    return before.toString().length;
}

/** Presses on these never end the region: the translation panel, the selection bar. */
const OWN_UI = '.sentence-tp, .sentence-sel';

/** The same text at the same place: what the host takes as the same read. */
function sameRead(a: Pick<PickedSentence, 'entryId' | 'piece'>, b: Pick<PickedSentence, 'entryId' | 'piece'>): boolean {
    return a.entryId === b.entryId && a.piece.text === b.piece.text && a.piece.sentence === b.piece.sentence && a.piece.range?.join() === b.piece.range?.join();
}

export function createReadAlong(actions: ReadAlongActions): ReadAlong {
    const { post } = actions;
    /** The region: the text picked or sent to be read, until a press away from it. */
    let reading: PickedSentence | undefined;
    let replay: VoiceReplay | undefined;
    /** The press in progress started on the region's text, with no selection made there. */
    let pressed = false;
    let frame = 0;

    /** The host reads the region. */
    const active = (): boolean => reading !== undefined && replay !== undefined && sameRead(reading, replay);
    const region = (): Range | undefined => reading?.surface.rangeOf(reading);

    const paint = (): void => {
        const whole = region();
        if (!whole && reading && !active()) {
            // Its text is no longer shown, and nothing reads it: the region is gone.
            reading = undefined;
            gate.cancel();
        }
        const live = whole !== undefined && active();
        const part = live ? (reading!.parts?.[replay!.part] ?? reading!) : undefined;
        const range = part && (part === reading ? whole : part.surface.rangeOf(part));
        const phase = live ? replay!.phase : undefined;
        paintSentence('vp-read-region', whole);
        paintSentence('vp-sentence-loading', phase === 'loading' || phase === 'queued' ? range : undefined);
        paintSentence('vp-sentence-playing', phase === 'playing' ? range : undefined);
        paintSentence('vp-sentence-paused', phase === 'paused' ? range : undefined);
        if (!whole) {
            document.body.removeAttribute('data-read-along');
        }
    };

    /** Stops the read (when the host still reads it) and forgets the region. */
    const end = (): void => {
        if (active()) {
            post({ type: 'replayControl', action: 'stop' });
        }
        reading = undefined;
        gate.cancel();
        paint();
    };

    const gate = new ClickGate({
        click: () => {
            if (active()) {
                post({ type: 'replayControl', action: replay!.phase === 'paused' ? 'resume' : 'pause' });
            } else if (reading) {
                actions.read(reading);
            }
        },
        double: (x, y) => {
            const whole = region();
            const caret = document.caretRangeFromPoint(x, y);
            if (!whole || !caret || !whole.isPointInRange(caret.startContainer, caret.startOffset)) {
                return;
            }
            const parts = (reading!.parts ?? [reading!]).map((p): [number, number] => {
                const at = p === reading ? whole : p.surface.rangeOf(p);
                const start = at ? charsBefore(whole, at.startContainer, at.startOffset) : -1;
                return [start, at ? start + at.toString().length : -1];
            });
            const to = seekPoint(whole.toString(), parts, charsBefore(whole, caret.startContainer, caret.startOffset));
            if (!to) {
                return;
            }
            if (active()) {
                post({ type: 'replaySeek', ...to });
            } else {
                actions.read(reading!, to);
            }
        },
    });

    // Captured, before the page's handlers: a click on the region is the control's, not a card's or a link's.
    document.addEventListener(
        'mousedown',
        (e) => {
            pressed = false;
            const whole = region();
            if (!whole || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
                return;
            }
            if (onText(whole, e.clientX, e.clientY)) {
                pressed = document.getSelection()?.isCollapsed ?? true;
                if (pressed && gate.press(e.clientX, e.clientY, e.timeStamp)) {
                    e.preventDefault();
                }
                return;
            }
            const target = e.target instanceof Element ? e.target : undefined;
            // A scrollbar is pressed on its element beyond the element's content box.
            const onScrollbar = target !== undefined && target.clientWidth > 0 && (e.offsetX >= target.clientWidth || e.offsetY >= target.clientHeight);
            const box = whole.getBoundingClientRect();
            const inBox = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
            if (!inBox && !onScrollbar && !target?.closest(OWN_UI)) {
                end();
            }
        },
        true,
    );
    document.addEventListener(
        'click',
        (e) => {
            const wasPressed = pressed;
            pressed = false;
            // A drag that selected text in the region is a selection, not a click.
            if (!wasPressed || !region() || !(document.getSelection()?.isCollapsed ?? true)) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            gate.release(e.clientX, e.clientY, e.timeStamp);
        },
        true,
    );
    document.addEventListener(
        'dblclick',
        (e) => {
            const whole = region();
            if (whole && onText(whole, e.clientX, e.clientY)) {
                e.stopPropagation();
            }
        },
        true,
    );
    document.addEventListener(
        'contextmenu',
        (e) => {
            const whole = region();
            // Alt+right-click is sentencePick.ts's; with text selected there, the menu is the page's.
            if (!whole || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !(document.getSelection()?.isCollapsed ?? true) || !onText(whole, e.clientX, e.clientY)) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            actions.translate(reading!);
        },
        true,
    );
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && reading) {
            end();
        }
    });
    document.addEventListener(
        'mousemove',
        (e) => {
            if (!reading) {
                return;
            }
            const { clientX, clientY } = e;
            frame ||= requestAnimationFrame(() => {
                frame = 0;
                const whole = region();
                document.body.toggleAttribute('data-read-along', whole !== undefined && onText(whole, clientX, clientY));
            });
        },
        { passive: true },
    );

    return {
        start(sentence) {
            gate.cancel();
            reading = sentence;
            // As EchoRead: the selection read is shown by the read-along, not the browser's selection.
            if (sentence.surface.name === 'selection') {
                document.getSelection()?.removeAllRanges();
            }
            paint();
        },
        select(sentence) {
            if (reading && sameRead(reading, sentence)) {
                return;
            }
            end();
            reading = sentence;
            paint();
        },
        update(next) {
            const wasActive = active();
            replay = next;
            // Read through, stopped or failed: a click waiting to pause it must not read it again.
            if (!next && wasActive) {
                gate.cancel();
            }
            paint();
        },
        refresh: paint,
        shown: () => reading !== undefined,
        clear: end,
    };
}
