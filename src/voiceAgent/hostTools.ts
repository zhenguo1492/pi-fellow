import * as path from 'node:path';
import type { RpcHostToolDefinition } from '../pi/rpcTypes';
import type { CodeAnchor } from './codeAnchors';
import type { WorkerAnswer, WorkerController, WorkerSendOutcome } from './workerController';
import type { ResearchJob } from './research';
import { formatViewers, type FileViewers, type Viewer } from './viewers';
import { clip, formatDigest, type WorkerDigest } from './workerDigest';

/** Keys terminal_send can press by name: what a terminal gets for each. */
const TERMINAL_KEYS: Record<string, string> = {
    up: '\x1b[A',
    down: '\x1b[B',
    right: '\x1b[C',
    left: '\x1b[D',
    tab: '\t',
    space: ' ',
    enter: '\r',
    escape: '\x1b',
    esc: '\x1b',
    backspace: '\x7f',
    delete: '\x1b[3~',
    home: '\x1b[H',
    end: '\x1b[F',
    pageup: '\x1b[5~',
    pagedown: '\x1b[6~',
};

/** Names terminal_send's description offers; any ctrl-<letter> works too. */
const TERMINAL_KEY_NAMES = `${Object.keys(TERMINAL_KEYS).join(', ')}, and ctrl-a to ctrl-z (e.g. ctrl-c)`;

/** How far back worker_status and terminal_read look at most, in screens. */
const MAX_PAGES_BACK = 20;

/** A pagesBack argument in whole screens, within 0..MAX_PAGES_BACK. */
function pagesBack(value: unknown): number {
    return typeof value === 'number' ? Math.min(Math.max(Math.round(value), 0), MAX_PAGES_BACK) : 0;
}

/** One key name as the characters a terminal gets for it; ctrl-<letter> (or ctrl+<letter>) is that control character. */
function terminalKey(name: string): string | undefined {
    const key = name.trim().toLowerCase().replace(/\s*\+\s*/g, '-');
    const ctrl = /^(?:ctrl|control)-([a-z])$/.exec(key);
    if (ctrl) {
        return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
    }
    return Object.hasOwn(TERMINAL_KEYS, key) ? TERMINAL_KEYS[key] : undefined;
}

/** terminal_send's keys, as the characters to send; unknown names are refused rather than guessed. */
export function terminalKeys(keys: unknown): string {
    if (keys === undefined) {
        return '';
    }
    if (!Array.isArray(keys)) {
        throw new Error('keys must be a list of key names.');
    }
    return keys
        .map((key) => {
            const sequence = typeof key === 'string' ? terminalKey(key) : undefined;
            if (sequence === undefined) {
                throw new Error(`Unknown key ${JSON.stringify(key)}: use ${TERMINAL_KEY_NAMES}.`);
            }
            return sequence;
        })
        .join('');
}

/** A new task held back until the user agrees (design §6, two-phase confirmation). */
export interface Proposal {
    id: string;
    tabId: string;
    message: string;
    includeEditorContext: boolean;
    /** Voice turn that proposed it; only a later user turn may confirm it. */
    createdTurn: number;
}

/** A proposal that is no longer waiting: sent, turned down, or confirmed but not delivered. */
export interface SettledProposal {
    id: string;
    tabId: string;
    message: string;
    outcome: 'confirmed' | 'cancelled' | 'failed';
    /** The voice panel's buttons, or confirm_task after the user agreed aloud. */
    by: 'button' | 'voice';
    /** What sending it did, or why it failed; undefined while it is being sent, and for a cancelled one. */
    result?: string;
}

/** One of the voice agent's own changes waiting on the approval card in the chat (Manual, or a command, move or deletion in Edit automatically). */
export interface HeldApproval {
    id: string;
    tabId: string;
    toolName: string;
    /** The command, path or move it would do. */
    summary: string;
}

/** The user answered an approval card: done (with the tool's result), rejected, or approved but it failed. */
export interface SettledApproval extends HeldApproval {
    outcome: 'done' | 'rejected' | 'failed';
    result: string;
}

/** The voice turn a tool call belongs to: its bound tab (§5.12 rule 4) and when the user spoke. */
export interface ToolTurn {
    tabId: string;
    /** Increments once per user turn; a proactive turn carries the last user turn's. */
    seq: number;
    /** Epoch ms the latest user message arrived. */
    userAt: number;
    /** Started by the arbiter, not the user: nobody asked for anything, so it may only look (§5.9). */
    proactive?: boolean;
}

export interface ToolResult {
    text: string;
    isError: boolean;
    /** research: the background job this call started; its findings arrive when it settles. */
    research?: ResearchJob;
}

const OBJECT = { type: 'object', additionalProperties: false } as const;

