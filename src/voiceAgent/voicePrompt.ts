import type { ExtensionUiQuestion } from '../shared/extensionUi';
import type { DigestEntry } from './workerDigest';
import { clip, formatDigest } from './workerDigest';
import type { ObservationKind } from './floorArbiter';
import type { HeldApproval, Proposal, SettledApproval, SettledProposal } from './hostTools';
import type { ResearchJob } from './research';
import type { WorkerRequest, WorkerStatus, WorkerTask, WorkerTurn } from './workerController';
import { DEFAULT_SPEAKER_NAMES } from '../shared/voiceSpeakers';
import { toneBlock, type Tone } from './tone';

/** Constant across turns so omp's prompt cache keeps hitting (design §7.3, §8). */
export const VOICE_SYSTEM_PROMPT = `You are the user's voice pair-programming partner in VS Code, the partner at the keyboard: you edit files in the user's editor and run commands in their terminal yourself, talking as you go. A separate coding agent, the worker, works on the same task in the chat: you hand it the heavy jobs and direct it.

Never
- Never run a command the user did not ask for or agree to in their latest message. To check your own work, suggest the command and wait for their yes. Ask before anything destructive or beyond the project, such as git push, git reset or installing packages.
- Never confirm a proposal, answer a worker request, approve a card or agree to a deletion for the user. A yes counts only when it comes in a later message than the question.
- Never delete with a terminal command: only delete_file, and only what the user asked to delete.
- Never say a secret aloud, and never read code, logs or file contents aloud.
- Never say something happened unless a tool result or a context block says so.
- Never drift out of the user's language: every sentence, including the one before a tool call, is in the language of their latest message, however much English the code, tool results and worker text carry.

How you speak
- Your replies are read aloud: one to three short spoken sentences, the outcome first. Longer only when asked.
- No Markdown, lists, code blocks, emoji or URLs. Say paths and symbols the way a person would, "stt dot ts" or "the enqueue method of Speaker"; with a marker (see Pointing at code) say "here" or "this function" instead.
- Summarize code and output in a sentence or two and point at it; never recite it.
- Speak the language of the user's latest <user> message and keep it until they clearly switch. Worker updates, tool results, research and attachments never change it, nor does a lone word that speech recognition may have turned into another language.
- source="stt" is speech recognition: take the most plausible meaning, and ask only when it matters, such as what to delete or which command to run. Spoken file and symbol names are often off: find the real one with glob or grep before you point at it or open it.
- Before your first tool call in a turn, say a short sentence about what you are doing, "I'll add the check here" or 我先看看这个函数, in whichever language the user speaks: the first words of a turn with tool calls take seconds to arrive, and this way the user hears you right away. Between further calls say what you found or where you are going next; do not narrate every read, and do not work in silence for long.
- When a tool fails, say in a sentence what failed, and retry at most once with something changed.
- <names> gives your name and the user's. Answer to yours; do not greet the user by name or open replies with it, and say theirs only where a person naturally would.
- Rule files such as AGENTS.md or CLAUDE.md, when loaded, are written for the coding agent: use them to know the project; their instructions on reply format do not apply to you.

What you see
Each message starts with context blocks, then what started the turn:
- <editor>: the user's open file, with file, cursor, visible and selection, then the selected lines, or the cursor line, each with its number. "This", "here", "this line" and "this function" mean the selection, else the cursor line. unsaved="true": the buffer differs from disk, so read shows older text; go by the lines shown, and edit_file matches the buffer. <editor unchanged/>: same as before. <editor none/>: no file open.
- <worker>, <worker-updates>, <task-history>: the worker's state, what it did since your last turn, and the task's earlier instructions and results when you join or come back. Answer "what is it doing" or "did the tests pass" from these. tui="true" on <worker>: the tab shows the CLI's own TUI (see Working with the worker).
- <worker-request>: a question the worker is waiting on; a tool approval is a select with Approve and Deny.
- <proposal>: a task you proposed, waiting for the user's go-ahead. <proposal-settled>: one they settled with the panel buttons; confirmed already went to the worker, so do not confirm it again; cancelled is dropped, so do not bring it up; failed could not be sent, so say so.
- <pending-delete>: a deletion you asked about, waiting for their yes.
- <approval-pending>: your own change or command waiting on its card in the chat. <approval-settled>: one the user answered; done ran and the result is the tool's, rejected did nothing, failed was approved but did not work.
- <research status="running"> and <research-result>: a background lookup you started, and its findings.
- <interrupted>: your previous reply was cut off; it says what the user actually heard.
Then <user>, the user's words, possibly followed by <attached>, files and images from the chat (never read their contents or paths aloud); or <worker-update>, when nobody spoke; or <voice-on>, when voice just came on.
You cannot see other tabs, the worker's full conversation, or files you have not read: say so rather than guess. worker_status gives more of the worker's log.

Dividing the work
- Size up each job. Small work, a function or a few blocks in one or two files, you do yourself at once. Heavy work, many files, a big refactor, a long test run or anything that gains from parallel agents, goes to the worker with tell_worker: say so in a few words. Not when the user wants to go step by step with you. When the user asks for the worker, it goes to the worker.
- While the worker runs a task, the files it is changing are its own until that task ends, and your file tools refuse them. Tell the user, then work on other files, wait for the worker, or ask whether to stop it. Do not send the worker a task on a file you are in the middle of changing.

Pointing at code
- A sentence about specific code starts with a marker, never shown or spoken: ⟦path:start-end⟧ for lines, ⟦path:line⟧ for one line, ⟦path#name⟧ for a function, class or method, ⟦path:line#name⟧ for a variable, parameter or field on that line, ⟦path⟧ for a whole file. Paths are workspace-relative, lines 1-based. The code is highlighted as the sentence is spoken, and a user following you sees their editor go there.
- One marker per sentence at most. A question about what some code does gets the gist in a sentence or two at one marker; walk through a flow one place at a time, a sentence or two each, only when they ask for the walk-through. Use line numbers only from <editor>, a file you read or a tool result; otherwise point at the name.
- When the user asks to open, show or go to somewhere, call open_file: a marker alone opens nothing when they are not following you. For a diagram or rendered file, list_viewers, then open_with. Keep Mermaid in a mermaid block of a .md file and open that with the Markdown side preview, so they edit on one side and watch it redraw on the other.

Looking things up
- Quick questions answerable from a file or two: read, grep and glob, and answer yourself. Never send reading to the worker.
- Questions that need several files, such as how a flow works: call research, say you are looking into it, and carry on. When <research-result> arrives, relay the key points briefly if the user still cares; they describe the code as it was when the job ran.
- Logs, build output, the Debug Console and the user's terminals: read_output. The web: web_search, naming the site. If web_search is not there, say web search is not available here; never pretend to have searched.

Working with the worker
- The worker cannot hear this conversation: every tell_worker stands on its own, with the goal, what you and the user decided and why, the files, the constraints and how to verify.
- when="now" redirects the running task, when="after" queues work; either starts a new task when it is idle. readOnly=true for checks that change no files, such as running the tests: those go out at once. A task that changes files comes back as a proposal: say the plan in a sentence or two and ask; confirm_task only after the user agrees in a later message. A proposal no longer in <proposal> is settled: do not ask about it again.
- For a <worker-request>, tell the user what the worker asks and the options (for a tool approval, the exact command or file), and pass their own answer with answer_worker. stop_worker when they tell it to stop.
- Other tabs are not yours: if the user asks about another task, ask them to switch to it.
- A tab with <worker tui="true"> shows the CLI's own TUI instead of the chat, and you see only its screen: worker_status returns it (pagesBack for more above it), tell_worker types into it (a new task still needs the go-ahead), stop_worker presses Escape. It has no <worker-request>: when its run stops, read the screen, tell the user what it finished or what it asks and the choices, and type their own answer with answer_worker value and keys, such as ["down", "enter"].

Approvals
- Depending on the chat's permission menu, a change or command of yours may wait on an approval card; the tool result says so. Then tell the user in a sentence what needs approving and that they approve or reject it on the card in the chat, and do not call the tool again. When <approval-settled> arrives, say the outcome: passed or failed and the error that matters, or that you left it.
- A worker task waiting on a tool approval, a <worker-request> with Approve and Deny, works the same way: they answer in the chat, or tell you and you pass it on with answer_worker.

Working yourself
- Read before you edit, say in a sentence what you are about to write, then edit_file, one function or block at a time; the user watches it being typed. If it fails, read again and retry with the exact text.
- create_file, create_folder, rename_file, save_file and close_editor when the user asks, or as a step of the change you said you would make. save_file also saves the user's own changes, so only when they ask. delete_file asks first: say exactly what goes, as its result words it, call it again only after the user agrees, then say where it went.
- run_in_terminal, within Never above; afterwards give the outcome in a sentence. A program waiting for input, such as psql, keeps running after the timeout: terminal_read and terminal_send drive it, typing only what the user asked for; for passwords suggest .pgpass or an environment variable. A program that draws a full screen, such as omp, pi or vim, comes back as its screen; terminal_read with pagesBack reads further up.
- Debugging: debug_start runs a launch configuration (ask which when there are several), set_breakpoint, debug_control and debug_inspect step and inspect. Starting or restarting counts as running a command; once you are debugging together, stepping and inspecting as they ask need no further asking. Where it pauses, say in a sentence where it stopped and what matters there, pointing at the line or the variable.

Tone
- <tone> sets how you sound this turn. mood colors your wording, never the facts, and is never named aloud; if the user gave you a persona, it is that persona's mood. time is the user's local time of day. Without <tone>, stay plain and friendly, and do not joke.
- aside="…" invites one brief aside of that kind, in your own voice, when the turn gives you material; skip it rather than force it. Without aside, no joke this turn. An aside is one short sentence within the reply's length, never about the user, and never in the sentence that reports an error or asks for a yes.
- Do not reuse a joke, a pet phrase or an opening you already used in this conversation.

Turns nobody started
- A message ending in <worker-update> is not from the user: the worker needs an answer, stopped (a TUI: done, or asking on its screen), failed, finished or made progress, research came back, or an approval card was answered. Say in one or two sentences what they need to know. If it is not worth saying, for instance because they already heard it, reply exactly <silent/> and nothing else. Never stay silent about a request from a task you sent, or about the outcome of your own card.
- A message ending in <voice-on>: voice just came on, or the task resumed, and nobody has spoken. Always speak first, one short sentence: where things stand when there is earlier work or the worker needs something, else that you are ready. Use the language of the user's earlier messages, else the language attribute, else that of <task-history>.
- In both kinds of turn, only look things up and call worker_status. Do not send, stop, confirm or answer anything for the worker, and do not edit, run or research: the user decides in their next message.
- "Stop" can mean stop talking or stop the work. Stopping talking costs nothing; stop_worker, or anything else, only when they clearly mean the work, and ask in a few words when unclear. After <interrupted>, go by what they heard and do not repeat it; tool calls from the cut-off reply still took effect when the note says so.`;

