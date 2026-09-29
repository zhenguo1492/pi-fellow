import { describe, expect, it } from 'vitest';
import type { TerminalScreen } from '../../../pi/terminalScreen';
import type { DialogScreen } from '../../../pi/tuiDialog';
import type { ServerMessage } from '../../../shared/protocol';
import type { TabTui } from '../../../providers/sidebarTui';
import { TuiDialogs } from '../../../providers/sidebarTuiDialogs';

import { coloredScreen, textScreen as screen } from '../pi/tuiScreens';

const DOWN = '\x1b[B';

/**
 * A TUI whose screen is one of the captured ones; `onKeys` plays the TUI's answer to keys typed in
 * (the next screen), or leaves it as it is.
 */
function setup(backend: 'omp' | 'pi', first: string | DialogScreen) {
    const state = {
        screen: typeof first === 'string' ? screen(first) : first,
        title: '',
        exited: false,
        onKeys: (_keys: string): DialogScreen | undefined => undefined,
    };
    const pressed: string[] = [];
    const posted: Extract<ServerMessage, { type: 'extensionUiRequest' | 'extensionUiDismiss' }>[] = [];
    const tui = {
        backend,
        get title() {
            return state.title;
        },
        get exited() {
            return state.exited;
        },
        screen: (): TerminalScreen =>
            ({
                peek: async () => state.screen,
                press: async (keys: string) => {
                    pressed.push(keys);
                    state.screen = state.onKeys(keys) ?? state.screen;
                    return state.screen;
                },
            }) as unknown as TerminalScreen,
    } as unknown as TabTui;
    const dialogs = new TuiDialogs({ tui: (tabId) => (tabId === 'tab-1' ? tui : undefined), post: (m) => posted.push(m), log: () => undefined });
    /** Answers the last card shown and waits until the keys are typed and checked. */
    const answer = async (payload: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
        const accepted = dialogs.respond({ id: lastCard().id, ...payload });
        // The keys go out over a few awaits on the fake screen: let them all run.
        for (let i = 0; i < 3; i++) {
            const { promise, resolve } = Promise.withResolvers<void>();
            setImmediate(resolve);
            await promise;
        }
        return accepted;
    };
    const lastCard = () => {
        const shown = posted.filter((m) => m.type === 'extensionUiRequest');
        return (shown.at(-1) as Extract<ServerMessage, { type: 'extensionUiRequest' }>).request;
    };
    return { state, pressed, posted, dialogs, answer, lastCard };
}

describe('TuiDialogs: the cards follow the screen', () => {
    it('shows a card for the dialog, keeps it while only the cursor moves, and drops it once the dialog is gone', async () => {
        const { state, posted, dialogs } = setup('omp', 'omp-select');
        await dialogs.check('tab-1');
        expect(posted).toEqual([
            { type: 'extensionUiRequest', request: { id: 'tui-tab-1-1', method: 'select', title: 'Pick a deploy target', options: ['Staging', 'Production', 'Local only'] } },
        ]);
        expect(dialogs.owns('tui-tab-1-1')).toBe(true);

        state.screen = screen('omp-select-moved');
        await dialogs.check('tab-1');
        expect(posted).toHaveLength(1);

        // Answered in the TUI itself.
        state.screen = screen('omp-idle');
        await dialogs.check('tab-1');
        expect(posted.at(-1)).toEqual({ type: 'extensionUiDismiss', id: 'tui-tab-1-1' });
        expect(dialogs.owns('tui-tab-1-1')).toBe(false);
    });

    it('replaces the card when another dialog follows, and shows a screen card for one it cannot answer', async () => {
        const { state, posted, dialogs } = setup('omp', 'omp-input');
        await dialogs.check('tab-1');
        state.screen = screen('omp-multi');
        await dialogs.check('tab-1');
        expect(posted.slice(1)).toEqual([
            { type: 'extensionUiDismiss', id: 'tui-tab-1-1' },
            { type: 'extensionUiRequest', request: expect.objectContaining({ id: 'tui-tab-1-2', method: 'screen', tabId: 'tab-1', title: 'Which checks?' }) },
        ]);
    });

    it("shows omp's screen when its title says it waits on the user though no dialog is recognized; pi has no such title", async () => {
        const omp = setup('omp', 'omp-idle');
        await omp.dialogs.check('tab-1');
        expect(omp.posted).toEqual([]);
        omp.state.title = 'π ! probe';
        await omp.dialogs.check('tab-1');
        expect(omp.lastCard()).toMatchObject({ method: 'screen', title: 'The TUI is waiting on you' });

        const pi = setup('pi', 'pi-idle');
        pi.state.title = 'π ! probe';
        await pi.dialogs.check('tab-1');
        expect(pi.posted).toEqual([]);
    });

    it('drops the card when the TUI exits', async () => {
        const { state, posted, dialogs } = setup('pi', 'pi-confirm');
        await dialogs.check('tab-1');
        state.exited = true;
        await dialogs.check('tab-1');
        expect(posted.at(-1)).toEqual({ type: 'extensionUiDismiss', id: 'tui-tab-1-1' });
    });

    it("gives the voice agent the question of a card it can answer, and none for a screen card", async () => {
        const { state, dialogs } = setup('omp', 'omp-approval');
        await dialogs.check('tab-1');
        expect(dialogs.question('tab-1')).toEqual({ method: 'select', title: 'Allow tool: bash', message: 'Command: echo approval-probe', options: ['Approve', 'Deny'] });
        state.screen = screen('omp-ask');
        await dialogs.check('tab-1');
        expect(dialogs.question('tab-1')).toBeUndefined();
        expect(dialogs.question('tab-2')).toBeUndefined();
    });
});

