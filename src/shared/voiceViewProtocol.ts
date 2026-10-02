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

/** Voice mode is on or starting: it owns the microphone. */
export function voiceIsOn(status: VoiceStatus | undefined): boolean {
    return status !== undefined && (status.phase !== 'off' || status.starting);
}

/** A request from the chat's voice controls to the voice agent. */
export type VoiceAgentAction =
    | { type: 'start' }
    | { type: 'stop' }
    | { type: 'mute'; muted: boolean }
    | { type: 'hush' }
    /** The follow button in the status line: whether the editor follows Pi's focus; remembered in the `followPi` setting. */
    | { type: 'follow'; following: boolean }
    /**
     * The model chip in the Bot view's composer: the voice agent's model (`voiceAgent.model`,
     * `provider/id`; empty takes the chat tab's). Never the worker's: the chat's chip sets that one.
     */
    | { type: 'model'; model: string }
    /** Typed in the composer for the voice agent: goes in like speech. */
    | { type: 'send'; text: string; attachments?: VoiceAttachments };

/**
 * The composer's attachments going with a message to the voice agent. The extension host takes
 * them from the chat tab's pending attachments; the webview never sends them.
 */
export interface VoiceAttachments {
    /** The attachments that are not images (or images without a file): their names follow the message text in the Bot view. */
    names: string[];
    /** The attached image files: shown on an image card under the message in the Bot view. */
    imageFiles: VoiceImage[];
    /** Image parts of the user message to the voice model. */
    images: ImageContent[];
    /** `<file>` blocks for the voice model: text files' contents, images' paths. */
    files: string;
}

/** An image the user attached to a message, as the Bot view shows it. */
export interface VoiceImage {
    name: string;
    /** The image file: its full-size view opens it in the editor. */
    path: string;
    /**
     * A webview URI of `path`, set only in the view's snapshots, when the file is in a folder the
     * webview may load from; without it, the view reads the file through `readImageFile`.
     */
    src?: string;
}

/** A user's message as the Bot view shows it. */
export interface VoiceUserMessage {
    /** The text, then the names of the attachments that are not images. */
    text: string;
    /** Attached images, on the message's image card. */
    images?: VoiceImage[];
}

export function voiceUserMessage(text: string, attachments?: VoiceAttachments): VoiceUserMessage {
    const names = attachments?.names.map((name) => `[${name}]`) ?? [];
    const shown = [text, ...names].filter(Boolean).join(' ');
    return attachments?.imageFiles.length ? { text: shown, images: attachments.imageFiles } : { text: shown };
}

/**
 * Tokens of one LLM call of the voice agent (omp `message_end` usage). All four token counts
 * together are the context the call left, which the next call reads.
 */
export interface VoiceCallUsage {
    at: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** USD. */
    cost: number;
    /** The model's context window in tokens; absent when the agent did not report it (and in older transcripts). */
    contextWindow?: number;
}

/**
 * What voice mode sent to STT and TTS in one conversation, successful requests only. Speech
 * services bill by audio length or characters and rarely report tokens: only STT servers that
 * return OpenAI's `usage` (gpt-4o-transcribe) give `input` / `output` tokens.
 */
export interface VoiceSpeechUsage {
    stt?: { calls: number; audioMs: number; input?: number; output?: number };
    tts?: { calls: number; chars: number; audioMs: number };
}

/** One STT or TTS request's use, as `VoiceSpeechUsage` adds it up. */
export type VoiceSpeechCall = { service: 'stt'; audioMs: number; input?: number; output?: number } | { service: 'tts'; chars: number; audioMs: number };

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
          /** Images attached in the composer, shown on an image card under the message. */
          images?: VoiceImage[];
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
    /**
     * `model`: what the voice agent runs (`provider/id`), or will at start; `setting`: `voiceAgent.model`
     * as chosen, empty when it takes the chat tab's model.
     */
    llm: { model?: string; setting: string; thinking: string };
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
    /** The shown conversation's STT and TTS use; absent before its first request. */
    speech?: VoiceSpeechUsage;
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
 * A paragraph or a selection is several sentences read one after another: `parts` are they, each
 * as TTS reads it (and as the speech cache keeps it), and `text` is them joined.
 */
export interface VoiceReplayPiece {
    text: string;
    range?: [start: number, end: number];
    sentence?: number;
    parts?: string[];
}

/**
 * A read aloud: `loading` while the sentence it starts with is with TTS, `queued` until its audio
 * starts, `playing` while the speakers play it, as the audio reports; `paused` until it resumes
 * (the speakers are let go meanwhile). `part`: which of `piece.parts` is being read (or is next
 * when paused); 0 for a single sentence.
 */
export interface VoiceReplay {
    entryId: string;
    piece: VoiceReplayPiece;
    phase: 'loading' | 'queued' | 'playing' | 'paused';
    part: number;
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
     * Alt+click on a sentence (Alt+Shift+click: its paragraph), Read aloud on a selection, or a
     * click (double-click: `from` the word) on the picked text once nothing reads it: read it
     * aloud, or stop if it is the one playing. `surface: 'bot'`: `entryId` is the Bot view entry it
     * is in; `chat`: a key for the chat text it is in; `selection`: a key for the selected text (its
     * audio is cached under the key). `from`: start `fraction` (0..1, by characters) into `part`.
     */
    | { type: 'replay'; entryId: string; piece: VoiceReplayPiece; surface: 'bot' | 'chat' | 'selection'; from?: { part: number; fraction: number } }
    | { type: 'replayClipStarted'; clipId: number }
    | { type: 'replayClipEnded'; clipId: number }
    /**
     * Alt+right-click on a sentence (Alt+Shift: its paragraph), or Translate on a selection:
     * translate this text into `to` (the `translateTo` language as shown), answered by `translation`.
     */
    | { type: 'translate'; requestId: number; text: string; to: string }
    /**
     * The read aloud now, as a playback control: a click on it pauses or resumes it; a click
     * elsewhere or Escape stops it.
     */
    | { type: 'replayControl'; action: 'pause' | 'resume' | 'stop' }
    /**
     * A double-click in the read aloud now: read on from `fraction` (0..1, by characters) into its
     * `part`, playing even when it was paused.
     */
    | { type: 'replaySeek'; part: number; fraction: number }
    /** A Board card's "Open board": board `board` of the voice session the view shows. */
    | { type: 'openBoard'; board: string };
