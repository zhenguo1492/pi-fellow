import { describe, expect, it } from 'vitest';
import {
    ASK_OTHER_OPTION,
    askOnSubmitTab,
    ompNeedsAttention,
    parseTuiDialog,
    sameTuiDialog,
    tuiAnswerLanded,
    tuiAnswerPlan,
    tuiCursorOn,
    tuiDialogCard,
    tuiDialogQuestion,
    type TuiDialog,
} from '../../../pi/tuiDialog';

import { coloredScreen, screenTextOf, textScreen as screen } from './tuiScreens';

const UP = '\x1b[A';
const DOWN = '\x1b[B';

describe('parseTuiDialog on captured omp screens', () => {
    it('reads a tool approval: the tool in the title, its details as the message, Approve / Deny', () => {
        expect(parseTuiDialog(screen('omp-approval'), 'omp')).toEqual({
            kind: 'select',
            title: 'Allow tool: bash',
            message: 'Command: echo approval-probe',
            options: ['Approve', 'Deny'],
            highlighted: 0,
        });
        expect(parseTuiDialog(screen('omp-approval-reason'), 'omp')).toMatchObject({ message: 'Reason: prompt\nCommand: rm -rf out' });
    });

    it('reads a select and where its cursor is', () => {
        expect(parseTuiDialog(screen('omp-select'), 'omp')).toEqual({
            kind: 'select',
            title: 'Pick a deploy target',
            options: ['Staging', 'Production', 'Local only'],
            highlighted: 0,
        });
        expect(parseTuiDialog(screen('omp-select-moved'), 'omp')).toMatchObject({ highlighted: 1 });
    });

    it('reads a confirm as a Yes / No select with its message', () => {
        expect(parseTuiDialog(screen('omp-confirm'), 'omp')).toEqual({
            kind: 'select',
            title: 'Delete the build folder?',
            message: 'This removes out/ and dist/.',
            options: ['Yes', 'No'],
            highlighted: 0,
        });
    });

    it('reads an empty input, and both editor styles, which submit with Ctrl+Q', () => {
        expect(parseTuiDialog(screen('omp-input'), 'omp')).toEqual({ kind: 'input', title: 'Branch name' });
        expect(parseTuiDialog(screen('omp-editor'), 'omp')).toEqual({ kind: 'editor', title: 'Commit message', submit: '\x11' });
        expect(parseTuiDialog(screen('omp-editor-prompt'), 'omp')).toEqual({ kind: 'editor', title: 'Describe the change', submit: '\x11' });
    });

    it('leaves to the TUI a text field that already holds text, a multi-select, a list that scrolls, and an ask panel read without colors', () => {
        const reasons = ['omp-input-typed', 'omp-editor-typed', 'omp-editor-prompt-typed', 'omp-multi', 'omp-long', 'omp-ask'].map((name) => {
            const dialog = parseTuiDialog(screen(name), 'omp');
            expect(dialog?.kind).toBe('unknown');
            return dialog?.kind === 'unknown' ? dialog.reason : '';
        });
        expect(reasons).toEqual([
            'its text field already has text',
            'its text field already has text',
            'its text field already has text',
            'a multi-select list',
            'a list of 16 options that does not fit on the screen',
            'an ask panel whose active tab cannot be seen',
        ]);
    });

    it("shows an ask panel it cannot answer as its box, not the whole terminal", () => {
        const ask = parseTuiDialog(screen('omp-ask'), 'omp') as Extract<TuiDialog, { kind: 'unknown' }>;
        expect(ask.title).toBe('Ask');
        expect(ask.screen.split('\n')[0]).toMatch(/^╭─ Ask ─/);
        expect(ask.screen).toContain('Which database?');
        expect(ask.screen.split('\n').at(-1)).toMatch(/^╰─+╯$/);
    });

    it('finds nothing on an idle screen, unless omp says in its title that it waits on the user', () => {
        expect(parseTuiDialog(screen('omp-idle'), 'omp')).toBeUndefined();
        const attention = parseTuiDialog(screen('omp-idle'), 'omp', true);
        expect(attention).toMatchObject({ kind: 'unknown', reason: 'omp says it is waiting on you' });
        expect((attention as Extract<TuiDialog, { kind: 'unknown' }>).screen.split('\n').length).toBeLessThanOrEqual(20);
    });

    it('does not read a pi dialog as an omp one', () => {
        expect(parseTuiDialog(screen('pi-select'), 'omp')).toBeUndefined();
    });
});

