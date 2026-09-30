import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { VoiceSessionSummary } from '../pi/sessionCatalog';
import type {
    VoiceEntry,
    VoiceHearing,
    VoiceLatency,
    VoiceObservationKind,
    VoiceSentence,
    VoiceSpeechCall,
    VoiceSpeechUsage,
    VoiceToolEntry,
    VoiceToolResearch,
} from '../shared/voiceViewProtocol';
import type { Metrics } from './conversation';
import type { ResearchJob } from './research';
import type { VoiceTurnListener, VoiceTurnResult } from './voiceAgent';
import type { ReplyAudioEvent } from './voiceMode';
import { provisionalTaskKey, taskKey } from './workerController';

type AssistantEntry = Extract<VoiceEntry, { kind: 'assistant' }>;
type BoundTask = { tabId: string; sessionFile?: string; name: string };

/** One task's voice conversation: one voice context of the voice agent (design §11.4). */
export interface VoiceSessionRecord {
    id: string;
    taskKey: string;
    title: string;
    startedAt: number;
    updatedAt: number;
    entries: VoiceEntry[];
    /** The omp session file holding the voice agent's context for this conversation, once it has one. */
    voiceSessionFile?: string;
    /** `title` names the task's worker session: generated from what the user said, or set by the user. */
    named?: 'auto' | 'user';
    /** What voice mode sent to STT and TTS in this conversation. */
    speech?: VoiceSpeechUsage;
}

/** The slice of `vscode.Memento` the store needs. */
export interface TranscriptMemento {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

export interface TranscriptLimits {
    /** Sessions kept per workspace (`voiceAgent.historySessions`). */
    sessions: () => number;
    /** Entries kept per session; older ones drop off. */
    entries: number;
}

const STORAGE_KEY = 'voiceAgent.transcripts';
const SAVE_DELAY_MS = 1000;
/** A lookup's result is kept up to this many characters: the transcript is saved in workspace state. */
const LOOKUP_RESULT_CHARS = 8000;

/**
 * The voice panel's record of what was said, grouped by task: an entry per user turn, reply,
 * update and panel action, with each reply's sentences in the state playback left them.
 * Kept by the extension, not taken from omp's voice sessions; saved to workspace state. Each
 * conversation also names its omp voice session file, so the voice agent resumes a task's last
 * conversation when it starts again (design §5.12) and the transcript goes on with it.
 */
export class VoiceTranscriptStore {
    private _sessions: VoiceSessionRecord[];
    /** Live sessions of the current run by task key; a new run starts new ones or resumes the last. */
    private readonly _live = new Map<string, VoiceSessionRecord>();
    /** Sessions this extension host started; saved `tab:` keys from earlier windows name no tab now. */
    private readonly _started = new WeakSet<VoiceSessionRecord>();
    private readonly _replies = new Map<number, AssistantEntry>();
    /** The tool entry of each research job still running, filled in when it settles. */
    private readonly _research = new WeakMap<ResearchJob, VoiceToolEntry>();
    /** The last reply was cut off by the user's voice or typing: their next entry barged in. */
    private _bargeIn = false;
    private _saveTimer: NodeJS.Timeout | undefined;
    private readonly _listeners = new Set<() => void>();

    constructor(
        private readonly _memento: TranscriptMemento,
        private readonly _limits: TranscriptLimits,
        /** The task voice is bound to (design §5.12); entries go to its session. */
        private readonly _taskOf: () => BoundTask | undefined,
    ) {
        this._sessions = _memento.get<VoiceSessionRecord[]>(STORAGE_KEY) ?? [];
        // Ids once restarted at e1 with every extension host while a resumed conversation kept its
        // old entries: later ones repeating an id get their own, so each names one entry again.
        const seen = new Set<string>();
        for (const entry of this._sessions.flatMap((s) => s.entries)) {
            if (seen.has(entry.id)) {
                entry.id = this._id();
            }
            seen.add(entry.id);
            if (entry.kind === 'assistant') {
                reviveTools(entry);
            }
        }
    }

    onDidChange(listener: () => void): { dispose(): void } {
        this._listeners.add(listener);
        return { dispose: () => this._listeners.delete(listener) };
    }

    /** Newest first. */
    sessions(): readonly VoiceSessionRecord[] {
        return this._sessions;
    }