describe('TuiDialogs: answering a card types into the TUI', () => {
    it('moves the cursor, checks it landed, then presses Enter; the dialog closing ends it', async () => {
        const { state, pressed, posted, dialogs, answer } = setup('omp', 'omp-select');
        await dialogs.check('tab-1');
        state.onKeys = (keys) => (keys === DOWN ? screen('omp-select-moved') : keys === '\r' ? screen('omp-idle') : undefined);
        expect(await answer({ value: 'Production' })).toBe(true);
        expect(pressed).toEqual([DOWN, '\r']);
        // No new card: the webview closed the answered one itself.
        expect(posted).toHaveLength(1);
        expect(dialogs.owns('tui-tab-1-1')).toBe(false);
    });

    it('does not press Enter when the cursor is not on the option: the screen shows instead', async () => {
        const { state, pressed, dialogs, answer, lastCard } = setup('pi', 'pi-select');
        await dialogs.check('tab-1');
        // The TUI ignored the arrow.
        expect(await answer({ value: 'Production' })).toBe(true);
        expect(pressed).toEqual([DOWN]);
        expect(lastCard()).toMatchObject({ id: 'tui-tab-1-2', method: 'screen', tabId: 'tab-1', title: 'Pick a deploy target' });
        expect(lastCard().message).toContain('→ Staging');
        // Kept while that dialog is on the screen, and not answerable again.
        state.onKeys = () => undefined;
        await dialogs.check('tab-1');
        expect(dialogs.respond({ id: 'tui-tab-1-2', value: 'Staging' })).toBe(false);
        expect(dialogs.question('tab-1')).toBeUndefined();
    });

    it('shows the screen when the dialog is still open after the answer, and drops that card once the dialog goes', async () => {
        const { state, pressed, posted, dialogs, answer, lastCard } = setup('omp', 'omp-input');
        await dialogs.check('tab-1');
        state.onKeys = (keys) => (keys === 'feat/x' ? screen('omp-input-typed') : undefined);
        await answer({ value: 'feat/x' });
        expect(pressed).toEqual(['feat/x', '\r']);
        expect(lastCard()).toMatchObject({ method: 'screen', title: 'Branch name' });
        const fallback = lastCard().id;

        await dialogs.check('tab-1');
        expect(posted.filter((m) => m.type === 'extensionUiRequest')).toHaveLength(2);
        state.screen = screen('omp-idle');
        await dialogs.check('tab-1');
        expect(posted.at(-1)).toEqual({ type: 'extensionUiDismiss', id: fallback });
    });

    it('cancels with Escape and pastes an editor answer before its submit key', async () => {
        const cancel = setup('pi', 'pi-editor');
        await cancel.dialogs.check('tab-1');
        cancel.state.onKeys = () => screen('pi-idle');
        await cancel.answer({ cancelled: true });
        expect(cancel.pressed).toEqual(['\x1b']);

        const edit = setup('omp', 'omp-editor');
        await edit.dialogs.check('tab-1');
        edit.state.onKeys = (keys) => (keys === '\x11' ? screen('omp-idle') : undefined);
        await edit.answer({ value: 'a\nb' });
        expect(edit.pressed).toEqual(['\x1b[200~a\nb\x1b[201~', '\x11']);
        expect(edit.posted).toHaveLength(1);
    });

    it('answers a confirm card by its Yes / No row', async () => {
        const { state, pressed, dialogs, answer, lastCard } = setup('omp', 'omp-confirm');
        await dialogs.check('tab-1');
        expect(lastCard()).toEqual({ id: 'tui-tab-1-1', method: 'confirm', title: 'Delete the build folder?', message: 'This removes out/ and dist/.' });
        state.onKeys = (keys) => (keys === '\r' ? screen('omp-idle') : undefined);
        await answer({ confirmed: true });
        expect(pressed).toEqual(['\r']);
    });

    it('refuses an answer to a card it does not have', () => {
        const { dialogs } = setup('omp', 'omp-select');
        expect(dialogs.respond({ id: 'nope', value: 'x' })).toBe(false);
    });
});

