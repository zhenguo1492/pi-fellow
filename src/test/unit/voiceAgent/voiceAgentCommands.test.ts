import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { VoiceAgentAction, VoiceStatus } from '../../../shared/voiceViewProtocol';

const disposable = { dispose: () => {} };

vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({ append: () => {}, appendLine: () => {}, dispose: () => {} }),
        onDidChangeWindowState: () => ({ dispose: () => {} }),
        showErrorMessage: async () => undefined,
    },
    workspace: {
        workspaceFolders: undefined,
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, update: async () => {} }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
    commands: { registerCommand: () => ({ dispose: () => {} }) },
    env: { openExternal: async () => true },
    Uri: {
        joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
        parse: (value: string) => ({ toString: () => value }),
    },
    ConfigurationTarget: { Global: 1 },
}));

// Voice mode (microphone, speech services) and the voice agent's process: what the chat's actions reach.
const voice = vi.hoisted(() => ({
    agents: [] as Array<{ say: Mock; stop: Mock }>,
    modes: [] as Array<{ type: Mock; stop: Mock }>,
}));
vi.mock('../../../voiceAgent/voiceAgent', () => ({
    VoiceAgent: class {
        model = undefined;
        say = vi.fn(async () => ({ reply: 'ok', silent: false, toolCalls: [], lookups: [], interrupted: false }));
        stop = vi.fn(async () => {});
        warmUp = () => {};
        open = () => {};
        constructor() {
            voice.agents.push(this);
        }
    },
}));
vi.mock('../../../voiceAgent/voiceMode', () => ({
    VoiceMode: {
        start: vi.fn(async () => {
            const mode = { type: vi.fn(), stop: vi.fn(async () => {}), setActive: () => {}, hush: () => {}, muted: false, unavailable: {}, sttModel: '' };
            voice.modes.push(mode);
            return mode;
        }),
    },
}));
vi.mock('../../../voiceAgent/serviceSync', () => ({
    VoiceServiceSync: class {
        sync = async () => {};
        dispose = () => {};
    },
}));
vi.mock('../../../voice/voiceSettings', () => ({
    onVoiceReadinessChange: () => ({ dispose: () => {} }),
    probeStt: async () => {},
    probeTts: async () => {},
    readTtsSettings: () => ({ engine: 'builtin', speed: 1 }),
    readVoiceSettings: () => ({ sttEngine: 'builtin', sttUrl: '', sttModel: '', language: '', vadConfidence: 0.5 }),
    resolveSttConfig: async () => ({}),
    resolveTtsConfig: async () => ({}),
    voiceReadiness: () => ({ stt: { ok: true }, tts: { ok: true } }),
}));
vi.mock('../../../voice/voiceprint', () => ({ speechGate: {} }));
vi.mock('../../../providers/settings-panel', () => ({ SettingsPanel: { showWithSection: () => {} } }));
// The editor, terminal, debugger and Bot view: not what these tests are about.
vi.mock('../../../utils/fileEditor', () => ({ FileEditorTracker: class { editor = undefined; dispose = () => {}; } }));
vi.mock('../../../voiceAgent/agentCursor', () => ({
    AgentCursor: class {
        following = false;
        onDidChangeFollowing = () => ({ dispose: () => {} });
        clear = () => {};
        point = () => {};
        activity = () => {};
        setFollowing = () => {};
        dispose = () => {};
    },
}));
vi.mock('../../../voiceAgent/debugDriver', () => ({ DebugDriver: class { consoles = () => []; dispose = () => {}; } }));
vi.mock('../../../voiceAgent/vscodeOutput', () => ({ OutputReader: class { dispose = () => {}; } }));
vi.mock('../../../voiceAgent/pairHands', () => ({ PairHands: class { dispose = () => {}; } }));
vi.mock('../../../voiceAgent/workerFocus', () => ({ WorkerFocusTracker: class { dispose = () => {}; } }));
vi.mock('../../../voiceAgent/blackboard', () => ({
    Blackboards: class {
        bindSession = async () => {};
        pointAnchor = () => {};
        clearPoint = () => {};
        openFromHistory = async () => {};
        dispose = () => {};
    },
    pruneBoardFolders: async () => {},
}));
vi.mock('../../../voiceAgent/activeWindow', () => ({
    ActiveVoiceWindow: class {
        active = true;
        join = () => {};
        leave = () => {};
        focused = () => {};
        onDidChange = () => ({ dispose: () => {} });
        dispose = () => {};
    },
}));
vi.mock('../../../voiceAgent/voicePanel', () => ({
    VoicePanel: class {
        refresh = () => {};
        dispose = () => {};
    },
}));
vi.mock('../../../voiceAgent/replay', () => ({ ReplayPlayer: class { stop = () => {}; } }));
vi.mock('../../../voiceAgent/sessionTitle', () => ({ SessionTitler: class { noteTurn = () => {}; }, generateTitle: async () => '' }));

