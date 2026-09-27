/**
 * Messages between the extension and the Bot view, which a chat tab shows in place of its
 * conversation (docs/voice-agent-design.md §11), wrapped in `{ type: 'voice', message }`. The host
 * sends whole snapshots; the view renders them. The chat's own voice controls (robot status line,
 * composer mic) use `VoiceStatus` from the chat protocol instead.
 */

/**
 * Voice mode phase as shown; `off` when voice mode is not running, `muted` when the mic is muted
 * while listening. `synthesizing`: the reply's first sentence is with TTS and nothing plays yet.
 */
export type VoicePhase =
    | 'off'
    | 'standby'
    | 'listening'
    | 'userSpeaking'
    | 'transcribing'
    | 'thinking'
    | 'synthesizing'
    | 'speaking'
    | 'muted';

/** What the chat's robot status line and composer mic show (src/webview/voiceBar.ts, dictation.ts). */
export interface VoiceStatus {
    phase: VoicePhase;
    /** Voice mode is starting: the phase is still `off`. */
    starting: boolean;
    muted: boolean;
    /** `omp`: the voice agent directs the worker; `pair`: it edits and runs commands itself. */
    mode: 'omp' | 'pair';
}

/** What the UI calls each mode. The values stay `omp` / `pair`: the voice model's set_mode tool and saved state use them. */
export const VOICE_MODE_LABEL: Record<VoiceStatus['mode'], string> = { omp: 'Delegate', pair: 'Pair' };

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
    | { type: 'mode'; mode: 'omp' | 'pair' }
    /** Typed in the composer for the voice agent: goes in like speech. */
    | { type: 'send'; text: string };

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

/** Why the voice agent spoke up on its own (design §5.9). */
export type VoiceObservationKind = 'needs_input' | 'error' | 'done' | 'research' | 'progress';

/** One sentence of a spoken reply: queued for TTS, playing, fully played, or cut off before the user heard it all. */
export interface VoiceSentence {
    text: string;
    state: 'pending' | 'playing' | 'played' | 'cut';
}

export interface VoiceToolEntry {
    name: string;
    args: Record<string, unknown>;
    result: string;
    isError: boolean;
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
          tools: VoiceToolEntry[];
          /** The agent's own lookups (read, grep, glob, web_search), described. */
          lookups: string[];
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
    tts: { provider: string; url: string; model: string; voice: string; speed: number; language: string };
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
    /** `omp`: the voice agent directs the worker; `pair`: it edits and runs commands itself. */
    mode: 'omp' | 'pair';
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

export type VoiceViewHostMessage = { type: 'state'; state: VoiceViewState };

export type VoiceViewClientMessage =
    | { type: 'ready' }
    | { type: 'proposal'; id: string; action: 'confirm' | 'cancel' }
    /** The history button: pick a past voice session to read. */
    | { type: 'history' };

