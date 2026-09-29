import type { ExtensionUiCard, ExtensionUiQuestion, ExtensionUiResponsePayload } from '../shared/extensionUi';
import { terminalKeys } from '../voiceAgent/hostTools';
import type { AgentBackend } from './agentBackend';

/**
 * The dialog a CLI TUI is waiting on, read off its screen (the headless mirror's text), and the keys
 * that answer it. Pure. Markers come from the TUIs' own components: omp's HookSelectorComponent,
 * HookInputComponent, HookEditorComponent and AskDialogComponent (packages/tui/src/overlays), drawn
 * in a box whose top border carries the title; pi's ExtensionSelector / Input / Editor components,
 * between full-width rules. Captured screens of each: src/test/unit/pi/fixtures/tuiDialogs/.
 */
export type TuiDialog =
    /** A list: the option with the cursor is `highlighted`. Yes / No is a confirm. */
    | { kind: 'select'; title: string; message?: string; options: string[]; highlighted: number }
    | { kind: 'input'; title: string; message?: string }
    /** `submit`: the key that submits it (omp Ctrl+Q, pi Enter; Enter is a newline in omp's). */
    | { kind: 'editor'; title: string; message?: string; submit: string }
    /**
     * omp's ask panel on a single-choice question, or on its Submit tab. Answered one question at a time,
     * as a select: Enter on an option picks it and moves to the next tab (the Submit tab after the last;
     * a single question has no tabs and submits at once); on "Other (type your own)" it opens an editor
     * for the answer; on the Submit tab it submits.
     */
    | {
          kind: 'ask';
          /** The questions' tab labels, in order; empty for a single question, which has no tab bar. */
          tabs: string[];
          /** The active tab: a question's index, or `tabs.length` for the Submit tab. */
          active: number;
          /** The active question, or "Review answers" on the Submit tab. */
          question: string;
          /** A question's options, "Other (type your own)" last; `["Submit"]` on the Submit tab. */
          options: string[];
          highlighted: number;
          /** Options marked as chosen (◉). */
          marked: number[];
          /** The Submit tab's review lines: the answers so far, a warning about unanswered ones. */
          review?: string[];
      }
    /** Waiting on the user, but not in a form a card can answer: `screen` is what to show instead. */
    | { kind: 'unknown'; title?: string; reason: string; screen: string };

/**
 * A screen to read a dialog off: its text, and its highlight (`ScreenSnapshot`), without which the ask
 * panel's active tab cannot be seen.
 */
export interface DialogScreen {
    text: string;
    highlight?: string;
}

/** The ask panel's row that opens an editor for the user's own answer. */
export const ASK_OTHER_OPTION = 'Other (type your own)';
const ASK_SUBMIT_TAB = 'Submit';

/** omp's terminal title while a tool waits on an approval or the ask panel (`π ! <session>`). */
export function ompNeedsAttention(title: string): boolean {
    return title === 'π !' || title.startsWith('π ! ');
}

/** Lines of the screen a fallback shows when no dialog box could be found. */
const FALLBACK_LINES = 20;
/** A selector's countdown, added to its title: `Pick one (12s)`. */
const COUNTDOWN = /\s\(\d+s\)$/;
const BOX_CHARS = /[\u2500-\u257f]/g;

type HintKind = 'select' | 'input' | 'editor' | 'ask' | { unknown: string };

const OMP_HINTS: Array<[RegExp, HintKind]> = [
    [/^up\/down navigate {2}enter select {2}esc cancel$/, 'select'],
    [/^up\/down navigate {2}enter toggle\b/, { unknown: 'a multi-select list' }],
    [/^enter submit {2}esc cancel$/, 'input'],
    [/^(?:enter or ctrl\+q|ctrl\+q\/ctrl\+enter) submit {2}esc cancel {2}ctrl\+g external editor$/, 'editor'],
    // The ask panel: questions on tabs, notes, an Other row.
    [/^(?:Enter (?:select|submit|next)|Space toggle) · .*\bcancel\b/i, 'ask'],
];

