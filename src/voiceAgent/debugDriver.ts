import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentCursor } from './agentCursor';
import type { DebugAction } from './hostTools';
import { cleanTerminalOutput, pickName } from './pairText';
import { clip } from './workerDigest';

/** Debug Console text kept per run, and runs kept. */
const MAX_CONSOLE_CHARS = 200_000;
const RUNS_KEPT = 5;
const STACK_FRAMES = 5;
const MAX_LOCALS = 25;
/** Lines of code shown around where it paused. */
const CONTEXT_LINES = 2;

/** The debug toolbar's buttons: they act on the session and thread the user sees in VS Code. */
const ACTION_COMMANDS: Record<DebugAction, string> = {
    continue: 'workbench.action.debug.continue',
    pause: 'workbench.action.debug.pause',
    stepOver: 'workbench.action.debug.stepOver',
    stepInto: 'workbench.action.debug.stepInto',
    stepOut: 'workbench.action.debug.stepOut',
    restart: 'workbench.action.debug.restart',
    stop: 'workbench.action.debug.stop',
};
/** Actions that need a paused program. */
const NEEDS_PAUSE: Partial<Record<DebugAction, true>> = { continue: true, stepOver: true, stepInto: true, stepOut: true };
/** Debug adapter requests after which a paused thread runs again; adapters need not say so with `continued`. */
const RESUMING: Record<string, true> = { continue: true, next: true, stepIn: true, stepOut: true, stepBack: true, reverseContinue: true, restartFrame: true, goto: true };

interface Stop {
    threadId?: number;
    reason: string;
    /** The exception message, for a pause on an exception. */
    text?: string;
}

/** One press of Run: a top-level session and the child sessions some adapters (js-debug) run the program in. */
interface DebugRun {
    root: vscode.DebugSession;
    console: string;
    exitCode?: number;
}

type DebugEvent = { kind: 'stopped'; session: vscode.DebugSession; stop: Stop } | { kind: 'ended'; root: vscode.DebugSession };

interface DapFrame {
    id: number;
    name: string;
    line: number;
    source?: { path?: string; name?: string };
}

/**
 * The voice agent at the debugger (docs/voice-pair-agent-cursor.md §12): starts the user's launch
 * configurations, presses the debug toolbar's buttons, sets breakpoints, and reads where the program
 * paused, which also becomes Pi's focus in the editor. Watches every debug session's adapter
 * messages, so it also knows about sessions the user started, and keeps their Debug Console text.
 */
export class DebugDriver implements vscode.Disposable {
    /** Oldest first. */
    private readonly _runs: DebugRun[] = [];
    /** Sessions paused now, and why. */
    private readonly _stops = new Map<vscode.DebugSession, Stop>();
    private readonly _events = new vscode.EventEmitter<DebugEvent>();
    private readonly _subscriptions: vscode.Disposable[];

    constructor(
        /** Relative paths are relative to it. */
        private readonly _root: string,
        private readonly _cursor: AgentCursor,
    ) {
        this._subscriptions = [
            this._events,
            vscode.debug.registerDebugAdapterTrackerFactory('*', { createDebugAdapterTracker: (session) => this._track(session) }),
            vscode.debug.onDidTerminateDebugSession((session) => {
                this._stops.delete(session);
                if (this._runs.some((run) => run.root === session)) {
                    this._events.fire({ kind: 'ended', root: session });
                }
            }),
        ];
    }

    dispose(): void {
        for (const subscription of this._subscriptions) {
            subscription.dispose();
        }
    }

    /** Debug Console text of each run that printed something, newest first. */
    consoles(): Array<{ name: string; text: string }> {
        return this._runs
            .filter((run) => run.console)
            .map((run) => ({ name: run.root.name, text: run.console }))
            .reverse();
    }

