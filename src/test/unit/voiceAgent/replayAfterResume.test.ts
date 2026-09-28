import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceViewClientMessage } from '../../../shared/voiceViewProtocol';
import { encodeWav } from '../../../voice/stt';
import { ReplayPlayer, type ReplayOutput } from '../../../voiceAgent/replay';
import { SpeechCache } from '../../../voiceAgent/speechCache';
import { VoiceTranscriptStore, type VoiceSessionRecord } from '../../../voiceAgent/transcriptStore';
import type { Pcm } from '../../../voiceAgent/tts';
import type { VoiceTurnResult } from '../../../voiceAgent/voiceAgent';
import { VoicePanel, type BotViewSurface, type VoiceViewController } from '../../../voiceAgent/voicePanel';
import type { WorkerController } from '../../../voiceAgent/workerController';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
}));

afterEach(() => vi.unstubAllGlobals());

const done: VoiceTurnResult = { reply: '', silent: false, toolCalls: [], lookups: [], interrupted: false };
/** Audio whose sample rate names the reply it belongs to. */
const audioOf = (rate: number): Pcm => ({ rate, data: Buffer.alloc(320) });

/** Voice mode speaks `reply` as reply `turnId`, and its live audio goes to the cache as voiceAgentCommands does. */
function speak(store: VoiceTranscriptStore, cache: SpeechCache, turnId: number, question: string, reply: string, rate: number): string {
    store.addUser(question, 'stt');
    const { listener } = store.beginReply({ turnId });
    listener.onText?.(reply);
    store.audio({ turnId, type: 'speak', text: reply });
    store.audio({ turnId, type: 'playing', text: reply });
    store.audio({ turnId, type: 'played', text: reply });
    store.audio({ turnId, type: 'idle' });
    const entryId = store.entryIdOfTurn(turnId)!;
    cache.put(entryId, 'voice', [{ text: reply, pcm: audioOf(rate) }]);
    listener.onEnd?.(done);
    return entryId;
}

describe('Bot view replay of a reply spoken after the window reloaded', () => {
    it('plays that reply, not an older one of the resumed conversation that had the same entry id', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-replay-'));
        const voiceSessionFile = path.join(dir, 'voice.jsonl');
        fs.writeFileSync(voiceSessionFile, '');
        const task = { tabId: 't1', sessionFile: '/s/worker.jsonl', name: 'Task' };
        const saved = new Map<string, unknown>();
        const memento = {
            get: <T>(key: string) => saved.get(key) as T | undefined,
            update: async (key: string, value: unknown) => void saved.set(key, JSON.parse(JSON.stringify(value))),
        };
        const limits = { sessions: () => 20, entries: 300 };

        // First run: reply A.
        const firstRun = new VoiceTranscriptStore(memento, limits, () => task);
        firstRun.bindContext(task, voiceSessionFile, false);
        const idA = speak(firstRun, new SpeechCache(), 1, 'Question A', 'Answer A.', 1001);
        firstRun.endRun();

        // The window reloads: a new store, cache and turn numbering; voice resumes the saved conversation.
        const store = new VoiceTranscriptStore(memento, limits, () => task);
        const cache = new SpeechCache();
        const idB = speak(store, cache, 1, 'Question B', 'Answer B.', 2002);
        expect(store.current()!.entries.map((e) => e.kind !== 'system' && e.text)).toEqual(['Question A', 'Answer A.', 'Question B', 'Answer B.']);
        expect(idB).not.toBe(idA);

        // TTS for what is not cached names the text it was asked for by its sample rate.
        const asked: string[] = [];
        vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
            const { input }: { input: string } = JSON.parse(init.body);
            asked.push(input);
            return new Response(encodeWav(new Int16Array(160), input === 'Answer A.' ? 1001 : 9999));
        });
        const played: number[] = [];
        const output = (): ReplayOutput => ({
            signal: new AbortController().signal,
            play: async (pcm) => void played.push(pcm.rate),
            end: () => {},
        });
        const replay = new ReplayPlayer({
            cache,
            ttsKey: () => 'voice',
            tts: async () => ({ engine: 'custom', languageField: 'none', url: 'http://tts.local', model: '', voice: '', speed: 1 }),
            output,
            onChange: () => {},
            onError: (message) => {
                throw new Error(message);
            },
            log: () => {},
        });
        let send: (message: VoiceViewClientMessage) => void = () => {};
        const surface: BotViewSurface = {
            onDidReceiveVoiceMessage: (listener) => {
                send = listener;
                return { dispose: () => {} };
            },
            onDidChangeBotViewVisibility: () => ({ dispose: () => {} }),
            isBotViewVisible: () => false,
            postVoice: () => {},
            showBotView: async () => {},
        };
        const worker = { onActiveTaskChanged: () => ({ dispose: () => {} }), onRequestsChanged: () => ({ dispose: () => {} }) } as unknown as WorkerController;
        const controller = { phase: () => 'listening', replay } as unknown as VoiceViewController;
        new VoicePanel(store, worker, controller, surface);

        // The newest reply: its own live audio, from the cache.
        send({ type: 'replay', entryId: idB, piece: { text: 'Answer B.', range: [0, 9] }, surface: 'bot' });
        await vi.waitFor(() => expect(played).toEqual([2002]));
        expect(asked).toEqual([]);
        await vi.waitFor(() => expect(replay.current).toBeUndefined());

        // The older reply: not cached in this run, synthesized from its own text.
        send({ type: 'replay', entryId: idA, piece: { text: 'Answer A.', range: [0, 9] }, surface: 'bot' });
        await vi.waitFor(() => expect(played).toEqual([2002, 1001]));
        expect(asked).toEqual(['Answer A.']);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('repairs saved conversations whose entries already share ids', () => {
        const entry = (id: string, text: string) => ({ kind: 'system' as const, id, at: 0, text });
        const session = (id: string, entries: VoiceSessionRecord['entries']): VoiceSessionRecord => ({ id, taskKey: 'k', title: 'T', startedAt: 0, updatedAt: 0, entries });
        const saved = [session('s1', [entry('e1', 'a'), entry('e2', 'b'), entry('e1', 'c')]), session('s2', [entry('e2', 'd')])];
        const store = new VoiceTranscriptStore(
            { get: <T>() => saved as T, update: async () => {} },
            { sessions: () => 20, entries: 300 },
            () => undefined,
        );
        const ids = store.sessions().flatMap((s) => s.entries.map((e) => e.id));
        expect(new Set(ids).size).toBe(ids.length);
        // The first of each id keeps it.
        expect(ids.slice(0, 2)).toEqual(['e1', 'e2']);
    });
});
