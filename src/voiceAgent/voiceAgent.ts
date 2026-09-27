import { VOICE_MODE_LABEL, type VoiceAttachments, type VoiceCallUsage, type VoiceObservationKind, type VoiceUsageTotals } from '../shared/voiceViewProtocol';
import type { ImageContent } from '../shared/piTypes';
import { AnchorStream, type CodeAnchor } from './codeAnchors';
import { FloorArbiter, type ArbiterSettings, type ArbiterView, type Observation } from './floorArbiter';
import { HostToolRouter, VOICE_HOST_TOOLS, type AgentMode, type EditorHands, type Proposal, type ToolResult, type ToolTurn } from './hostTools';
import { readTarget, type FocusTarget } from './piFocus';
import { ResearchRunner, type ResearchJob } from './research';
import { VoiceLlm } from './voiceLlm';
import { SilenceGate, VOICE_SYSTEM_PROMPT, buildTurnMessage, type EditorSnapshot, type OpeningReason, type TurnInput } from './voicePrompt';
import { provisionalTaskKey, taskKey, type WorkerController, type WorkerTask } from './workerController';
import { WorkerDigest, clip, type DigestEntry } from './workerDigest';

export interface VoiceAgentOptions {
    worker: WorkerController;
    cwd: string;
    /** Where omp keeps voice contexts, one session file each; they outlive the agent (see `contexts`). */
    sessionDir: string;
    /** Remembers each task's voice context across agents, so a restart picks the conversation up again. */
    contexts?: VoiceContextMemory;
    /** `provider/id`; empty follows the worker's model when the process starts (design §5.4). */
    model: string;
    thinking: string;
    confirmBeforeDispatch: () => boolean;
    /** Read at every decision, so settings changes apply right away. */
    arbiter: () => ArbiterSettings;
    /** A turn the agent starts on its own (§5.9), or its opening line, is about to be prompted: how to report and scope it. */
    onProactiveTurn?: (kind: VoiceObservationKind, task: WorkerTask) => ProactiveTurnHooks;
    /** Someone is talking or about to (voice mode): proactive turns wait. */
    floorBusy?: () => boolean;
    /** Stops the reply being spoken, if any (voice mode); the text reply is cut off either way. */
    hush?: () => void;
    /** Proposals or research changed (voice panel cards). */
    onChange?: () => void;
    /** The user's editor, attached to every turn; without it the agent does not see the editor. */
    editor?: () => EditorSnapshot | undefined;
    /** The agent reads this file itself (Pi focus). */
    onRead?: (target: FocusTarget) => void;
    /** Its hands in the user's VS Code: open_file, list_viewers, open_with and read_output, and in pair mode editing and managing files, the terminal and the debugger. */
    hands?: EditorHands;
    /** Switched between omp and pair mode, by a tool call or setMode. */
    onModeChange?: (mode: AgentMode) => void;
    log: (line: string) => void;
}

/** Where a task's voice context outlives the agent: the voice transcript store (design §5.12, §11.4). */
export interface VoiceContextMemory {
    /** The session file of the task's last voice context, while it is still on disk. */
    savedContext(task: WorkerTask): string | undefined;
    /** The task's voice context is now `sessionFile`; `resumed` when it is the saved one. */
    bindContext(task: WorkerTask, sessionFile: string, resumed: boolean): void;
}

export interface ProactiveTurnHooks {
    listener: VoiceTurnListener;
    /** Aborting it cuts the turn off, like a new user message does. */
    signal?: AbortSignal;
}

/** Voice came on: the agent speaks first. */
export interface Opening {
    reason: OpeningReason;
    /** Only while this tab is the active one (a resumed session); otherwise whatever task is active. */
    tabId?: string;
    /** For a voice context with no user words yet to go by (the speech recognition language). */
    language?: string;
}