describe('parseTuiDialog on captured pi screens', () => {
    it('reads a select, its cursor, and a title with detail lines', () => {
        expect(parseTuiDialog(screen('pi-select'), 'pi')).toEqual({
            kind: 'select',
            title: 'Pick a deploy target',
            options: ['Staging', 'Production', 'Local only'],
            highlighted: 0,
        });
        expect(parseTuiDialog(screen('pi-select-moved'), 'pi')).toMatchObject({ highlighted: 1 });
        expect(parseTuiDialog(screen('pi-approval-like'), 'pi')).toEqual({
            kind: 'select',
            title: 'Allow tool: bash',
            message: 'Reason: prompt\nCommand: rm -rf out',
            options: ['Approve', 'Deny'],
            highlighted: 0,
        });
    });

    it('reads a confirm, a long list it shows whole, an input and an editor that submits with Enter', () => {
        expect(parseTuiDialog(screen('pi-confirm'), 'pi')).toMatchObject({ kind: 'select', title: 'Delete the build folder?', message: 'This removes out/ and dist/.', options: ['Yes', 'No'] });
        const long = parseTuiDialog(screen('pi-long'), 'pi');
        expect(long?.kind === 'select' && long.options).toEqual(Array.from({ length: 16 }, (_, i) => `Option ${i + 1}`));
        expect(parseTuiDialog(screen('pi-input'), 'pi')).toEqual({ kind: 'input', title: 'Branch name' });
        expect(parseTuiDialog(screen('pi-editor'), 'pi')).toEqual({ kind: 'editor', title: 'Commit message', submit: '\r' });
    });

    it('leaves a text field that already holds text to the TUI, and finds nothing on an idle screen', () => {
        expect(parseTuiDialog(screen('pi-input-typed'), 'pi')).toMatchObject({ kind: 'unknown', title: 'Branch name' });
        expect(parseTuiDialog(screen('pi-editor-typed'), 'pi')).toMatchObject({ kind: 'unknown', title: 'Commit message' });
        expect(parseTuiDialog(screen('pi-idle'), 'pi')).toBeUndefined();
    });
});

describe('parseTuiDialog details', () => {
    it("drops a selector's countdown from its title, so the dialog stays the same while it counts", () => {
        const counting = screenTextOf('omp-select').replace('╭─ Pick a deploy target ───', '╭─ Pick a deploy target (12s) ');
        const later = screenTextOf('omp-select').replace('╭─ Pick a deploy target ───', '╭─ Pick a deploy target (11s) ');
        const a = parseTuiDialog({ text: counting }, 'omp')!;
        expect(a).toMatchObject({ title: 'Pick a deploy target' });
        expect(sameTuiDialog(a, parseTuiDialog({ text: later }, 'omp')!)).toBe(true);
    });

    it('treats a moved cursor as the same dialog, other options as another', () => {
        const first = parseTuiDialog(screen('omp-select'), 'omp')!;
        expect(sameTuiDialog(first, parseTuiDialog(screen('omp-select-moved'), 'omp')!)).toBe(true);
        expect(sameTuiDialog(first, parseTuiDialog(screen('omp-confirm'), 'omp')!)).toBe(false);
    });

    it("recognizes omp's attention title", () => {
        expect(ompNeedsAttention('π ! probe')).toBe(true);
        expect(ompNeedsAttention('π !')).toBe(true);
        expect(ompNeedsAttention('π > probe')).toBe(false);
        expect(ompNeedsAttention('π ⠋ probe')).toBe(false);
    });
});