const PI_HINTS: Array<[RegExp, HintKind]> = [
    [/^↑↓ navigate {2}enter select {2}\S+ cancel$/, 'select'],
    [/^enter submit {2}\S+ newline {2}\S+ cancel {2}\S+ external editor$/, 'editor'],
    [/^enter submit {2}\S+ cancel$/, 'input'],
];

/**
 * The dialog on `screen`, or undefined when there is none to show. `attention` (omp's title says it
 * waits on the user) turns a screen with no dialog found into an `unknown` one.
 */
export function parseTuiDialog(screen: DialogScreen, backend: AgentBackend, attention = false): TuiDialog | undefined {
    const lines = screen.text.split('\n');
    const hints = backend === 'omp' ? OMP_HINTS : PI_HINTS;
    for (let h = lines.length - 1; h >= 0; h--) {
        const text = (backend === 'omp' ? unbox(lines[h]) ?? '' : lines[h]).trim();
        const match = hints.find(([re]) => re.test(text));
        if (match) {
            const kind = match[1];
            const dialog =
                kind === 'ask'
                    ? parseAsk(lines, screen.highlight?.split('\n') ?? [], h, text)
                    : backend === 'omp'
                      ? parseOmp(lines, h, kind)
                      : parsePi(lines, h, kind);
            return dialog ?? fallback(lines, 'a dialog whose layout was not recognized');
        }
    }
    return attention ? fallback(lines, 'omp says it is waiting on you') : undefined;
}

function fallback(lines: string[], reason: string, from = Math.max(0, lines.length - FALLBACK_LINES), to = lines.length, title?: string): TuiDialog {
    return { kind: 'unknown', reason, screen: trimBlankLines(lines.slice(from, to)).join('\n'), ...(title ? { title } : {}) };
}

/** A row inside omp's dialog box without its side borders; undefined for any other row. */
function unbox(line: string): string | undefined {
    const match = /^│(.*)│$/.exec(line);
    return match ? match[1].trimEnd() : undefined;
}

function parseOmp(lines: string[], hint: number, kind: Exclude<HintKind, 'ask'>): TuiDialog | undefined {
    if (typeof kind === 'object') {
        // A box that is no plain select: back to the box's top, then to its bottom.
        let boxTop = hint - 1;
        while (boxTop >= 0 && !lines[boxTop].startsWith('╭')) boxTop--;
        const bottom = lines.findIndex((line, i) => i > hint && line.startsWith('╰'));
        const title = boxTop >= 0 ? /^╭─ (.+?) ─+╮$/.exec(lines[boxTop])?.[1].replace(COUNTDOWN, '') : undefined;
        return fallback(lines, kind.unknown, Math.max(0, boxTop), bottom < 0 ? lines.length : bottom + 1, title);
    }
    let top = hint - 1;
    while (top >= 0 && unbox(lines[top]) !== undefined) top--;
    const border = top >= 0 ? /^╭─ (.+?) ─+╮$/.exec(lines[top]) : null;
    if (!border) return undefined;
    const title = border[1].replace(COUNTDOWN, '');
    const body = lines.slice(top + 1, hint).map((line) => unbox(line)!);
    if (kind === 'select') {
        return parseList(body, title, /^ {2}❯ (.+)$/, /^ {4}(\S.*)$/, /^ (\S.*)$/, /^ {4}\((\d+)\/(\d+)\)/);
    }
    // The text field: omp's input and prompt-style editor start it with `> `; its default editor is a box.
    const field = body.findIndex((line) => /^ >(?: |$)/.test(line) || /^ ╭─+╮$/.test(line));
    if (field < 0) return undefined;
    const detail = bodyMessage(body.slice(0, field), /^ (\S.*)$/);
    // Detail lines below the border's title are all message here.
    const message = [detail.title, detail.message].filter(Boolean).join('\n');
    // Text already in the field would stay in front of the answer: the TUI takes it from here.
    if (fieldText(body.slice(field)) !== '') {
        return { kind: 'unknown', title, reason: 'its text field already has text', screen: trimBlankLines(body).join('\n') };
    }
    const withMessage = { title, ...(message ? { message } : {}) };
    return kind === 'input' ? { kind: 'input', ...withMessage } : { kind: 'editor', ...withMessage, submit: '\x11' };
}

