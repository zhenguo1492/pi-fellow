import * as path from 'node:path';
import type { RpcHostToolDefinition } from '../pi/rpcTypes';
import type { CodeAnchor } from './codeAnchors';
import type { WorkerAnswer, WorkerController, WorkerSendOutcome } from './workerController';
import type { ResearchJob } from './research';
import { formatViewers, type FileViewers, type Viewer } from './viewers';
import { clip, formatDigest, type WorkerDigest } from './workerDigest';

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
}

const OBJECT = { type: 'object', additionalProperties: false } as const;

export const VOICE_HOST_TOOLS: RpcHostToolDefinition[] = [
    {
        name: 'tell_worker',
        label: 'Tell worker',
        description:
            "Send an instruction to the worker, the coding agent on the user's current task. Routed on the worker's state when it runs: idle starts a new task (a task that changes files may return a proposal that needs the user's go-ahead); working with when=now steers the running task; working with when=after queues it to run once the current task finishes.",
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
        description: 'Stop what the worker is doing. Use when the user tells it to stop.',
        parameters: { ...OBJECT, properties: {} },
        loadMode: 'essential',
    },
    {
        name: 'answer_worker',
        label: 'Answer worker',
        description:
            "Answer a <worker-request> with the user's own answer. select: value is one of the options. confirm: confirmed. input/editor: value. cancel: true dismisses the request.",
        parameters: {
            ...OBJECT,
            properties: {
                requestId: { type: 'string' },
                value: { type: 'string' },
                confirmed: { type: 'boolean' },
                cancel: { type: 'boolean' },
            },
            required: ['requestId'],
        },
        loadMode: 'essential',
    },
    {
        name: 'worker_status',
        label: 'Worker status',
        description:
            "The worker's state, what it is waiting on, its recent activity log, and the task's last instructions with their results.",
        parameters: { ...OBJECT, properties: {} },
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
            "List the ways the user's VS Code can show a file besides plain text: editors for its file type from the installed extensions (e.g. the draw.io editor for .drawio, VS Code's image preview) and VS Code's built-in preview commands (e.g. the Markdown preview, which also draws the Mermaid diagrams in a .md file). Call it before open_with whenever the user asks to see, preview or view a diagram or rendered file; open_with only takes a viewer id from this list. Changes nothing; works in both modes.",
        parameters: { ...OBJECT, properties: { path: { type: 'string', description: 'Workspace-relative path.' } }, required: ['path'] },
        loadMode: 'essential',
    },
    {
        name: 'open_with',
        label: 'Open with',
        description:
            "Show a file in the user's editor with one of the viewers list_viewers returned for it: an editor opens the file in it, a command opens the file and runs it. For a diagram file such as .drawio, use its editor. For Mermaid, show the Markdown file that holds it with markdown.showPreviewToSide, so the user edits on one side and watches it render on the other. Only ids from list_viewers for this same file are accepted: call list_viewers first. Gives up waiting after 8 seconds. Changes no files; works in both modes.",
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
        name: 'set_mode',
        label: 'Set mode',
        description:
            'Switch between omp mode (you direct the worker) and pair mode (you edit files and run commands yourself, like a human partner, and do not direct the worker). To omp: switches at once. Pass auto=true when you switch from pair to omp on your own because the job is heavy, not because the user asked. To pair: the first call only records the request; ask the user to confirm, and call it again after they agree in their next message. Exception: after your own auto=true switch, set_mode pair switches back at once once that work is done.',
        parameters: {
            ...OBJECT,
            properties: {
                mode: { type: 'string', enum: ['omp', 'pair'] },
                auto: { type: 'boolean', description: 'Only with mode="omp": you switch on your own initiative, the user did not ask.' },
            },
            required: ['mode'],
        },
        loadMode: 'essential',
    },
    {
        name: 'edit_file',
        label: 'Edit file',
        description:
            "Pair mode only. Replace oldText with newText in an existing file, typed out line by line in the user's editor so they watch you write; one Ctrl+Z undoes it. oldText must match the file exactly (read it first). An empty oldText fills an empty file. New files are made with create_file. Keep each edit small: one function or block.",
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
            "Pair mode only. Create a new file in the workspace, with its content if given, and open it in the user's editor. Missing parent folders are created. Fails if the file exists: change existing files with edit_file.",
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
        description: 'Pair mode only. Create a folder in the workspace, with any missing parents.',
        parameters: { ...OBJECT, properties: { path: { type: 'string', description: 'Workspace-relative path.' } }, required: ['path'] },
        loadMode: 'essential',
    },
    {
        name: 'rename_file',
        label: 'Rename file',
        description: 'Pair mode only. Rename or move a file or folder within the workspace. Never overwrites: fails if the new path exists.',
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
            'Pair mode only. Delete a file, or a folder with recursive true. The first call deletes nothing: it checks the path and records the request; tell the user exactly what goes and ask. Call it again with the same path and recursive only after they agree in their next message. It goes to the trash; if the trash cannot take it, it is backed up to a temp folder first and the result says where.',
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
            "Pair mode only. Save an open file, or without path every open workspace file with unsaved changes. This also saves the user's own unsaved changes.",
        parameters: { ...OBJECT, properties: { path: { type: 'string', description: 'Workspace-relative path; leave out to save all.' } } },
        loadMode: 'essential',
    },
    {
        name: 'close_editor',
        label: 'Close editor',
        description: "Pair mode only. Close a file's tabs in the user's editor. Refused while it has unsaved changes.",
        parameters: { ...OBJECT, properties: { path: { type: 'string', description: 'Workspace-relative path.' } }, required: ['path'] },
        loadMode: 'essential',
    },
    {
        name: 'run_in_terminal',
        label: 'Run in terminal',
        description:
            "Pair mode only. Type a command into the Pi terminal in the user's VS Code and run it; returns the exit code and the last lines of output. After timeoutSecs it returns what it has so far and the command keeps running (servers, watchers).",
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
            "Pair mode only. Start one of the user's launch configurations (.vscode/launch.json) under the debugger, as Run and Debug does, and wait until it pauses (a breakpoint or an exception) or ends. Returns where it paused, with the code, call stack and local variables, or its exit code and Debug Console output; the pause becomes your focus in the editor.",
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
            'Pair mode only. Press a debug toolbar button for the session the user sees: continue, pause, stepOver, stepInto, stepOut, restart or stop. Waits for the next pause or the end and returns it like debug_start; the pause becomes your focus in the editor.',
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
        description: 'Pair mode only. Add a breakpoint on a line, optionally only when a condition holds, or remove the one there.',
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
            'Pair mode only. Where the program being debugged is paused: the code, call stack and local variables, and the breakpoints; with expression, its value in the paused frame, as a watch shows it. The pause becomes your focus in the editor.',
        parameters: {
            ...OBJECT,
            properties: {
                expression: { type: 'string', description: 'Evaluated in the top frame, e.g. items.length or user.name.' },
            },
        },
        loadMode: 'essential',
    },
];