    /** The live session of the task voice is bound to; undefined before it has any entry this run. */
    current(): VoiceSessionRecord | undefined {
        return this._live.get(this._keyOf(this._taskOf()));
    }

    /** A task's sessions (the bound one by default), newest first, live or saved; other tasks' stay in `sessions()`. */
    taskSessions(task = this._taskOf()): VoiceSessionRecord[] {
        const key = this._keyOf(task);
        // Only a session file names the same task across windows: tab ids restart with the extension host.
        return this._sessions.filter((s) => s.taskKey === key && (key === task?.sessionFile || this._started.has(s)));
    }

    /** A task's last conversation while its voice context is still on disk: the voice agent picks it up again. */
    resumable(task = this._taskOf()): VoiceSessionRecord | undefined {
        const latest = this.taskSessions(task)[0];
        return latest?.voiceSessionFile && existsSync(latest.voiceSessionFile) ? latest : undefined;
    }

    savedContext(task: BoundTask): string | undefined {
        return this.resumable(task)?.voiceSessionFile;
    }

    /** The voice agent loaded the task's context: its conversation goes on in the live session. */
    bindContext(task: BoundTask, sessionFile: string, resumed: boolean): void {
        const session = this._liveSession(task);
        if (!resumed && session.voiceSessionFile !== undefined && session.voiceSessionFile !== sessionFile) {
            // Ahead of the reply waiting on this context: that reply is the first of the new one.
            const { entries } = session;
            let at = entries.length;
            while (at > 0 && entries[at - 1].kind === 'assistant' && !(entries[at - 1] as AssistantEntry).done) {
                at--;
            }
            entries.splice(at, 0, { kind: 'system', id: this._id(), at: Date.now(), text: 'The earlier conversation could not be restored; the voice agent starts over from here.' });
        }
        session.voiceSessionFile = sessionFile;
        this._changed();
    }

    /** Deletes voice session files in `dir` that no conversation names any more: dropped from history or never used. */
    async pruneContexts(dir: string): Promise<void> {
        const kept = new Set(this._sessions.flatMap((s) => (s.voiceSessionFile ? [path.basename(s.voiceSessionFile)] : [])));
        const names = await fs.readdir(dir).catch(() => []);
        await Promise.all(names.filter((name) => name.endsWith('.jsonl') && !kept.has(name)).map((name) => fs.rm(path.join(dir, name), { force: true })));
    }

    /**
     * Every worker session with a voice conversation in it, for the resume list: a session the user
     * only talked to the voice agent about has nothing else to show. Keyed by session file only, since
     * `tab:` keys name no tab in another window.
     */
    voiceSessions(): VoiceSessionSummary[] {
        const byFile = new Map<string, VoiceSessionSummary>();
        // Oldest first (`_sessions` is newest first), so on a tie the earlier conversation stays first.
        for (const session of [...this._sessions].reverse()) {
            if (session.taskKey.startsWith(provisionalTaskKey(''))) {
                continue;
            }
            const said = userTexts(session);
            if (said.length === 0) {
                continue;
            }
            const summary = byFile.get(session.taskKey);
            if (!summary) {
                byFile.set(session.taskKey, {
                    sessionFile: session.taskKey,
                    title: session.named ? session.title : undefined,
                    firstUtterance: said[0],
                    turns: said.length,
                    startedAt: session.startedAt,
                    updatedAt: session.updatedAt,
                });
                continue;
            }
            summary.turns += said.length;
            summary.title ??= session.named ? session.title : undefined;
            summary.updatedAt = Math.max(summary.updatedAt, session.updatedAt);
            if (session.startedAt < summary.startedAt) {
                summary.startedAt = session.startedAt;
                summary.firstUtterance = said[0];
            }
        }
        return [...byFile.values()];
    }

    /** What the user said in a worker session's voice conversations, oldest first. */
    userUtterances(sessionFile: string): string[] {
        return this._sessions
            .filter((s) => s.taskKey === sessionFile)
            .reverse()
            .sort((a, b) => a.startedAt - b.startedAt)
            .flatMap(userTexts);
    }

    isNamed(sessionFile: string): boolean {
        return this._sessions.some((s) => s.taskKey === sessionFile && s.named);
    }