function parsePi(lines: string[], hint: number, kind: Exclude<HintKind, 'ask'>): TuiDialog | undefined {
    const rule = (from: number) => {
        let i = from;
        while (i >= 0 && !/^─+$/.test(lines[i])) i--;
        return i;
    };
    const top = rule(hint - 1);
    if (top < 0) return undefined;
    if (kind === 'select') {
        return parseList(lines.slice(top + 1, hint), undefined, /^ → (.+)$/, /^ {3}(\S.*)$/, /^ (\S.*)$/);
    }
    if (kind === 'editor') {
        // The editor has its own rules: title, rule, text, rule, hint.
        const editorTop = rule(top - 1);
        const dialogTop = rule(editorTop - 1);
        if (editorTop < 0 || dialogTop < 0) return undefined;
        const heading = bodyMessage(lines.slice(dialogTop + 1, editorTop), /^ (\S.*)$/);
        if (!heading.title) return undefined;
        if (fieldText(lines.slice(editorTop + 1, top)) !== '') {
            return { kind: 'unknown', title: heading.title, reason: 'its text field already has text', screen: trimBlankLines(lines.slice(dialogTop + 1, hint + 1)).join('\n') };
        }
        return { kind: 'editor', title: heading.title, ...(heading.message ? { message: heading.message } : {}), submit: '\r' };
    }
    if (typeof kind === 'object') return undefined;
    const body = lines.slice(top + 1, hint);
    const field = body.findIndex((line) => /^>(?: |$)/.test(line));
    if (field < 0) return undefined;
    const heading = bodyMessage(body.slice(0, field), /^ (\S.*)$/);
    if (!heading.title) return undefined;
    if (fieldText(body.slice(field)) !== '') {
        return { kind: 'unknown', title: heading.title, reason: 'its text field already has text', screen: trimBlankLines(body).join('\n') };
    }
    return { kind: 'input', title: heading.title, ...(heading.message ? { message: heading.message } : {}) };
}

/**
 * omp's ask panel (AskDialogComponent): a box titled `Ask`, then the tab bar (question ids, then
 * `Submit`; the active tab told apart only by its background, so read from `highlights`), the question,
 * a rule, the options (`❯` the cursor, `○` / `◉` unchosen / chosen), a rule, and `footer`. Anything it
 * cannot answer as a select (a multi-select question, a list that scrolls, a tab bar it cannot read)
 * becomes an unknown dialog showing the box.
 */