export const VOICE_HOST_TOOLS: RpcHostToolDefinition[] = [
    {
        name: 'tell_worker',
        label: 'Tell worker',
        description:
            "Send an instruction to the worker, the coding agent on the user's current task. Routed on the worker's state when it runs: idle starts a new task (a task that changes files may return a proposal that needs the user's go-ahead); working with when=now steers the running task; working with when=after queues it to run once the current task finishes. In a tab showing the CLI's TUI (<worker tui=\"true\">) it is typed into the TUI's editor and submitted, as the user would.",
        parameters: {
            ...OBJECT,
            properties: {
                message: {
                    type: 'string',
                    description:
                        'Self-contained instruction: the goal, decisions made with the user and why, files involved, constraints, and how to verify.',
                },
                when: {
                    type: 'string',
                    enum: ['now', 'after'],
                    description: 'now: change what the worker is doing right now. after: do this once the current task is done.',
                },
                includeEditorContext: {
                    type: 'boolean',
                    description: "Attach the user's current editor file and selection.",
                },
                readOnly: {
                    type: 'boolean',
                    description:
                        'true when the worker only runs checks such as tests or other commands, without editing, creating or deleting files. Sent without asking; the worker is told not to change files.',
                },
            },
            required: ['message', 'when'],
        },
        loadMode: 'essential',
    },
    {
        name: 'confirm_task',
        label: 'Confirm task',
        description:
            'Send a proposal from tell_worker after the user agreed to it in a message that came after the proposal.',
        parameters: { ...OBJECT, properties: { proposalId: { type: 'string' } }, required: ['proposalId'] },
        loadMode: 'essential',
    },
    {
        name: 'stop_worker',
        label: 'Stop worker',
        description:
            "Stop what the worker is doing. Use when the user tells it to stop. In a TUI tab it presses Escape, the TUI's interrupt; a run stopped on a question counts as idle there: to dismiss the question, press escape with answer_worker.",
        parameters: { ...OBJECT, properties: {} },
        loadMode: 'essential',
    },
    {
        name: 'answer_worker',
        label: 'Answer worker',
        description:
            "Answer a <worker-request> with the user's own answer. select: value is one of the options. confirm: confirmed. input/editor: value. cancel: true dismisses the request. In a TUI tab (<worker tui=\"true\">) there are no requests: the question is on its screen; type the user's answer into the TUI as value (text) and/or keys (e.g. [\"down\", \"enter\"] to pick the second option), without requestId, and get its screen back.",
        parameters: {
            ...OBJECT,
            properties: {
                requestId: { type: 'string', description: 'The <worker-request> id; not in a TUI tab.' },
                value: { type: 'string', description: 'The answer; in a TUI tab, text typed as it is.' },
                confirmed: { type: 'boolean' },
                cancel: { type: 'boolean' },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: `TUI tab only: keys pressed after value, in order: ${TERMINAL_KEY_NAMES}.`,
                },
            },
        },
        loadMode: 'essential',
    },
    {
        name: 'worker_status',
        label: 'Worker status',
        description:
            "The worker's state, what it is waiting on, its recent activity log, and the task's last instructions with their results. In a TUI tab, its state and the TUI's screen as text instead (or that nothing changed since you last read it).",
        parameters: {
            ...OBJECT,
            properties: {
                pagesBack: {
                    type: 'integer',
                    minimum: 0,
                    maximum: MAX_PAGES_BACK,
                    description: 'TUI tab only: how many screens further up to read, when the screen does not show enough; default 0, the screen itself.',
                },
            },
        },
        loadMode: 'essential',
    },
    {
        name: 'research',
        label: 'Research',
        description:
            'Start a background look through the codebase for a question that needs several files read, such as how a flow works or where a feature lives. Runs read-only in a separate process while you keep talking; its findings arrive in a later message as <research-result>. For one file or symbol, read it yourself instead.',
        parameters: {
            ...OBJECT,
            properties: {
                question: {
                    type: 'string',
                    description: 'Self-contained question; name the files, symbols or features you already know about.',
                },
            },
            required: ['question'],
        },
        loadMode: 'essential',
    },
    {
        name: 'show_text',
        label: 'Show text',
        description:
            'Show text as a card under your reply in the chat, never read aloud: a code example, a SQL query, a command line, a config snippet, or anything else the user should see or copy rather than hear. Say in a sentence what it is instead of reading it. Changes nothing.',
        parameters: {
            ...OBJECT,
            properties: {
                text: { type: 'string', description: 'Exactly what to show, as the user would copy it.' },
                language: { type: 'string', description: 'Its language for highlighting, e.g. sql, bash, typescript, json; leave out for plain text.' },
                title: { type: 'string', description: 'A few words on what it is, shown on the card.' },
            },
            required: ['text'],
        },
        loadMode: 'essential',
    },
    {
        name: 'open_file',
        label: 'Open file',
        description:
            "Open a file in the user's editor, scroll to the lines, symbol or name and highlight them, whether or not the user is following you. Use it when the user asks to open, show or go to a file or place. To point at code while you explain it, start the sentence with a marker instead.",
        parameters: {
            ...OBJECT,
            properties: {
                path: { type: 'string', description: 'Workspace-relative path.' },
                startLine: { type: 'integer', minimum: 1, description: 'First line to show, 1-based.' },
                endLine: { type: 'integer', minimum: 1, description: 'Last line to show; defaults to startLine.' },
                symbol: {
                    type: 'string',
                    description:
                        'Alone: a function, class or method to show instead of lines, e.g. Speaker.enqueue. With startLine: one name on that line, such as a variable or parameter; just it and its other uses in the file are highlighted.',
                },
            },
            required: ['path'],
        },
        loadMode: 'essential',
    },
    {
        name: 'list_viewers',
        label: 'List viewers',
        description:
            "List the ways the user's VS Code can show a file besides plain text: editors for its file type from the installed extensions (e.g. the draw.io editor for .drawio, VS Code's image preview) and VS Code's built-in preview commands (e.g. the Markdown preview, which also draws the Mermaid diagrams in a .md file). Call it before open_with whenever the user asks to see, preview or view a diagram or rendered file; open_with only takes a viewer id from this list. Changes nothing.",
        parameters: { ...OBJECT, properties: { path: { type: 'string', description: 'Workspace-relative path.' } }, required: ['path'] },
        loadMode: 'essential',
    },
    {
        name: 'open_with',
        label: 'Open with',
        description:
            "Show a file in the user's editor with one of the viewers list_viewers returned for it: an editor opens the file in it, a command opens the file and runs it. For a diagram file such as .drawio, use its editor. For Mermaid, show the Markdown file that holds it with markdown.showPreviewToSide, so the user edits on one side and watches it render on the other. Only ids from list_viewers for this same file are accepted: call list_viewers first. Gives up waiting after 8 seconds. Changes no files.",
        parameters: {
            ...OBJECT,
            properties: {
                path: { type: 'string', description: 'Workspace-relative path.' },
                viewer: { type: 'string', description: 'The id of an editor or command exactly as list_viewers gave it, e.g. an editor viewType, "default" for the text editor, or a command id.' },
                toSide: { type: 'boolean', description: 'Open it in the editor group beside the current one, so the source stays visible.' },
            },
            required: ['path', 'viewer'],
        },
        loadMode: 'essential',
    },
    {
        name: 'edit_file',
        label: 'Edit file',
        description:
            "Replace oldText with newText in an existing file, typed out character by character in the user's editor while they follow you, so they watch you write (at once when they do not); one Ctrl+Z undoes it. oldText must match the file exactly (read it first). An empty oldText fills an empty file. New files are made with create_file. Keep each edit small: one function or block.",
        parameters: {
            ...OBJECT,
            properties: {
                path: { type: 'string', description: 'Workspace-relative path.' },
                oldText: { type: 'string', description: 'Exact text to replace, whitespace included; empty for an empty file.' },
                newText: { type: 'string', description: 'The replacement.' },
                nearLine: { type: 'integer', minimum: 1, description: 'When oldText occurs more than once: the line of the one you mean.' },
            },
            required: ['path', 'oldText', 'newText'],
        },
        loadMode: 'essential',
    },
    {
        name: 'create_file',
        label: 'Create file',
        description:
            "Create a new file in the workspace, with its content if given, and open it in the user's editor. Missing parent folders are created. Fails if the file exists: change existing files with edit_file.",
        parameters: {
            ...OBJECT,
            properties: {
                path: { type: 'string', description: 'Workspace-relative path.' },
                content: { type: 'string', description: 'The whole initial content; empty when left out.' },
            },
            required: ['path'],
        },
        loadMode: 'essential',
    },
    {
        name: 'create_folder',
        label: 'Create folder',
        description: 'Create a folder in the workspace, with any missing parents.',
        parameters: { ...OBJECT, properties: { path: { type: 'string', description: 'Workspace-relative path.' } }, required: ['path'] },
        loadMode: 'essential',
    },
    {
        name: 'rename_file',
        label: 'Rename file',
        description: 'Rename or move a file or folder within the workspace. Never overwrites: fails if the new path exists.',
        parameters: {
            ...OBJECT,
            properties: {
                from: { type: 'string', description: 'Workspace-relative path it has now.' },
                to: { type: 'string', description: 'Workspace-relative path it gets.' },
            },
            required: ['from', 'to'],
        },
        loadMode: 'essential',
    },
    {
        name: 'delete_file',
        label: 'Delete file',
        description:
            'Delete a file, or a folder with recursive true. The first call deletes nothing: it checks the path and records the request; tell the user exactly what goes and ask. Call it again with the same path and recursive only after they agree in their next message. It goes to the trash; if the trash cannot take it, it is backed up to a temp folder first and the result says where.',
        parameters: {
            ...OBJECT,
            properties: {
                path: { type: 'string', description: 'Workspace-relative path.' },
                recursive: { type: 'boolean', description: 'Required for a folder: delete it with everything in it.' },
            },
            required: ['path'],
        },
        loadMode: 'essential',
    },
    {
        name: 'save_file',
        label: 'Save file',
        description:
            "Save an open file, or without path every open workspace file with unsaved changes. This also saves the user's own unsaved changes.",
        parameters: { ...OBJECT, properties: { path: { type: 'string', description: 'Workspace-relative path; leave out to save all.' } } },
        loadMode: 'essential',
    },
    {
        name: 'close_editor',
        label: 'Close editor',
        description: "Close a file's tabs in the user's editor. Refused while it has unsaved changes.",
        parameters: { ...OBJECT, properties: { path: { type: 'string', description: 'Workspace-relative path.' } }, required: ['path'] },
        loadMode: 'essential',
    },
    {
        name: 'run_in_terminal',
        label: 'Run in terminal',
        description:
            "Type a command into the Pi terminal in the user's VS Code and run it; returns the exit code and the last lines of output. When its output has been quiet for 5 seconds, or after timeoutSecs, it returns what it has so far and the command keeps running (servers, watchers, or a program waiting for input such as psql), which terminal_send and terminal_read then drive.",
        parameters: {
            ...OBJECT,
            properties: {
                command: { type: 'string' },
                timeoutSecs: { type: 'integer', minimum: 1, maximum: 600, description: 'How long to wait for it to finish; default 30.' },
            },
            required: ['command'],
        },
        loadMode: 'essential',
    },
    {
        name: 'terminal_send',
        label: 'Type in terminal',
        description:
            "Type a line into a program still running in a Pi terminal (one run_in_terminal left running, such as psql answering a prompt), then wait until its output goes quiet and return only the new output, or its exit code if it ended; for a program that draws a full screen (omp, pi, vim, less, htop) its screen as text instead. What you type is usually echoed into the terminal and its output: for passwords prefer .pgpass or environment variables, and never repeat a secret back.",
        parameters: {
            ...OBJECT,
            properties: {
                terminal: { type: 'string', description: 'The Pi terminal\'s name, e.g. "Pi (2)"; default: the latest one still running.' },
                text: { type: 'string', description: 'What to type, e.g. a SQL statement; may be empty to just press Enter or send keys.' },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: `Keys to press after the text, in order, e.g. ["down", "down"] to move in a selection menu or ["ctrl-c"] to interrupt: ${TERMINAL_KEY_NAMES}.`,
                },
                enter: { type: 'boolean', description: 'Press Enter after it all; default true, but false when keys are given.' },
                waitSecs: { type: 'integer', minimum: 1, maximum: 30, description: 'How long to wait for its output to go quiet; default 2.' },
            },
            required: ['text'],
        },
        loadMode: 'essential',
    },
    {
        name: 'terminal_read',
        label: 'Read terminal',
        description:
            "What a program left running in a Pi terminal printed since you last saw it (its last lines when nothing is new), and whether it is still running. For a program that draws a full screen (omp, pi, vim, less, htop), its screen as text instead, or that nothing changed since you last read it.",
        parameters: {
            ...OBJECT,
            properties: {
                terminal: { type: 'string', description: 'The Pi terminal\'s name, e.g. "Pi (2)"; default: the latest one still running.' },
                pagesBack: {
                    type: 'integer',
                    minimum: 0,
                    maximum: MAX_PAGES_BACK,
                    description:
                        'Screen-drawing programs only: how many screens further up to read, from what the terminal kept above the screen, else by pressing PageUp and back down in a full-screen program; default 0, the screen itself.',
                },
            },
        },
        loadMode: 'essential',
    },
    {
        name: 'read_output',
        label: 'Read output',
        description:
            "Read what VS Code printed that you cannot see otherwise: the Output panel's channels (extension, language server, Git, Tasks and other logs), the Debug Console, and the commands and output of the user's terminals. Without source it lists what there is; with source it returns the last lines of that one.",
        parameters: {
            ...OBJECT,
            properties: {
                source: { type: 'string', description: 'A name from the list, e.g. "Tasks", "Debug Console", "Terminal: bash"; part of a name will do when only one has it.' },
                lines: { type: 'integer', minimum: 1, maximum: 400, description: 'How many of the last lines; default 80.' },
            },
        },
        loadMode: 'essential',
    },
    {
        name: 'debug_start',
        label: 'Start debugging',
        description:
            "Start one of the user's launch configurations (.vscode/launch.json) under the debugger, as Run and Debug does, and wait until it pauses (a breakpoint or an exception) or ends. Returns where it paused, with the code, call stack and local variables, or its exit code and Debug Console output; the pause becomes your focus in the editor.",
        parameters: {
            ...OBJECT,
            properties: {
                configuration: { type: 'string', description: 'The launch configuration name; may be left out when there is only one.' },
                noDebug: { type: 'boolean', description: 'Run without debugging (Ctrl+F5): breakpoints are ignored.' },
                timeoutSecs: { type: 'integer', minimum: 1, maximum: 120, description: 'How long to wait for a pause or the end; default 15. It keeps running after.' },
            },
        },
        loadMode: 'essential',
    },
    {
        name: 'debug_control',
        label: 'Debug control',
        description:
            'Press a debug toolbar button for the session the user sees: continue, pause, stepOver, stepInto, stepOut, restart or stop. Waits for the next pause or the end and returns it like debug_start; the pause becomes your focus in the editor.',
        parameters: {
            ...OBJECT,
            properties: {
                action: { type: 'string', enum: ['continue', 'pause', 'stepOver', 'stepInto', 'stepOut', 'restart', 'stop'] },
                timeoutSecs: { type: 'integer', minimum: 1, maximum: 120, description: 'How long to wait for the next pause; default 10.' },
            },
            required: ['action'],
        },
        loadMode: 'essential',
    },
    {
        name: 'set_breakpoint',
        label: 'Set breakpoint',
        description: 'Add a breakpoint on a line, optionally only when a condition holds, or remove the one there.',
        parameters: {
            ...OBJECT,
            properties: {
                path: { type: 'string', description: 'Workspace-relative path.' },
                line: { type: 'integer', minimum: 1 },
                condition: { type: 'string', description: 'An expression in the program\'s language; it pauses only when true.' },
                remove: { type: 'boolean', description: 'Remove the breakpoint on that line instead.' },
            },
            required: ['path', 'line'],
        },
        loadMode: 'essential',
    },
    {
        name: 'debug_inspect',
        label: 'Debug inspect',
        description:
            'Where the program being debugged is paused: the code, call stack and local variables, and the breakpoints; with expression, its value in the paused frame, as a watch shows it. The pause becomes your focus in the editor.',
        parameters: {
            ...OBJECT,
            properties: {
                expression: { type: 'string', description: 'Evaluated in the top frame, e.g. items.length or user.name.' },
            },
        },
        loadMode: 'essential',
    },
];

