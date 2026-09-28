import * as vscode from 'vscode';
import type { VoiceEngines, VoiceEntry, VoicePhase, VoiceTranslation, VoiceViewClientMessage, VoiceViewHostMessage, VoiceViewState } from '../shared/voiceViewProtocol';
import { translationLanguage } from '../shared/translationLanguages';
import { describeError } from '../voice/modelsProbe';
import { Translator, TranslationError } from './googleTranslate';
import { BotViewAudio, type ReplayPlayer } from './replay';
import { affectsSpeakers, resolveSpeakers } from './speakers';
import type { VoiceTranscriptStore, VoiceSessionRecord } from './transcriptStore';
import type { VoiceAgent } from './voiceAgent';
import type { WorkerController } from './workerController';

/** Snapshots are coalesced: a streaming reply changes the transcript many times a second. */
const REFRESH_MS = 50;
const WORKER_RECENT = 4;

/** What the Bot view needs from voice mode, implemented by the voice agent commands. */
export interface VoiceViewController {
    phase(): VoicePhase;
    mode(): 'omp' | 'pair';
    engines(): VoiceEngines;
    /** The voice agent when it is running; cards and usage that need it are empty otherwise. */
    agent(): VoiceAgent | undefined;
    /** Alt+click on a sentence: reads it aloud. */
    readonly replay: ReplayPlayer;
}

/**
 * Where the Bot view is drawn: a chat tab shows it in place of its conversation (the tab's icon
 * toggles it). Implemented by the chat sidebar.
 */
export interface BotViewSurface {
    readonly onDidReceiveVoiceMessage: vscode.Event<VoiceViewClientMessage>;
    /** The Bot view came into or went out of sight: tab switch, toggle, sidebar shown or hidden. */
    readonly onDidChangeBotViewVisibility: vscode.Event<void>;
    isBotViewVisible(): boolean;
    postVoice(message: VoiceViewHostMessage): void;
    /** Shows the Bot view in the active tab and reveals the chat. */
    showBotView(preserveFocus: boolean, options?: { onlyIfWorkerUnused?: boolean }): Promise<void>;
}

/**
 * The Bot view's content (docs/voice-agent-design.md §11): the engines voice mode uses, the voice
 * context's token use, the voice conversation of the task voice is bound to and its cards. The view
 * replaces a chat tab's conversation and only shows; everything typed goes through the chat's
 * composer. This side owns the snapshots, the session shown and the card actions.
 */
export class VoicePanel implements vscode.Disposable {
    /** A past session picked from history; undefined follows the live one. */
    private _pinned: string | undefined;
    private _refreshTimer: NodeJS.Timeout | undefined;
    /** The last snapshot posted, serialized; an identical one is not posted again. */
    private _posted: string | undefined;
    /** Likewise the last `sentenceActions`, which goes to the whole webview (the chat has the gestures too). */
    private _postedSentences: string | undefined;
    /** The names and avatars, once resolved (image files read), and the last of them posted (by identity: a picture is large). */
    private _speakers: VoiceViewHostMessage | undefined;
    private _postedSpeakers: VoiceViewHostMessage | undefined;
    /** Bumped per load, so a slower earlier load does not overwrite a newer one. */
    private _speakersLoad = 0;
    private readonly _disposables: vscode.Disposable[] = [];
    /** Replay without voice mode plays in the view itself. */
    readonly audio: BotViewAudio;
    private readonly _translator = new Translator();
    /** Sentence translations being fetched, by the view's request id. */
    private readonly _translating = new Map<number, AbortController>();

