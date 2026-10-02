import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    onVoiceReadinessChange,
    probeStt,
    probeTts,
    readTtsSettings,
    readVoiceSettings,
    resolveSttConfig,
    resolveTtsConfig,
    voiceReadiness,
} from '../voice/voiceSettings';
import { STT_MODEL, TTS_MODEL_ID, TTS_VOICE } from '../voice/builtinEngine/models';
import { explainVoiceError } from '../voice/voiceErrors';
import { speechGate } from '../voice/voiceprint';
import { SettingsPanel } from '../providers/settings-panel';
import { FileEditorTracker } from '../utils/fileEditor';
import { builtinVoiceSkills, resolveVoiceSkills } from './builtinSkills';
import { AgentCursor } from './agentCursor';
import { DebugDriver } from './debugDriver';
import { PairHands } from './pairHands';
import { OutputReader } from './vscodeOutput';
import { WorkerFocusTracker } from './workerFocus';
import { formatAnchor, type CodeAnchor } from './codeAnchors';
import { routeAnchors, withBoards } from './boardWiring';
import { Blackboards, pruneBoardFolders } from './blackboard';
import { editorSnapshot } from './editorSnapshot';
import type { Metrics, Phase } from './conversation';
import {
    voiceUserMessage,
    type VoiceAgentAction,
    type VoiceAttachments,
    type VoiceEngines,
    type VoiceObservationKind,
    type VoicePhase,
    type VoiceStatus,
    type VoiceUnavailable,
    type VoiceUserMessage,
} from '../shared/voiceViewProtocol';
import type { SkillInfo, VoiceLevelSource, VoiceServiceCheck } from '../shared/protocol';
import { ActiveVoiceWindow } from './activeWindow';
import type { ArbiterSettings, Narration } from './floorArbiter';
import type { Humor } from './tone';
import { VoiceAgent, type VoiceTurnListener, type VoiceTurnResult } from './voiceAgent';
import { TTS_LANGUAGE_HANDLING } from './tts';
import { ReplayPlayer, type ReplayOutput } from './replay';
import { DEFAULT_REPLAY_CACHE_SIZE, SpeechCache, ttsCacheKey } from './speechCache';
import { speakerNames } from './speakers';
import { VoiceMode } from './voiceMode';
import { VoiceServiceSync, type VoiceService } from './serviceSync';
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
    /** Dictation drops what the microphone hears while a Bot view message is replayed without voice mode. */
    setDictationPaused(paused: boolean): void;
    /** Voice mode's level 0..1 and waveform, the microphone's or the bot's: the wave in the voice bar. */
    postVoiceLevel(level: number, source: VoiceLevelSource, wave?: number[]): void;
    readonly onVoiceAction: vscode.Event<VoiceAgentAction>;
}

export interface VoiceAgentWiring {
    worker: WorkerController;
    chat: VoiceChatControls;
    /** The chat's resume list, which lists sessions the user only talked to the voice agent about. */
    resumeList: { setVoiceHistory(history: VoiceHistory): void };
    /** The skills installed for the chat tab's CLI (with their files on pi), to find the chosen ones' files. */
    installedSkills: () => Promise<SkillInfo[]>;
}