    /**
     * Names a worker session's voice conversations; later ones for the task inherit it. A generated
     * name never replaces the user's. False when nothing was named.
     */
    nameTask(sessionFile: string, title: string, by: 'auto' | 'user'): boolean {
        const sessions = this._sessions.filter((s) => s.taskKey === sessionFile);
        if (sessions.length === 0 || (by === 'auto' && sessions.some((s) => s.named === 'user'))) {
            return false;
        }
        for (const session of sessions) {
            session.title = title;
            session.named = by;
        }
        this._changed();
        return true;
    }

    /** The worker session was deleted: its voice conversations go too, and their contexts with the next prune. */
    forgetTask(sessionFile: string): void {
        this._sessions = this._sessions.filter((s) => s.taskKey !== sessionFile);
        this._live.delete(sessionFile);
        this._changed();
    }

    isLive(session: VoiceSessionRecord): boolean {
        return this._live.get(session.taskKey) === session;
    }

    /** The voice agent stopped: the next entries start new sessions or resume the last ones. */
    endRun(): void {
        // A context loaded for an update that then had nothing to say left an empty conversation.
        const empty = new Set([...this._live.values()].filter((s) => s.entries.length === 0));
        this._sessions = this._sessions.filter((s) => !empty.has(s));
        this._live.clear();
        this._replies.clear();
        this._bargeIn = false;
        this.flush();
    }

    /** `metrics`: voice mode's timestamps as the turn went out, for how long hearing it took. */
    addUser(text: string, source: 'stt' | 'text' | 'panel', metrics?: Metrics): void {
        const bargeIn = this._bargeIn && source !== 'panel';
        this._bargeIn = false;
        const latency =
            source === 'stt' && metrics
                ? measured<VoiceHearing>({ endOfTurn: span(metrics.silenceAt, metrics.endDetectedAt), stt: span(metrics.endDetectedAt, metrics.sttDoneAt) })
                : undefined;
        this._push({ kind: 'user', id: this._id(), at: Date.now(), text, source, ...(bargeIn ? { bargeIn } : {}), ...(latency ? { latency } : {}) });
    }

    addSystem(text: string): void {
        this._push({ kind: 'system', id: this._id(), at: Date.now(), text });
    }

    /**
     * A reply starting: returns the listener that fills it in. `turnId` (voice mode) receives the
     * reply's audio events; a proactive reply learns its id later through `bindTurn`.
     */
    beginReply(options: { proactive?: VoiceObservationKind; turnId?: number } = {}): { listener: VoiceTurnListener; bindTurn(turnId: number | undefined): void } {
        const entry: AssistantEntry = {
            kind: 'assistant',
            id: this._id(),
            at: Date.now(),
            ...(options.proactive ? { proactive: options.proactive } : {}),
            text: '',
            tools: [],
            done: false,
        };
        const session = this._push(entry);
        const bindTurn = (turnId: number | undefined) => {
            if (turnId !== undefined) {
                entry.sentences = [];
                this._replies.set(turnId, entry);
            }
        };
        bindTurn(options.turnId);
        const listener: VoiceTurnListener = {
            onPrompt: (message) => {
                entry.input = message;
                this._changed();
            },
            onText: (delta) => {
                entry.text += delta;
                this._changed();
            },
            onToolCall: (name, args, result) => {
                const tool: VoiceToolEntry = { name, args, result: result.text, isError: result.isError };
                if (result.research) {
                    tool.research = researchState(result.research);
                    if (result.research.status === 'running') {
                        this._research.set(result.research, tool);
                    }
                }
                entry.tools.push(tool);
                this._changed();
            },
            onLookup: ({ id, name, args }) => {
                entry.tools.push({ id, name, args, result: '', isError: false, running: true });
                this._changed();
            },
            onLookupEnd: (id, result) => {
                const tool = entry.tools.find((t) => t.running && t.id === id);
                if (!tool) {
                    return;
                }
                delete tool.running;
                const { text } = result;
                tool.result = text.length > LOOKUP_RESULT_CHARS ? `${text.slice(0, LOOKUP_RESULT_CHARS)}\n… ${text.length - LOOKUP_RESULT_CHARS} more characters not kept` : text;
                tool.isError = result.isError;
                this._changed();
            },
            onUsage: (usage) => {
                (entry.usage ??= []).push(usage);
                this._changed();
            },
            onEnd: (result) => this._endReply(session, entry, result),
        };
        return { listener, bindTurn };
    }