describe('tuiDialogQuestion and tuiDialogCard', () => {
    it('asks a Yes / No select as a confirm, and the rest as what they are', () => {
        expect(tuiDialogQuestion(parseTuiDialog(screen('omp-confirm'), 'omp')!)).toEqual({ method: 'confirm', title: 'Delete the build folder?', message: 'This removes out/ and dist/.' });
        expect(tuiDialogQuestion(parseTuiDialog(screen('omp-approval'), 'omp')!)).toEqual({
            method: 'select',
            title: 'Allow tool: bash',
            message: 'Command: echo approval-probe',
            options: ['Approve', 'Deny'],
        });
        expect(tuiDialogQuestion(parseTuiDialog(screen('pi-editor'), 'pi')!)).toEqual({ method: 'editor', title: 'Commit message' });
        expect(tuiDialogQuestion(parseTuiDialog(screen('omp-ask'), 'omp')!)).toBeUndefined();
    });

    it('makes a card of the question, or of the screen with the tab to show when nothing can be answered', () => {
        expect(tuiDialogCard(parseTuiDialog(screen('omp-input'), 'omp')!, 'tui-1', 'tab-1')).toEqual({ id: 'tui-1', method: 'input', title: 'Branch name' });
        const card = tuiDialogCard(parseTuiDialog(screen('omp-multi'), 'omp')!, 'tui-2', 'tab-1');
        expect(card).toMatchObject({ id: 'tui-2', method: 'screen', tabId: 'tab-1', title: 'Which checks?' });
        expect(card.message).toContain('☑ Tests');
    });
});

describe('tuiAnswerPlan', () => {
    const select = parseTuiDialog(screen('omp-select-moved'), 'omp')!;

    it('moves the cursor from where it is to the option, then presses Enter', () => {
        expect(tuiAnswerPlan(select, { value: 'Local only' })).toEqual({ keys: DOWN, target: 2, submit: '\r' });
        expect(tuiAnswerPlan(select, { value: 'Staging' })).toEqual({ keys: UP, target: 0, submit: '\r' });
        expect(tuiAnswerPlan(select, { value: 'Production' })).toEqual({ keys: '', target: 1, submit: '\r' });
    });

    it('answers a confirm by its Yes or No row', () => {
        const confirm = parseTuiDialog(screen('pi-confirm'), 'pi')!;
        expect(tuiAnswerPlan(confirm, { confirmed: false })).toEqual({ keys: DOWN, target: 1, submit: '\r' });
        expect(tuiAnswerPlan(confirm, { confirmed: true })).toEqual({ keys: '', target: 0, submit: '\r' });
    });

    it('cancels anything with Escape', () => {
        expect(tuiAnswerPlan(select, { cancelled: true })).toEqual({ keys: '', submit: '\x1b' });
        expect(tuiAnswerPlan(parseTuiDialog(screen('pi-editor'), 'pi')!, { cancelled: true })).toEqual({ keys: '', submit: '\x1b' });
    });

    it('types an input as one line of plain characters, then Enter', () => {
        expect(tuiAnswerPlan(parseTuiDialog(screen('omp-input'), 'omp')!, { value: 'feat/y\nz\x1b[B\x07' })).toEqual({ keys: 'feat/y z[B', submit: '\r' });
    });

    it("pastes an editor's text, newlines and all, and submits with that TUI's key", () => {
        expect(tuiAnswerPlan(parseTuiDialog(screen('omp-editor'), 'omp')!, { value: 'first\r\nsecond' })).toEqual({ keys: '\x1b[200~first\nsecond\x1b[201~', submit: '\x11' });
        expect(tuiAnswerPlan(parseTuiDialog(screen('pi-editor'), 'pi')!, { value: 'a\x1b[201~b' })).toEqual({ keys: '\x1b[200~ab\x1b[201~', submit: '\r' });
    });

    it('refuses an option the dialog does not have, and a dialog it cannot read', () => {
        expect(tuiAnswerPlan(select, { value: 'Moon' })).toEqual({ error: '"Moon" is not one of its options' });
        expect(tuiAnswerPlan(parseTuiDialog(screen('omp-ask'), 'omp')!, { value: 'x' })).toEqual({ error: 'the dialog is an ask panel whose active tab cannot be seen' });
    });
});

