/**
 * Drives the voice agent's real LLM process (omp) with scripted turns, the way VoiceAgent does, but
 * with a fake worker and fake editor hands, and records what the model said and which tools it called.
 * The HostToolRouter is the real one, so mode gating, proposals and the delete handshake behave as in
 * the extension. Used by the behavioural evals in this folder (`npm run eval:voice`), never by unit tests.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionLevel } from '../../shared/protocol';
import { formatOutline, parseBoard, type BoardHands } from '../../shared/board';
import { HostToolRouter, VOICE_HOST_TOOLS, type EditorHands, type ToolTurn } from '../../voiceAgent/hostTools';
import { findViewers, type ExtensionManifest } from '../../voiceAgent/viewers';
import { VoiceLlm } from '../../voiceAgent/voiceLlm';
import { buildTurnMessage, SILENT_REPLY, voiceSystemPrompt, type EditorSnapshot, type TurnInput } from '../../voiceAgent/voicePrompt';
import type { WorkerAnswer, WorkerController, WorkerRequest, WorkerSendOptions, WorkerStatus, WorkerTurn } from '../../voiceAgent/workerController';

export const TAB = 'tab-1';

/** How often each case runs; every run must pass. */
export const REPS = Math.max(1, Number(process.env.VOICE_EVAL_REPS ?? '1') || 1);

export class FakeWorker implements WorkerController {
    phase: WorkerStatus['phase'] = 'idle';
    requests: WorkerRequest[] = [];
    turns: WorkerTurn[] = [];
    sends: Array<{ tabId: string; text: string; options: WorkerSendOptions }> = [];
    answers: Array<{ requestId: string; answer: WorkerAnswer }> = [];
    aborted = 0;
    level: PermissionLevel = 'auto';
    /** The files the worker's running task changes, as the permission gate would report them. */
    locked: string[] = [];

    activeTask() {
        return { tabId: TAB, name: 'Task', backend: 'omp' as const };
    }
    onActiveTaskChanged() {
        return { dispose() {} };
    }
    onSessionResumed() {
        return { dispose() {} };
    }
    onTabEvent() {
        return { dispose() {} };
    }
    onRequestsChanged() {
        return { dispose() {} };
    }
    async send(tabId: string, text: string, options: WorkerSendOptions) {
        this.sends.push({ tabId, text, options });
        return this.phase === 'idle' ? ('started' as const) : options.when === 'now' ? ('steered' as const) : ('queued' as const);
    }
    async abort() {
        this.aborted++;
    }
    status(): WorkerStatus {
        return { phase: this.phase, queued: 0 };
    }
    pendingRequests() {
        return this.requests;
    }
    answer(_tabId: string, requestId: string, answer: WorkerAnswer) {
        this.answers.push({ requestId, answer });
        return true;
    }
    recentTurns() {
        return this.turns;
    }
    async nameTask() {
        return false;
    }
    permissionLevel() {
        return this.level;
    }
    async requestToolApproval() {
        return true;
    }
    lockedPaths(_tabId: string, paths: string[]) {
        return this.phase === 'idle' ? [] : this.locked.filter((locked) => paths.includes(locked));
    }
    async readTuiScreen(): Promise<string> {
        throw new Error('Not a TUI tab.');
    }
    async typeIntoTui(): Promise<string> {
        throw new Error('Not a TUI tab.');
    }
}

/** What the fake editor hands were asked to do. */
export interface Recorded {
    edits: string[];
    commands: string[];
    opened: string[];
    deleted: string[];
}

/** VS Code's built-in Markdown extension, trimmed to its side preview, so list_viewers has something to offer. */
const MARKDOWN: ExtensionManifest = {
    id: 'vscode.markdown-language-features',
    builtin: true,
    packageJSON: {
        contributes: {
            commands: [{ command: 'markdown.showPreviewToSide', title: 'Open Preview to the Side', category: 'Markdown' }],
            menus: { 'editor/title': [{ command: 'markdown.showPreviewToSide', when: 'resourceExtname == .md' }] },
        },
    },
};