    /** A research job settled: its call's entry shows the findings. */
    researchSettled(job: ResearchJob): void {
        const tool = this._research.get(job);
        if (!tool) {
            return;
        }
        this._research.delete(job);
        tool.research = researchState(job);
        this._changed();
    }

    /** The entry of voice mode reply `turnId`, until it is cut off or voice mode ends. */
    entryIdOfTurn(turnId: number): string | undefined {
        return this._replies.get(turnId)?.id;
    }

    /** Voice mode playback of a reply. */
    audio(event: ReplyAudioEvent): void {
        const entry = this._replies.get(event.turnId);
        const sentences = entry?.sentences;
        if (!entry || !sentences) {
            return;
        }
        switch (event.type) {
            case 'speak':
                sentences.push({ text: event.text, state: 'pending' });
                break;
            case 'playing':
                setFirst(sentences, event.text, ['pending'], 'playing');
                break;
            case 'played':
                setFirst(sentences, event.text, ['playing', 'pending'], 'played');
                break;
            case 'idle':
                // Sentences that never played (TTS failed) were not heard.
                cutUnheard(sentences);
                break;
            case 'cut':
                cutUnheard(sentences);
                entry.interrupted = true;
                this._bargeIn = event.by === 'user';
                this._replies.delete(event.turnId);
                break;
        }
        this._changed();
    }

    /** Voice mode: an exchange finished playing or was cut off; `metrics` are its epoch-ms timestamps. */
    metrics(turnId: number, metrics: Metrics): void {
        const entry = this._replies.get(turnId);
        if (!entry) {
            return;
        }
        entry.latency = measured<VoiceLatency>({
            llmFirstText: span(metrics.promptAt, metrics.firstTextAt),
            llmTotal: span(metrics.promptAt, metrics.llmDoneAt),
            ttsFirstAudio: span(metrics.firstSpeakAt, metrics.firstAudioAt),
            total: span(metrics.silenceAt ?? metrics.promptAt, metrics.firstAudioAt),
            cutOff: span(metrics.promptAt, metrics.cutAt),
        });
        this._changed();
    }

    /** Voice mode: one STT or TTS request returned; added to the live conversation's totals. */
    addSpeechUsage(call: VoiceSpeechCall): void {
        const speech = (this._liveSession().speech ??= {});
        if (call.service === 'stt') {
            const stt = (speech.stt ??= { calls: 0, audioMs: 0 });
            stt.calls++;
            stt.audioMs += call.audioMs;
            if (call.input !== undefined) {
                stt.input = (stt.input ?? 0) + call.input;
            }
            if (call.output !== undefined) {
                stt.output = (stt.output ?? 0) + call.output;
            }
        } else {
            const tts = (speech.tts ??= { calls: 0, chars: 0, audioMs: 0 });
            tts.calls++;
            tts.chars += call.chars;
            tts.audioMs += call.audioMs;
        }
        this._changed();
    }

    /** Writes pending changes now. */
    flush(): void {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = undefined;
        }
        void this._memento.update(STORAGE_KEY, this._sessions);
    }

    dispose(): void {
        this.flush();
        this._listeners.clear();
    }

    private _endReply(session: VoiceSessionRecord, entry: AssistantEntry, result: VoiceTurnResult): void {
        entry.done = true;
        if (result.silent) {
            entry.silent = true;
        }
        if (result.error) {
            entry.error = result.error;
        }
        if (result.interrupted) {
            entry.interrupted = true;
            if (entry.sentences) {
                cutUnheard(entry.sentences);
            }
        }
        // A lookup the cut-off run never finished.
        for (const tool of entry.tools) {
            delete tool.running;
        }
        // A proactive turn that lost the floor before saying or doing anything left nothing to show.
        if (entry.proactive && result.interrupted && !entry.text && entry.tools.length === 0) {
            session.entries = session.entries.filter((e) => e !== entry);
        }
        this._changed();
    }

    private _push(entry: VoiceEntry, session = this._liveSession()): VoiceSessionRecord {
        session.entries.push(entry);
        if (session.entries.length > this._limits.entries) {
            session.entries.splice(0, session.entries.length - this._limits.entries);
        }
        this._changed();
        return session;
    }