function parseAsk(lines: string[], highlights: string[], hint: number, footer: string): TuiDialog | undefined {
    let top = hint - 1;
    while (top >= 0 && !lines[top].startsWith('╭')) top--;
    const title = top >= 0 ? /^╭─ (.+?) ─+╮$/.exec(lines[top])?.[1].replace(COUNTDOWN, '') : undefined;
    if (top < 0 || !title) return undefined;
    const bottom = lines.findIndex((line, i) => i > hint && line.startsWith('╰'));
    const unknown = (reason: string): TuiDialog => fallback(lines, reason, top, bottom < 0 ? lines.length : bottom + 1, title);
    // Sections between the box's inner rules: the heading, then the list.
    const sections: number[][] = [[]];
    for (let i = top + 1; i < hint; i++) {
        if (lines[i].startsWith('├')) sections.push([]);
        else if (unbox(lines[i]) !== undefined) sections[sections.length - 1].push(i);
    }
    if (sections.length < 3) return undefined;
    const [heading, list] = sections;
    if (/^Space toggle/.test(footer)) return unknown('a multi-select question of the ask panel');
    const submitTab = /^Enter submit · /.test(footer);
    if (!submitTab && /PgUp|PgDn| scroll ·/.test(footer)) return unknown('an ask question whose options do not fit on the screen');

    // The tab bar: each label padded with a space, two spaces apart; the last is Submit.
    const bar = heading.length > 0 ? unbox(lines[heading[0]])!.trim() : '';
    const labels = bar.split(/ {4,}/);
    const hasTabs = labels.length > 1 && labels[labels.length - 1] === ASK_SUBMIT_TAB;
    let tabs: string[] = [];
    let active = 0;
    if (hasTabs) {
        tabs = labels.slice(0, -1);
        const row = lines[heading[0]];
        const start = (highlights[heading[0]] ?? '').search(/\S/);
        if (start < 0) return unknown('an ask panel whose active tab cannot be seen');
        let from = 0;
        active = labels.findIndex((label) => {
            const at = row.indexOf(label, from);
            from = at + label.length;
            return at >= 0 && start >= at - 1 && start < at + label.length + 1;
        });
        if (active < 0) return unknown('an ask panel whose active tab cannot be seen');
    } else if (submitTab || /Tab\/←\/→/.test(footer)) {
        return unknown('an ask panel whose tabs do not fit on one line');
    }
    const question = heading
        .slice(hasTabs ? 1 : 0)
        .map((i) => unbox(lines[i])!.trim())
        .filter(Boolean)
        .join(' ');
    const rows = list.map((i) => unbox(lines[i])!);

    if (hasTabs && active === tabs.length) {
        const submit = rows.findIndex((row) => /^ ❯ Submit$/.test(row));
        if (question !== 'Review answers' || submit < 0) return undefined;
        const review = rows.filter((row, i) => i !== submit && row.trim()).map((row) => row.trim());
        return { kind: 'ask', tabs, active, question, options: [ASK_SUBMIT_TAB], highlighted: 0, marked: [], review };
    }
    const options: string[] = [];
    const marked: number[] = [];
    let highlighted = -1;
    for (const row of rows) {
        const option = /^ (❯| ) ([○◉]) (.+)$/.exec(row);
        if (option) {
            if (option[1] === '❯') highlighted = options.length;
            if (option[2] === '◉') marked.push(options.length);
            options.push(option[3].replace(/ {2}✎ note$/, '').trim());
            continue;
        }
        // A label wrapped onto the next row: indented past the cursor and marker. Deeper rows are
        // option descriptions, or the text typed for Other.
        const more = /^ {5}(\S.*)$/.exec(row);
        if (more && options.length > 0) options[options.length - 1] += ` ${more[1].trim()}`;
    }
    if (!question || highlighted < 0 || options[options.length - 1] !== ASK_OTHER_OPTION) return undefined;
    return { kind: 'ask', tabs, active, question, options, highlighted, marked };
}

/**
 * A select's rows: the highlighted option, the others, heading lines (the title when the box does not
 * carry it, then detail lines such as `Command: …`), and omp's `(k/N)` count, shown when the list
 * scrolls. Deeper-indented rows (option descriptions) are left out.
 */