export interface SayOptions {
    /** Aborting it cuts this turn off, whether it is running or still queued. */
    signal?: AbortSignal;
    /**
     * What the user actually heard of the reply that was cut off before this message (voice mode
     * knows from playback); replaces the default note, which assumes they saw the whole text.
     */
    interrupted?: string;
    /** Files and images the user attached in the chat composer. */
    attachments?: VoiceAttachments;
}

export interface VoiceTurnListener {
    /** The whole message going to the voice model for this turn (debug transcript). */
    onPrompt?(message: string): void;
    /** The turn got the LLM: earlier turns are done. */
    onStart?(task: WorkerTask): void;
    /** Never called for a `<silent/>` reply. Code anchors are taken out: they arrive through onAnchor. */
    onText?(delta: string): void;
    /** The reply points at code here, between the text before and after it. */
    onAnchor?(anchor: CodeAnchor): void;
    onToolCall?(name: string, args: Record<string, unknown>, result: ToolResult): void;
    /** The voice agent is looking something up itself (read, grep, glob, web_search). */
    onLookup?(description: string): void;
    /** One LLM call of the turn finished (several when it uses tools). */
    onUsage?(usage: VoiceCallUsage): void;
    onEnd?(result: VoiceTurnResult): void;
}

export interface VoiceToolCallRecord {
    name: string;
    args: Record<string, unknown>;
    result: ToolResult;
}

export interface VoiceTurnResult {
    reply: string;
    /** The agent chose to say nothing (`<silent/>`); only proactive turns should. */
    silent: boolean;
    toolCalls: VoiceToolCallRecord[];
    /** The voice agent's own reads, in order. */
    lookups: string[];
    /** A newer message or a task switch cut this reply off. */
    interrupted: boolean;
    error?: string;
}

interface VoiceContext {
    sessionFile: string;
    /** Newest activity-log entry this context has been shown. */
    seenSeq: number;
    /** Background research started from this context: running, or settled and not yet shown. */
    research: ResearchJob[];
    /** The editor as last shown to this context, so an unchanged one is not repeated. */
    editorKey?: string;
}

interface RunningTurn {
    /** The voice context it runs in. */
    key: string;
    ctl: AbortController;
    turn: ToolTurn;
    /** Why it is being cut off, when not by a new message or a task switch; goes into `<interrupted>`. */
    cause?: string;
}

/** How often the arbiter is asked when nothing else prompts it (§7.7 Tick). */
const TICK_MS = 1000;
/** Research jobs kept per tab for the voice panel. */
const RESEARCH_SHOWN = 10;

/**
 * The voice agent without audio: user turns in, streamed replies and worker control out.
 * One omp process holds one voice context per worker task and switches between them.
 * Between user turns it speaks up on its own when the arbiter finds something worth saying.
 */
export class VoiceAgent {
    private _llm: Promise<VoiceLlm> | undefined;
    private _loadedKey: string | undefined;
    private readonly _contexts = new Map<string, VoiceContext>();
    private readonly _digests = new Map<string, WorkerDigest>();
    private readonly _router: HostToolRouter;
    private readonly _arbiter: FloorArbiter;
    private readonly _subscriptions: Array<{ dispose(): void }>;
    private readonly _research: ResearchRunner;
    /** Every research job per tab, newest last, for the voice panel (contexts drop them once relayed). */
    private readonly _researchShown = new Map<string, ResearchJob[]>();
    private readonly _tick: NodeJS.Timeout;
    private _lastTask: WorkerTask | undefined;
    private _userSeq = 0;
    /** When the latest user message arrived; bounds which worker requests it can answer. */
    private _lastUserAt = 0;
    private _chain: Promise<unknown> = Promise.resolve();
    /** Turns queued or running, user and proactive. */
    private _inFlight = 0;
    /** User turns queued behind the running one: a proactive turn yields to them. */
    private _userWaiting = 0;
    private _turn: RunningTurn | undefined;
    /** The turn started last, running or not: its reply may still be playing. */
    private _lastTurn: ToolTurn | undefined;
    /** Left by a reply that was cut off, for the next turn's `<interrupted>` (§5.4). */
    private _cutOff: { reply: string; effects: string; cause?: string } | undefined;
    private _stopped = false;
    /** `provider/id` of the running omp process, once it is up. */
    private _model: string | undefined;
    /** The loaded voice context's totals, refreshed after each turn and context switch. */
    private _usage: VoiceUsageTotals | undefined;
    /** Voice came on and the agent has not spoken first yet; dropped once the user speaks. */
    private _opening: Opening | undefined;