function looksLikeFolder(target: string): boolean {
    return path.extname(target) === '';
}

function fakeHands(rec: Recorded): EditorHands {
    return {
        finishTyping: () => {},
        takeLateResults: () => [],
        previewEdit: () => ({ update() {}, commit: async () => undefined, drop() {} }),
        openFile: async (target) => {
            rec.opened.push(target.path);
            return `Opened ${target.path}.`;
        },
        listViewers: async (file) => ({ path: file, languageId: undefined, ...findViewers([MARKDOWN], file, undefined, { thirdPartyCommands: false }) }),
        openWith: async (file, viewer) => {
            rec.opened.push(`${viewer.id} ${file}`);
            return `Opened ${file}.`;
        },
        editFile: async (edit) => {
            rec.edits.push(edit.path);
            return `Edit of ${edit.path} accepted: it is being typed into the user's editor now, and saved when done. One Ctrl+Z in the editor undoes it.`;
        },
        createFile: async (file) => {
            rec.edits.push(`create ${file}`);
            return `Created ${file}.`;
        },
        createFolder: async (folder) => {
            rec.edits.push(`mkdir ${folder}`);
            return `Created ${folder}.`;
        },
        renamePath: async (from, to) => {
            rec.edits.push(`rename ${from} ${to}`);
            return `Renamed ${from} to ${to}.`;
        },
        describeDeletion: async (target, recursive) => {
            if (looksLikeFolder(target) && !recursive) {
                throw new Error(`${target} is a folder: pass recursive true to delete it with everything in it.`);
            }
            return looksLikeFolder(target) ? `the folder ${target} with 4 files in it` : `the file ${target}`;
        },
        deletePath: async (target) => {
            rec.deleted.push(target);
            return `Moved ${target} to the trash.`;
        },
        saveFiles: async () => 'Saved.',
        closeEditor: async () => 'Closed.',
        runInTerminal: async (command) => {
            rec.commands.push(command);
            return 'Exit code 0.\n\n  212 passed (212)\n';
        },
        sendToTerminal: async (input) => {
            rec.commands.push(`type ${input.text}`);
            return 'Typed a line; no new output.';
        },
        readTerminal: async () => 'Nothing new; still running.',
        readOutput: async (source) => (source ? `[${source}] 12:00:01 Build finished with 0 errors.` : 'Sources: Tasks, Debug Console, Terminal: zsh'),
        startDebugging: async (configuration) => {
            rec.commands.push(`debug ${configuration ?? ''}`);
            return 'Paused at a breakpoint.';
        },
        controlDebugging: async (action) => {
            rec.commands.push(`debug ${action}`);
            return 'Paused.';
        },
        setBreakpoint: async (breakpoint) => {
            rec.commands.push(`break ${breakpoint.path}:${breakpoint.line}`);
            return 'Breakpoint set.';
        },
        inspectDebugging: async () => 'Not paused.',
    };
}

/** Boards that record each write in `opened` as `board <mode> <board>`, and answer with a plain outline. */
function fakeBoards(rec: Recorded): BoardHands {
    return {
        write: async (request) => {
            rec.opened.push(`board ${request.mode} ${request.board ?? 'current'}`);
            return `Board b1 "${request.title ?? 'Board'}"\n${formatOutline(parseBoard(request.markdown))}`;
        },
        point: async (target) => `Pointed at ${target.block}.`,
        view: async (request) => `Done: ${request.action}.`,
        takeLateResults: () => [],
        preview: () => ({ update() {}, end() {} }),
    };
}

export interface TurnCall {
    tool: string;
    args: Record<string, unknown>;
    result: string;
    isError: boolean;
}

export interface TurnResult {
    /** The whole reply, markers included. */
    text: string;
    silent: boolean;
    /** Host tool calls in order, with what the router answered. */
    calls: TurnCall[];
    /** Their names, for quick assertions. */
    tools: string[];
    /** The model's own lookups (read, grep, glob, web_search). */
    lookups: string[];
    error?: string;
}

