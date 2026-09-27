import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { readTtsSettings, readVoiceSettings } from '../voice/voiceSettings';
import { FileEditorTracker } from '../utils/fileEditor';
import { AgentCursor } from './agentCursor';
import { DebugDriver } from './debugDriver';
import type { AgentMode } from './hostTools';
import { PairHands } from './pairHands';
import { OutputReader } from './vscodeOutput';
import { WorkerFocusTracker } from './workerFocus';
import { formatAnchor, type CodeAnchor } from './codeAnchors';
import { editorSnapshot } from './editorSnapshot';
import type { Metrics, Phase } from './conversation';
import type { VoiceAgentAction, VoiceEngines, VoiceObservationKind, VoicePhase, VoiceStatus } from '../shared/voiceViewProtocol';
import type { VoiceLevelSource } from '../shared/protocol';
import { ActiveVoiceWindow } from './activeWindow';
import type { ArbiterSettings, Narration } from './floorArbiter';
import { VoiceAgent, type VoiceTurnListener, type VoiceTurnResult } from './voiceAgent';
import { TTS_LANGUAGE_HANDLING, TTS_PROVIDER_DEFAULTS } from './tts';
import { VoiceMode } from './voiceMode';
import { SessionTitler, generateTitle } from './sessionTitle';
import { VoiceTranscriptStore } from './transcriptStore';
import { VoicePanel, type BotViewSurface } from './voicePanel';
import type { VoiceHistory, WorkerController } from './workerController';

/** A turn the voice agent started on its own, as reported to scripts. */
export interface ProactiveTurnRecord {
    kind: VoiceObservationKind;
    task: string;
    result: VoiceTurnResult;
}

/** Enough for a script polling between checks; older turns are only in the output channel. */
const PROACTIVE_RECORD_LIMIT = 20;
/** Output kept for `takeOutput`, in characters. */
const CAPTURE_LIMIT = 50_000;

/** Entries kept per voice session. */
const SESSION_ENTRIES = 300;

/** The chat's voice controls (the robot status line over the composer, the composer mic) and the Bot view its tabs show. */
export interface VoiceChatControls extends BotViewSurface {
    setVoiceStatus(status: VoiceStatus): void;
    /** Voice mode's level 0..1 and waveform, the microphone's or the bot's: the wave in the voice bar. */
    postVoiceLevel(level: number, source: VoiceLevelSource, wave?: number[]): void;
    readonly onVoiceAction: vscode.Event<VoiceAgentAction>;
}

export interface VoiceAgentWiring {
    worker: WorkerController;
    chat: VoiceChatControls;
    /** The chat's resume list, which lists sessions the user only talked to the voice agent about. */
    resumeList: { setVoiceHistory(history: VoiceHistory): void };
}

/**
 * The voice agent's commands, the chat's voice controls and the Bot view. The conversation shows in
 * the Bot view, which a chat tab shows in place of its conversation when its icon is clicked (design
 * §11), and, as a log, in the "Oh My Pi Chater: Voice Agent"
 * output channel.
 * - Chat: the robot above the composer starts voice mode and, while it is on, shows its phase and
 *   stops it; the composer mic shows the microphone level and mutes; in the Bot view the composer
 *   sends typed text to the voice agent (and is locked while it is offline), in the conversation to omp.
 * - `oh-my-pi-chater.voiceAgent.start` / `stop` (robot, palette): voice mode, i.e. microphone and
 *   speaker through a hidden Chrome (design §5.1); stop also ends the omp process. Voice contexts
 *   stay on disk with the workspace: the next start resumes each task's last one (§5.12).
 * - `oh-my-pi-chater.voiceAgent.toggleMute`, `hush` (palette, keys), `oh-my-pi-chater.voiceView.show`
 *   and `history` (Bot view's history button, palette).
 * - `oh-my-pi-chater.voiceAgent.clearHighlight` (palette): removes Pi's highlight.
 * - `followPi` / `unfollowPi` (eye button in the editor title bar, palette) and `toggleFollowPi`
 *   (Pi's status bar item): whether the editor follows Pi's focus.
 * - `oh-my-pi-chater.voiceAgent.typeMessage` (palette): input box loop; a new message interrupts the
 *   reply. In voice mode it goes in like speech. Scripts pass the text to send it once.
 * - Internal, scriptable: `say` (one typed turn outside voice mode, resolves with its
 *   VoiceTurnResult), `takeProactiveTurns` and `takeOutput` (what happened since the last call),
 *   `agentFocus` (Pi's focus now), `oh-my-pi-chater.voiceView.state` (the Bot view's current snapshot).
 *   `start` takes `{ chromeArgs }` for tests that feed the hidden Chrome a WAV file as microphone.
 */
