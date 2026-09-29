/**
 * Messages between the extension and the Bot view, which a chat tab shows in place of its
 * conversation (docs/voice-agent-design.md §11), wrapped in `{ type: 'voice', message }`. The host
 * sends whole snapshots; the view renders them. The chat's own voice controls (robot status line,
 * composer mic) use `VoiceStatus` from the chat protocol instead.
 */

import type { ImageContent } from './piTypes';
import type { VoiceSpeakers } from './voiceSpeakers';

/**
 * Voice mode phase as shown; `off` when voice mode is not running, `muted` when the mic is muted
 * while listening. `soundDetected`: a sound is heard that the voiceprint check has not yet found to
 * be the user's (`userSpeaking` once it has). `synthesizing`: the reply's first sentence is with TTS
 * and nothing plays yet.
 */
export type VoicePhase =
    | 'off'
    | 'standby'
    | 'listening'
    | 'soundDetected'
    | 'userSpeaking'
    | 'transcribing'
    | 'thinking'
    | 'synthesizing'
    | 'speaking'
    | 'muted';

/**
 * Why voice mode runs without a speech service, in plain words: no `stt`, it cannot hear (the
 * microphone stays closed, the user types); no `tts`, it cannot speak (replies are only shown).
 */
export interface VoiceUnavailable {
    stt?: string;
    tts?: string;
}

/** What the chat's robot status line and composer mic show (src/webview/voiceBar.ts, dictation.ts). */
export interface VoiceStatus {
    phase: VoicePhase;
    /** Voice mode is starting: the phase is still `off`. */
    starting: boolean;
    muted: boolean;
    /** The editor follows Pi's focus (AgentCursor): opens and scrolls to what Pi points at, reads or writes. */
    following: boolean;
    /** While voice mode is on: the speech services it runs without; absent while off or starting. */
    unavailable?: VoiceUnavailable;
}

/** Voice mode is on or starting: the composer's text can go to the voice agent. */
export function voiceIsOn(status: VoiceStatus | undefined): boolean {
    return status !== undefined && (status.phase !== 'off' || status.starting);
}

/** The Bot view with the voice agent offline: the composer is locked, and its placeholder says why. */
export const VOICE_OFFLINE_SEND_HINT = 'The voice agent must be online to send messages';
export const VOICE_OFFLINE_SEND_TITLE =
    'The voice agent must be online to send messages here: start it with the robot above, or go back to the worker conversation.';

/** A request from the chat's voice controls to the voice agent. */
export type VoiceAgentAction =
    | { type: 'start' }
    | { type: 'stop' }
    | { type: 'mute'; muted: boolean }
    | { type: 'hush' }
    /** The follow button in the status line: whether the editor follows Pi's focus; remembered in the `followPi` setting. */
    | { type: 'follow'; following: boolean }
    /** Typed in the composer for the voice agent: goes in like speech. */
    | { type: 'send'; text: string; attachments?: VoiceAttachments };

/**
 * The composer's attachments going with a message to the voice agent. The extension host takes
 * them from the chat tab's pending attachments; the webview never sends them.
 */
export interface VoiceAttachments {
    /** Shown with the message in the Bot view. */
    names: string[];
    /** Image parts of the user message to the voice model. */
    images: ImageContent[];
    /** `<file>` blocks for the voice model: text files' contents, images' paths. */
    files: string;
}

/** The user's message as the Bot view shows it: the text, then the attachments' names. */
export function voiceUserText(text: string, attachments?: VoiceAttachments): string {
    const names = attachments?.names.map((name) => `[${name}]`) ?? [];
    return [text, ...names].filter(Boolean).join(' ');
}

/** Tokens of one LLM call of the voice agent (omp `message_end` usage). */
export interface VoiceCallUsage {
    at: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** USD. */
    cost: number;
}

/** How long one spoken user turn took to be heard, in ms; each part only when both of its ends were seen. */
export interface VoiceHearing {
    /** Stopped talking → end of the turn detected (the silence waited out). */
    endOfTurn?: number;
    /** End of the turn detected → transcript. */
    stt?: number;
}