/**
 * The voice agent's commands, the chat's voice controls and the Bot view. The conversation shows in
 * the Bot view, which a chat tab shows in place of its conversation when its icon is clicked (design
 * §11), and, as a log, in the "Pi Fellow: Voice Agent"
 * output channel.
 * - Chat: the phone button above the composer starts voice mode and, while it is on, hangs up; the
 *   avatar and status text next to it show its phase and switch the tab to the Bot view and back;
 *   the follow button sets whether the editor follows Pi's focus (remembered in the `followPi`
 *   setting); the composer mic shows the microphone level and mutes; in the Bot view the composer
 *   sends typed text to the voice agent (a text turn while voice mode is off), in the conversation to omp.
 * - `oh-my-pi-chater.voiceAgent.start` / `stop` (phone button, palette): voice mode, i.e. microphone and
 *   speaker through a hidden Chrome (design §5.1); stop also ends the omp process. A speech service
 *   that does not work is left out rather than failing the start: without STT the user types, without
 *   TTS replies are shown as text (§5.13). Voice contexts stay on disk with the workspace: the next
 *   start resumes each task's last one (§5.12).
 * - `oh-my-pi-chater.voiceAgent.toggleMute`, `hush` (palette, keys), `oh-my-pi-chater.voiceView.show`
 *   and `history` (Bot view's history button, palette).
 * - `oh-my-pi-chater.voiceAgent.clearHighlight` (palette): removes Pi's highlight.
 * - `oh-my-pi-chater.voiceAgent.typeMessage` (palette): input box loop; a new message interrupts the
 *   reply. In voice mode it goes in like speech. Scripts pass the text to send it once.
 * - Internal, scriptable: `say` (one typed turn outside voice mode, resolves with its
 *   VoiceTurnResult), `takeProactiveTurns` and `takeOutput` (what happened since the last call),
 *   `agentFocus` (Pi's focus now), `oh-my-pi-chater.voiceView.state` (the Bot view's current snapshot).
 *   `start` takes `{ chromeArgs }` for tests that feed the hidden Chrome a WAV file as microphone.
 */