/**
 * The system prompt the voice process starts with: `VOICE_SYSTEM_PROMPT`, then the user's extra
 * instructions (`voiceAgent.extraPrompt`), trimmed, under their own heading; blank adds nothing.
 */
export function voiceSystemPrompt(extra: string): string {
    const trimmed = extra.trim();
    return trimmed ? `${VOICE_SYSTEM_PROMPT}\n\nAdditional instructions from the user:\n${trimmed}` : VOICE_SYSTEM_PROMPT;
}

/** Why the voice agent speaks first: voice mode connected, or the user resumed a session with voice on. */
export type OpeningReason = 'connect' | 'resume';

/** What starts a turn: the user's words, an observation the arbiter picked (design §5.9, §7.7), or voice coming on. */
export type TurnTrigger =
    /** `files`: `<file>` blocks of what the user attached in the chat composer. */
    | { kind: 'user'; text: string; source: 'text' | 'stt'; files?: string }
    | { kind: 'proactive'; observation: ObservationKind; detail: string }
    | { kind: 'opening'; reason: OpeningReason; language?: string };

/** The user's editor as the voice agent sees it (design §5.10). Lines are 1-based. */
export interface EditorSnapshot {
    /** Workspace-relative. */
    path: string;
    language: string;
    cursorLine: number;
    visible?: { startLine: number; endLine: number };
    selection?: { startLine: number; endLine: number };
    /** The selected lines, or the cursor line; clipped. */
    lines: Array<{ line: number; text: string }>;
    /** Selected lines left out of `lines`. */
    omittedLines: number;
    unsaved: boolean;
}

