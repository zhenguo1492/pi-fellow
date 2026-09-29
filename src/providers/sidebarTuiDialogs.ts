import {
    askOnSubmitTab,
    ompNeedsAttention,
    parseTuiDialog,
    sameTuiDialog,
    tuiAnswerLanded,
    tuiAnswerPlan,
    tuiCursorOn,
    tuiDialogCard,
    tuiDialogQuestion,
    type DialogScreen,
    type TuiDialog,
} from '../pi/tuiDialog';
import type { ExtensionUiAnswerer, ExtensionUiQuestion, ExtensionUiResponsePayload } from '../shared/extensionUi';
import type { ServerMessage } from '../shared/protocol';
import type { TabTui } from './sidebarTui';

export interface TuiDialogsHost {
    /** The tab's running TUI, if any. */
    tui(tabId: string): TabTui | undefined;
    post(message: Extract<ServerMessage, { type: 'extensionUiRequest' | 'extensionUiDismiss' }>): void;
    log(line: string): void;
}

interface Card {
    id: string;
    /** The dialog on the screen when the card was shown. */
    dialog: TuiDialog;
    /** Answering it from the card did not work: the card shows the screen instead, until the dialog goes. */
    failed: boolean;
}

/** Steps one card answer may take: the answer, then the ask panel's Submit, or a second Escape. */
const MAX_STEPS = 3;

/**
 * The dialog cards of tabs showing their TUI. The same cards as a chat tab's RPC dialogs; only the
 * answer path differs: here it is typed into the TUI (`respond`, the `ExtensionUiAnswerer`). A card
 * shows while the dialog is on the screen and goes when it does, however it was answered.
 *
 * omp's ask panel is answered one question at a time: each question's card is a select, and answering
 * it picks the option on the active tab, which moves the panel to the next (its card follows from the
 * next check). Other opens omp's own editor, shown as an editor card. Once the answers reach the
 * Submit tab it is submitted, and cancelling any of its cards cancels the whole panel.
 */
export class TuiDialogs implements ExtensionUiAnswerer {
    private readonly _cards = new Map<string, Card>();
    /** Tabs whose card answer is being typed: the screen is mid-change, so checks wait. */
    private readonly _answering = new Set<string>();
    /** Tabs whose ask panel the cards are answering: its Submit tab gets submitted, and a cancel cancels it all. */
    private readonly _askFlows = new Set<string>();
    private _seq = 0;

    constructor(private readonly _host: TuiDialogsHost) {}

    /** Whether the card with `id` is one of these (its answer goes into a TUI). */
    owns(id: string): boolean {
        return [...this._cards.values()].some((card) => card.id === id);
    }

    /** The question the tab's TUI is asking, for the voice agent; undefined without a dialog, or one no card answers. */
    question(tabId: string): ExtensionUiQuestion | undefined {
        const card = this._cards.get(tabId);
        return card && !card.failed ? tuiDialogQuestion(card.dialog) : undefined;
    }

    /** Reads the tab's screen and shows, keeps, replaces or drops its card to match. */
    async check(tabId: string): Promise<void> {
        if (this._answering.has(tabId)) return;
        const tui = this._host.tui(tabId);
        const dialog = tui && !tui.exited ? this._parse(tui, await tui.screen().peek()) : undefined;
        // The screen was read asynchronously: an answer may have started meanwhile.
        if (this._answering.has(tabId)) return;
        // The ask panel is gone (answered or cancelled in the TUI, or timed out): its flow ended.
        if (dialog?.kind !== 'ask' && dialog?.kind !== 'editor') this._askFlows.delete(tabId);
        const card = this._cards.get(tabId);
        if (card && dialog && sameTuiDialog(card.dialog, dialog)) {
            // The cursor moves as the user uses the TUI: answers start from where it is.
            if (!card.failed) card.dialog = dialog;
            return;
        }
        if (card) this._drop(tabId);
        if (dialog) this._show(tabId, dialog, false);
    }

