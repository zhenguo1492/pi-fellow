import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { cliCommand, getAgentLayout, piCliChildEnv, resolvePiCliInvocation } from '../pi/piCliPaths';
import {
    fetchPiProviderUsage,
    parseOmpUsage,
    ProviderUsageTracker,
    statusBarWindows,
    usageDetails,
    type ProviderAccountUsage,
    type UsageTarget,
} from '../pi/providerUsage';
import type { PiAgentEvent } from '../pi/rpcTypes';
import type { PiChatSession } from '../pi/slashCommands';
import type { ModelStatusInfo } from '../shared/protocol';

const execFileAsync = promisify(execFile);

/** Background poll so reset countdowns and usage from other clients stay current while idle. */
const USAGE_POLL_MS = 5 * 60_000;

/** omp owns multi-provider usage (token refresh, multi-account); pi gets a direct OAuth fetch. */
async function fetchUsage(target: UsageTarget): Promise<ProviderAccountUsage[] | null> {
    if (target.backend === 'pi') {
        return fetchPiProviderUsage(getAgentLayout('pi').agentDir, target.provider);
    }
    const invocation = await resolvePiCliInvocation('omp');
    const [command, argv] = cliCommand(invocation, ['usage', '--json', '--provider', target.provider]);
    const { stdout } = await execFileAsync(command, argv, {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: piCliChildEnv(invocation),
    });
    const accounts = parseOmpUsage(JSON.parse(stdout));
    return accounts.length > 0 ? accounts : null;
}

const REFRESH_EVENTS: Partial<Record<PiAgentEvent['type'], true>> = {
    agent_start: true,
    agent_end: true,
    message_end: true,
    turn_end: true,
    context_usage: true,
    auto_retry_start: true,
    auto_retry_end: true,
    model_change: true,
};

/**
 * The active tab's model status (model, context use, provider plan limits), which the chat shows
 * over its conversation. Follows one session; `SidebarProvider` switches it with the active tab.
 */
export class ModelStatusTracker implements vscode.Disposable {
    private _session: PiChatSession;
    private _unsubscribe: (() => void) | undefined;
    private _status!: ModelStatusInfo;
    private readonly _changed = new vscode.EventEmitter<ModelStatusInfo>();
    readonly onDidChange = this._changed.event;
    private readonly _usage = new ProviderUsageTracker(fetchUsage, () => this._update());
    private readonly _usagePoll = setInterval(() => this._usage.refresh(), USAGE_POLL_MS);

    constructor(session: PiChatSession) {
        this._session = session;
        this._subscribe();
        this._update();
    }

    get status(): ModelStatusInfo {
        return this._status;
    }

    refresh(): void {
        this._update();
    }

    setSession(session: PiChatSession): void {
        if (!session) return;
        if (this._session !== session) {
            this._unsubscribe?.();
            this._session = session;
            this._subscribe();
        }
        this._update();
    }

    private _subscribe(): void {
        this._unsubscribe = this._session.events.onAll((event) => {
            if (REFRESH_EVENTS[event.type]) {
                this._update();
            }
            if (event.type === 'agent_end') {
                this._usage.refresh();
            }
        });
    }

    private _update(): void {
        const session = this._session;
        const model = session.getCurrentModel();
        const agentSession = session.session;
        const retrying = agentSession?.isRetrying ?? false;
        this._usage.setTarget(model?.provider ? { backend: session.backend, provider: model.provider } : undefined);
        const snapshot = this._usage.snapshot;
        this._status = {
            model: model ? (model.name ?? model.id) : undefined,
            activity: retrying ? 'retrying' : agentSession?.isStreaming ? 'streaming' : 'idle',
            retryAttempt: retrying ? (agentSession?.retryAttempt ?? 0) : 0,
            context: agentSession?.getContextUsage(),
            tokens: session.getSessionTokenStats(),
            thinking: session.getThinkingLevel(),
            limits: snapshot && model ? statusBarWindows(snapshot.accounts, model.id) : [],
            usage: snapshot ? usageDetails(snapshot) : [],
            usageError: snapshot?.error,
        };
        this._changed.fire(this._status);
    }

    dispose(): void {
        this._unsubscribe?.();
        clearInterval(this._usagePoll);
        this._changed.dispose();
    }
}