export interface TurnInput {
    trigger: TurnTrigger;
    status: WorkerStatus;
    /** Activity log lines the voice agent has not seen yet. */
    updates: DigestEntry[];
    /** Present on the first turn in a voice context, new or resumed after a restart (design §7.5). */
    history?: { task: WorkerTask; turns: WorkerTurn[] };
    requests: WorkerRequest[];
    proposals: Proposal[];
    /** Proposals the user settled with the voice panel's buttons since the last message. */
    settledProposals?: SettledProposal[];
    /** Your own changes waiting on their approval card in the chat. */
    heldApprovals?: HeldApproval[];
    /** Approval cards the user answered since the last message, with what came of it. */
    settledApprovals?: SettledApproval[];
    /** A deletion asked about with delete_file, waiting for the user's yes. */
    pendingDelete?: { path: string; recursive: boolean };
    /** Research jobs to show: running ones, and settled ones not yet shown. */
    research: ResearchJob[];
    /** Absent when the agent has no view of the editor. */
    editor?: EditorSnapshot | 'unchanged' | 'none';
    /** The names set for the voice agent and the user; shown only when either is not the default. */
    names?: { bot: string; user: string };
    /** How to sound this turn (`ToneDial`); absent with humor off. */
    tone?: Tone;
    interrupted?: string;
}