    /** Runs a launch configuration, and waits for it to pause or end. */
    async start(configuration: string | undefined, noDebug: boolean, timeoutMs: number): Promise<string> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        const launch = vscode.workspace.getConfiguration('launch', folder?.uri);
        const names = [...(launch.get<Array<{ name?: unknown }>>('configurations') ?? []), ...(launch.get<Array<{ name?: unknown }>>('compounds') ?? [])]
            .map((c) => c.name)
            .filter((name): name is string => typeof name === 'string');
        if (names.length === 0) {
            throw new Error('There is no launch configuration in .vscode/launch.json. Write one with edit_file, then start it.');
        }
        let name = names[0];
        if (configuration?.trim()) {
            const picked = pickName(names, configuration, 'launch configuration');
            if ('error' in picked) {
                throw new Error(picked.error);
            }
            name = picked.name;
        } else if (names.length > 1) {
            throw new Error(`There are several launch configurations: ${names.join(', ')}. Ask the user which one.`);
        }
        const before = new Set(this._runs.map((run) => run.root));
        const isNew = (session: vscode.DebugSession) => !before.has(rootOf(session));
        const outcome = this._next((e) => (e.kind === 'stopped' ? isNew(e.session) : isNew(e.root)), timeoutMs);
        if (!(await vscode.debug.startDebugging(folder, name, { noDebug }))) {
            outcome.cancel();
            throw new Error(`VS Code could not start ${name}; it shows why. read_output may say more.`);
        }
        const event = await outcome.event;
        const run = this._runs.findLast((r) => isNew(r.root));
        return `Started ${name}${noDebug ? ' without debugging' : ''}. ${await this._report(event, run, timeoutMs)}`;
    }

    /** Presses a debug toolbar button, and waits for the program to pause again or end. */
    async control(action: DebugAction, timeoutMs: number): Promise<string> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('Nothing is being debugged. Start it with debug_start.');
        }
        const root = rootOf(session);
        const run = this._runs.find((r) => r.root === root);
        const paused = this._pausedIn(root);
        if (action === 'stop') {
            const ended = this._next((e) => e.kind === 'ended' && e.root === root, timeoutMs);
            await vscode.commands.executeCommand(ACTION_COMMANDS.stop);
            return (await ended.event) ? `Stopped debugging ${root.name}.` : `Asked ${root.name} to stop; it has not ended yet.`;
        }
        if (action === 'pause' && paused) {
            return `Already paused. ${await this._describeStop(paused.session, paused.stop)}`;
        }
        if (NEEDS_PAUSE[action] && !paused) {
            throw new Error(`${root.name} is running, not paused: pause it or set a breakpoint first.`);
        }
        // A restart may start a new top-level session: any pause counts, and the old one ending does not.
        const next = this._next(
            (e) => (e.kind === 'stopped' ? action === 'restart' || rootOf(e.session) === root : action !== 'restart' && e.root === root),
            timeoutMs,
        );
        await vscode.commands.executeCommand(ACTION_COMMANDS[action]);
        return this._report(await next.event, run, timeoutMs);
    }

    async setBreakpoint(breakpoint: { path: string; line: number; condition?: string; remove: boolean }): Promise<string> {
        const uri = vscode.Uri.file(path.resolve(this._root, breakpoint.path));
        const where = `${vscode.workspace.asRelativePath(uri, false)}:${breakpoint.line}`;
        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(uri);
        } catch {
            throw new Error(`${breakpoint.path} does not exist.`);
        }
        if (breakpoint.line < 1 || breakpoint.line > document.lineCount) {
            throw new Error(`${vscode.workspace.asRelativePath(uri, false)} has ${document.lineCount} lines.`);
        }
        const here = vscode.debug.breakpoints.filter(
            (b): b is vscode.SourceBreakpoint =>
                b instanceof vscode.SourceBreakpoint && b.location.uri.fsPath === uri.fsPath && b.location.range.start.line === breakpoint.line - 1,
        );
        if (breakpoint.remove) {
            if (here.length === 0) {
                return `There was no breakpoint at ${where}. ${this._breakpoints()}`;
            }
            vscode.debug.removeBreakpoints(here);
            return `Removed the breakpoint at ${where}.`;
        }
        vscode.debug.removeBreakpoints(here);
        const condition = breakpoint.condition?.trim() || undefined;
        vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(breakpoint.line - 1, 0)), true, condition)]);
        await this._cursor.open({ path: uri.fsPath, startLine: breakpoint.line }).catch(() => undefined);
        return `Breakpoint at ${where}${condition ? ` when ${condition}` : ''}: ${clip(document.lineAt(breakpoint.line - 1).text, 200)}`;
    }

    /** Where the program is paused, with its stack and locals, and optionally an expression's value there. */
    async inspect(expression: string | undefined): Promise<string> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            return `Nothing is being debugged. ${this._breakpoints()}`;
        }
        const root = rootOf(session);
        const paused = this._pausedIn(root);
        if (!paused) {
            const run = this._runs.find((r) => r.root === root);
            const console = run?.console ? `\nDebug Console so far:\n${cleanTerminalOutput(run.console, 20, 2000)}` : '';
            return `${root.name} is running, not paused${expression ? ', so expressions cannot be evaluated' : ''}. ${this._breakpoints()}${console}`;
        }
        const report = await this._describeStop(paused.session, paused.stop);
        let value = '';
        if (expression?.trim()) {
            try {
                const frameId = (await this._frames(paused.session, paused.stop))[0]?.id;
                const result = (await paused.session.customRequest('evaluate', { expression, frameId, context: 'watch' })) as { result?: string };
                value = `\n${expression} = ${clip(result.result ?? '', 2000)}`;
            } catch (err) {
                value = `\n${expression}: ${err instanceof Error ? err.message : String(err)}`;
            }
        }
        return `${report}${value}\n${this._breakpoints()}`;
    }

    private _track(session: vscode.DebugSession): vscode.DebugAdapterTracker {
        const root = rootOf(session);
        let run = this._runs.find((r) => r.root === root);
        if (!run) {
            run = { root, console: '' };
            this._runs.push(run);
            if (this._runs.length > RUNS_KEPT) {
                this._runs.shift();
            }
        }
        const mine = run;
        return {
            onWillReceiveMessage: (message: { type?: string; command?: string }) => {
                if (message.type === 'request' && message.command && RESUMING[message.command]) {
                    this._stops.delete(session);
                }
            },
            onDidSendMessage: (message: { type?: string; event?: string; body?: Record<string, unknown> }) => {
                if (message.type !== 'event') {
                    return;
                }
                const body = message.body ?? {};
                switch (message.event) {
                    case 'output':
                        if (body.category !== 'telemetry' && typeof body.output === 'string') {
                            mine.console = (mine.console + body.output).slice(-MAX_CONSOLE_CHARS);
                        }
                        break;
                    case 'stopped': {
                        const stop: Stop = {
                            threadId: typeof body.threadId === 'number' ? body.threadId : undefined,
                            reason: typeof body.reason === 'string' ? body.reason : 'paused',
                            // `description` mostly restates the reason ("Paused on breakpoint"); `text` carries an exception's message.
                            text: typeof body.text === 'string' && body.text.trim() ? body.text : undefined,
                        };
                        this._stops.set(session, stop);
                        this._events.fire({ kind: 'stopped', session, stop });
                        break;
                    }
                    case 'continued':
                        this._stops.delete(session);
                        break;
                    case 'exited':
                        if (typeof body.exitCode === 'number') {
                            mine.exitCode = body.exitCode;
                        }
                        break;
                }
            },
        };
    }

    /** Listens from now on, so an event the caller's next action causes is not missed. */
    private _next(accept: (e: DebugEvent) => boolean, timeoutMs: number): { event: Promise<DebugEvent | undefined>; cancel(): void } {
        const { promise, resolve } = Promise.withResolvers<DebugEvent | undefined>();
        const done = (e: DebugEvent | undefined) => {
            clearTimeout(timer);
            subscription.dispose();
            resolve(e);
        };
        const timer = setTimeout(() => done(undefined), timeoutMs);
        const subscription = this._events.event((e) => {
            if (accept(e)) {
                done(e);
            }
        });
        return { event: promise, cancel: () => done(undefined) };
    }

    /** The paused session of a run: the one the user sees if it is paused. */
    private _pausedIn(root: vscode.DebugSession): { session: vscode.DebugSession; stop: Stop } | undefined {
        const active = vscode.debug.activeDebugSession;
        const activeStop = active && this._stops.get(active);
        if (active && activeStop && rootOf(active) === root) {
            return { session: active, stop: activeStop };
        }
        for (const [session, stop] of this._stops) {
            if (rootOf(session) === root) {
                return { session, stop };
            }
        }
        return undefined;
    }

    private async _report(event: DebugEvent | undefined, run: DebugRun | undefined, timeoutMs: number): Promise<string> {
        const console = (lines: number) => (run?.console ? `\nDebug Console:\n${cleanTerminalOutput(run.console, lines, 3000)}` : '');
        if (!event) {
            return `Still running after ${Math.round(timeoutMs / 1000)}s without pausing.${console(20)}`;
        }
        if (event.kind === 'stopped') {
            return this._describeStop(event.session, event.stop);
        }
        const exit = run?.exitCode === undefined ? '' : ` with exit code ${run.exitCode}`;
        return `It ran to the end${exit} without pausing.${console(40)}`;
    }

    private async _frames(session: vscode.DebugSession, stop: Stop): Promise<DapFrame[]> {
        let threadId = stop.threadId;
        if (threadId === undefined) {
            const { threads } = (await session.customRequest('threads')) as { threads?: Array<{ id: number }> };
            threadId = threads?.[0]?.id;
        }
        const { stackFrames } = (await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: STACK_FRAMES })) as { stackFrames?: DapFrame[] };
        return stackFrames ?? [];
    }

    /** Where it paused: the code around it, the call stack and the locals. The place becomes Pi's focus. */
    private async _describeStop(session: vscode.DebugSession, stop: Stop): Promise<string> {
        const why = stop.text ? `${stop.reason}: ${clip(stop.text, 300)}` : stop.reason;
        const frames = await this._frames(session, stop);
        const top = frames[0];
        if (!top) {
            return `Paused (${why}), but the debugger gave no call stack.`;
        }
        const where = (frame: DapFrame) =>
            frame.source?.path ? `${vscode.workspace.asRelativePath(frame.source.path, false)}:${frame.line}` : `${frame.source?.name ?? 'unknown source'}:${frame.line}`;
        const lines = [`Paused (${why}) in ${top.name} at ${where(top)}.`];
        const file = top.source?.path;
        if (file) {
            try {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                const first = Math.max(1, top.line - CONTEXT_LINES);
                const last = Math.min(document.lineCount, top.line + CONTEXT_LINES);
                for (let line = first; line <= last; line++) {
                    lines.push(`${line === top.line ? '→' : ' '}${line}: ${document.lineAt(line - 1).text}`);
                }
                await this._cursor.open({ path: file, startLine: top.line });
            } catch {
                // A source the adapter generated, or the file is gone: the location alone must do.
            }
        }
        if (frames.length > 1) {
            lines.push(`Call stack: ${frames.map((f) => `${f.name} (${where(f)})`).join(' ← ')}`);
        }
        try {
            const { scopes } = (await session.customRequest('scopes', { frameId: top.id })) as {
                scopes?: Array<{ name: string; variablesReference: number; expensive?: boolean }>;
            };
            const scope = scopes?.find((s) => !s.expensive);
            if (scope) {
                const { variables = [] } = (await session.customRequest('variables', { variablesReference: scope.variablesReference })) as {
                    variables?: Array<{ name: string; value: string }>;
                };
                const shown = variables.slice(0, MAX_LOCALS).map((v) => `${v.name} = ${clip(v.value, 120)}`);
                const more = variables.length > MAX_LOCALS ? `; and ${variables.length - MAX_LOCALS} more` : '';
                lines.push(`${scope.name}: ${shown.join('; ') || '(none)'}${more}`);
            }
        } catch (err) {
            lines.push(`Variables unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
        return lines.join('\n');
    }

    private _breakpoints(): string {
        const breakpoints = vscode.debug.breakpoints.filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint);
        if (breakpoints.length === 0) {
            return 'No breakpoints.';
        }
        const list = breakpoints.map(
            (b) =>
                `${vscode.workspace.asRelativePath(b.location.uri, false)}:${b.location.range.start.line + 1}${b.condition ? ` when ${b.condition}` : ''}${b.enabled ? '' : ' (disabled)'}`,
        );
        return `Breakpoints: ${list.join(', ')}.`;
    }
}

function rootOf(session: vscode.DebugSession): vscode.DebugSession {
    let root = session;
    while (root.parentSession) {
        root = root.parentSession;
    }
    return root;
}
