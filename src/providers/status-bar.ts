import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { cliCommand, getAgentLayout, piCliChildEnv, resolvePiCliInvocation } from '../pi/piCliPaths';
import {
    fetchPiProviderUsage,
    formatUsageTooltip,
    parseOmpUsage,
    ProviderUsageTracker,
    statusBarWindows,
    type ProviderAccountUsage,
    type UsageTarget,
} from '../pi/providerUsage';
import type { PiAgentEvent } from '../pi/rpcTypes';
import type { PiChatSession } from '../pi/slashCommands';

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

export class StatusBarManager implements vscode.Disposable {
    private _item: vscode.StatusBarItem;
    private _session: PiChatSession;
    private _unsubscribe: (() => void) | undefined;
    private readonly _usage = new ProviderUsageTracker(fetchUsage, () => this._update());
    private readonly _usagePoll = setInterval(() => this._usage.refresh(), USAGE_POLL_MS);

    constructor(session: PiChatSession) {
        this._session = session;
        this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this._item.command = 'oh-my-pi-chater.selectModel';
        this._subscribe();
        this._update();
        this._item.show();
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
        const isRetrying = agentSession?.isRetrying ?? false;
        const isStreaming = (agentSession?.isStreaming ?? false) || isRetrying;
        const icon = isRetrying ? '$(sync~spin)' : isStreaming ? '$(loading~spin)' : '$(hubot)';
        const name = model ? (model.name ?? model.id) : 'No model';
        const retrySuffix =
            isRetrying && agentSession && agentSession.retryAttempt > 0
                ? ` (reconnecting ${agentSession.retryAttempt})`
                : '';
        const usage = agentSession?.getContextUsage?.();
        const percent =
            typeof usage?.percent === 'number' && !Number.isNaN(usage.percent)
                ? Math.round(usage.percent)
                : undefined;

        this._usage.setTarget(model?.provider ? { backend: session.backend, provider: model.provider } : undefined);
        const snapshot = this._usage.snapshot;
        const limitWindows = snapshot && model ? statusBarWindows(snapshot.accounts, model.id) : [];
        const limitText = limitWindows.map((w) => ` · ${w.text} ${Math.round(w.usedPercent)}%`).join('');
        const maxUsed = Math.max(0, ...limitWindows.map((w) => w.usedPercent));
        this._item.backgroundColor =
            maxUsed >= 100
                ? new vscode.ThemeColor('statusBarItem.errorBackground')
                : maxUsed >= 90
                  ? new vscode.ThemeColor('statusBarItem.warningBackground')
                  : undefined;
        this._item.text = `${icon} ${name}${percent !== undefined ? ` · ctx ${percent}%` : ''}${limitText}${retrySuffix}`;

        const tooltip: string[] = [`Model: ${name}`];
        if (usage) {
            if (usage.tokens !== null) {
                tooltip.push(
                    `Context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`,
                );
            }
            if (percent !== undefined) {
                tooltip.push(`Context used: ${percent}%`);
            }
        }
        const tokens = session.getSessionTokenStats();
        if (tokens) {
            tooltip.push(`Session in/out: ${tokens.input.toLocaleString()} / ${tokens.output.toLocaleString()}`);
            if (tokens.cacheRead > 0 || tokens.cacheWrite > 0) {
                tooltip.push(
                    `Cache read/write: ${tokens.cacheRead.toLocaleString()} / ${tokens.cacheWrite.toLocaleString()}`,
                );
            }
            if (tokens.cost > 0) {
                tooltip.push(`Cost: $${tokens.cost.toFixed(4)}`);
            }
        }
        const thinking = session.getThinkingLevel();
        if (thinking) {
            tooltip.push(`Thinking: ${thinking}`);
        }
        if (snapshot) {
            tooltip.push(...formatUsageTooltip(snapshot));
        }
        this._item.tooltip = tooltip.join('\n');
    }

    dispose(): void {
        this._unsubscribe?.();
        clearInterval(this._usagePoll);
        this._item.dispose();
    }
}