/** What the voice agent can do in the user's VS Code; each resolves with a report for the model. */
export interface EditorHands {
    /** Opens and highlights code in the user's editor. */
    openFile(target: CodeAnchor): Promise<string>;
    /** The editors and preview commands that can show a file; throws when it is outside the workspace or not a file. */
    listViewers(path: string): Promise<FileViewers>;
    /** Shows a file with one of the viewers listViewers gave for it. */
    openWith(path: string, viewer: Viewer, toSide: boolean): Promise<string>;
    editFile(edit: { path: string; oldText: string; newText: string; nearLine?: number }): Promise<string>;
    createFile(path: string, content: string): Promise<string>;
    createFolder(path: string): Promise<string>;
    renamePath(from: string, to: string): Promise<string>;
    /** What deleting would remove, as a phrase; throws when it may not be deleted. Deletes nothing. */
    describeDeletion(path: string, recursive: boolean): Promise<string>;
    deletePath(path: string, recursive: boolean): Promise<string>;
    /** Without path: every open workspace file with unsaved changes. */
    saveFiles(path: string | undefined): Promise<string>;
    closeEditor(path: string): Promise<string>;
    runInTerminal(command: string, timeoutMs: number): Promise<string>;
    /** Types into the program a run left running in a Pi terminal (default: the latest); returns its new output. */
    sendToTerminal(input: { terminal?: string; text: string; enter: boolean; waitMs: number }): Promise<string>;
    /**
     * What a program left running in a Pi terminal printed since last shown, and whether it still runs;
     * a screen-drawing program's screen instead, `pagesBack` screens further up when asked.
     */
    readTerminal(terminal: string | undefined, pagesBack: number): Promise<string>;
    /** Without source: what there is to read. */
    readOutput(source: string | undefined, lines: number): Promise<string>;
    startDebugging(configuration: string | undefined, noDebug: boolean, timeoutMs: number): Promise<string>;
    controlDebugging(action: DebugAction, timeoutMs: number): Promise<string>;
    setBreakpoint(breakpoint: { path: string; line: number; condition?: string; remove: boolean }): Promise<string>;
    inspectDebugging(expression: string | undefined): Promise<string>;
}