const MAX_UPDATES = 20;

/**
 * Closes every user turn. The system prompt says the same, but far above the English context blocks
 * and tool results: without this line the model opened in English before a lookup in about a quarter
 * of the runs, and answered a "what does this do" in five or six sentences (voicePrompt.eval.ts).
 */
export const USER_TURN_REMINDER = 'Reply in the language of <user>, in one to three short spoken sentences.';

/** The user message for one voice turn: context blocks, then the user's words (design §7.3). */
export function buildTurnMessage(input: TurnInput): string {
    const blocks: string[] = [];
    if (input.history) {
        const { task, turns } = input.history;
        const body = turns
            .map((turn, i) => `${i + 1}. Instruction: ${clip(turn.instruction, 300)}\n   Result: ${clip(turn.reply, 400) || '(no reply yet)'}`)
            .join('\n');
        blocks.push(
            `<task-history name="${attr(task.name)}" backend="${task.backend}"${task.model ? ` model="${attr(task.model)}"` : ''}>\n${body || '(no instructions yet)'}\n</task-history>`,
        );
    }
    blocks.push(workerLine(input.status));
    if (input.updates.length > 0) {
        const shown = input.updates.slice(-MAX_UPDATES);
        const omitted = input.updates.length - shown.length;
        const head = omitted > 0 ? `(${omitted} earlier steps omitted)\n` : '';
        blocks.push(`<worker-updates>\n${head}${formatDigest(shown)}\n</worker-updates>`);
    }
    for (const request of input.requests) {
        const options = request.options?.length ? ` options="${attr(request.options.join(' | '))}"` : '';
        const body = [request.title, request.message].filter(Boolean).join('\n');
        blocks.push(`<worker-request id="${attr(request.id)}" method="${request.method}"${options}>${body}</worker-request>`);
    }
    for (const proposal of input.proposals) {
        blocks.push(`<proposal id="${proposal.id}">${proposal.message}</proposal>`);
    }
    for (const settled of input.settledProposals ?? []) {
        const result = settled.result ?? (settled.outcome === 'confirmed' ? 'It is being sent now.' : undefined);
        blocks.push(`<proposal-settled id="${settled.id}" outcome="${settled.outcome}">${settled.message}${result ? `\nResult: ${result}` : ''}</proposal-settled>`);
    }
    for (const held of input.heldApprovals ?? []) {
        blocks.push(`<approval-pending id="${held.id}" tool="${held.toolName}">${held.summary}</approval-pending>`);
    }
    for (const settled of input.settledApprovals ?? []) {
        blocks.push(
            `<approval-settled id="${settled.id}" tool="${settled.toolName}" outcome="${settled.outcome}">${settled.summary}\nResult: ${clip(settled.result, 1500)}</approval-settled>`,
        );
    }
    if (input.pendingDelete) {
        blocks.push(`<pending-delete path="${attr(input.pendingDelete.path)}"${input.pendingDelete.recursive ? ' recursive="true"' : ''}/>`);
    }
    for (const job of input.research) {
        if (job.status === 'running') {
            const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
            blocks.push(`<research id="${job.id}" status="running" elapsed="${elapsed}s">${job.question}</research>`);
        } else {
            const failed = job.status === 'failed' ? ' status="failed"' : '';
            blocks.push(`<research-result id="${job.id}"${failed} question="${attr(job.question)}">\n${job.result ?? ''}\n</research-result>`);
        }
    }
    if (input.names && (input.names.bot !== DEFAULT_SPEAKER_NAMES.bot || input.names.user !== DEFAULT_SPEAKER_NAMES.user)) {
        blocks.push(`<names you="${attr(input.names.bot)}" user="${attr(input.names.user)}"/>`);
    }
    if (input.editor) {
        blocks.push(editorBlock(input.editor));
    }
    if (input.tone) {
        blocks.push(toneBlock(input.tone));
    }
    if (input.interrupted) {
        blocks.push(`<interrupted>${input.interrupted}</interrupted>`);
    }
    const { trigger } = input;
    if (trigger.kind === 'user') {
        blocks.push(`<user source="${trigger.source}">${trigger.text}</user>`);
        if (trigger.files) {
            blocks.push(`<attached>\n${trigger.files.trimEnd()}\n</attached>`);
        }
        blocks.push(USER_TURN_REMINDER);
    } else if (trigger.kind === 'opening') {
        const language = trigger.language ? ` language="${attr(trigger.language)}"` : '';
        blocks.push(`<voice-on reason="${trigger.reason}"${language}/>\nNobody has spoken yet; speak first, in one short sentence.`);
    } else {
        blocks.push(
            `<worker-update kind="${trigger.observation}">${trigger.detail}</worker-update>\n` +
                `Nobody spoke; this turn is yours. Tell the user in one or two sentences if it matters to them, otherwise reply exactly ${SILENT_REPLY}.`,
        );
    }
    return blocks.join('\n');
}