describe("omp's ask panel, read with its colors", () => {
    const COLOR = ['Red', 'Green', 'Blue', ASK_OTHER_OPTION];
    const FRUIT = ['Apple', 'Pear', ASK_OTHER_OPTION];

    it('reads the active tab from its background, the question, its options with Other, and the cursor', async () => {
        expect(parseTuiDialog(await coloredScreen('omp-ask-color'), 'omp')).toEqual({
            kind: 'ask',
            tabs: ['color', 'fruit'],
            active: 0,
            question: 'Which color do you like?',
            options: COLOR,
            highlighted: 0,
            marked: [],
        });
        expect(parseTuiDialog(await coloredScreen('omp-ask-color-moved'), 'omp')).toMatchObject({ active: 0, highlighted: 1 });
        expect(parseTuiDialog(await coloredScreen('omp-ask-fruit'), 'omp')).toMatchObject({ active: 1, question: 'Which fruit?', options: FRUIT, highlighted: 0, marked: [] });
    });

    it('reads which option is chosen (◉), Other included, leaving out the text typed for it', async () => {
        expect(parseTuiDialog(await coloredScreen('omp-ask-fruit-chosen'), 'omp')).toMatchObject({ active: 1, options: FRUIT, marked: [0] });
        expect(parseTuiDialog(await coloredScreen('omp-ask-other-chosen'), 'omp')).toMatchObject({ active: 0, options: COLOR, highlighted: 3, marked: [3] });
    });

    it('reads the Submit tab: the review, and Submit as the one option', async () => {
        expect(parseTuiDialog(await coloredScreen('omp-ask-review'), 'omp')).toEqual({
            kind: 'ask',
            tabs: ['color', 'fruit'],
            active: 2,
            question: 'Review answers',
            options: ['Submit'],
            highlighted: 0,
            marked: [],
            review: ['1. color: Green', '2. fruit: Apple'],
        });
        expect(parseTuiDialog(await coloredScreen('omp-ask-review-unanswered'), 'omp')).toMatchObject({
            review: ['1 unanswered question; Enter still submits.', '1. color: “Purple”', '2. fruit: unanswered'],
        });
    });

    it('reads a single question, which has no tab bar', async () => {
        expect(parseTuiDialog(await coloredScreen('omp-ask-single'), 'omp')).toEqual({
            kind: 'ask',
            tabs: [],
            active: 0,
            question: 'Which color do you like?',
            options: COLOR,
            highlighted: 0,
            marked: [],
        });
        expect(parseTuiDialog(await coloredScreen('omp-ask-single-moved'), 'omp')).toMatchObject({ highlighted: 2 });
    });

    it("reads Other's editor as an editor, and leaves a multi-select question, shown as its box, to the TUI", async () => {
        expect(parseTuiDialog(await coloredScreen('omp-ask-other-prompt'), 'omp')).toEqual({ kind: 'editor', title: 'Custom answer: Which color do you like?', submit: '\x11' });
        const multi = parseTuiDialog(await coloredScreen('omp-ask-multi'), 'omp') as Extract<TuiDialog, { kind: 'unknown' }>;
        expect(multi).toMatchObject({ kind: 'unknown', title: 'Ask', reason: 'a multi-select question of the ask panel' });
        expect(multi.screen).toContain('☐ Tests');
        expect(parseTuiDialog(await coloredScreen('omp-ask-done'), 'omp')).toBeUndefined();
    });

    it('treats another tab as another dialog, and a moved cursor as the same', async () => {
        const color = parseTuiDialog(await coloredScreen('omp-ask-color'), 'omp')!;
        expect(sameTuiDialog(color, parseTuiDialog(await coloredScreen('omp-ask-color-moved'), 'omp')!)).toBe(true);
        expect(sameTuiDialog(color, parseTuiDialog(await coloredScreen('omp-ask-fruit'), 'omp')!)).toBe(false);
        expect(askOnSubmitTab(parseTuiDialog(await coloredScreen('omp-ask-review'), 'omp'))).toBe(true);
        expect(askOnSubmitTab(color)).toBe(false);
        expect(askOnSubmitTab(parseTuiDialog(await coloredScreen('omp-ask-single'), 'omp'))).toBe(false);
    });

    it('asks one question at a time as a select, saying which of how many and what is chosen', async () => {
        expect(tuiDialogQuestion(parseTuiDialog(await coloredScreen('omp-ask-color'), 'omp')!)).toEqual({
            method: 'select',
            title: 'Which color do you like?',
            message: 'Question 1 of 2',
            options: COLOR,
        });
        expect(tuiDialogQuestion(parseTuiDialog(await coloredScreen('omp-ask-fruit-chosen'), 'omp')!)).toEqual({
            method: 'select',
            title: 'Which fruit?',
            message: 'Question 2 of 2 · Chosen: Apple',
            options: FRUIT,
        });
        expect(tuiDialogQuestion(parseTuiDialog(await coloredScreen('omp-ask-review'), 'omp')!)).toEqual({
            method: 'select',
            title: 'Review answers',
            message: '1. color: Green\n2. fruit: Apple',
            options: ['Submit'],
        });
        expect(tuiDialogQuestion(parseTuiDialog(await coloredScreen('omp-ask-single'), 'omp')!)).toEqual({ method: 'select', title: 'Which color do you like?', options: COLOR });
    });

    it('answers a question like a select: arrows from the cursor, then Enter; Escape cancels', async () => {
        const moved = parseTuiDialog(await coloredScreen('omp-ask-color-moved'), 'omp')!;
        expect(tuiAnswerPlan(moved, { value: ASK_OTHER_OPTION })).toEqual({ keys: DOWN + DOWN, target: 3, submit: '\r' });
        expect(tuiAnswerPlan(moved, { value: 'Red' })).toEqual({ keys: UP, target: 0, submit: '\r' });
        expect(tuiAnswerPlan(moved, { cancelled: true })).toEqual({ keys: '', submit: '\x1b' });
        expect(tuiAnswerPlan(parseTuiDialog(await coloredScreen('omp-ask-review'), 'omp')!, { value: 'Submit' })).toEqual({ keys: '', target: 0, submit: '\r' });
    });
});