/** The debug toolbar's buttons. */
export type DebugAction = 'continue' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut' | 'restart' | 'stop';
const DEBUG_ACTIONS: Record<DebugAction, true> = { continue: true, pause: true, stepOver: true, stepInto: true, stepOut: true, restart: true, stop: true };

/**
 * What a file-changing tool would touch, for the worker's file lock: undefined for a tool that
 * changes no file. save_file without a path saves every open file: the whole workspace.
 */
function lockTargets(toolName: string, args: Record<string, unknown>): string[] | undefined {
    switch (toolName) {
        case 'edit_file':
        case 'create_file':
        case 'delete_file':
            return [requireString(args, 'path')];
        case 'rename_file':
            return [requireString(args, 'from'), requireString(args, 'to')];
        case 'save_file':
            return [optionalString(args, 'path') ?? '.'];
        default:
            return undefined;
    }
}

/**
 * Pair tools governed by the tab's permission level. `write` changes file contents: runs unasked in
 * Edit automatically. `exec` runs things, or deletes or moves files (as the worker's gate treats
 * `rm` / `mv` and omp edit's REM / MV): asks there too. Plan refuses both; Manual asks for both.
 */
const PERMISSION_TIER: Record<string, 'write' | 'exec'> = {
    edit_file: 'write',
    create_file: 'write',
    create_folder: 'write',
    rename_file: 'exec',
    save_file: 'write',
    delete_file: 'exec',
    run_in_terminal: 'exec',
    terminal_send: 'exec',
    debug_start: 'exec',
};
const DEFAULT_TERMINAL_TIMEOUT_SECS = 30;
const DEFAULT_TERMINAL_WAIT_SECS = 2;
const DEFAULT_DEBUG_START_SECS = 15;
const DEFAULT_DEBUG_STEP_SECS = 10;
const DEFAULT_OUTPUT_LINES = 80;
/** Longest show_text: the transcript, with every tool call's arguments, lives in workspace state. */
const MAX_SHOWN_CHARS = 20000;
/** Settled proposals remembered for a late confirm_task. */
const MAX_SETTLED = 20;