import { VoiceMode } from '../../../voiceAgent/voiceMode';
import { registerVoiceAgentCommands, type VoiceChatControls } from '../../../voiceAgent/voiceAgentCommands';
import type { WorkerController } from '../../../voiceAgent/workerController';

let dir: string;
let act: (action: VoiceAgentAction) => void;
let statuses: VoiceStatus[];

beforeEach(() => {
    voice.agents.length = 0;
    voice.modes.length = 0;
    vi.mocked(VoiceMode.start).mockClear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-commands-'));
    statuses = [];
    const chat = {
        setVoiceStatus: (status: VoiceStatus) => statuses.push(status),
        setDictationPaused: () => {},
        postVoiceLevel: () => {},
        showBotView: async () => {},
        onVoiceAction: (listener: (action: VoiceAgentAction) => void) => {
            act = listener;
            return disposable;
        },
    } as unknown as VoiceChatControls;
    const worker = {
        activeTask: () => ({ tabId: 't1', sessionFile: '/s/worker.jsonl', name: 'Task' }),
        onSessionResumed: () => disposable,
    } as unknown as WorkerController;
    const saved = new Map<string, unknown>();
    const context = {
        globalStorageUri: { fsPath: dir },
        storageUri: undefined,
        logUri: { fsPath: dir },
        extensionPath: dir,
        extensionUri: { fsPath: dir },
        workspaceState: {
            get: <T>(key: string) => saved.get(key) as T | undefined,
            update: async (key: string, value: unknown) => void saved.set(key, value),
        },
    };
    registerVoiceAgentCommands(context as never, { worker, chat, resumeList: { setVoiceHistory: () => {} }, installedSkills: async () => [] });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the phone button', () => {
    it('connects voice mode (the microphone) on start and disconnects it on stop', async () => {
        expect(statuses.at(-1)?.phase).toBe('off');

        act({ type: 'start' });
        await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ phase: 'listening', starting: false }));
        expect(VoiceMode.start).toHaveBeenCalledTimes(1);
        expect(statuses).toContainEqual(expect.objectContaining({ starting: true }));

        act({ type: 'stop' });
        await vi.waitFor(() => expect(voice.modes[0].stop).toHaveBeenCalled());
        expect(statuses.at(-1)).toMatchObject({ phase: 'off', starting: false });
    });
});

describe('a message typed in the Bot view', () => {
    it('is a text turn while voice mode is off, goes in like speech while it is on, and is a text turn again after hanging up', async () => {
        act({ type: 'send', text: '  what does it do?  ' });
        expect(voice.agents[0].say).toHaveBeenCalledExactlyOnceWith('what does it do?', 'text', expect.anything(), { attachments: undefined });
        expect(VoiceMode.start).not.toHaveBeenCalled();

        act({ type: 'start' });
        await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ phase: 'listening' }));
        act({ type: 'send', text: 'and the tests?' });
        expect(voice.modes[0].type).toHaveBeenCalledExactlyOnceWith('and the tests?', undefined);
        expect(voice.agents[0].say).toHaveBeenCalledTimes(1);

        act({ type: 'stop' });
        await vi.waitFor(() => expect(voice.agents[0].stop).toHaveBeenCalled());
        act({ type: 'send', text: 'still there?' });
        expect(voice.modes[0].type).toHaveBeenCalledTimes(1);
        expect(voice.agents.at(-1)!.say).toHaveBeenCalledExactlyOnceWith('still there?', 'text', expect.anything(), { attachments: undefined });
    });

    it('sends nothing when it is empty', () => {
        act({ type: 'send', text: '   ' });
        expect(voice.agents).toEqual([]);
    });
});