/** A partial turn: everything `buildTurnMessage` needs that the harness does not fill in itself. */
export type TurnExtras = Partial<Pick<TurnInput, 'updates' | 'history' | 'research' | 'editor' | 'names' | 'interrupted' | 'tone'>>;

export class VoiceEval {
    worker = new FakeWorker();
    rec: Recorded = { edits: [], commands: [], opened: [], deleted: [] };
    router: HostToolRouter;
    private _seq = 0;
    private _label = '';

    private constructor(
        private readonly _llm: VoiceLlm,
        readonly model: string,
        private readonly _sessionDir: string,
    ) {
        this.router = this._newRouter();
    }

    static async start(): Promise<VoiceEval> {
        const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eval-'));
        const llm = await VoiceLlm.start(
            {
                cwd: process.cwd(),
                sessionDir,
                // VOICE_EVAL_EXTRA_PROMPT stands in for the voiceAgent.extraPrompt setting, appended the same way.
                systemPrompt: voiceSystemPrompt(process.env.VOICE_EVAL_EXTRA_PROMPT ?? ''),
                model: process.env.VOICE_EVAL_MODEL || undefined,
                thinking: process.env.VOICE_EVAL_THINKING ?? 'off',
                tools: VOICE_HOST_TOOLS,
                skills: [],
            },
            (error) => {
                if (error) {
                    console.error(`voice process exited: ${error.message}`);
                }
            },
        );
        return new VoiceEval(llm, llm.model, sessionDir);
    }

    /** A fresh voice context, worker and router: cases never see each other. */
    async fresh(label: string): Promise<void> {
        await this._llm.newSession();
        this.worker = new FakeWorker();
        this.rec = { edits: [], commands: [], opened: [], deleted: [] };
        this.router = this._newRouter();
        this._seq = 0;
        this._label = label;
    }

    /** One turn, built like VoiceAgent builds it; host tool calls go through the real router. */
    async turn(trigger: TurnInput['trigger'], extras: TurnExtras = {}): Promise<TurnResult> {
        const proactive = trigger.kind !== 'user';
        const userAt = Date.now();
        if (!proactive) {
            this._seq++;
        }
        const message = buildTurnMessage({
            trigger,
            status: this.worker.status(),
            updates: [],
            requests: this.worker.requests,
            proposals: this.router.proposals(TAB),
            settledProposals: this.router.takeSettled(TAB),
            heldApprovals: this.router.heldApprovals(TAB),
            settledApprovals: this.router.takeSettledApprovals(TAB),
            pendingDelete: this.router.pendingDelete,
            research: [],
            ...extras,
        });
        const toolTurn: ToolTurn = { tabId: TAB, seq: this._seq, userAt, proactive };
        const calls: TurnCall[] = [];
        const lookups: string[] = [];
        const pending: Promise<void>[] = [];
        let text = '';
        const { error } = await this._llm.prompt(message, new AbortController().signal, {
            onText: (delta) => {
                text += delta;
            },
            onToolStart: () => {},
            onToolDelta: () => {},
            onToolDropped: () => {},
            onToolCall: (call) => {
                pending.push(
                    this.router.execute(call.toolName, call.arguments, toolTurn).then((result) => {
                        calls.push({ tool: call.toolName, args: call.arguments, result: result.text, isError: result.isError });
                        this._llm.sendToolResult(call.id, result.text, result.isError);
                    }),
                );
            },
            onToolCancel: () => {},
            onBuiltinTool: (_description, call) => {
                lookups.push(call.toolName);
            },
            onBuiltinToolEnd: () => {},
            onUsage: () => {},
        });
        await Promise.all(pending);
        const result: TurnResult = { text, silent: text.trim() === SILENT_REPLY, calls, tools: calls.map((call) => call.tool), lookups, error };
        this._log(trigger, result);
        return result;
    }