const OUTCOME_TEXT: Record<WorkerSendOutcome, string> = {
    started: 'Sent as a new task; the worker has started.',
    steered: 'Delivered to the running task as a correction.',
    queued: 'Queued; it runs as a new turn once the current task finishes.',
};

/** Executes the voice agent's host tool calls against the worker (design §5.11, §6). */
export class HostToolRouter {
    private readonly _proposals = new Map<string, Proposal>();
    /** Proposals no longer waiting, newest last, so a late confirm_task learns what became of them. */
    private readonly _settled = new Map<string, SettledProposal>();
    /** Settled with the voice panel's buttons and not yet told to the model, per tab. */
    private readonly _unseenSettled = new Map<string, SettledProposal[]>();
    private _nextProposal = 1;
    /** A deletion asked about in `turn`; the same delete_file in a later user turn carries it out. */
    private _pendingDelete: { path: string; recursive: boolean; turn: number } | undefined;
    /** Own changes waiting on their approval card, by id. */
    private readonly _held = new Map<string, HeldApproval>();
    /** Approval cards the user answered, not yet told to the model, per tab. */
    private readonly _unseenApprovals = new Map<string, SettledApproval[]>();
    private _nextApproval = 1;
    /** The user answered an approval card and the change ran or was dropped: the voice agent should say the outcome. */
    onApprovalSettled: (() => void) | undefined;

    constructor(
        private readonly _worker: WorkerController,
        private readonly _digestFor: (tabId: string) => WorkerDigest | undefined,
        private readonly _confirmBeforeDispatch: () => boolean,
        /** Starts a background research job for the task on `tabId`; throws when too many are running. */
        private readonly _startResearch: (tabId: string, question: string) => ResearchJob,
        /** Absent without an editor: open_file and the pair tools fail. */
        private readonly _hands?: EditorHands,
    ) {}

    /** Own changes waiting on the approval card, shown on every turn so the model keeps reminding the user. */
    heldApprovals(tabId: string): HeldApproval[] {
        return [...this._held.values()].filter((held) => held.tabId === tabId);
    }

    /** How many answered approvals the model has not been told about (the arbiter's `approval` observation). */
    settledApprovalCount(tabId: string): number {
        return this._unseenApprovals.get(tabId)?.length ?? 0;
    }

    /** Answered approvals for the next turn's message; each is handed out once. */
    takeSettledApprovals(tabId: string): SettledApproval[] {
        const settled = this._unseenApprovals.get(tabId) ?? [];
        this._unseenApprovals.delete(tabId);
        return settled;
    }

    proposals(tabId: string): Proposal[] {
        return [...this._proposals.values()].filter((proposal) => proposal.tabId === tabId);
    }

    /** The deletion waiting for the user's yes, shown on every turn so the model does not lose it. */
    get pendingDelete(): { path: string; recursive: boolean } | undefined {
        return this._pendingDelete && { path: this._pendingDelete.path, recursive: this._pendingDelete.recursive };
    }

    /** Proposals, and a deletion asked about, die with the voice context that made them (§6 step 4). */
    clearProposals(): void {
        this._proposals.clear();
        this._pendingDelete = undefined;
    }

    /** The user agreed in the voice panel: send it now, without the later-turn rule confirm_task has. */
    async confirmProposal(id: string): Promise<string> {
        return this._send(this._take(id), 'button');
    }

    /** The user turned a proposal down in the voice panel. */
    cancelProposal(id: string): void {
        this._settle(this._take(id), 'cancelled', 'button');
    }

    /**
     * Proposals the user settled with the voice panel's buttons since the model was last told, for
     * the next turn's message; each is handed out once.
     */
    takeSettled(tabId: string): SettledProposal[] {
        const settled = this._unseenSettled.get(tabId) ?? [];
        this._unseenSettled.delete(tabId);
        return settled;
    }

    async execute(toolName: string, args: Record<string, unknown>, turn: ToolTurn): Promise<ToolResult> {
        try {
            const out = await this._run(toolName, args, turn);
            return typeof out === 'string' ? { text: out, isError: false } : out;
        } catch (err: unknown) {
            return { text: err instanceof Error ? err.message : String(err), isError: true };
        }
    }

    private async _run(toolName: string, args: Record<string, unknown>, turn: ToolTurn): Promise<string | ToolResult> {
        const { tabId } = turn;
        if (turn.proactive && toolName !== 'worker_status') {
            throw new Error('Nobody asked for this: the user has not spoken since this update. Tell them and let them decide.');
        }
        const locked = this._workerLock(tabId, toolName, args);
        if (locked) {
            throw new Error(locked);
        }
        if (Object.hasOwn(PERMISSION_TIER, toolName)) {
            if (this._worker.permissionLevel(tabId) === 'plan') {
                throw new Error(
                    'Not done: this task is in read-only Plan mode (the permission menu under the chat input), so you may not change files or run commands. Tell the user what you would do, or ask them to leave Plan mode.',
                );
            }
            // delete_file asks the user in words first; its approval card comes when it would actually delete.
            if (toolName !== 'delete_file' && this._needsApproval(tabId, toolName)) {
                return this._holdForApproval(tabId, toolName, args, () => this._act(toolName, args, turn));
            }
        }
        if (toolName === 'research') {
            const job = this._startResearch(tabId, requireString(args, 'question'));
            return {
                text: `Started research ${job.id} in the background. Tell the user you are looking into it and carry on; the findings arrive in a later message as <research-result id="${job.id}">.`,
                isError: false,
                research: job,
            };
        }
        return this._act(toolName, args, turn);
    }