function parseList(body: string[], boxTitle: string | undefined, selected: RegExp, other: RegExp, heading: RegExp, count?: RegExp): TuiDialog | undefined {
    const options: string[] = [];
    const headingLines: string[] = [];
    let highlighted = -1;
    let total: number | undefined;
    for (const line of body) {
        const counted = count?.exec(line);
        if (counted) {
            total = Number(counted[2]);
            continue;
        }
        const chosen = selected.exec(line);
        if (chosen) {
            highlighted = options.length;
            options.push(chosen[1].trim());
            continue;
        }
        const plain = other.exec(line);
        if (plain) {
            options.push(plain[1].trim());
            continue;
        }
        const head = heading.exec(line);
        if (head && options.length === 0) headingLines.push(head[1].trim());
    }
    const title = (boxTitle ?? headingLines.shift())?.replace(COUNTDOWN, '');
    if (!title || options.length === 0 || highlighted < 0) return undefined;
    if (total !== undefined && total > options.length) {
        return { kind: 'unknown', title, reason: `a list of ${total} options that does not fit on the screen`, screen: trimBlankLines(body).join('\n') };
    }
    return { kind: 'select', title, ...(headingLines.length > 0 ? { message: headingLines.join('\n') } : {}), options, highlighted };
}

/** Heading lines above a text field: the first is the title (when not on a border), the rest the message. */
function bodyMessage(lines: string[], heading: RegExp): { title?: string; message?: string } {
    const found = lines.flatMap((line) => {
        const match = heading.exec(line);
        return match ? [match[1].trim()] : [];
    });
    const [title, ...rest] = found;
    return { ...(title ? { title: title.replace(COUNTDOWN, '') } : {}), ...(rest.length > 0 ? { message: rest.join('\n') } : {}) };
}

/** What a text field holds, borders and the `>` prompt left out. */
function fieldText(lines: string[]): string {
    return lines
        .join('\n')
        .replace(BOX_CHARS, '')
        .replace(/^\s*>/, '')
        .trim();
}

function trimBlankLines(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && !lines[start].trim()) start++;
    while (end > start && !lines[end - 1].trim()) end--;
    return lines.slice(start, end);
}

/** Two readings of the same dialog: kind, title and options match (not where the cursor is). */
export function sameTuiDialog(a: TuiDialog, b: TuiDialog): boolean {
    return tuiDialogKey(a) === tuiDialogKey(b);
}

function tuiDialogKey(dialog: TuiDialog): string {
    switch (dialog.kind) {
        case 'select':
            return JSON.stringify([dialog.kind, dialog.title, dialog.options]);
        case 'ask':
            // Another tab is another question, and another card.
            return JSON.stringify([dialog.kind, dialog.tabs, dialog.active, dialog.question, dialog.options]);
        default:
            return JSON.stringify([dialog.kind, dialog.title ?? '', dialog.kind === 'unknown' ? dialog.reason : '']);
    }
}

/** An ask panel on its Submit tab, which Enter submits. */
export function askOnSubmitTab(dialog: TuiDialog | undefined): boolean {
    return dialog?.kind === 'ask' && dialog.tabs.length > 0 && dialog.active === dialog.tabs.length;
}

/** The question a dialog asks, as a card shows it and the voice agent hears it; undefined for an unknown one. */
export function tuiDialogQuestion(dialog: TuiDialog): ExtensionUiQuestion | undefined {
    switch (dialog.kind) {
        case 'unknown':
            return undefined;
        case 'ask': {
            // One question of the panel at a time, as a select; the Submit tab as a select of Submit.
            const chosen = dialog.marked.map((i) => dialog.options[i]);
            const message = askOnSubmitTab(dialog)
                ? dialog.review?.join('\n')
                : [dialog.tabs.length > 1 ? `Question ${dialog.active + 1} of ${dialog.tabs.length}` : '', chosen.length > 0 ? `Chosen: ${chosen.join(', ')}` : '']
                      .filter(Boolean)
                      .join(' · ');
            return { method: 'select', title: dialog.question, ...(message ? { message } : {}), options: dialog.options };
        }
        case 'select':
            return isConfirm(dialog.options)
                ? { method: 'confirm', title: dialog.title, ...(dialog.message ? { message: dialog.message } : {}) }
                : { method: 'select', title: dialog.title, ...(dialog.message ? { message: dialog.message } : {}), options: dialog.options };
        case 'input':
        case 'editor':
            return { method: dialog.kind, title: dialog.title, ...(dialog.message ? { message: dialog.message } : {}) };
    }
}