/** Where one reply's time went, in ms; each part only when both of its ends were seen. */
export interface VoiceLatency {
    /** Prompt sent → first reply text. */
    llmFirstText?: number;
    /** Prompt sent → reply complete. */
    llmTotal?: number;
    /** First sentence handed to TTS → its audio started playing. */
    ttsFirstAudio?: number;
    /** The user stopped talking (or the prompt went out) → the reply was heard. */
    total?: number;
    /** Prompt sent → the reply was cut off. */
    cutOff?: number;
}

/** Why the voice agent spoke up on its own (design §5.9); `opening`: it speaks first as voice comes on. */
export type VoiceObservationKind = 'approval' | 'needs_input' | 'stopped' | 'error' | 'done' | 'research' | 'progress' | 'opening';

/** One sentence of a spoken reply: queued for TTS, playing, fully played, or cut off before the user heard it all. */
export interface VoiceSentence {
    text: string;
    state: 'pending' | 'playing' | 'played' | 'cut';
}

/** A host tool call of a reply, or one of the voice agent's own lookups (read, grep, glob, web_search), in call order. */
export interface VoiceToolEntry {
    name: string;
    args: Record<string, unknown>;
    result: string;
    isError: boolean;
    /** A lookup's tool call id, which its end is matched by. */
    id?: string;
    /** A lookup still waiting for its result. */
    running?: boolean;
    /** research: the background job the call started, which outlives the reply. */
    research?: VoiceToolResearch;
}

export interface VoiceToolResearch {
    status: 'running' | 'done' | 'failed';
    startedAt: number;
    finishedAt?: number;
    /** The findings when done; the error when failed. */
    result?: string;
}

export type VoiceEntry =
    | {
          kind: 'user';
          id: string;
          at: number;
          text: string;
          /** `panel`: a button in the Bot view (confirm, cancel, …). */
          source: 'stt' | 'text' | 'panel';
          /** Spoken or typed over a reply, cutting it off. */
          bargeIn?: boolean;
          /** Voice mode, spoken turns: how long hearing it took. */
          latency?: VoiceHearing;
      }
    | {
          kind: 'assistant';
          id: string;
          at: number;
          /** Set for a turn the agent started on its own. */
          proactive?: VoiceObservationKind;
          /** Replied `<silent/>`: shown only with the debug transcript. */
          silent?: boolean;
          /** Streamed reply text so far. */
          text: string;
          /** Voice mode only: the reply as it went to TTS, with playback state. Absent for typed-only turns. */
          sentences?: VoiceSentence[];
          /** Host tool calls and the agent's own lookups, in call order. */
          tools: VoiceToolEntry[];
          done: boolean;
          interrupted?: boolean;
          error?: string;
          /** Debug transcript: the whole message sent to the voice model for this turn. */
          input?: string;
          /** One entry per LLM call this reply took (several when it used tools). */
          usage?: VoiceCallUsage[];
          /** Voice mode: where the exchange's time went, once its audio has finished or it was cut off. */
          latency?: VoiceLatency;
      }
    | { kind: 'system'; id: string; at: number; text: string };

export interface VoiceProposalCard {
    id: string;
    message: string;
}

export interface VoiceResearchCard {
    id: string;
    question: string;
    status: 'running' | 'done' | 'failed';
    startedAt: number;
    finishedAt?: number;
}

export interface VoiceWorkerCard {
    tabId: string;
    name: string;
    model?: string;
    phase: 'idle' | 'working' | 'awaiting' | 'error';
    elapsedMs?: number;
    queued: number;
    error?: string;
    /** Newest last: the worker's latest steps in plain language. */
    recent: Array<{ at: number; text: string }>;
}

export interface VoiceRequestCard {
    tabId: string;
    id: string;
    method: 'select' | 'confirm' | 'input' | 'editor' | string;
    title?: string;
    message?: string;
    options?: string[];
}