    /** The task's session this run: its resumable last one (the voice agent resumes that context too), else a new one. */
    private _liveSession(task = this._taskOf()): VoiceSessionRecord {
        const key = this._keyOf(task);
        let session = this._live.get(key);
        if (session) {
            return session;
        }
        session = this.resumable(task);
        if (session) {
            this._sessions = [session, ...this._sessions.filter((s) => s !== session)];
        } else {
            const now = Date.now();
            const named = this._sessions.find((s) => s.taskKey === key && s.named);
            session = { id: randomUUID(), taskKey: key, title: named?.title ?? (task?.name || 'Voice'), startedAt: now, updatedAt: now, entries: [] };
            if (named) {
                session.named = named.named;
            }
            this._started.add(session);
            this._sessions.unshift(session);
            this._sessions.splice(Math.max(1, this._limits.sessions()));
        }
        this._live.set(key, session);
        return session;
    }

    /**
     * Keyed like voice contexts (§5.12 rule 1): the worker session file, or the tab before it has
     * one. A tab that got its session file takes over what was said in it before, live or from an
     * earlier run of this extension host: same task.
     */
    private _keyOf(task: BoundTask | undefined): string {
        if (!task) {
            return '';
        }
        const key = taskKey(task);
        const provisional = provisionalTaskKey(task.tabId);
        if (key === provisional) {
            return key;
        }
        const early = this._live.get(provisional);
        if (early && !this._live.has(key)) {
            early.taskKey = key;
            this._live.delete(provisional);
            this._live.set(key, early);
        }
        let moved = false;
        for (const session of this._sessions) {
            if (session.taskKey === provisional && this._started.has(session)) {
                session.taskKey = key;
                moved = true;
            }
        }
        if (moved) {
            this._saveTimer ??= setTimeout(() => this.flush(), SAVE_DELAY_MS);
        }
        return key;
    }

    /**
     * Unique across extension hosts: a resumed conversation keeps its saved entries, and the Bot
     * view, the replay cache and the translations find an entry by its id.
     */
    private _id(): string {
        return randomUUID();
    }

    private _changed(save = true): void {
        if (save) {
            const session = this.current();
            if (session) {
                session.updatedAt = Date.now();
            }
            this._saveTimer ??= setTimeout(() => this.flush(), SAVE_DELAY_MS);
        }
        for (const listener of this._listeners) {
            listener();
        }
    }
}

/** What the user said in a conversation, spoken or typed; panel actions (approve, cancel) are not talk. */
function userTexts(session: VoiceSessionRecord): string[] {
    return session.entries.flatMap((e) => (e.kind === 'user' && e.source !== 'panel' ? [e.text] : []));
}

function researchState(job: ResearchJob): VoiceToolResearch {
    return {
        status: job.status,
        startedAt: job.startedAt,
        ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
        ...(job.result !== undefined ? { result: job.result } : {}),
    };
}

/**
 * A saved reply as this run shows it: nothing of an earlier run is still running, and lookups saved
 * as descriptions only (`lookups`, before they became tool entries) join its tools.
 */
function reviveTools(entry: AssistantEntry): void {
    const legacy: unknown = Reflect.get(entry, 'lookups');
    if (Array.isArray(legacy)) {
        Reflect.deleteProperty(entry, 'lookups');
        for (const description of legacy) {
            entry.tools.push({ name: 'lookup', args: { description: String(description) }, result: '', isError: false });
        }
    }
    for (const tool of entry.tools) {
        delete tool.running;
        if (tool.research?.status === 'running') {
            tool.research = { ...tool.research, status: 'failed', result: 'Stopped: the window closed before it finished.' };
        }
    }
}

/** Moves the first matching sentence to `to`. */
function setFirst(sentences: VoiceSentence[], text: string, from: VoiceSentence['state'][], to: VoiceSentence['state']): void {
    const sentence = sentences.find((s) => s.text === text && from.includes(s.state));
    if (sentence) {
        sentence.state = to;
    }
}

function cutUnheard(sentences: VoiceSentence[]): void {
    for (const sentence of sentences) {
        if (sentence.state === 'pending' || sentence.state === 'playing') {
            sentence.state = 'cut';
        }
    }
}

/** `from` → `to` in ms, when both were seen in that order. */
function span(from?: number, to?: number): number | undefined {
    return from !== undefined && to !== undefined && to >= from ? to - from : undefined;
}

/** The parts that were measured; undefined when none was. */
function measured<T extends object>(parts: T): T | undefined {
    const seen = Object.entries(parts).filter(([, ms]) => ms !== undefined);
    return seen.length > 0 ? (Object.fromEntries(seen) as T) : undefined;
}