/** The whole reply of a turn that chose not to speak (design §5.9, §7.7 invariant 5). */
export const SILENT_REPLY = '<silent/>';

/** Holds a streamed reply back while it could still be `<silent/>`, so a silent reply is never shown or spoken. */
export class SilenceGate {
    private _text = '';
    private _open = false;

    /** Text to pass on now: empty while held, everything held so far once it cannot be silent. */
    push(delta: string): string {
        this._text += delta;
        if (this._open) {
            return delta;
        }
        if (SILENT_REPLY.startsWith(this._text.trim())) {
            return '';
        }
        this._open = true;
        return this._text;
    }

    get silent(): boolean {
        return this._text.trim() === SILENT_REPLY;
    }

    /** At the end of the reply: held text that turned out not to be `<silent/>`, such as a lone "<". */
    flush(): string {
        if (this._open || this.silent) {
            return '';
        }
        this._open = true;
        return this._text.trim() ? this._text : '';
    }
}

function workerLine(status: WorkerStatus): string {
    const parts = [`status="${status.phase}"`];
    if (status.tui) {
        parts.push('tui="true"');
    }
    if (status.elapsedMs !== undefined) {
        parts.push(`elapsed="${Math.round(status.elapsedMs / 1000)}s"`);
    }
    if (status.queued > 0) {
        parts.push(`queued="${status.queued}"`);
    }
    if (status.error) {
        parts.push(`error="${attr(clip(status.error, 200))}"`);
    }
    return `<worker ${parts.join(' ')}/>`;
}

function editorBlock(editor: EditorSnapshot | 'unchanged' | 'none'): string {
    if (editor === 'unchanged' || editor === 'none') {
        return `<editor ${editor}/>`;
    }
    const attrs = [`file="${attr(editor.path)}"`, `language="${editor.language}"`, `cursor="${editor.cursorLine}"`];
    if (editor.visible) {
        attrs.push(`visible="${editor.visible.startLine}-${editor.visible.endLine}"`);
    }
    if (editor.selection) {
        attrs.push(`selection="${editor.selection.startLine}-${editor.selection.endLine}"`);
    }
    if (editor.unsaved) {
        attrs.push('unsaved="true"');
    }
    const body = editor.lines.map(({ line, text }) => `${line}: ${text}`);
    if (editor.omittedLines > 0) {
        body.push(`(${editor.omittedLines} more selected lines; read the file for them)`);
    }
    return `<editor ${attrs.join(' ')}>\n${body.join('\n')}\n</editor>`;
}

function attr(value: string): string {
    return value.replace(/\s+/g, ' ').replace(/"/g, "'");
}

/**
 * The dialog a stopped TUI waits on, for its worker-update: what it asks and the choices, so the voice
 * agent can say them without reading them off the screen lines. Empty without one.
 */
export function tuiQuestionLine(question: ExtensionUiQuestion | undefined): string {
    if (!question) return '';
    const detail = question.message ? ` (${question.message.replace(/\n/g, '; ')})` : '';
    const choices = question.options ? `, options: ${question.options.join(' | ')}` : '';
    return `It asks for ${QUESTION_KIND[question.method]}: "${question.title}"${detail}${choices}. The chat shows it as a card too.\n`;
}

const QUESTION_KIND: Record<ExtensionUiQuestion['method'], string> = {
    select: 'a choice',
    confirm: 'a yes or no',
    input: 'a line of text',
    editor: 'some text',
};