    async stop(): Promise<void> {
        await this._llm.stop();
        fs.rmSync(this._sessionDir, { recursive: true, force: true });
    }

    private _newRouter(): HostToolRouter {
        return new HostToolRouter(
            this.worker,
            () => undefined,
            () => true,
            (_tabId, question) => ({ id: 'r1', question, startedAt: Date.now(), status: 'running' as const }),
            fakeHands(this.rec),
            fakeBoards(this.rec),
        );
    }

    private _log(trigger: TurnInput['trigger'], result: TurnResult): void {
        const what = trigger.kind === 'user' ? `user: ${trigger.text}` : trigger.kind === 'opening' ? `voice-on (${trigger.reason})` : `update: ${trigger.observation}`;
        const tools = result.calls.map((call) => `${call.tool}${call.isError ? '!' : ''}(${JSON.stringify(call.args).slice(0, 80)})`).join(' ');
        const lookups = result.lookups.length ? ` lookups=[${result.lookups.join(',')}]` : '';
        const shape = `sentences=${sentenceCount(result.text)} first=${JSON.stringify(firstSentence(result.text).slice(0, 40))}`;
        console.log(`[${this._label}] ${what}\n  tools=[${tools}]${lookups}${result.error ? ` error=${result.error}` : ''} ${shape}\n  reply: ${result.text.trim() || '(empty)'}`);
    }
}

/** An editor snapshot on the first line of `file` containing `needle`, with `span` lines selected. */
export function editorAt(file: string, needle: string, span = 3): EditorSnapshot {
    const lines = fs.readFileSync(path.join(process.cwd(), file), 'utf8').split('\n');
    const index = lines.findIndex((line) => line.includes(needle));
    if (index < 0) {
        throw new Error(`${JSON.stringify(needle)} is not in ${file}`);
    }
    const startLine = index + 1;
    const endLine = Math.min(lines.length, index + span);
    return {
        path: file,
        language: 'typescript',
        cursorLine: startLine,
        visible: { startLine: Math.max(1, startLine - 15), endLine: endLine + 15 },
        selection: { startLine, endLine },
        lines: lines.slice(index, endLine).map((text, i) => ({ line: startLine + i, text })),
        omittedLines: 0,
        unsaved: false,
    };
}

/** The first spoken sentence: the one said before any tool call, and the one most likely to slip out of the user's language. */
export function firstSentence(text: string): string {
    const spoken = stripMarkers(text).trim();
    const match = spoken.match(/^[\s\S]*?(?:[.!?](?=\s|$)|[。！？])/);
    return (match ? match[0] : spoken).trim();
}

/** Three or more English words before anything else: the reply started in English, whatever came after. */
export function startsInEnglish(text: string): boolean {
    return /^[A-Za-z'’]+(?:\s+[A-Za-z'’]+){2,}/.test(stripMarkers(text).trim());
}

export function markers(text: string): string[] {
    return text.match(/⟦[^⟧]*⟧/g) ?? [];
}

export function stripMarkers(text: string): string {
    return text.replace(/⟦[^⟧]*⟧/g, '');
}

/** Sentences as a listener would count them: Western enders followed by a space or the end, CJK enders anywhere. */
export function sentenceCount(text: string): number {
    const spoken = stripMarkers(text).trim();
    if (!spoken) {
        return 0;
    }
    return spoken.split(/[.!?](?=\s|$)|[。！？]/).filter((part) => part.trim()).length;
}

export function hasCjk(text: string): boolean {
    return /[一-鿿]/.test(text);
}

/** Markdown a TTS engine would read out or mangle: list bullets, headings, bold, code spans or fences. */
export function hasMarkdown(text: string): boolean {
    return /(^|\n)\s*(?:[-*•]\s|#{1,6}\s|\d+[.)]\s)|\*\*|```|`[^`\n]+`/.test(stripMarkers(text));
}

export function asksQuestion(text: string): boolean {
    return /[?？]/.test(text) || /吗[。!！]?\s*$/.test(text.trim());
}
