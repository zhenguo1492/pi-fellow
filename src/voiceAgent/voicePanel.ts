import * as vscode from 'vscode';
import type { VoiceEngines, VoiceEntry, VoicePhase, VoiceViewClientMessage, VoiceViewState } from '../shared/voiceViewProtocol';
import type { VoiceTranscriptStore, VoiceSessionRecord } from './transcriptStore';
import type { VoiceAgent } from './voiceAgent';
import type { VoicePanelView } from './voicePanelView';
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
}

/**
 * The Bot view's content (docs/voice-agent-design.md §11): the engines voice mode uses, the voice
 * context's token use, the voice conversation of the task voice is bound to and its cards. The view
 * lives in the bottom panel next to Terminal and only shows; everything typed goes through the
 * chat's composer. This side owns the snapshots, the session shown and the card actions.
 */
export class VoicePanel implements vscode.Disposable {
    /** A past session picked from history; undefined follows the live one. */
    private _pinned: string | undefined;
    private _refreshTimer: NodeJS.Timeout | undefined;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _store: VoiceTranscriptStore,
        private readonly _worker: WorkerController,
        private readonly _controller: VoiceViewController,
        private readonly _view: VoicePanelView,
    ) {
        this._disposables.push(
            _view.onDidReceiveVoiceMessage((message) => this._onMessage(message)),
            // Hidden (retained) webviews drop messages: bring the view up to date when it shows.
            _view.onDidChangeVisibility(() => this.refresh()),
            _store.onDidChange(() => this.refresh()),
            _worker.onActiveTaskChanged(() => {
                this._pinned = undefined;
                this.refresh();
            }),
            _worker.onRequestsChanged(() => this.refresh()),
            _worker.onTabEvent(() => this.refresh()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('oh-my-pi-chater.voiceAgent') || e.affectsConfiguration('oh-my-pi-chater.voice')) {
                    this.refresh();
                }
            }),
        );
    }

    /** Reveals the Bot view. */
    show(preserveFocus = false): Promise<void> {
        return this._view.reveal(preserveFocus);
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
            // Off screen: nothing to draw; coming into view refreshes.
            if (this._view.isVisible()) {
                this._view.postVoice({ type: 'state', state: this.snapshot() });
            }
        }, REFRESH_MS);
    }

    dispose(): void {
        clearTimeout(this._refreshTimer);
        for (const d of this._disposables) {
            d.dispose();
        }
    }

    /** What the view shows now (also a scriptable command for tests). */
    snapshot(): VoiceViewState {
        const { live, session } = this._shownSession();
        const debug = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent').get<boolean>('debugTranscript', false);
        const agent = this._controller.agent();
        const state: VoiceViewState = {
            phase: this._controller.phase(),
            mode: this._controller.mode(),
            engines: this._controller.engines(),
            usage: live ? agent?.usage : undefined,
            session: session
                ? { id: session.id, title: session.title, startedAt: session.startedAt, readonly: !live }
                : { id: '', title: 'Voice', startedAt: Date.now(), readonly: false },
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

    private _onMessage(message: VoiceViewClientMessage): void {
        switch (message.type) {
            case 'ready':
                this.refresh();
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