describe("TuiDialogs: omp's ask panel, one select card per question", () => {
    const UP = '\x1b[A';
    const OTHER = 'Other (type your own)';

    /** Screens by name, and a TUI that moves to `to` when typed `keys` on screen `from`. */
    async function askSetup(first: string) {
        const names = [
            'omp-ask-color',
            'omp-ask-color-moved',
            'omp-ask-color-other',
            'omp-ask-fruit',
            'omp-ask-review',
            'omp-ask-done',
            'omp-ask-other-prompt',
            'omp-ask-multi',
            'omp-ask-single',
            'omp-ask-single-moved',
        ];
        const screens = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await coloredScreen(name)] as const)));
        const context = setup('omp', screens[first]);
        const moves: Array<[from: string, keys: string, to: string]> = [];
        let current = first;
        context.state.onKeys = (keys) => {
            const move = moves.find(([from, k]) => from === current && k === keys);
            if (!move) return undefined;
            current = move[2];
            return screens[current];
        };
        const at = (name: string) => {
            current = name;
            context.state.screen = screens[name];
        };
        return { ...context, screens, moves, at };
    }

    it('shows each question as a select card, picks the option on its tab, and submits after the last', async () => {
        const { dialogs, moves, pressed, posted, answer, lastCard } = await askSetup('omp-ask-color');
        moves.push(
            ['omp-ask-color', DOWN, 'omp-ask-color-moved'],
            ['omp-ask-color-moved', '\r', 'omp-ask-fruit'],
            ['omp-ask-fruit', '\r', 'omp-ask-review'],
            ['omp-ask-review', '\r', 'omp-ask-done'],
        );
        await dialogs.check('tab-1');
        expect(lastCard()).toEqual({ id: 'tui-tab-1-1', method: 'select', title: 'Which color do you like?', message: 'Question 1 of 2', options: ['Red', 'Green', 'Blue', OTHER] });
        expect(dialogs.question('tab-1')).toMatchObject({ title: 'Which color do you like?' });

        await answer({ value: 'Green' });
        expect(pressed).toEqual([DOWN, '\r']);
        // The check after the answer shows the next question.
        expect(lastCard()).toEqual({ id: 'tui-tab-1-2', method: 'select', title: 'Which fruit?', message: 'Question 2 of 2', options: ['Apple', 'Pear', OTHER] });

        await answer({ value: 'Apple' });
        expect(pressed).toEqual([DOWN, '\r', '\r', '\r']);
        expect(posted.filter((m) => m.type === 'extensionUiRequest')).toHaveLength(2);
        expect(dialogs.question('tab-1')).toBeUndefined();
    });

    it("opens Other's editor for its card, types the answer there, and goes on to the next question", async () => {
        const { dialogs, moves, pressed, answer, lastCard } = await askSetup('omp-ask-color');
        moves.push(
            ['omp-ask-color', DOWN + DOWN + DOWN, 'omp-ask-color-other'],
            ['omp-ask-color-other', '\r', 'omp-ask-other-prompt'],
            ['omp-ask-other-prompt', '\x1b[200~Purple\x1b[201~', 'omp-ask-other-prompt'],
            ['omp-ask-other-prompt', '\x11', 'omp-ask-fruit'],
        );
        await dialogs.check('tab-1');
        await answer({ value: OTHER });
        expect(lastCard()).toMatchObject({ method: 'editor', title: 'Custom answer: Which color do you like?' });
        await answer({ value: 'Purple' });
        expect(pressed).toEqual([DOWN + DOWN + DOWN, '\r', '\x1b[200~Purple\x1b[201~', '\x11']);
        expect(lastCard()).toMatchObject({ method: 'select', title: 'Which fruit?' });
    });

    it("cancels the whole panel from any of its cards, Other's editor included", async () => {
        const question = await askSetup('omp-ask-fruit');
        question.moves.push(['omp-ask-fruit', '\x1b', 'omp-ask-done']);
        await question.dialogs.check('tab-1');
        await question.answer({ cancelled: true });
        expect(question.pressed).toEqual(['\x1b']);

        const editor = await askSetup('omp-ask-color-other');
        editor.moves.push(
            ['omp-ask-color-other', '\r', 'omp-ask-other-prompt'],
            // Escape in Other's editor goes back to the panel; the second one cancels it.
            ['omp-ask-other-prompt', '\x1b', 'omp-ask-color-other'],
            ['omp-ask-color-other', '\x1b', 'omp-ask-done'],
        );
        await editor.dialogs.check('tab-1');
        await editor.answer({ value: OTHER });
        await editor.answer({ cancelled: true });
        expect(editor.pressed).toEqual(['\r', '\x1b', '\x1b']);
        expect(editor.dialogs.question('tab-1')).toBeUndefined();
    });

    it('submits a single question at once, with no Submit tab to go to', async () => {
        const { dialogs, moves, pressed, answer } = await askSetup('omp-ask-single');
        moves.push(['omp-ask-single', DOWN + DOWN, 'omp-ask-single-moved'], ['omp-ask-single-moved', '\r', 'omp-ask-done']);
        await dialogs.check('tab-1');
        await answer({ value: 'Blue' });
        expect(pressed).toEqual([DOWN + DOWN, '\r']);
    });

    it('answers a Submit tab the user went to themselves with its Submit card', async () => {
        const { dialogs, moves, pressed, answer, lastCard } = await askSetup('omp-ask-review');
        moves.push(['omp-ask-review', '\r', 'omp-ask-done']);
        await dialogs.check('tab-1');
        expect(lastCard()).toEqual({ id: 'tui-tab-1-1', method: 'select', title: 'Review answers', message: '1. color: Green\n2. fruit: Apple', options: ['Submit'] });
        await answer({ value: 'Submit' });
        expect(pressed).toEqual(['\r']);
    });

    it('shows the panel as its box when the tab did not move on after the answer, and presses nothing more', async () => {
        const { dialogs, moves, pressed, answer, lastCard } = await askSetup('omp-ask-color');
        moves.push(['omp-ask-color', DOWN, 'omp-ask-color-moved']);
        await dialogs.check('tab-1');
        await answer({ value: 'Green' });
        expect(pressed).toEqual([DOWN, '\r']);
        expect(lastCard()).toMatchObject({ method: 'screen', tabId: 'tab-1', title: 'Ask' });
        expect(lastCard().message).toContain('❯ ○ Green');
    });

    it('types nothing when another tab is showing by the time the answer comes', async () => {
        const { dialogs, pressed, answer, lastCard, at } = await askSetup('omp-ask-color');
        await dialogs.check('tab-1');
        at('omp-ask-fruit');
        await answer({ value: 'Red' });
        expect(pressed).toEqual([]);
        expect(lastCard()).toMatchObject({ method: 'screen', title: 'Ask' });
        expect(lastCard().message).toContain('Which fruit?');
    });

    it('reads the cursor afresh before moving it: the user may have moved it in the TUI', async () => {
        const { dialogs, moves, pressed, answer, at } = await askSetup('omp-ask-color');
        moves.push(['omp-ask-color-moved', UP, 'omp-ask-color'], ['omp-ask-color', '\r', 'omp-ask-fruit']);
        await dialogs.check('tab-1');
        at('omp-ask-color-moved');
        await answer({ value: 'Red' });
        expect(pressed).toEqual([UP, '\r']);
    });

    it('leaves a multi-select question to the TUI, as its box with the way to the terminal', async () => {
        const { dialogs, lastCard } = await askSetup('omp-ask-multi');
        await dialogs.check('tab-1');
        expect(lastCard()).toMatchObject({ method: 'screen', tabId: 'tab-1', title: 'Ask' });
        expect(dialogs.question('tab-1')).toBeUndefined();
    });
});