    constructor(private readonly _options: VoiceAgentOptions) {
        const { worker } = _options;
        this._research = new ResearchRunner(_options.cwd);
        this._arbiter = new FloorArbiter(_options.arbiter);
        this._router = new HostToolRouter(
            worker,
            (tabId) => this._digests.get(tabId),
            _options.confirmBeforeDispatch,
            (tabId, question) => this._startResearch(tabId, question),
            _options.hands,
            (mode) => {
                this._options.log(`Voice agent now in ${VOICE_MODE_LABEL[mode]} mode.`);
                this._options.onModeChange?.(mode);
            },
        );
        // The user answered one of the voice agent's approval cards: say what came of it.
        this._router.onApprovalSettled = () => {
            this._options.onChange?.();
            this._maybeProactive();
        };
        this._lastTask = worker.activeTask();
        this._subscriptions = [
            worker.onTabEvent(({ tabId, event }) => {
                const now = Date.now();
                this._digest(tabId).ingest(event, now);
                this._arbiter.ingest(tabId, event, now);
            }),
            // A request should be heard before it times out: don't wait for the tick.
            worker.onRequestsChanged(() => this._maybeProactive()),
            worker.onActiveTaskChanged((task) => {
                const last = this._lastTask;
                this._lastTask = task;
                this._arbiter.taskChanged(task?.tabId, task !== undefined && task.tabId === last?.tabId, Date.now());
                // A resumed session's opening is about that session only.
                if (this._opening?.tabId !== undefined && this._opening.tabId !== task?.tabId) {
                    this._opening = undefined;
                }
                // Switching task cancels the reply about the old one (§5.12 rule 3).
                if (this._turn && (!task || taskKey(task) !== this._turn.key)) {
                    this._turn.ctl.abort();
                }
            }),
        ];
        this._tick = setInterval(() => this._maybeProactive(), TICK_MS);
    }

    /**
     * A user turn. A reply still running is cut off: the user always wins. Never rejects: a turn that
     * cannot run (the agent process failed to start, no chat tab, …) ends through `listener.onEnd`
     * with `error` set, like a failed reply, so the transcript shows it instead of a pending reply.
     */
    say(text: string, source: 'text' | 'stt', listener: VoiceTurnListener = {}, options: SayOptions = {}): Promise<VoiceTurnResult> {
        const userAt = Date.now();
        this._userWaiting++;
        // The user spoke first: nothing to open with any more.
        this._opening = undefined;
        this._turn?.ctl.abort();
        return this._enqueue(async () => {
            this._userWaiting--;
            try {
                return await this._userTurn(text, source, userAt, listener, options);
            } catch (err: unknown) {
                const result: VoiceTurnResult = {
                    reply: '',
                    silent: false,
                    toolCalls: [],
                    lookups: [],
                    interrupted: false,
                    error: err instanceof Error ? err.message : String(err),
                };
                listener.onEnd?.(result);
                return result;
            }
        });
    }

    /** omp (default): it directs the worker. pair: it edits and runs commands itself. */
    get mode(): AgentMode {
        return this._router.mode;
    }

    /** The voice model in use (`provider/id`); undefined until the omp process has started. */
    get model(): string | undefined {
        return this._model;
    }

    /** Token totals and context window use of the loaded voice context; undefined before it has one. */
    get usage(): VoiceUsageTotals | undefined {
        return this._usage;
    }

    /** The user switched from the UI. */
    setMode(mode: AgentMode): void {
        this._router.setMode(mode);
    }