describe('tuiCursorOn and tuiAnswerLanded', () => {
    it('sees the cursor on the option in the same dialog only', async () => {
        const color = parseTuiDialog(await coloredScreen('omp-ask-color'), 'omp')!;
        const moved = parseTuiDialog(await coloredScreen('omp-ask-color-moved'), 'omp');
        expect(tuiCursorOn(moved, color, 1)).toBe(true);
        expect(tuiCursorOn(moved, color, 2)).toBe(false);
        expect(tuiCursorOn(parseTuiDialog(await coloredScreen('omp-ask-fruit'), 'omp'), color, 0)).toBe(false);
        expect(tuiCursorOn(undefined, color, 0)).toBe(false);
    });

    it('expects an ask question answered to move to the next tab, Other to open its editor, and the Submit tab or Escape to close the panel', async () => {
        const color = parseTuiDialog(await coloredScreen('omp-ask-color'), 'omp')!;
        const fruit = parseTuiDialog(await coloredScreen('omp-ask-fruit'), 'omp')!;
        const review = parseTuiDialog(await coloredScreen('omp-ask-review'), 'omp')!;
        const editor = parseTuiDialog(await coloredScreen('omp-ask-other-prompt'), 'omp')!;
        expect(tuiAnswerLanded(color, { value: 'Green' }, fruit)).toBe(true);
        expect(tuiAnswerLanded(color, { value: 'Green' }, color)).toBe(false);
        expect(tuiAnswerLanded(color, { value: 'Green' }, review)).toBe(false);
        expect(tuiAnswerLanded(fruit, { value: 'Apple' }, review)).toBe(true);
        expect(tuiAnswerLanded(color, { value: ASK_OTHER_OPTION }, editor)).toBe(true);
        expect(tuiAnswerLanded(color, { value: ASK_OTHER_OPTION }, fruit)).toBe(false);
        expect(tuiAnswerLanded(review, { value: 'Submit' }, undefined)).toBe(true);
        expect(tuiAnswerLanded(review, { value: 'Submit' }, review)).toBe(false);
        expect(tuiAnswerLanded(color, { cancelled: true }, undefined)).toBe(true);
        expect(tuiAnswerLanded(color, { cancelled: true }, color)).toBe(false);
        const single = parseTuiDialog(await coloredScreen('omp-ask-single'), 'omp')!;
        expect(tuiAnswerLanded(single, { value: 'Blue' }, undefined)).toBe(true);
    });

    it('expects any other dialog to be gone, or another one', () => {
        const select = parseTuiDialog(screen('omp-select'), 'omp')!;
        expect(tuiAnswerLanded(select, { value: 'Staging' }, undefined)).toBe(true);
        expect(tuiAnswerLanded(select, { value: 'Staging' }, parseTuiDialog(screen('omp-select-moved'), 'omp'))).toBe(false);
        expect(tuiAnswerLanded(select, { value: 'Staging' }, parseTuiDialog(screen('omp-confirm'), 'omp'))).toBe(true);
    });
});