/** The services voice mode uses, as resolved (defaults filled in), for the Bot view's header. */
export interface VoiceEngines {
    /** Voice mode is running: the values are in use, not just configured. */
    running: boolean;
    llm: { model?: string; thinking: string };
    stt: { url: string; model: string; language: string };
    tts: { engine: 'built-in' | 'custom'; url: string; model: string; voice: string; speed: number; language: string };
}

/** The voice context's token totals and context window use (omp `get_session_stats`). */
export interface VoiceUsageTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** USD. */
    cost: number;
    context?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface VoiceViewState {
    phase: VoicePhase;
    engines: VoiceEngines;
    /** The loaded voice context's totals; absent before its first turn. */
    usage?: VoiceUsageTotals;
    session: {
        id: string;
        title: string;
        startedAt: number;
        /** A past session picked from history: no cards. */
        readonly: boolean;
    };
    entries: VoiceEntry[];
    proposals: VoiceProposalCard[];
    research: VoiceResearchCard[];
    worker?: VoiceWorkerCard;
    requests: VoiceRequestCard[];
    /** `oh-my-pi-chater.voiceAgent.debugTranscript`: show `input` of each turn and silent turns. */
    debug: boolean;
}

/**
 * A sentence, as TTS reads it, and where it is: `range` in the text it is in as shown (start
 * inclusive, end exclusive), or `sentence`, which of a Bot view reply's spoken sentences
 * (`VoiceEntry.sentences`) it is when the view shows those one by one. Exactly one of them is set.
 */
export interface VoiceReplayPiece {
    text: string;
    range?: [start: number, end: number];
    sentence?: number;
}

/**
 * A sentence being read aloud: `loading` while it is with TTS, `queued` until its audio starts,
 * `playing` while the speakers play it, as the audio reports.
 */
export interface VoiceReplay {
    entryId: string;
    piece: VoiceReplayPiece;
    phase: 'loading' | 'queued' | 'playing';
}

/** A sentence's translation into the `translateTo` language. */
export type VoiceTranslation = { text: string } | { alreadyInTarget: true } | { error: string };

export type VoiceViewHostMessage =
    | { type: 'state'; state: VoiceViewState }
    /**
     * Alt over sentences (`voiceAgent.messageButtons`, `voiceAgent.translateTo`) and the sentence
     * being read aloud. Sent whether or not the Bot view shows: the chat's messages have the
     * gestures too.
     */
    | { type: 'sentenceActions'; enabled: boolean; translateTo: string; replay?: VoiceReplay }
    /** The names and avatars of the user and the voice agent; sent when they change and when the view shows. */
    | { type: 'speakers'; speakers: VoiceSpeakers }
    /** The answer to `translate`. */
    | { type: 'translation'; requestId: number; result: VoiceTranslation }
    /** A sentence could not be read aloud, in plain words. */
    | { type: 'replayError'; message: string }
    /**
     * Replay without voice mode plays in the webview: one sentence, 16-bit mono PCM (base64) at
     * `rate`; the webview answers `replayClipStarted` as it starts playing and `replayClipEnded`
     * once it has played.
     */
    | { type: 'replayAudio'; clipId: number; rate: number; pcm: string }
    /** Stop the replay audio playing and queued in the webview. */
    | { type: 'replayHalt' };

export type VoiceViewClientMessage =
    | { type: 'ready' }
    | { type: 'proposal'; id: string; action: 'confirm' | 'cancel' }
    /** The history button: pick a past voice session to read. */
    | { type: 'history' }
    /**
     * Alt+click on a sentence: read it aloud, or stop if it is the one playing. `surface: 'bot'`:
     * `entryId` is the Bot view entry it is in; `chat`: a key for the chat text it is in (its
     * audio is cached under it).
     */
    | { type: 'replay'; entryId: string; piece: VoiceReplayPiece; surface: 'bot' | 'chat' }
    | { type: 'replayClipStarted'; clipId: number }
    | { type: 'replayClipEnded'; clipId: number }
    /** Alt+right-click on a sentence: translate this text into `to` (the `translateTo` language as shown), answered by `translation`. */
    | { type: 'translate'; requestId: number; text: string; to: string };