export function registerVoiceAgentCommands(context: vscode.ExtensionContext, wiring: VoiceAgentWiring): vscode.Disposable[] {
    const { worker, chat, resumeList, installedSkills } = wiring;
    const channel = vscode.window.createOutputChannel('Pi Fellow: Voice Agent');
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
    /** Keeps the running voice mode's STT and TTS in step with readiness and settings (design §5.13). */
    let serviceSync: VoiceServiceSync | undefined;
    /** The voice the running voice mode speaks with: the replay cache's key for what it says out loud. */
    let liveTtsKey = '';
    /** A service's settings as they matter to a running voice mode, to tell when they change. */
    const serviceSettings = (service: VoiceService): string => {
        if (service === 'tts') {
            return JSON.stringify(readTtsSettings());
        }
        const { sttEngine, sttUrl, sttModel, language } = readVoiceSettings();
        return JSON.stringify({ sttEngine, sttUrl, sttModel, language });
    };
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
    /** The voice agent's hands in the editor, terminal and debugger. */
    const debug = new DebugDriver(root, cursor);
    const outputs = new OutputReader(context.logUri, () => debug.consoles());
    const hands = new PairHands(root, cursor, debug, outputs);
    /** Skills shipped with the extension, always loaded next to the chosen ones. */
    const builtinSkills = builtinVoiceSkills(context.extensionPath);
    /** What the worker reads and writes shows as Pi's focus while the voice agent is on. */
    let workerFocus: WorkerFocusTracker | undefined;
    /** The voice agent's blackboards (docs/blackboard.md); a board comes into view on a point only while the user follows Pi. */
    const boards = new Blackboards({ extensionUri: context.extensionUri, following: () => cursor.following, log });
    /** Marks the anchor in the output channel; in a text turn the agent points at once, in voice mode as the sentence plays. */
    const anchorLogged = (anchor: CodeAnchor) => {
        output.append(`⟦${formatAnchor(anchor)}⟧`);
        if (!voiceMode) {
            routeAnchors([anchor], boards, cursor);
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
        return {
            running: voiceMode !== undefined,
            llm: {
                model: voiceModel(),
                setting: config.get<string>('model', '').trim(),
                thinking: config.get<string>('thinking', 'off'),
            },
            stt: {
                url: voice.sttEngine === 'builtin' ? 'built-in engine' : voice.sttUrl,
                model: voiceMode?.sttModel || (voice.sttEngine === 'builtin' ? STT_MODEL.id : voice.sttModel) || 'first model the server lists',
                language: voice.language || 'auto',
            },
            tts: tts.engine === 'builtin'
                ? { engine: 'built-in', url: 'built-in engine', model: TTS_MODEL_ID, voice: TTS_VOICE.id, speed: tts.speed, language: 'not sent (English only)' }
                : {
                      engine: 'custom',
                      url: tts.url,
                      model: tts.model || 'server default',
                      voice: tts.voice || 'server default',
                      speed: tts.speed,
                      language: TTS_LANGUAGE_HANDLING[tts.languageField],
                  },
        };
    };

    /** Audio of spoken messages and of sentences read aloud, for Alt+click. */
    const speechCache = new SpeechCache(() =>
        vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent').get<number>('replayCacheSize', DEFAULT_REPLAY_CACHE_SIZE),
    );

    /**
     * Alt+click on a sentence (Bot view or chat). In voice mode a replay plays on its audio page (echo
     * cancelled, microphone input held); otherwise in the webview, with dictation paused while it
     * plays (a paused read plays nothing).
     */
    const replay = new ReplayPlayer({
        cache: speechCache,
        ttsKey: () => ttsCacheKey(readTtsSettings()),
        tts: () => resolveTtsConfig(readTtsSettings()),
        output: (text): ReplayOutput | string => voiceMode?.beginReplay(text) ?? view.audio.output(),
        onChange: (current) => {
            chat.setDictationPaused(current !== undefined && current.phase !== 'paused');
            view.refresh();
        },
        onError: (message) => chat.postVoice({ type: 'replayError', message }),
        // The bot's voice as the reply's is: the voice bar's wave and the talking avatar.
        onLevel: (level, wave) => chat.postVoiceLevel(level, 'bot', wave),
        log,
    });

    // The Bot view, drawn by a chat tab in place of its conversation.
    const view = new VoicePanel(
        store,
        worker,
        {
            phase: viewPhase,
            engines,
            agent: () => agent,
            replay,
            openBoard: (voiceSessionFile, board) => {
                boards.openFromHistory(voiceSessionFile, board).catch((err: unknown) => {
                    void vscode.window.showWarningMessage(`Board ${board}: ${err instanceof Error ? err.message : String(err)}`);
                });
            },
        },
        chat,
    );

    /** The robot status line, follow button and composer mic follow voice mode and Pi's focus. */
    const publishStatus = () =>
        chat.setVoiceStatus({
            phase: viewPhase(),
            starting,
            muted: voiceMode?.muted ?? false,
            following: cursor.following,
            ...(voiceMode ? { unavailable: voiceMode.unavailable } : {}),
        });

    const setPhase = (next: Phase | undefined) => {
        phase = next;
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
    const userListener = (user: VoiceUserMessage, source: 'text' | 'stt', turnId?: number, metrics?: Metrics): VoiceTurnListener => {
        const task = worker.activeTask();
        store.addUser(user.text, source, metrics, user.images);
        const reply = store.beginReply({ turnId }).listener;
        const logged = [user.text, ...(user.images ?? []).map((image) => `[${image.name}]`)].filter(Boolean).join(' ');
        return {
            onPrompt: reply.onPrompt,
            onStart: (task) => output.append(`\nYou${source === 'stt' ? ' (voice)' : ''} [${task.name}]: ${logged}\nVoice: `),
            onText: (delta) => {
                output.append(delta);
                reply.onText?.(delta);
            },
            onAnchor: anchorLogged,
            onToolStart: reply.onToolStart,
            onToolCall: (id, name, args, r) => {
                output.append(toolLine(name, args, r));
                reply.onToolCall?.(id, name, args, r);
            },
            onLookup: (lookup) => {
                output.append(`\n  · ${lookup.description}\nVoice: `);
                reply.onLookup?.(lookup);
            },
            onLookupEnd: reply.onLookupEnd,
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
            onToolStart: (id, name, args) => {
                begin();
                reply.onToolStart?.(id, name, args);
            },
            onToolCall: (id, name, args, r) => {
                begin();
                output.append(toolLine(name, args, r));
                reply.onToolCall?.(id, name, args, r);
            },
            onLookup: (lookup) => {
                begin();
                output.append(`\n  · ${lookup.description}\nVoice: `);
                reply.onLookup?.(lookup);
            },
            onLookupEnd: reply.onLookupEnd,
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
                // Boards belong to the voice context: they follow it as it is bound.
                contexts: withBoards(store, boards, log),
                model: config.get<string>('model', '').trim(),
                thinking: config.get<string>('thinking', 'off'),
                // Read at every process start, so a change applies once voice starts again.
                skills: () =>
                    resolveVoiceSkills(
                        builtinSkills,
                        vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent').get<string[]>('skills', []),
                        () =>
                            installedSkills().catch((err: unknown) => {
                                log(`Could not list the installed skills: ${err instanceof Error ? err.message : String(err)}`);
                                return undefined;
                            }),
                        log,
                    ),
                extraPrompt: () => vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent').get<string>('extraPrompt', ''),
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
                names: speakerNames,
                humor: () => vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent').get<Humor>('humor', 'occasional'),
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
                onResearchSettled: (job) => store.researchSettled(job),
                editor: () => fileEditor.editor && editorSnapshot(fileEditor.editor),
                onRead: (target) => cursor.activity('reading', target),
                hands,
                boards,
                log,
            });
            workerFocus = new WorkerFocusTracker(worker, root, (kind, target) => cursor.activity(kind, target));
        }
        return agent;
    };

    const say = async (text: string, attachments?: VoiceAttachments): Promise<VoiceTurnResult> => {
        if (voiceMode) {
            throw new Error('Voice mode is on: typed messages go through Voice Agent — Type a Message.');
        }
        return getAgent().say(text, 'text', userListener(voiceUserMessage(text, attachments), 'text'), { attachments });
    };

    /** Typed to the voice agent: like speech in voice mode, a text turn otherwise. */
    const type = (text: string, attachments?: VoiceAttachments): void => {
        if (voiceMode) {
            activeWindow.focused();
            voiceMode.type(text, attachments);
            return;
        }
        void say(text, attachments).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            output.appendLine(`\n  ✗ ${message}`);
            store.addSystem(message);
        });
    };

    const stop = async (): Promise<void> => {
        replay.stop();
        const stoppingMode = voiceMode;
        const stoppingAgent = agent;
        voiceMode = undefined;
        serviceSync?.dispose();
        serviceSync = undefined;
        agent = undefined;
        startGeneration++;
        activeWindow.leave();
        setPhase(undefined);
        store.endRun();
        cursor.clear();
        boards.clearPoint();
        workerFocus?.dispose();
        workerFocus = undefined;
        try {
            await stoppingMode?.stop();
        } finally {
            if (stoppingAgent) {
                await stoppingAgent.stop();
                // Only once omp is gone, so nothing writes the files any more.
                if (persistentSessions) {
                    await pruneBoardFolders(sessionDir, await store.pruneContexts(sessionDir));
                } else {
                    await fs.rm(sessionDir, { recursive: true, force: true });
                }
            }
        }
    };

    const start = async (options: { chromeArgs?: string[] } = {}): Promise<void> => {
        if (voiceMode || starting) {
            return;
        }
        starting = true;
        // A replay playing in the Bot view has no echo cancellation: the microphone would hear it.
        replay.stop();
        const generation = ++startGeneration;
        setPhase(undefined);
        try {
            const voiceAgent = getAgent();
            voiceAgent.warmUp();
            activeWindow.join();
            const voice = readVoiceSettings();
            const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent');
            const ttsSettings = readTtsSettings();
            const startedSettings = { stt: serviceSettings('stt'), tts: serviceSettings('tts') };
            // A service that failed its check may have been fixed since: check it again. Either one
            // failing only leaves it out; voice mode runs without it (design §5.13).
            let readiness = voiceReadiness();
            await Promise.all([readiness.stt.ok ? undefined : probeStt(), readiness.tts.ok ? undefined : probeTts()]);
            readiness = voiceReadiness();
            const unavailable: VoiceUnavailable = {};
            /** The service's config, or undefined with the reason in `unavailable`; the built-in engine may download its models and start here. */
            const resolve = async <T>(service: 'stt' | 'tts', check: VoiceServiceCheck, load: () => Promise<T>): Promise<T | undefined> => {
                if (!check.ok) {
                    unavailable[service] = check.reason ?? `${service === 'stt' ? 'Speech-to-text' : 'Text-to-speech'} is unavailable.`;
                    return undefined;
                }
                try {
                    return await load();
                } catch (err) {
                    unavailable[service] = explainVoiceError(err, { service }).message;
                    return undefined;
                }
            };
            const [stt, tts] = await Promise.all([
                resolve('stt', readiness.stt, () => resolveSttConfig(voice)),
                resolve('tts', readiness.tts, () => resolveTtsConfig(ttsSettings)),
            ]);
            /** The voice this run speaks with, for the cache; follows TTS settings the running voice mode takes. */
            liveTtsKey = ttsCacheKey(ttsSettings);
            if (generation !== startGeneration) {
                log('Voice mode was stopped while it started.');
                return;
            }
            const mode = await VoiceMode.start({
                agent: voiceAgent,
                vad: {
                    modelPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'vad', 'silero_vad.onnx').fsPath,
                    runtimeDir: vscode.Uri.joinPath(context.extensionUri, 'out', 'vad').fsPath,
                },
                stt,
                tts,
                unavailable,
                // Only your voice is a turn (and can cut a reply off), once you have a voiceprint turned on.
                gate: speechGate,
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
                onAnchors: (anchors) => routeAnchors(anchors, boards, cursor),
                // What a reply said out loud is the audio Alt+click reads its sentences from.
                onSpoken: (turnId, pieces) => {
                    const entryId = store.entryIdOfTurn(turnId);
                    const texts = JSON.stringify(pieces.map((p) => p.text));
                    if (entryId) {
                        speechCache.put(entryId, liveTtsKey, pieces);
                        log(`Replay cache: reply ${turnId} spoken live, stored as ${entryId}: ${texts}`);
                    } else {
                        log(`Replay cache: reply ${turnId} spoken live but no transcript entry for it, not stored: ${texts}`);
                    }
                },
                onSpeechUsage: (usage) => {
                    if (generation === startGeneration) {
                        store.addSpeechUsage(usage);
                    }
                },
                onServiceError: (service, message) =>
                    store.addSystem(`${service === 'stt' ? 'Speech-to-text' : 'Text-to-speech'} failed: ${message} The conversation goes on in text.`),
                // The robot's "Can't hear" tag follows the microphone too.
                onMicStatus: (error) => {
                    if (error && generation === startGeneration) {
                        store.addSystem(`The microphone could not be opened (${error}). Type to the voice agent instead.`);
                    }
                    publishStatus();
                },
                log,
            });
            if (generation !== startGeneration) {
                // Stopped while starting (Stop, or the window closing): its agent is already stopped.
                await mode.stop();
                log('Voice mode was stopped while it started.');
                return;
            }
            voiceMode = mode;
            serviceSync = new VoiceServiceSync(mode, startedSettings, {
                readiness: voiceReadiness,
                settings: serviceSettings,
                resolveStt: () => resolveSttConfig(readVoiceSettings()),
                resolveTts: () => resolveTtsConfig(readTtsSettings()),
                onChange: (service, how) => {
                    if (service === 'tts') {
                        liveTtsKey = ttsCacheKey(readTtsSettings());
                    }
                    if (how === 'attached') {
                        store.addSystem(
                            service === 'stt'
                                ? 'Speech-to-text works now: the voice agent hears you again.'
                                : 'Text-to-speech works now: the voice agent speaks its replies again, from the next one.',
                        );
                    }
                    log(`Voice mode ${how === 'attached' ? 'picked up' : 'switched to the new settings of'} ${service === 'stt' ? 'speech-to-text' : 'text-to-speech'}.`);
                    publishStatus();
                    view.refresh();
                },
                log,
            });
            // Readiness may have changed while it started.
            void serviceSync.sync();
            voiceAgent.open({ reason: 'connect', language: voice.language });
            // A tab the worker has not touched yet belongs to the voice agent: show its Bot view.
            void chat.showBotView(true, { onlyIfWorkerUnused: true });
            // Focus may have moved to another voice window while this one was starting.
            voiceMode.setActive(activeWindow.active);
            const { stt: deaf, tts: voiceless } = mode.unavailable;
            if (deaf || voiceless) {
                // Where the user types to it: say what it cannot do, and why.
                store.addSystem(
                    [
                        deaf && `The voice agent can't hear you, type to it here instead. ${deaf}`,
                        voiceless && `The voice agent has no voice, its replies are shown here as text. ${voiceless}`,
                    ]
                        .filter(Boolean)
                        .join('\n'),
                );
            }
            log(
                deaf
                    ? `Voice mode on without listening: type to the voice agent${voiceless ? '; replies are shown as text' : ''}.`
                    : voiceless
                      ? 'Voice mode on: talk any time; replies are shown as text, not spoken.'
                      : 'Voice mode on: talk any time; speaking over a reply cuts it off.',
            );
        } catch (err: unknown) {
            const explained = explainVoiceError(err);
            log(`Voice mode failed to start: ${explained.detail}`);
            const action = explained.openSettings ? ['Open Voice Settings'] : [];
            void vscode.window.showErrorMessage(`Voice mode: ${explained.message}`, ...action).then((pick) => {
                if (pick) {
                    SettingsPanel.showWithSection('voice');
                }
            });
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
        boards,
        hands,
        debug,
        outputs,
        worker.onSessionResumed((tabId) => {
            if (voiceMode) {
                agent?.open({ reason: 'resume', tabId, language: readVoiceSettings().language });
            }
        }),
        cursor.onDidChangeFollowing(publishStatus),
        // A service the running voice mode lacks is picked up once it works; new settings are taken at once.
        onVoiceReadinessChange(() => void serviceSync?.sync()),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('oh-my-pi-chater.voice') || e.affectsConfiguration('oh-my-pi-chater.voiceAgent.tts')) {
                void serviceSync?.sync();
            }
            // The system prompt is read only when the process starts.
            if (e.affectsConfiguration('oh-my-pi-chater.voiceAgent.extraPrompt')) {
                void agent?.restartProcess();
            }
            // The model switches between turns, without a restart.
            if (e.affectsConfiguration('oh-my-pi-chater.voiceAgent.model')) {
                const model = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent').get<string>('model', '').trim();
                agent?.setModel(model).catch((err: unknown) => {
                    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
                });
                view.refresh();
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
                case 'follow':
                    cursor.setFollowing(action.following);
                    void vscode.workspace
                        .getConfiguration('oh-my-pi-chater.voiceAgent')
                        .update('followPi', action.following, vscode.ConfigurationTarget.Global);
                    return;
                case 'model': {
                    // Saved where it is set: a workspace value would hide a user one.
                    const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voiceAgent');
                    const target = config.inspect<string>('model')?.workspaceValue !== undefined
                        ? vscode.ConfigurationTarget.Workspace
                        : vscode.ConfigurationTarget.Global;
                    void config.update('model', action.model, target).then(undefined, (err: unknown) => {
                        void vscode.window.showWarningMessage(`Voice agent model: ${err instanceof Error ? err.message : String(err)}`);
                    });
                    return;
                }
                case 'send':
                    if (action.text.trim() || action.attachments) {
                        type(action.text.trim(), action.attachments);
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
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.clearHighlight', () => {
            cursor.clear();
            boards.clearPoint();
        }),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.agentFocus', () => cursor.current()),
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