    /** New tasks waiting on the user's go-ahead (voice panel cards). */
    proposals(tabId: string): Proposal[] {
        return this._router.proposals(tabId);
    }

    /** Research started for this tab, newest last. */
    researchJobs(tabId: string): readonly ResearchJob[] {
        return this._researchShown.get(tabId) ?? [];
    }

    /** The worker's latest steps in plain language, newest last. */
    recentActivity(tabId: string, count: number): DigestEntry[] {
        return this._digests.get(tabId)?.recent(count) ?? [];
    }

    /** The user agreed to a proposal in the voice panel: send it as confirm_task would. */
    async confirmProposal(id: string): Promise<string> {
        this._cutAsking(id);
        const sending = this._router.confirmProposal(id);
        this._options.onChange?.();
        return sending;
    }

    /** The user turned a proposal down in the voice panel. */
    cancelProposal(id: string): void {
        this._cutAsking(id);
        this._router.cancelProposal(id);
        this._options.onChange?.();
    }

    /**
     * A proposal was settled with a button while the reply that made it may still be asking for it:
     * that reply is cut off, spoken or not. The model hears what happened on its next turn.
     */
    private _cutAsking(id: string): void {
        const last = this._lastTurn;
        const proposal = last && this._router.proposals(last.tabId).find((p) => p.id === id);
        // With a newer user message queued, the reply being spoken, or about to be, is not the one asking.
        if (!last || last.proactive || !proposal || proposal.createdTurn !== last.seq || this._userWaiting > 0) {
            return;
        }
        if (this._turn?.turn === last) {
            this._turn.cause = 'You proposed a task and the user answered it with the button in the voice panel, which cut off your reply';
            this._turn.ctl.abort();
        }
        this._options.hush?.();
    }

    /** Starts the omp process for the current task ahead of the first turn, so proactive turns can happen. */
    warmUp(): void {
        const task = this._options.worker.activeTask();
        if (task && !this._stopped) {
            void this._ensureLlm(task).catch(() => undefined);
        }
    }

    /** Voice came on: the agent speaks first as soon as nobody is talking, unless the user speaks before. */
    open(opening: Opening): void {
        // A session resumed into a tab the user has already left: nothing to open about.
        if (this._stopped || (opening.tabId !== undefined && opening.tabId !== this._options.worker.activeTask()?.tabId)) {
            return;
        }
        this._opening = opening;
        this._maybeProactive();
    }

    /** Voice mode: the reply finished playing or the user finished speaking; quiet time starts now. */
    floorReleased(): void {
        this._arbiter.turnEnded(Date.now());
        this._maybeProactive();
    }

    async stop(): Promise<void> {
        this._stopped = true;
        clearInterval(this._tick);
        this._turn?.ctl.abort();
        this._research.stopAll();
        for (const subscription of this._subscriptions) {
            subscription.dispose();
        }
        const llm = await this._llm?.catch(() => undefined);
        this._llm = undefined;
        await llm?.stop();
    }

    /** Turns run one at a time (§7.7 invariant 1). */
    private _enqueue<T>(work: () => Promise<T>): Promise<T> {
        this._inFlight++;
        const run = this._chain.then(work).finally(() => {
            this._inFlight--;
            this._maybeProactive();
        });
        this._chain = run.catch(() => undefined);
        return run;
    }

    /** Starts a proactive turn when nobody is talking and there is an opening or the arbiter has something (§7.7 maybeProactive). */
    private _maybeProactive(): void {
        // Before the first user turn the voice agent is not on; after its process died it waits for the user.
        if (this._stopped || this._inFlight > 0 || !this._llm || this._options.floorBusy?.()) {
            return;
        }
        const task = this._options.worker.activeTask();
        if (!task || (!this._opening && !this._arbiter.next(this._view(task), Date.now()))) {
            return;
        }
        void this._enqueue(() => this._proactiveTurn()).catch((err: unknown) =>
            this._options.log(`Proactive turn failed: ${err instanceof Error ? err.message : String(err)}`),
        );
    }