export function registerVoiceAgentCommands(context: vscode.ExtensionContext, wiring: VoiceAgentWiring): vscode.Disposable[] {
    const { worker, chat, resumeList } = wiring;
    const channel = vscode.window.createOutputChannel('Oh My Pi Chater: Voice Agent');
    let captured = '';
    const output = {
        append(text: string): void {
            channel.append(text);
            captured = (captured + text).slice(-CAPTURE_LIMIT);
        },
        appendLine(text: string): void {
            output.append(`${text}\n`);
        },
    };
    const log = (line: string) => output.appendLine(`· ${line}`);
    let agent: VoiceAgent | undefined;
    let voiceMode: VoiceMode | undefined;
    let starting = false;
    /** Bumped by every start and stop: a start that finishes after a stop must not turn voice mode on. */
    let startGeneration = 0;
    let phase: Phase | undefined;
    // Shared by every window with voice mode on: only the one focused last listens and speaks.
    const activeWindow = new ActiveVoiceWindow(path.join(context.globalStorageUri.fsPath, 'voice-windows'));
    let proactiveTurns: ProactiveTurnRecord[] = [];
    const store = new VoiceTranscriptStore(
        context.workspaceState,
        {
            sessions: () => vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent').get<number>('historySessions', 20),
            entries: SESSION_ENTRIES,
        },
        () => worker.activeTask(),
    );
    resumeList.setVoiceHistory(store);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    /**
     * omp's voice session files. Kept with the workspace so a task's voice conversation goes on after
     * a restart; without a workspace folder there is no such place, and they go when the agent stops.
     */
    const persistentSessions = context.storageUri !== undefined;
    const sessionDir = context.storageUri
        ? path.join(context.storageUri.fsPath, 'voice-sessions')
        : path.join(context.globalStorageUri.fsPath, 'voice-sessions', randomUUID());
    // The user's editor as the voice agent sees it, and Pi's focus in it.
    const fileEditor = new FileEditorTracker();
    const cursor = new AgentCursor(
        root,
        () => fileEditor.editor,
        log,
        vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent').get<boolean>('followPi', true),
    );
    /** The voice agent's hands in the editor, terminal and debugger: open_file, list_viewers, open_with and read_output always, the rest in pair mode. */
    const debug = new DebugDriver(root, cursor);
    const outputs = new OutputReader(context.logUri, () => debug.consoles());
    const hands = new PairHands(root, cursor, debug, outputs);
    /** A new voice agent always starts in pair mode. */
    const setMode = (mode: AgentMode) => getAgent().setMode(mode);
    /** What the worker reads and writes shows as Pi's focus while the voice agent is on. */
    let workerFocus: WorkerFocusTracker | undefined;
    /** Marks the anchor in the output channel; in a text turn the agent points at once, in voice mode as the sentence plays. */
    const anchorLogged = (anchor: CodeAnchor) => {
        output.append(`⟦${formatAnchor(anchor)}⟧`);
        if (!voiceMode) {
            cursor.point([anchor]);
        }
    };

    const viewPhase = (): VoicePhase => {
        if (!voiceMode) {
            return 'off';
        }
        const current = phase ?? 'listening';
        return voiceMode.muted && current === 'listening' ? 'muted' : current;
    };

    /** The voice agent's model: the running agent's, else as configured, else the worker's. */
    const voiceModel = (): string | undefined =>
        agent?.model ?? (vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent').get<string>('model', '').trim() || worker.activeTask()?.model);
    /** Tasks are named after what the user wanted, by the voice agent's model. */
    const titler = new SessionTitler(store, worker, (utterances) => generateTitle(utterances, root, voiceModel()), log);

    /** The services voice mode uses: resolved while it runs, as configured otherwise. */
    const engines = (): VoiceEngines => {
        const voice = readVoiceSettings();
        const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent');
        const tts = readTtsSettings();
        const defaults = TTS_PROVIDER_DEFAULTS[tts.provider] ?? TTS_PROVIDER_DEFAULTS.openai;
        return {
            running: voiceMode !== undefined,
            llm: {
                model: voiceModel(),
                thinking: config.get<string>('thinking', 'off'),
            },
            stt: {
                url: voice.sttUrl,
                model: voiceMode?.sttModel || voice.sttModel || 'first model the server lists',
                language: voice.language || 'auto',
            },
            tts: {
                provider: tts.provider,
                url: tts.url,
                model: tts.model || defaults.model,
                voice: tts.voice || defaults.voice,
                speed: tts.speed,
                language: TTS_LANGUAGE_HANDLING[tts.provider] ?? TTS_LANGUAGE_HANDLING.openai,
            },
        };
    };

    // The Bot view, drawn by a chat tab in place of its conversation.
    const view = new VoicePanel(store, worker, { phase: viewPhase, mode: () => agent?.mode ?? 'pair', engines, agent: () => agent }, chat);

    /** The robot status line and composer mic follow voice mode. */
    const publishStatus = () =>
        chat.setVoiceStatus({ phase: viewPhase(), starting, muted: voiceMode?.muted ?? false, mode: agent?.mode ?? 'pair' });

    const setPhase = (next: Phase | undefined) => {
        phase = next;
        void vscode.commands.executeCommand('setContext', 'oh-my-pi-chater.voiceMode', voiceMode !== undefined || next !== undefined);
        publishStatus();
        view.refresh();
    };

    const setMuted = (muted: boolean) => {
        voiceMode?.setMuted(muted);
        publishStatus();
        view.refresh();
    };

    const toolLine = (name: string, args: Record<string, unknown>, r: { isError: boolean; text: string }) =>
        `\n  ⟶ ${name} ${JSON.stringify(args)}\n  ${r.isError ? '✗' : '✓'} ${r.text}\nVoice: `;

    /** A user turn: logged to the output channel, recorded in the view. */
    const userListener = (text: string, source: 'text' | 'stt', turnId?: number, metrics?: Metrics): VoiceTurnListener => {
        const task = worker.activeTask();
        store.addUser(text, source, metrics);
        const reply = store.beginReply({ turnId }).listener;
        return {
            onPrompt: reply.onPrompt,
            onStart: (task) => output.append(`\nYou${source === 'stt' ? ' (voice)' : ''} [${task.name}]: ${text}\nVoice: `),
            onText: (delta) => {
                output.append(delta);
                reply.onText?.(delta);
            },
            onAnchor: anchorLogged,
            onToolCall: (name, args, r) => {
                output.append(toolLine(name, args, r));
                reply.onToolCall?.(name, args, r);
            },
            onLookup: (description) => {
                output.append(`\n  · ${description}\nVoice: `);
                reply.onLookup?.(description);
            },
            onUsage: reply.onUsage,
            onEnd: (result) => {
                output.appendLine(result.interrupted ? ' [interrupted]' : result.error ? `\n  ✗ ${result.error}` : result.silent ? '(silent)' : '');
                reply.onEnd?.(result);
                titler.noteTurn(task);
            },
        };
    };

    const proactiveListener = (kind: VoiceObservationKind, task: { name: string }, reply: VoiceTurnListener): VoiceTurnListener => {
        let started = false;
        // Printed on first output, so a silent turn is one short line.
        const begin = () => {
            if (!started) {
                started = true;
                output.append(`\n[${kind}] Voice [${task.name}]: `);
            }
        };
        return {
            onPrompt: reply.onPrompt,
            onText: (delta) => {
                begin();
                output.append(delta);
                reply.onText?.(delta);
            },
            onAnchor: (anchor) => {
                begin();
                anchorLogged(anchor);
            },
            onToolCall: (name, args, r) => {
                begin();
                output.append(toolLine(name, args, r));
                reply.onToolCall?.(name, args, r);
            },
            onLookup: (description) => {
                begin();
                output.append(`\n  · ${description}\nVoice: `);
                reply.onLookup?.(description);
            },
            onUsage: reply.onUsage,
            onEnd: (result) => {
                if (started) {
                    output.appendLine(result.interrupted ? ' [interrupted]' : result.error ? `\n  ✗ ${result.error}` : '');
                } else {
                    output.appendLine(`· [${kind}] nothing worth saying${result.error ? ` (✗ ${result.error})` : ''}`);
                }
                reply.onEnd?.(result);
                proactiveTurns.push({ kind, task: task.name, result });
                proactiveTurns = proactiveTurns.slice(-PROACTIVE_RECORD_LIMIT);
            },
        };
    };

    const getAgent = (): VoiceAgent => {
        if (!agent) {
            const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent');
            agent = new VoiceAgent({
                worker,
                cwd: root,
                sessionDir,
                contexts: store,
                model: config.get<string>('model', '').trim(),
                thinking: config.get<string>('thinking', 'off'),
                confirmBeforeDispatch: () =>
                    vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent').get<boolean>('confirmBeforeDispatch', true),
                arbiter: (): ArbiterSettings => {
                    const live = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent');
                    return {
                        narration: live.get<Narration>('narration', 'important'),
                        minProactiveGapMs: live.get<number>('minProactiveGapSecs', 8) * 1000,
                        narrationIntervalMs: live.get<number>('narrationIntervalSecs', 30) * 1000,
                    };
                },
                onProactiveTurn: (kind, task) => {
                    const reply = store.beginReply({ proactive: kind });
                    const listener = proactiveListener(kind, task, reply.listener);
                    if (!voiceMode) {
                        return { listener };
                    }
                    const hooks = voiceMode.proactiveTurn(listener);
                    reply.bindTurn(hooks.turnId);
                    return hooks;
                },
                floorBusy: () => voiceMode?.floorBusy ?? false,
                hush: () => voiceMode?.hush(),
                onChange: () => view.refresh(),
                editor: () => fileEditor.editor && editorSnapshot(fileEditor.editor),
                onRead: (target) => cursor.activity('reading', target),
                hands,
                onModeChange: (mode) => {
                    store.addSystem(
                        mode === 'pair'
                            ? 'Pair mode: the voice agent now edits files and runs commands itself, and does not direct the worker.'
                            : 'Delegate mode: the voice agent hands the work to the omp worker again.',
                    );
                    publishStatus();
                    view.refresh();
                },
                log,
            });
            workerFocus = new WorkerFocusTracker(worker, root, (kind, target) => cursor.activity(kind, target));
        }
        return agent;
    };

    const say = async (text: string): Promise<VoiceTurnResult> => {
        if (voiceMode) {
            throw new Error('Voice mode is on: typed messages go through Voice Agent — Type a Message.');
        }
        return getAgent().say(text, 'text', userListener(text, 'text'));
    };

    /** Typed to the voice agent: like speech in voice mode, a text turn otherwise. */
    const type = (text: string): void => {
        if (voiceMode) {
            activeWindow.focused();
            voiceMode.type(text);
            return;
        }
        void say(text).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            output.appendLine(`\n  ✗ ${message}`);
            store.addSystem(message);
        });
    };

    const stop = async (): Promise<void> => {
        const stoppingMode = voiceMode;
        const stoppingAgent = agent;
        voiceMode = undefined;
        agent = undefined;
        startGeneration++;
        activeWindow.leave();
        setPhase(undefined);
        store.endRun();
        cursor.clear();
        workerFocus?.dispose();
        workerFocus = undefined;
        try {
            await stoppingMode?.stop();
        } finally {
            if (stoppingAgent) {
                await stoppingAgent.stop();
                // Only once omp is gone, so nothing writes the files any more.
                await (persistentSessions ? store.pruneContexts(sessionDir) : fs.rm(sessionDir, { recursive: true, force: true }));
            }
        }
    };

    const start = async (options: { chromeArgs?: string[] } = {}): Promise<void> => {
        if (voiceMode || starting) {
            return;
        }
        starting = true;
        const generation = ++startGeneration;
        setPhase(undefined);
        try {
            const voiceAgent = getAgent();
            voiceAgent.warmUp();
            activeWindow.join();
            const voice = readVoiceSettings();
            const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent');
            const mode = await VoiceMode.start({
                agent: voiceAgent,
                vad: {
                    modelPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'vad', 'silero_vad.onnx').fsPath,
                    runtimeDir: vscode.Uri.joinPath(context.extensionUri, 'out', 'vad').fsPath,
                },
                stt: { url: voice.sttUrl, model: voice.sttModel, language: voice.language },
                tts: readTtsSettings(),
                turnStopSecs: config.get<number>('turnStopSecs', 1.2),
                vadConfidence: voice.vadConfidence,
                chromeArgs: options.chromeArgs ?? [],
                active: activeWindow.active,
                transcript: userListener,
                openExternal: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
                onPhase: (next) => {
                    if (generation === startGeneration) {
                        setPhase(next);
                    }
                },
                onLevel: (level, wave) => chat.postVoiceLevel(level, 'user', wave),
                onBotLevel: (level, wave) => chat.postVoiceLevel(level, 'bot', wave),
                onMetrics: (turnId, metrics) => store.metrics(turnId, metrics),
                onAudio: (event) => store.audio(event),
                onAnchors: (anchors) => cursor.point(anchors),
                log,
            });
            if (generation !== startGeneration) {
                // Stopped while starting (Stop, or the window closing): its agent is already stopped.
                await mode.stop();
                log('Voice mode was stopped while it started.');
                return;
            }
            voiceMode = mode;
            voiceAgent.open({ reason: 'connect', language: voice.language });
            // A tab the worker has not touched yet belongs to the voice agent: show its Bot view.
            void chat.showBotView(true, { onlyIfWorkerUnused: true });
            // Focus may have moved to another voice window while this one was starting.
            voiceMode.setActive(activeWindow.active);
            log('Voice mode on: talk any time; speaking over a reply cuts it off.');
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            log(`Voice mode failed to start: ${message}`);
            void vscode.window.showErrorMessage(`Voice mode: ${message}`);
        } finally {
            starting = false;
            if (!voiceMode) {
                activeWindow.leave();
            }
            setPhase(phase);
        }
    };

    const stopCommand = async () => {
        await stop();
        log('Voice agent stopped.');
    };

    setPhase(undefined);
    return [
        channel,
        view,
        store,
        fileEditor,
        cursor,
        hands,
        debug,
        outputs,
        worker.onSessionResumed((tabId) => {
            if (voiceMode) {
                agent?.open({ reason: 'resume', tabId, language: readVoiceSettings().language });
            }
        }),
        chat.onVoiceAction((action) => {
            switch (action.type) {
                case 'start':
                    void start();
                    return;
                case 'stop':
                    void stopCommand();
                    return;
                case 'mute':
                    setMuted(action.muted);
                    return;
                case 'hush':
                    voiceMode?.hush();
                    return;
                case 'mode':
                    setMode(action.mode);
                    return;
                case 'send':
                    if (action.text.trim()) {
                        type(action.text.trim());
                    }
                    return;
            }
        }),
        { dispose: () => void stop().finally(() => activeWindow.dispose()) },
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                activeWindow.focused();
            }
        }),
        activeWindow.onDidChange((active) => voiceMode?.setActive(active)),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.start', start),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.stop', stopCommand),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.toggleMute', () => setMuted(!(voiceMode?.muted ?? false))),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.hush', () => voiceMode?.hush()),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceView.show', () => view.show()),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceView.history', () => view.pickSession()),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceView.state', () => view.snapshot()),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.say', say),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.clearHighlight', () => cursor.clear()),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.agentFocus', () => cursor.current()),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.toggleFollowPi', () => cursor.setFollowing(!cursor.following)),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.followPi', () => cursor.setFollowing(true)),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.unfollowPi', () => cursor.setFollowing(false)),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.toggleMode', () => setMode(agent?.mode === 'omp' ? 'pair' : 'omp')),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.mode', () => agent?.mode ?? 'pair'),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.takeProactiveTurns', () => {
            const taken = proactiveTurns;
            proactiveTurns = [];
            return taken;
        }),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.takeOutput', () => {
            const taken = captured;
            captured = '';
            return taken;
        }),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.typeMessage', async (scripted?: string) => {
            if (typeof scripted === 'string') {
                type(scripted);
                return;
            }
            for (;;) {
                const text = await vscode.window.showInputBox({
                    title: 'Voice agent',
                    prompt: 'Type what you would say. Enter sends, and a new message interrupts the reply. Esc closes.',
                    ignoreFocusOut: true,
                });
                if (!text?.trim()) {
                    return;
                }
                type(text.trim());
            }
        }),
    ];
}