    /** The card was answered in the webview (which already closed it): type the answer into the TUI. */
    respond(payload: ExtensionUiResponsePayload): boolean {
        const entry = [...this._cards].find(([, card]) => card.id === payload.id);
        if (!entry || entry[1].failed) return false;
        const [tabId, card] = entry;
        this._cards.delete(tabId);
        this._answering.add(tabId);
        void this._answer(tabId, card.dialog, payload)
            .catch((err: unknown) => this._host.log(`Answering the TUI dialog failed: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => {
                this._answering.delete(tabId);
                void this.check(tabId);
            });
        return true;
    }

    private _parse(tui: TabTui, screen: DialogScreen): TuiDialog | undefined {
        return parseTuiDialog(screen, tui.backend, tui.backend === 'omp' && ompNeedsAttention(tui.title));
    }

    /**
     * Each step is checked on the screen: the dialog still the card's (its cursor read afresh), the move
     * (arrows, or the text) landed, then the submit key left what it should (`tuiAnswerLanded`). Anything
     * off shows the dialog's screen instead, for the user to finish in the TUI; a select is never
     * submitted with the cursor on another option.
     */
    private async _answer(tabId: string, dialog: TuiDialog, payload: ExtensionUiResponsePayload): Promise<void> {
        const tui = this._host.tui(tabId);
        if (!tui || tui.exited) return;
        const screen = tui.screen();
        if (dialog.kind === 'ask' && !payload.cancelled) this._askFlows.add(tabId);
        let expected = dialog;
        let answer: Omit<ExtensionUiResponsePayload, 'id'> = payload;
        for (let step = 0; step < MAX_STEPS; step++) {
            const before = await screen.peek();
            const now = this._parse(tui, before);
            if (!now || !sameTuiDialog(now, expected)) {
                this._fail(tabId, expected, before, 'the dialog changed before the answer was typed');
                return;
            }
            const plan = tuiAnswerPlan(now, answer);
            if ('error' in plan) {
                this._fail(tabId, now, before, plan.error);
                return;
            }
            if (plan.keys) {
                const typed = await screen.press(plan.keys);
                if (plan.target !== undefined && !tuiCursorOn(this._parse(tui, typed), now, plan.target)) {
                    this._fail(tabId, now, typed, 'the cursor did not land on that option');
                    return;
                }
            }
            const afterScreen = await screen.press(plan.submit);
            const after = this._parse(tui, afterScreen);
            if (!tuiAnswerLanded(now, answer, after)) {
                this._askFlows.delete(tabId);
                this._fail(tabId, now, afterScreen, 'the dialog did not take the answer as expected');
                return;
            }
            if (!this._askFlows.has(tabId) || !after) break;
            if (answer.cancelled && after.kind === 'ask') {
                // Escape closed Other's editor, back to the panel: cancelling the card cancels the panel.
                expected = after;
                continue;
            }
            if (!answer.cancelled && askOnSubmitTab(after)) {
                // Every question answered: submit.
                expected = after;
                answer = { value: 'Submit' };
                continue;
            }
            break;
        }
        const left = this._parse(tui, await screen.peek());
        if (left?.kind !== 'ask' && left?.kind !== 'editor') this._askFlows.delete(tabId);
    }

    /** Shows the dialog's screen, in place of the card that could not answer it. */
    private _fail(tabId: string, dialog: TuiDialog, screen: DialogScreen, why: string): void {
        this._host.log(`TUI dialog card not answered (${why}); showing its screen instead.`);
        const tui = this._host.tui(tabId);
        const fromScreen = tui ? this._parse(tui, screen) : undefined;
        const title = dialog.kind === 'ask' ? 'Ask' : 'title' in dialog ? dialog.title : undefined;
        const shown: TuiDialog =
            fromScreen?.kind === 'unknown' ? fromScreen : { kind: 'unknown', title, reason: why, screen: screen.text.split('\n').slice(-20).join('\n') };
        // Kept while the dialog now on the screen stays, however far the answer got.
        this._show(tabId, shown, true, fromScreen ?? dialog);
    }

    private _show(tabId: string, dialog: TuiDialog, failed: boolean, onScreen = dialog): void {
        const id = `tui-${tabId}-${++this._seq}`;
        // A failed card keeps the dialog on the screen, so the next check keeps it while that stays.
        this._cards.set(tabId, { id, dialog: failed ? onScreen : dialog, failed });
        this._host.post({ type: 'extensionUiRequest', request: tuiDialogCard(dialog, id, tabId) });
    }

    private _drop(tabId: string): void {
        const card = this._cards.get(tabId);
        if (!card) return;
        this._cards.delete(tabId);
        this._host.post({ type: 'extensionUiDismiss', id: card.id });
    }
}