    private async _userTurn(
        text: string,
        source: 'text' | 'stt',
        userAt: number,
        listener: VoiceTurnListener,
        options: SayOptions,
    ): Promise<VoiceTurnResult> {
        if (this._stopped) {
            throw new Error('The voice agent was stopped');
        }
        const { worker } = this._options;
        const task = worker.activeTask();
        if (!task) {
            throw new Error('No chat tab');
        }
        const llm = await this._ensureLlm(task);
        const { key, fresh } = await this._enterContext(llm, task);
        const context = this._contexts.get(key)!;
        const digest = this._digest(task.tabId);
        const requests = worker.pendingRequests(task.tabId);
        const message = buildTurnMessage({
            trigger: { kind: 'user', text, source, files: options.attachments?.files },
            status: worker.status(task.tabId),
            updates: digest.since(context.seenSeq),
            history: fresh ? { task, turns: worker.recentTurns(task.tabId, 3) } : undefined,
            requests,
            proposals: this._router.proposals(task.tabId),
            settledProposals: this._router.takeSettled(task.tabId),
            heldApprovals: this._router.heldApprovals(task.tabId),
            settledApprovals: this._router.takeSettledApprovals(task.tabId),
            pendingDelete: this._router.pendingDelete,
            research: context.research,
            editor: this._editorFor(context),
            mode: this._router.mode,
            interrupted: this._takeInterrupted(options.interrupted),
        });
        context.seenSeq = digest.lastSeq;
        // A finished job is shown once; running ones keep appearing with their elapsed time.
        context.research = context.research.filter((job) => job.status === 'running');
        this._lastUserAt = userAt;
        // The user's turn carries every observation along (§5.9 rule 3).
        this._arbiter.userTurn(task.tabId, requests.map((request) => request.id));
        listener.onStart?.(task);
        return this._runTurn(llm, key, message, { tabId: task.tabId, seq: ++this._userSeq, userAt }, listener, options.signal, options.attachments?.images);
    }

    /**
     * The opening line, else one observation, re-picked now that the turn has the LLM; undefined
     * when there is nothing to say.
     */
    private async _proactiveTurn(): Promise<VoiceTurnResult | undefined> {
        const { worker } = this._options;
        const task = worker.activeTask();
        if (this._stopped || this._userWaiting > 0 || !task) {
            return undefined;
        }
        const llm = await this._ensureLlm(task);
        const { key, fresh } = await this._enterContext(llm, task);
        // The user spoke while the context loaded: their turn goes first and covers this.
        if (this._stopped || this._userWaiting > 0 || this._options.floorBusy?.()) {
            return undefined;
        }
        const opening = this._opening;
        const observation = opening ? undefined : this._arbiter.next(this._view(task), Date.now());
        const context = this._contexts.get(key)!;
        const digest = this._digest(task.tabId);
        const requests = worker.pendingRequests(task.tabId);
        let trigger: TurnInput['trigger'];
        let research: ResearchJob[];
        if (opening) {
            this._opening = undefined;
            trigger = { kind: 'opening', reason: opening.reason, language: opening.language };
            // Like a user turn, the opening shows the task's whole state: nothing in it is news afterwards.
            research = context.research;
            this._arbiter.userTurn(task.tabId, requests.map((request) => request.id));
        } else if (observation) {
            this._arbiter.consume(observation);
            trigger = { kind: 'proactive', observation: observation.kind, detail: this._describe(observation) };
            // One observation per proactive turn (§7.7 invariant 4): other finished research waits for its own.
            research = context.research.filter(
                (job) => job.status === 'running' || (observation.kind === 'research' && job.id === observation.jobId),
            );
        } else {
            return undefined;
        }
        const message = buildTurnMessage({
            trigger,
            status: worker.status(task.tabId),
            updates: digest.since(context.seenSeq),
            history: fresh ? { task, turns: worker.recentTurns(task.tabId, 3) } : undefined,
            requests,
            proposals: this._router.proposals(task.tabId),
            settledProposals: this._router.takeSettled(task.tabId),
            heldApprovals: this._router.heldApprovals(task.tabId),
            settledApprovals: this._router.takeSettledApprovals(task.tabId),
            pendingDelete: this._router.pendingDelete,
            research,
            editor: this._editorFor(context),
            mode: this._router.mode,
            interrupted: this._takeInterrupted(),
        });
        context.seenSeq = digest.lastSeq;
        context.research = context.research.filter((job) => job.status === 'running' || !research.includes(job));
        const hooks = this._options.onProactiveTurn?.(observation?.kind ?? 'opening', task);
        const listener = hooks?.listener ?? {};
        listener.onStart?.(task);
        const turn: ToolTurn = { tabId: task.tabId, seq: this._userSeq, userAt: this._lastUserAt, proactive: true };
        return this._runTurn(llm, key, message, turn, listener, hooks?.signal);
    }