    /** Carries out a call that passed the worker-lock and permission checks. */
    private async _act(toolName: string, args: Record<string, unknown>, turn: ToolTurn): Promise<string> {
        const { tabId } = turn;
        switch (toolName) {
            case 'edit_file':
                return this._requireHands().editFile({
                    path: requireString(args, 'path'),
                    oldText: typeof args.oldText === 'string' ? args.oldText : '',
                    newText: typeof args.newText === 'string' ? args.newText : '',
                    nearLine: typeof args.nearLine === 'number' ? args.nearLine : undefined,
                });
            case 'create_file':
                return this._requireHands().createFile(requireString(args, 'path'), typeof args.content === 'string' ? args.content : '');
            case 'create_folder':
                return this._requireHands().createFolder(requireString(args, 'path'));
            case 'rename_file':
                return this._requireHands().renamePath(requireString(args, 'from'), requireString(args, 'to'));
            case 'delete_file': {
                const target = requireString(args, 'path');
                const recursive = args.recursive === true;
                const key = path.normalize(target.trim());
                const pending = this._pendingDelete;
                const same = pending?.path === key && pending.recursive === recursive;
                if (!same || turn.seq <= pending.turn) {
                    // Checked now, so the user is asked only about something that can be deleted.
                    const what = await this._requireHands().describeDeletion(target, recursive);
                    if (!same) {
                        this._pendingDelete = { path: key, recursive, turn: turn.seq };
                    }
                    return `Not deleted yet. Tell the user it deletes ${what}, and ask them to confirm. Call delete_file again with the same path and recursive only after they agree in their next message.`;
                }
                this._pendingDelete = undefined;
                const hands = this._requireHands();
                if (this._needsApproval(tabId, toolName)) {
                    return this._holdForApproval(tabId, toolName, args, () => hands.deletePath(target, recursive));
                }
                return hands.deletePath(target, recursive);
            }
            case 'save_file':
                return this._requireHands().saveFiles(optionalString(args, 'path'));
            case 'close_editor':
                return this._requireHands().closeEditor(requireString(args, 'path'));
            case 'run_in_terminal':
                return this._requireHands().runInTerminal(requireString(args, 'command'), seconds(args.timeoutSecs, 600, DEFAULT_TERMINAL_TIMEOUT_SECS) * 1000);
            case 'terminal_send': {
                if (typeof args.text !== 'string') {
                    throw new Error('Missing text.');
                }
                const keys = terminalKeys(args.keys);
                const enter = typeof args.enter === 'boolean' ? args.enter : keys === '';
                if (args.text === '' && keys === '' && !enter) {
                    throw new Error('Nothing to send: give text or keys, or leave enter on to press Enter.');
                }
                return this._requireHands().sendToTerminal({
                    terminal: optionalString(args, 'terminal'),
                    text: args.text + keys,
                    enter,
                    waitMs: seconds(args.waitSecs, 30, DEFAULT_TERMINAL_WAIT_SECS) * 1000,
                });
            }
            case 'terminal_read':
                return this._requireHands().readTerminal(optionalString(args, 'terminal'), pagesBack(args.pagesBack));
            case 'read_output': {
                const lines = typeof args.lines === 'number' ? Math.min(Math.max(Math.round(args.lines), 1), 400) : DEFAULT_OUTPUT_LINES;
                return this._requireHands().readOutput(optionalString(args, 'source'), lines);
            }
            case 'debug_start':
                return this._requireHands().startDebugging(
                    optionalString(args, 'configuration'),
                    args.noDebug === true,
                    seconds(args.timeoutSecs, 120, DEFAULT_DEBUG_START_SECS) * 1000,
                );
            case 'debug_control': {
                const action = requireString(args, 'action');
                if (!isDebugAction(action)) {
                    throw new Error(`Unknown action ${action}: use one of ${Object.keys(DEBUG_ACTIONS).join(', ')}.`);
                }
                return this._requireHands().controlDebugging(action, seconds(args.timeoutSecs, 120, DEFAULT_DEBUG_STEP_SECS) * 1000);
            }
            case 'set_breakpoint': {
                if (typeof args.line !== 'number' || args.line < 1) {
                    throw new Error('Missing line.');
                }
                return this._requireHands().setBreakpoint({
                    path: requireString(args, 'path'),
                    line: Math.round(args.line),
                    condition: optionalString(args, 'condition'),
                    remove: args.remove === true,
                });
            }
            case 'debug_inspect':
                return this._requireHands().inspectDebugging(optionalString(args, 'expression'));
            case 'tell_worker': {
                const message = requireString(args, 'message');
                const when = args.when === 'after' ? 'after' : 'now';
                const includeEditorContext = args.includeEditorContext === true;
                const readOnly = args.readOnly === true;
                const phase = this._worker.status(tabId).phase;
                if (!readOnly && (phase === 'idle' || phase === 'error') && this._confirmBeforeDispatch()) {
                    // One pending plan per task: a new proposal replaces the old one.
                    for (const proposal of this.proposals(tabId)) {
                        this._proposals.delete(proposal.id);
                    }
                    const id = `p${this._nextProposal++}`;
                    this._proposals.set(id, { id, tabId, message, includeEditorContext, createdTurn: turn.seq });
                    return `Not sent yet: the worker is idle, so this starts a new task and needs the user's go-ahead. Say the plan in a sentence or two and ask. Only after the user agrees in their next message, call confirm_task with proposalId "${id}".`;
                }
                const text = readOnly ? `${message}\n\n(Read-only task: do not edit, create or delete any files.)` : message;
                return OUTCOME_TEXT[await this._worker.send(tabId, text, { when, includeEditorContext })];
            }
            case 'confirm_task': {
                const id = requireString(args, 'proposalId');
                const settled = this._settled.get(id);
                if (settled?.tabId === tabId) {
                    const who = settled.by === 'button' ? 'the user confirmed it with the button in the voice panel' : 'you confirmed it earlier';
                    switch (settled.outcome) {
                        case 'cancelled':
                            throw new Error(
                                'Not sent: the user cancelled it with the button in the voice panel. Do not ask about it again; if they bring it up and want it after all, propose it again with tell_worker.',
                            );
                        case 'failed':
                            throw new Error(`Not sent: ${who}, but ${settled.result}`);
                        case 'confirmed':
                            return `Already sent, nothing more to do: ${who}. ${settled.result ?? 'It is being sent now.'} Do not ask the user about it again.`;
                    }
                }
                const proposal = this._proposals.get(id);
                if (!proposal || proposal.tabId !== tabId) {
                    throw new Error('No such proposal: it was replaced, or belongs to another task.');
                }
                if (turn.seq <= proposal.createdTurn) {
                    throw new Error('The user has not replied since you proposed this. Ask them and wait for their answer.');
                }
                return this._send(this._take(id), 'voice');
            }
            case 'stop_worker': {
                const status = this._worker.status(tabId);
                if (status.phase === 'idle') {
                    return 'The worker was already idle.';
                }
                await this._worker.abort(tabId);
                return status.tui ? 'Pressed Escape, the TUI\'s interrupt. worker_status shows whether it stopped.' : 'Stopped.';
            }
            case 'answer_worker': {
                if (this._worker.status(tabId).tui) {
                    const keys = (typeof args.value === 'string' ? args.value : '') + terminalKeys(args.keys);
                    if (!keys) {
                        throw new Error('Nothing to type: give the user\'s answer as value (text) and/or keys, e.g. ["down", "enter"].');
                    }
                    // The text itself is not repeated: it may be a secret.
                    return `Typed into the TUI. Its screen now:\n${await this._worker.typeIntoTui(tabId, keys)}`;
                }
                const requestId = requireString(args, 'requestId');
                const request = this._worker.pendingRequests(tabId).find((r) => r.id === requestId);
                if (!request) {
                    throw new Error('That request is no longer pending: it was answered in the editor, timed out, or never existed.');
                }
                if (request.receivedAt >= turn.userAt) {
                    throw new Error('The user has not answered this yet. Tell them what the worker is asking and wait for their reply.');
                }
                let answer: WorkerAnswer;
                if (args.cancel === true) {
                    answer = { cancelled: true };
                } else if (request.method === 'confirm') {
                    if (typeof args.confirmed !== 'boolean') {
                        throw new Error('A confirm request takes confirmed: true or false.');
                    }
                    answer = { confirmed: args.confirmed };
                } else {
                    answer = { value: requireString(args, 'value') };
                }
                return this._worker.answer(tabId, requestId, answer)
                    ? 'Answered.'
                    : 'Too late: it was already answered in the editor or timed out.';
            }
            case 'worker_status':
                if (this._worker.status(tabId).tui) {
                    const screen = await this._worker.readTuiScreen(tabId, pagesBack(args.pagesBack));
                    return `State: ${this._worker.status(tabId).phase}. This tab shows the CLI's own TUI; its screen:\n${screen}`;
                }
                return this._statusReport(tabId);
            case 'open_file': {
                const startLine = typeof args.startLine === 'number' ? args.startLine : undefined;
                const endLine = typeof args.endLine === 'number' ? args.endLine : startLine;
                const symbol = optionalString(args, 'symbol')?.trim();
                // A symbol with lines is a name on those lines; without, a declared symbol.
                return this._requireHands().openFile({
                    path: requireString(args, 'path'),
                    ...(startLine !== undefined ? { startLine, endLine } : {}),
                    ...(symbol ? { symbol } : {}),
                });
            }
            case 'show_text': {
                const text = requireString(args, 'text');
                if (text.length > MAX_SHOWN_CHARS) {
                    throw new Error(
                        `Not shown: ${text.length} characters, at most ${MAX_SHOWN_CHARS}. Show a shorter excerpt, or put it in a file with create_file.`,
                    );
                }
                return 'Shown as a card under your reply in the chat; it is not read aloud.';
            }
            case 'list_viewers':
                return formatViewers(await this._requireHands().listViewers(requireString(args, 'path')));
            case 'open_with': {
                const target = requireString(args, 'path');
                const id = requireString(args, 'viewer').trim();
                const hands = this._requireHands();
                // Only what list_viewers offers for this file: never an arbitrary command.
                const { path: relative, editors, commands } = await hands.listViewers(target);
                const offered = [...editors, ...commands];
                const viewer = offered.find((v) => v.id === id);
                if (!viewer) {
                    throw new Error(`${id} is not a viewer for ${relative}. Use one of: ${offered.map((v) => v.id).join(', ')}.`);
                }
                return hands.openWith(target, viewer, args.toSide === true);
            }
            default:
                throw new Error(`Unknown tool ${toolName}`);
        }
    }