/** omp: the voice agent directs the worker. pair: it works in the editor and terminal itself, like a human partner. */
export type AgentMode = 'omp' | 'pair';

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

/** Tools that direct the worker: not in pair mode, where the voice agent is the one working. */
const WORKER_CONTROL: Record<string, true> = { tell_worker: true, confirm_task: true, stop_worker: true, answer_worker: true };
/** Tools that change files, run things or drive the debugger. Reading output is not among them. */
const PAIR_ONLY: Record<string, true> = {
    edit_file: true,
    create_file: true,
    create_folder: true,
    rename_file: true,
    delete_file: true,
    save_file: true,
    close_editor: true,
    run_in_terminal: true,
    debug_start: true,
    debug_control: true,
    set_breakpoint: true,
    debug_inspect: true,
};
/** Pair tools that write the workspace's files: not while the worker may be writing them too. */
const FILE_CHANGING: Record<string, true> = { edit_file: true, create_file: true, rename_file: true, delete_file: true };
const DEFAULT_TERMINAL_TIMEOUT_SECS = 30;
const DEFAULT_DEBUG_START_SECS = 15;
const DEFAULT_DEBUG_STEP_SECS = 10;
const DEFAULT_OUTPUT_LINES = 80;
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
    /** A new voice agent starts in pair mode; it hands heavy jobs to the worker with set_mode auto. */
    private _mode: AgentMode = 'pair';
    /** User turn in which switching to pair mode was asked for; a later user turn confirms it. */
    private _pairRequestedTurn: number | undefined;
    /** The voice agent itself switched pair -> omp for a heavy job: it may switch back to pair without asking. */
    private _autoSwitchedFromPair = false;
    /** A deletion asked about in `turn`; the same delete_file in a later user turn carries it out. */
    private _pendingDelete: { path: string; recursive: boolean; turn: number } | undefined;

    constructor(
        private readonly _worker: WorkerController,
        private readonly _digestFor: (tabId: string) => WorkerDigest | undefined,
        private readonly _confirmBeforeDispatch: () => boolean,
        /** Starts a background research job for the task on `tabId`; throws when too many are running. */
        private readonly _startResearch: (tabId: string, question: string) => ResearchJob,
        /** Absent without an editor: open_file and the pair tools fail. */
        private readonly _hands?: EditorHands,
        private readonly _onModeChange?: (mode: AgentMode) => void,
    ) {}

    get mode(): AgentMode {
        return this._mode;
    }

    /** The user switched in the UI: no confirmation needed. */
    setMode(mode: AgentMode): void {
        this._pairRequestedTurn = undefined;
        this._pendingDelete = undefined;
        this._autoSwitchedFromPair = false;
        if (mode !== this._mode) {
            this._mode = mode;
            this._onModeChange?.(mode);
        }
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
            return { text: await this._run(toolName, args, turn), isError: false };
        } catch (err: unknown) {
            return { text: err instanceof Error ? err.message : String(err), isError: true };
        }
    }

    private async _run(toolName: string, args: Record<string, unknown>, turn: ToolTurn): Promise<string> {
        const { tabId } = turn;
        if (turn.proactive && toolName !== 'worker_status') {
            throw new Error('Nobody asked for this: the user has not spoken since this update. Tell them and let them decide.');
        }
        if (this._mode === 'pair' && WORKER_CONTROL[toolName]) {
            throw new Error(
                'You are in pair mode: you do the work yourself and do not direct the worker. If the user wants omp to do it, ask whether to switch back to omp mode; if the job is too heavy to do yourself, switch with set_mode omp and auto=true.',
            );
        }
        if (this._mode === 'omp' && PAIR_ONLY[toolName]) {
            throw new Error(
                this._autoSwitchedFromPair
                    ? 'Only in pair mode. You switched to omp mode yourself: once the worker has finished that work, switch back with set_mode pair.'
                    : 'Only in pair mode. In omp mode changes and commands go to the worker; switch to pair mode only if the user explicitly asks for it.',
            );
        }
        if (FILE_CHANGING[toolName] && this._worker.status(tabId).phase === 'working') {
            throw new Error('The worker is still running a task and may be writing files. Wait for it to finish, or ask the user to stop it from the chat.');
        }
        switch (toolName) {
            case 'set_mode': {
                const mode = args.mode === 'pair' ? 'pair' : 'omp';
                if (mode === 'omp') {
                    if (this._mode === 'omp') {
                        this._pairRequestedTurn = undefined;
                        return 'Already in omp mode.';
                    }
                    const auto = args.auto === true;
                    this.setMode('omp');
                    this._autoSwitchedFromPair = auto;
                    return auto
                        ? 'Now in omp mode: tell the worker to do the job; it can run its own subagents in parallel. Once that work is done, switch back with set_mode pair; no confirmation needed.'
                        : 'Now in omp mode: changes and commands go to the worker again.';
                }
                if (this._mode === 'pair') {
                    return 'Already in pair mode.';
                }
                if (!this._autoSwitchedFromPair && (this._pairRequestedTurn === undefined || turn.seq <= this._pairRequestedTurn)) {
                    this._pairRequestedTurn = turn.seq;
                    return 'Not switched yet. Ask the user to confirm pair mode: you will edit files and run commands yourself in their editor and terminal, and will not direct omp. Call set_mode pair again only after they agree in their next message.';
                }
                this.setMode('pair');
                return 'Now in pair mode: edit files with edit_file, manage them with create_file, create_folder, rename_file, delete_file, save_file and close_editor, run commands with run_in_terminal, and debug with debug_start, set_breakpoint, debug_control and debug_inspect, saying what you do as you go. The worker is not yours to direct until you switch to omp mode: when the user asks for it, or on your own for a job too heavy to do yourself.';
            }
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
                return this._requireHands().deletePath(target, recursive);
            }
            case 'save_file':
                return this._requireHands().saveFiles(optionalString(args, 'path'));
            case 'close_editor':
                return this._requireHands().closeEditor(requireString(args, 'path'));
            case 'run_in_terminal':
                return this._requireHands().runInTerminal(requireString(args, 'command'), seconds(args.timeoutSecs, 600, DEFAULT_TERMINAL_TIMEOUT_SECS) * 1000);
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
                if (this._worker.status(tabId).phase === 'idle') {
                    return 'The worker was already idle.';
                }
                await this._worker.abort(tabId);
                return 'Stopped.';
            }
            case 'answer_worker': {
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
            case 'research': {
                const job = this._startResearch(tabId, requireString(args, 'question'));
                return `Started research ${job.id} in the background. Tell the user you are looking into it and carry on; the findings arrive in a later message as <research-result id="${job.id}">.`;
            }
            case 'worker_status':
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

    private _requireHands(): EditorHands {
        if (!this._hands) {
            throw new Error('There is no editor here.');
        }
        return this._hands;
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