    /** The `<interrupted>` note for the next message, once: `heard` from voice mode, else the default. */
    private _takeInterrupted(heard?: string): string | undefined {
        const cut = this._cutOff;
        this._cutOff = undefined;
        const effects = cut?.effects ? ` Tool calls from that reply still took effect: ${cut.effects}` : '';
        const cause = cut?.cause ? `${cut.cause}. ` : '';
        if (heard) {
            return cause + heard + effects;
        }
        return cut && `${cut.cause ?? 'A new message cut off your previous reply'}; the user saw only: "${cut.reply.trim()}".${effects}`;
    }

    /** The editor for this context's next message: in full only when it changed since the context last saw it. */
    private _editorFor(context: VoiceContext): TurnInput['editor'] {
        if (!this._options.editor) {
            return undefined;
        }
        const snapshot = this._options.editor();
        const key = snapshot ? JSON.stringify(snapshot) : 'none';
        if (key === context.editorKey) {
            return 'unchanged';
        }
        context.editorKey = key;
        return snapshot ?? 'none';
    }

    private _describe(observation: Observation): string {
        switch (observation.kind) {
            case 'approval':
                return 'The user answered your approval card; the outcome is in <approval-settled> above. Tell them in a sentence what happened.';
            case 'needs_input':
                return this._options.worker.status(observation.tabId).fromVoice
                    ? 'The task you sent is waiting on the request above. Remind the user: they answer it in the chat (Approve or Deny for a tool approval), or tell you their answer.'
                    : 'The worker is waiting on the request above.';
            case 'error':
                return `The worker stopped with an error: ${clip(observation.detail, 300)}`;
            case 'done': {
                const reply = this._options.worker.recentTurns(observation.tabId, 1)[0]?.reply;
                return `The worker finished.${reply ? ` Its final reply: ${clip(reply, 600)}` : ''}`;
            }
            case 'research':
                return `Research ${observation.jobId} is back; its result is above.`;
            case 'progress':
                return 'The worker is still working; its latest steps are above.';
        }
    }

    private _view(task: WorkerTask): ArbiterView {
        const { worker } = this._options;
        const context = this._contexts.get(taskKey(task)) ?? this._contexts.get(provisionalTaskKey(task.tabId));
        const status = worker.status(task.tabId);
        return {
            tabId: task.tabId,
            phase: status.phase,
            requestIds: worker.pendingRequests(task.tabId).map((request) => request.id),
            fromVoice: status.fromVoice === true,
            settledApprovals: this._router.settledApprovalCount(task.tabId),
            settledResearch: context?.research.filter((job) => job.status !== 'running').map((job) => job.id) ?? [],
            unseenUpdates: context ? this._digest(task.tabId).since(context.seenSeq).length : 0,
        };
    }