    /** Takes a waiting proposal out, to be sent or dropped. */
    private _take(id: string): Proposal {
        const proposal = this._proposals.get(id);
        if (!proposal) {
            throw new Error('That proposal is gone: it was replaced or already settled.');
        }
        this._proposals.delete(id);
        return proposal;
    }

    /** Remembers how a proposal ended; one settled with a button is told to the model on its next turn. */
    private _settle(proposal: Proposal, outcome: SettledProposal['outcome'], by: SettledProposal['by']): SettledProposal {
        const settled: SettledProposal = { id: proposal.id, tabId: proposal.tabId, message: proposal.message, outcome, by };
        this._settled.set(settled.id, settled);
        if (this._settled.size > MAX_SETTLED) {
            this._settled.delete(this._settled.keys().next().value!);
        }
        if (by === 'button') {
            this._unseenSettled.set(settled.tabId, [...(this._unseenSettled.get(settled.tabId) ?? []), settled]);
        }
        return settled;
    }

    private async _send(proposal: Proposal, by: SettledProposal['by']): Promise<string> {
        // Settled before it goes out, so a confirm_task meanwhile does not send it twice.
        const settled = this._settle(proposal, 'confirmed', by);
        try {
            const outcome = await this._worker.send(proposal.tabId, proposal.message, {
                when: 'after',
                includeEditorContext: proposal.includeEditorContext,
            });
            settled.result = OUTCOME_TEXT[outcome];
        } catch (err: unknown) {
            settled.outcome = 'failed';
            settled.result = `sending it failed: ${err instanceof Error ? err.message : String(err)}`;
            throw err;
        }
        return settled.result;
    }