/** The card for `dialog`: its question, or its screen text with a way to the TUI. */
export function tuiDialogCard(dialog: TuiDialog, id: string, tabId: string): ExtensionUiCard {
    const question = tuiDialogQuestion(dialog);
    if (question) return { id, ...question };
    const unknown = dialog as Extract<TuiDialog, { kind: 'unknown' }>;
    return { id, method: 'screen', tabId, title: unknown.title ?? 'The TUI is waiting on you', message: unknown.screen };
}

function isConfirm(options: string[]): boolean {
    return options.length === 2 && options[0] === 'Yes' && options[1] === 'No';
}

/**
 * Keys that answer `dialog` with a card's answer, in two steps so the result can be checked before it
 * is final: `keys` (arrows to the option, or the text), then `submit`. For a select, `target` is the
 * option the cursor must be on before `submit`.
 */
export type TuiAnswerPlan = { keys: string; target?: number; submit: string } | { error: string };

export function tuiAnswerPlan(dialog: TuiDialog, answer: Omit<ExtensionUiResponsePayload, 'id'>): TuiAnswerPlan {
    if (dialog.kind === 'unknown') {
        return { error: `the dialog is ${dialog.reason}` };
    }
    if (answer.cancelled) {
        return { keys: '', submit: terminalKeys(['escape']) };
    }
    if (dialog.kind === 'select' || dialog.kind === 'ask') {
        const value =
            dialog.kind === 'select' && answer.confirmed !== undefined && isConfirm(dialog.options) ? (answer.confirmed ? 'Yes' : 'No') : answer.value;
        const target = value === undefined ? -1 : dialog.options.indexOf(value);
        if (target < 0) return { error: `"${value ?? ''}" is not one of its options` };
        const steps = target - dialog.highlighted;
        return { keys: terminalKeys(Array(Math.abs(steps)).fill(steps > 0 ? 'down' : 'up')), target, submit: terminalKeys(['enter']) };
    }
    const value = answer.value ?? '';
    if (dialog.kind === 'input') {
        // One line, typed: no newline, and no control character that would act as a key.
        return { keys: value.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, ''), submit: terminalKeys(['enter']) };
    }
    // Pasted, so its newlines stay newlines; a paste end marker inside it would end the paste early.
    const text = value.replace(/\x1b\[20[01]~/g, '').replace(/\r\n?/g, '\n');
    return { keys: `\x1b[200~${text}\x1b[201~`, submit: dialog.submit };
}

/** Whether `screen` shows `dialog` with its cursor on option `target`: the move before a select's Enter landed. */
export function tuiCursorOn(screen: TuiDialog | undefined, dialog: TuiDialog, target: number): boolean {
    return (screen?.kind === 'select' || screen?.kind === 'ask') && sameTuiDialog(screen, dialog) && screen.highlighted === target;
}

/**
 * Whether `after` (the dialog on the screen after the submit key, if any) is what answering `before`
 * with `answer` should leave. Most dialogs just close. The ask panel: Escape closes it whole; Other
 * opens the editor for the answer; an option moves to the next tab (a single question submits and
 * closes); the Submit tab closes.
 */
export function tuiAnswerLanded(before: TuiDialog, answer: Omit<ExtensionUiResponsePayload, 'id'>, after: TuiDialog | undefined): boolean {
    if (before.kind !== 'ask') {
        return !after || !sameTuiDialog(after, before);
    }
    if (answer.cancelled || askOnSubmitTab(before) || before.tabs.length === 0) {
        return after?.kind !== 'ask' && !(after?.kind === 'unknown' && after.title === 'Ask');
    }
    if (answer.value === ASK_OTHER_OPTION) {
        return after?.kind === 'editor';
    }
    return after?.kind === 'ask' && JSON.stringify(after.tabs) === JSON.stringify(before.tabs) && after.active === before.active + 1;
}