    private async _runTurn(
        llm: VoiceLlm,
        key: string,
        message: string,
        turn: ToolTurn,
        listener: VoiceTurnListener,
        signal?: AbortSignal,
        images?: ImageContent[],
    ): Promise<VoiceTurnResult> {
        const ctl = new AbortController();
        const current: RunningTurn = { key, ctl, turn };
        this._turn = current;
        this._lastTurn = turn;
        const cutOff = () => ctl.abort();
        signal?.addEventListener('abort', cutOff, { once: true });
        /** What the user was shown: the reply without `<silent/>` and without anchors. */
        let reply = '';
        const gate = new SilenceGate();
        const anchors = new AnchorStream();
        const show = (text: string) => {
            for (const part of anchors.push(text)) {
                if ('anchor' in part) {
                    listener.onAnchor?.(part.anchor);
                } else {
                    reply += part.text;
                    listener.onText?.(part.text);
                }
            }
        };
        const toolCalls: VoiceToolCallRecord[] = [];
        const lookups: string[] = [];
        const cancelled = new Set<string>();
        const executing: Promise<void>[] = [];
        listener.onPrompt?.(message);
        const running = llm.prompt(message, ctl.signal, {
            onText: (delta) => {
                const shown = gate.push(delta);
                if (shown) {
                    show(shown);
                }
            },
            onToolCall: (call) => {
                executing.push(
                    this._router.execute(call.toolName, call.arguments, turn).then((result) => {
                        toolCalls.push({ name: call.toolName, args: call.arguments, result });
                        listener.onToolCall?.(call.toolName, call.arguments, result);
                        this._options.onChange?.();
                        if (!cancelled.has(call.id)) {
                            llm.sendToolResult(call.id, result.text, result.isError);
                        }
                    }),
                );
            },
            onToolCancel: (callId) => cancelled.add(callId),
            onBuiltinTool: (description, call) => {
                lookups.push(description);
                listener.onLookup?.(description);
                const target = call.toolName === 'read' ? readTarget(call.args) : undefined;
                if (target) {
                    this._options.onRead?.(target);
                }
            },
            onUsage: (usage) => listener.onUsage?.(usage),
        }, images);
        // Aborted while queued: the prompt still goes in (the context keeps the user's words), cut off at once.
        if (signal?.aborted) {
            ctl.abort();
        }
        const { error } = await running;
        // A cancelled run can settle while a tool call is still executing; it still takes effect.
        await Promise.all(executing);
        signal?.removeEventListener('abort', cutOff);
        if (this._turn === current) {
            this._turn = undefined;
        }
        this._arbiter.turnEnded(Date.now());
        this._refreshUsage(llm);
        const held = gate.flush();
        if (held) {
            show(held);
        }
        anchors.flush();
        const { silent } = gate;
        const interrupted = ctl.signal.aborted;
        if (interrupted) {
            this._cutOff = { reply, effects: toolCalls.map((call) => `${call.name}: ${call.result.text}`).join(' '), cause: current.cause };
        }
        const result: VoiceTurnResult = { reply, silent, toolCalls, lookups, interrupted, error: interrupted ? undefined : error };
        listener.onEnd?.(result);
        return result;
    }

    private _ensureLlm(task: WorkerTask): Promise<VoiceLlm> {
        if (!this._llm) {
            const { cwd, sessionDir, model, thinking, log } = this._options;
            const started = VoiceLlm.start(
                { cwd, sessionDir, systemPrompt: VOICE_SYSTEM_PROMPT, model: model || task.model, thinking, tools: VOICE_HOST_TOOLS },
                (error) => {
                    log(`Voice agent process exited${error ? `: ${error.message}` : ''}; it restarts on the next message.`);
                    this._llm = undefined;
                    this._loadedKey = undefined;
                },
            );
            this._llm = started;
            this._loadedKey = undefined;
            started.then(
                (llm) => {
                    this._model = llm.model;
                    this._options.onChange?.();
                    log(`Voice agent ready (${llm.model}).`);
                },
                (err: unknown) => {
                    log(`Voice agent failed to start: ${err instanceof Error ? err.message : String(err)}`);
                    if (this._llm === started) {
                        this._llm = undefined;
                    }
                },
            );
        }
        return this._llm;
    }