    /** Manual asks for every change and command; Edit automatically only for commands, moves and deletions. */
    private _needsApproval(tabId: string, toolName: string): boolean {
        const level = this._worker.permissionLevel(tabId);
        return level === 'ask' || (level === 'edit' && PERMISSION_TIER[toolName] === 'exec');
    }

    /**
     * Puts up the approval card and returns at once, so the voice agent can tell the user to answer
     * it (it cannot speak while a tool call is open). Approved, `act` runs; either way the outcome
     * comes back as a settled approval, and `onApprovalSettled` asks for a turn to say it.
     */
    private _holdForApproval(tabId: string, toolName: string, args: Record<string, unknown>, act: () => Promise<string>): string {
        const id = `a${this._nextApproval++}`;
        // terminal_send's text is what gets typed into the running program.
        const command = typeof args.command === 'string' ? args.command : typeof args.text === 'string' ? args.text : undefined;
        const target = typeof args.path === 'string' ? args.path : undefined;
        const move = typeof args.from === 'string' ? `${args.from} -> ${String(args.to)}` : undefined;
        const held: HeldApproval = { id, tabId, toolName, summary: command ?? move ?? target ?? '' };
        // Throws for a closed tab: the call fails like any other.
        const decision = this._worker.requestToolApproval(tabId, toolName, args);
        this._held.set(id, held);
        void decision
            .then(async (approved): Promise<Pick<SettledApproval, 'outcome' | 'result'>> => {
                if (!approved) {
                    return { outcome: 'rejected', result: 'The user rejected it on the approval card; nothing was done.' };
                }
                // Rechecked: the permission level or the worker's files may have changed while the card waited.
                if (this._worker.permissionLevel(tabId) === 'plan') {
                    return { outcome: 'failed', result: 'Not done: the task was switched to read-only Plan mode before it was approved.' };
                }
                const locked = this._workerLock(tabId, toolName, args);
                if (locked) {
                    return { outcome: 'failed', result: `Not done: ${locked}` };
                }
                return { outcome: 'done', result: await act() };
            })
            .catch((err: unknown) => ({ outcome: 'failed' as const, result: err instanceof Error ? err.message : String(err) }))
            .then((outcome) => {
                this._held.delete(id);
                this._unseenApprovals.set(tabId, [...(this._unseenApprovals.get(tabId) ?? []), { ...held, ...outcome }]);
                this.onApprovalSettled?.();
            });
        return (
            `Waiting for the user's approval (${id}): ${toolName} runs only after they click Approve on its card in the chat. ` +
            'Tell the user now, in a sentence, what needs approving and to approve or reject it there. ' +
            `Do not call ${toolName} again for this; the outcome arrives as <approval-settled id="${id}">.`
        );
    }

    private _requireHands(): EditorHands {
        if (!this._hands) {
            throw new Error('There is no editor here.');
        }
        return this._hands;
    }

    /**
     * Why a file-changing tool may not run now: the worker's running task is changing one of its files
     * (the permission gate reports each before it happens). A TUI tab reports nothing, so there any
     * running task keeps the voice agent's file changes out. Undefined when it may go ahead.
     */
    private _workerLock(tabId: string, toolName: string, args: Record<string, unknown>): string | undefined {
        const targets = lockTargets(toolName, args);
        if (!targets) {
            return undefined;
        }
        const status = this._worker.status(tabId);
        if (status.tui) {
            return status.phase === 'working'
                ? 'The worker is still running a task and may be writing files. Wait for it to finish, or ask the user to stop it from the chat.'
                : undefined;
        }
        const locked = this._worker.lockedPaths(tabId, targets);
        if (locked.length === 0) {
            return undefined;
        }
        return (
            `The worker's running task is changing ${locked.join(', ')}, so you may not touch ${locked.length === 1 ? 'it' : 'them'} until that task ends. ` +
            'Tell the user, then work on other files, wait for the worker to finish, or ask whether to stop it.'
        );
    }

    private _statusReport(tabId: string): string {
        const status = this._worker.status(tabId);
        const lines = [
            `State: ${status.phase}${status.elapsedMs !== undefined ? ` for ${Math.round(status.elapsedMs / 1000)}s` : ''}` +
                `${status.queued ? `, ${status.queued} queued` : ''}${status.error ? `, error: ${clip(status.error, 200)}` : ''}.`,
        ];
        for (const request of this._worker.pendingRequests(tabId)) {
            const options = request.options?.length ? ` (${request.options.join(' | ')})` : '';
            lines.push(`Waiting on ${request.method} ${request.id}: ${clip(request.title ?? request.message ?? '', 200)}${options}`);
        }
        const recent = this._digestFor(tabId)?.recent(15) ?? [];
        if (recent.length > 0) {
            lines.push('Recent activity:', formatDigest(recent));
        }
        const turns = this._worker.recentTurns(tabId, 2);
        if (turns.length > 0) {
            lines.push('Last instructions:');
            for (const t of turns) {
                lines.push(`- ${clip(t.instruction, 300)} → ${clip(t.reply, 500) || '(no reply yet)'}`);
            }
        }
        return lines.join('\n');
    }
}

function requireString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Missing ${key}.`);
    }
    return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
}

/** A timeout argument in whole seconds, within 1..max. */
function seconds(value: unknown, max: number, fallback: number): number {
    return typeof value === 'number' ? Math.min(Math.max(Math.round(value), 1), max) : fallback;
}

function isDebugAction(value: string): value is DebugAction {
    return Object.hasOwn(DEBUG_ACTIONS, value);
}