    constructor(
        private readonly _store: VoiceTranscriptStore,
        private readonly _worker: WorkerController,
        private readonly _controller: VoiceViewController,
        private readonly _view: BotViewSurface,
    ) {
        this.audio = new BotViewAudio((message) => _view.postVoice(message));
        this._disposables.push(
            _view.onDidReceiveVoiceMessage((message) => this._onMessage(message)),
            // Hidden (retained) webviews drop messages: bring the view up to date when it shows.
            _view.onDidChangeBotViewVisibility(() => {
                this._posted = undefined;
                this._postedSentences = undefined;
                this._postedSpeakers = undefined;
                // Picks up an avatar picture edited on disk too.
                this._loadSpeakers();
                this.refresh();
            }),
            _store.onDidChange(() => this.refresh()),
            _worker.onActiveTaskChanged(() => {
                this._pinned = undefined;
                this.refresh();
            }),
            // Not the worker's tab events: the view does not draw the worker (the chat around it does).
            _worker.onRequestsChanged(() => this.refresh()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (affectsSpeakers(e)) {
                    this._loadSpeakers();
                }
                if (e.affectsConfiguration('oh-my-pi-chater.voiceAgent') || e.affectsConfiguration('oh-my-pi-chater.voice')) {
                    this.refresh();
                }
            }),
        );
        this._loadSpeakers();
    }

    private _loadSpeakers(): void {
        const load = ++this._speakersLoad;
        void resolveSpeakers().then(({ speakers }) => {
            if (load === this._speakersLoad) {
                this._speakers = { type: 'speakers', speakers };
                this.refresh();
            }
        });
    }

    /** Reveals the Bot view. */
    show(preserveFocus = false): Promise<void> {
        return this._view.showBotView(preserveFocus);
    }

    /** History: pick a past session to read, or go back to the live one; the active task's come first. */
    async pickSession(): Promise<void> {
        type Item = vscode.QuickPickItem & { id?: string };
        const current = this._store.current();
        const items: Item[] = [];
        if (current) {
            items.push({ label: `$(circle-filled) ${current.title}`, description: 'Current', detail: summary(current), id: undefined });
        }
        const task = this._store.taskSessions().filter((s) => s !== current);
        const others = this._store.sessions().filter((s) => s !== current && !task.includes(s));
        for (const [label, sessions] of [
            ['This task', task],
            ['Other tasks', others],
        ] as const) {
            if (sessions.length > 0) {
                items.push({ label, kind: vscode.QuickPickItemKind.Separator });
            }
            for (const session of sessions) {
                items.push({ label: session.title, description: formatWhen(session.startedAt), detail: summary(session), id: session.id });
            }
        }
        if (items.length === 0) {
            void vscode.window.showInformationMessage('No voice sessions yet.');
            return;
        }
        const picked = await vscode.window.showQuickPick(items, { title: 'Voice sessions', placeHolder: 'Pick a session to read' });
        if (picked) {
            this._pinned = picked.id;
            this.refresh();
            await this.show(true);
        }
    }

    refresh(): void {
        this._refreshTimer ??= setTimeout(() => {
            this._refreshTimer = undefined;
            const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent');
            const sentences: VoiceViewHostMessage = {
                type: 'sentenceActions',
                enabled: config.get<boolean>('messageButtons', false),
                translateTo: translationLanguage(config.get<string>('translateTo')).code,
                replay: this._controller.replay.current,
            };
            const postedSentences = JSON.stringify(sentences);
            if (postedSentences !== this._postedSentences) {
                this._postedSentences = postedSentences;
                this._view.postVoice(sentences);
            }
            if (this._speakers && this._speakers !== this._postedSpeakers) {
                this._postedSpeakers = this._speakers;
                this._view.postVoice(this._speakers);
            }
            // Off screen: nothing to draw; coming into view refreshes.
            if (!this._view.isBotViewVisible()) {
                this._posted = undefined;
                return;
            }
            const state = this.snapshot();
            // Not drawn, and its elapsed time would make every snapshot differ.
            delete state.worker;
            const posted = JSON.stringify(state);
            if (posted !== this._posted) {
                this._posted = posted;
                this._view.postVoice({ type: 'state', state });
            }
        }, REFRESH_MS);
    }

    dispose(): void {
        clearTimeout(this._refreshTimer);
        for (const ctl of this._translating.values()) {
            ctl.abort();
        }
        for (const d of this._disposables) {
            d.dispose();
        }
    }

    /** What the view shows now (also a scriptable command for tests). */
    snapshot(): VoiceViewState {
        const { live, session } = this._shownSession();
        const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent');
        const debug = config.get<boolean>('debugTranscript', false);
        const agent = this._controller.agent();
        const state: VoiceViewState = {
            phase: this._controller.phase(),
            mode: this._controller.mode(),
            engines: this._controller.engines(),
            usage: live ? agent?.usage : undefined,
            session: session
                ? { id: session.id, title: session.title, startedAt: session.startedAt, readonly: !live }
                : { id: '', title: 'Voice', startedAt: 0, readonly: false },
            entries: session?.entries ?? [],
            proposals: [],
            research: [],
            requests: [],
            debug,
        };
        const task = this._worker.activeTask();
        if (!live || !task) {
            return state;
        }
        const status = this._worker.status(task.tabId);
        state.worker = {
            tabId: task.tabId,
            name: task.name,
            model: task.model,
            phase: status.phase,
            elapsedMs: status.elapsedMs,
            queued: status.queued,
            error: status.error,
            recent: (agent?.recentActivity(task.tabId, WORKER_RECENT) ?? []).map(({ at, text }) => ({ at, text })),
        };
        state.requests = this._worker.pendingRequests(task.tabId).map((r) => ({
            tabId: task.tabId,
            id: r.id,
            method: r.method,
            title: r.title,
            message: r.message,
            options: r.options,
        }));
        if (agent) {
            state.proposals = agent.proposals(task.tabId).map(({ id, message }) => ({ id, message }));
            state.research = agent.researchJobs(task.tabId).map(({ id, question, status: jobStatus, startedAt, finishedAt }) => ({
                id,
                question,
                status: jobStatus,
                startedAt,
                finishedAt,
            }));
        }
        return state;
    }

    /** The pinned past session, else the active task's live one, else its newest saved (read-only). */
    private _shownSession(): { session: VoiceSessionRecord | undefined; live: boolean } {
        const pinned = this._pinned === undefined ? undefined : this._store.sessions().find((s) => s.id === this._pinned);
        // Before anything is said this run, the task's last conversation is live when voice will resume it.
        const live = this._store.current() ?? (this._controller.phase() !== 'off' ? this._store.resumable() : undefined);
        if (pinned && pinned !== live) {
            return { session: pinned, live: false };
        }
        if (live) {
            return { session: live, live: true };
        }
        // Nothing said yet for this task in this run: an empty live view.
        if (this._controller.phase() !== 'off') {
            return { session: undefined, live: true };
        }
        // Other tasks' conversations stay in history.
        const latest = this._store.taskSessions()[0];
        return latest ? { session: latest, live: this._store.isLive(latest) } : { session: undefined, live: true };
    }

    /** Whether the view shows `entryId` as a user turn or reply (not a setting line). */
    private _showsEntry(entryId: string): boolean {
        const entry = this._shownSession().session?.entries.find((e) => e.id === entryId);
        return entry !== undefined && entry.kind !== 'system';
    }

    /** Alt+right-click: a sentence into `to`, posted back for `requestId`; nothing once the panel is disposed. */
    private async _translate(requestId: number, text: string, to: string): Promise<void> {
        const ctl = new AbortController();
        this._translating.set(requestId, ctl);
        let result: VoiceTranslation;
        try {
            result = await this._translator.translate(text, translationLanguage(to).code, ctl.signal);
        } catch (err) {
            result = { error: err instanceof TranslationError ? err.message : `Translation failed: ${describeError(err)}` };
        } finally {
            this._translating.delete(requestId);
        }
        if (!ctl.signal.aborted) {
            this._view.postVoice({ type: 'translation', requestId, result });
        }
    }

    private _onMessage(message: VoiceViewClientMessage): void {
        switch (message.type) {
            case 'ready':
                // A fresh webview has nothing drawn yet.
                this._posted = undefined;
                this._postedSentences = undefined;
                this._postedSpeakers = undefined;
                this.refresh();
                return;
            case 'history':
                void this.pickSession();
                return;
            case 'replay': {
                const { entryId, piece } = message;
                if (message.surface === 'bot' && !this._showsEntry(entryId)) {
                    this._view.postVoice({ type: 'replayError', message: 'This message is no longer shown.' });
                    return;
                }
                void this._controller.replay.toggle(entryId, piece);
                return;
            }
            case 'replayClipStarted':
                this.audio.clipStarted(message.clipId);
                return;
            case 'replayClipEnded':
                this.audio.clipEnded(message.clipId);
                return;
            case 'translate':
                void this._translate(message.requestId, message.text, message.to);
                return;
            case 'proposal': {
                const agent = this._controller.agent();
                const proposal = agent?.proposals(this._worker.activeTask()?.tabId ?? '').find((p) => p.id === message.id);
                if (!agent || !proposal) {
                    this.refresh();
                    return;
                }
                if (message.action === 'cancel') {
                    agent.cancelProposal(message.id);
                    this._store.addUser(`Cancelled the proposed task: ${proposal.message}`, 'panel');
                    return;
                }
                this._store.addUser(`Confirmed the proposed task: ${proposal.message}`, 'panel');
                agent.confirmProposal(message.id).then(
                    (outcome) => this._store.addSystem(outcome),
                    (err: unknown) => this._store.addSystem(`Could not send it: ${err instanceof Error ? err.message : String(err)}`),
                );
                return;
            }
        }
    }
}

function summary(session: VoiceSessionRecord): string {
    const said = session.entries.filter((e): e is Extract<VoiceEntry, { kind: 'user' }> => e.kind === 'user');
    const last = said[said.length - 1]?.text ?? '';
    return `${session.entries.length} entries${last ? ` · ${last.slice(0, 80)}` : ''}`;
}

function formatWhen(at: number): string {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