    /**
     * Load the task's voice context into the omp process: the one in memory, else the one saved from
     * an earlier agent, else a new one. `fresh` the first time this agent loads it: the context then
     * gets <task-history>, since what the worker did meanwhile is not in it. Only while idle.
     */
    private async _enterContext(llm: VoiceLlm, task: WorkerTask): Promise<{ key: string; fresh: boolean }> {
        const key = taskKey(task);
        const provisional = provisionalTaskKey(task.tabId);
        const early = this._contexts.get(provisional);
        if (key !== provisional && early && !this._contexts.has(key)) {
            // The tab got its session file after the voice context was made: same task.
            this._contexts.set(key, early);
            this._contexts.delete(provisional);
            if (this._loadedKey === provisional) {
                this._loadedKey = key;
            }
        }
        if (key === this._loadedKey) {
            return { key, fresh: false };
        }
        this._router.clearProposals();
        const existing = this._contexts.get(key);
        if (existing) {
            await llm.switchSession(existing.sessionFile);
            this._loadedKey = key;
            this._refreshUsage(llm);
            return { key, fresh: false };
        }
        const saved = this._options.contexts?.savedContext(task);
        let sessionFile: string | undefined;
        if (saved) {
            try {
                await llm.switchSession(saved);
                sessionFile = saved;
                this._options.log(`Resumed the voice conversation about ${task.name}.`);
            } catch (err) {
                this._options.log(`Could not resume the voice conversation about ${task.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        const resumed = sessionFile !== undefined;
        sessionFile ??= await llm.newSession();
        this._options.contexts?.bindContext(task, sessionFile, resumed);
        // A new context: older activity is either in <task-history> or from an earlier task in this
        // tab, so keep only the run in progress, if any. A resumed one saw none of what this agent's
        // digest holds (it starts with the agent): all of it.
        const digest = this._digest(task.tabId);
        const busy = this._options.worker.status(task.tabId).phase !== 'idle';
        const seenSeq = resumed ? 0 : busy ? digest.runStartSeq : digest.lastSeq;
        this._contexts.set(key, { sessionFile, seenSeq, research: [] });
        this._loadedKey = key;
        if (resumed) {
            this._refreshUsage(llm);
        } else {
            this._usage = undefined;
        }
        this._options.onChange?.();
        return { key, fresh: true };
    }

    /** Reads the loaded context's totals from omp in the background; the voice panel shows them. */
    private _refreshUsage(llm: VoiceLlm): void {
        llm.usage().then(
            (usage) => {
                this._usage = usage;
                this._options.onChange?.();
            },
            (err: unknown) => this._options.log(`Could not read the voice context's token usage: ${err instanceof Error ? err.message : String(err)}`),
        );
    }

    /** A research job belongs to the voice context whose turn started it; its result goes to that context. */
    private _startResearch(tabId: string, question: string): ResearchJob {
        const key = this._turn?.key;
        const context = key === undefined ? undefined : this._contexts.get(key);
        if (!context) {
            throw new Error('No voice turn is running');
        }
        const model = this._options.model || this._options.worker.activeTask()?.model;
        const job = this._research.start(question, model, (done) => {
            const seconds = Math.round(((done.finishedAt ?? Date.now()) - done.startedAt) / 1000);
            this._options.log(
                done.status === 'done'
                    ? `Research ${done.id} finished after ${seconds}s (${question}).`
                    : `Research ${done.id} failed after ${seconds}s: ${done.result}`,
            );
            this._options.onChange?.();
            this._maybeProactive();
        });
        context.research.push(job);
        const shown = [...(this._researchShown.get(tabId) ?? []), job].slice(-RESEARCH_SHOWN);
        this._researchShown.set(tabId, shown);
        this._options.log(`Research ${job.id} started for ${tabId}: ${question}`);
        return job;
    }

    private _digest(tabId: string): WorkerDigest {
        let digest = this._digests.get(tabId);
        if (!digest) {
            digest = new WorkerDigest();
            this._digests.set(tabId, digest);
        }
        return digest;
    }
}
