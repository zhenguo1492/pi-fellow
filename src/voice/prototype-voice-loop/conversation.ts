/**
 * PROTOTYPE (voice loop) — conversation state machine for a full-duplex voice chat.
 *
 * Pure reducer: `reduce(state, event) → { state, effects }`. The shell feeds it
 * microphone/STT/LLM/playback events and executes the returned effects
 * (prompt the LLM, speak a sentence, cancel a turn). No I/O here.
 *
 * Policy under test:
 * - The user always wins: speech start while the bot is generating or audible
 *   cancels the bot's turn (barge-in).
 * - A reply is only requested once the user has stopped talking AND every
 *   pending transcription has landed, so utterances split by a pause merge.
 * - After an interruption the next prompt carries an `<interrupted>` note that
 *   says what the user actually heard, since the LLM's context holds the full text.
 *
 * Cancellation contract: every bot turn is one cancellation scope in the shell
 * (an AbortController created on `prompt`). `cancelTurn` aborts it, and the
 * shell then delivers no further events from that turn — no `llmText`,
 * `sentencePlaying/Played` or `audioIdle` — except `llmEnd`, which only says
 * the LLM is free for the next prompt. So the reducer needs no stale-event checks.
 */
import { flushSentence, takeSentences } from './sentences';

export type Phase = 'listening' | 'userSpeaking' | 'transcribing' | 'thinking' | 'speaking';

export interface UserEntry {
    role: 'user';
    text: string;
}

export interface BotEntry {
    role: 'bot';
    turnId: number;
    /** Everything the LLM produced for this reply. */
    generated: string;
    /** Sentences fully played. */
    spoken: string[];
    /** Sentence playing right now. */
    playing?: string;
    llmDone: boolean;
    interrupted: boolean;
}

export interface NoteEntry {
    role: 'note';
    text: string;
}

export type Entry = UserEntry | BotEntry | NoteEntry;

/** Epoch ms of each hop of one exchange; drives the latency readout. */
export interface Metrics {
    silenceAt?: number;
    endDetectedAt?: number;
    sttDoneAt?: number;
    promptAt?: number;
    firstTextAt?: number;
    firstAudioAt?: number;
}

export interface ConvState {
    phase: Phase;
    muted: boolean;
    /** Ignore the microphone while the bot is audible (no-headphones mode). */
    halfDuplex: boolean;
    userSpeaking: boolean;
    sttPending: number;
    /** Transcripts not yet sent to the LLM. */
    userBuffer: string[];
    /** A prompt is in flight until the LLM reports the turn ended — also for a cancelled turn, until its `llmEnd`. */
    llmBusy: boolean;
    /** Sentences queued for TTS or playing. */
    audioActive: boolean;
    /** Streamed text not yet cut into a sentence. */
    textBuffer: string;
    /** Reply currently being generated/spoken. */
    botTurnId?: number;
    nextTurnId: number;
    interruptedNote?: string;
    entries: Entry[];
    metrics: Metrics;
    lastMetrics?: Metrics;
}

export type ConvEvent =
    | { type: 'userSpeechStart'; at: number }
    | { type: 'userSpeechEnd'; at: number; silenceAt: number }
    | { type: 'transcript'; text: string; at: number }
    | { type: 'llmText'; delta: string; at: number }
    | { type: 'llmEnd'; at: number; error?: string }
    | { type: 'sentencePlaying'; turnId: number; text: string; at: number }
    | { type: 'sentencePlayed'; turnId: number; text: string; at: number }
    | { type: 'audioIdle'; at: number }
    | { type: 'shutUp'; at: number }
    | { type: 'toggleMute' }
    | { type: 'toggleHalfDuplex' };

export type Effect =
    | { type: 'prompt'; turnId: number; message: string }
    | { type: 'speak'; turnId: number; text: string }
    /** Stop everything of this turn: LLM generation, pending TTS, queued and playing audio. */
    | { type: 'cancelTurn'; turnId: number };

export interface Step {
    state: ConvState;
    effects: Effect[];
}

export function initialState(): ConvState {
    return {
        phase: 'listening',
        muted: false,
        halfDuplex: false,
        userSpeaking: false,
        sttPending: 0,
        userBuffer: [],
        llmBusy: false,
        audioActive: false,
        textBuffer: '',
        nextTurnId: 1,
        entries: [],
        metrics: {},
    };
}

function currentBot(s: ConvState): BotEntry | undefined {
    return s.entries.find((x): x is BotEntry => x.role === 'bot' && x.turnId === s.botTurnId);
}

function updateBot(s: ConvState, turnId: number | undefined, fn: (b: BotEntry) => BotEntry): ConvState {
    if (turnId === undefined) {
        return s;
    }
    return { ...s, entries: s.entries.map((e) => (e.role === 'bot' && e.turnId === turnId ? fn(e) : e)) };
}

/** What the user heard of the reply being cut off, phrased for the LLM. */
function interruptionNote(bot: BotEntry): string {
    const heard = bot.spoken.join(' ');
    if (!heard && !bot.playing) {
        return 'The user spoke again before your previous reply was voiced; they heard none of it.';
    }
    if (!heard) {
        return `The user interrupted you partway through your first sentence "${bot.playing}"; they heard only part of it and none of the rest.`;
    }
    const partial = bot.playing ? ` (and only part of the next sentence, "${bot.playing}")` : '';
    return `The user interrupted you. They heard only: "${heard}"${partial}. They did not hear the rest.`;
}

/** Cuts the bot off: cancel its turn, remember what the user actually heard. */
function interrupt(s: ConvState): Step {
    const bot = currentBot(s);
    if (!bot) {
        return { state: s, effects: [] }; // nothing in progress (or already cancelled)
    }
    const next = updateBot({ ...s, textBuffer: '', audioActive: false, botTurnId: undefined }, bot.turnId, (b) => ({
        ...b,
        interrupted: true,
        playing: undefined,
    }));
    return {
        state: { ...next, interruptedNote: interruptionNote(bot) },
        effects: [{ type: 'cancelTurn', turnId: bot.turnId }],
    };
}

/** Sends buffered user speech once the user is done and all transcripts are in. */
function tryPrompt(s: ConvState, at: number): Step {
    if (s.userSpeaking || s.sttPending > 0) {
        return { state: s, effects: [] };
    }
    if (s.userBuffer.length === 0) {
        return { state: { ...s, phase: settledPhase(s) }, effects: [] };
    }
    if (s.llmBusy) {
        // An aborted turn has not finished unwinding; prompt when it does.
        return { state: { ...s, phase: 'thinking' }, effects: [] };
    }
    const userText = s.userBuffer.join(' ');
    const message = s.interruptedNote ? `<interrupted>${s.interruptedNote}</interrupted>\n${userText}` : userText;
    const turnId = s.nextTurnId;
    const bot: BotEntry = { role: 'bot', turnId, generated: '', spoken: [], llmDone: false, interrupted: false };
    return {
        state: {
            ...s,
            phase: 'thinking',
            userBuffer: [],
            interruptedNote: undefined,
            llmBusy: true,
            textBuffer: '',
            botTurnId: turnId,
            nextTurnId: turnId + 1,
            entries: [...s.entries, bot],
            metrics: { ...s.metrics, promptAt: at },
        },
        effects: [{ type: 'prompt', turnId, message }],
    };
}

function settledPhase(s: ConvState): Phase {
    if (s.userSpeaking) {
        return 'userSpeaking';
    }
    if (s.sttPending > 0) {
        return 'transcribing';
    }
    if (s.audioActive) {
        return 'speaking';
    }
    if (s.llmBusy && s.botTurnId !== undefined) {
        return 'thinking';
    }
    return 'listening';
}

/** Reply fully generated and fully played: close the exchange. */
function maybeFinish(s: ConvState): ConvState {
    const bot = currentBot(s);
    if (!bot || !bot.llmDone || s.audioActive) {
        return { ...s, phase: settledPhase(s) };
    }
    return { ...s, botTurnId: undefined, phase: settledPhase(s), lastMetrics: s.metrics, metrics: {} };
}

export function reduce(s: ConvState, ev: ConvEvent): Step {
    switch (ev.type) {
        case 'userSpeechStart': {
            const cut = interrupt(s);
            return { state: { ...cut.state, userSpeaking: true, phase: 'userSpeaking' }, effects: cut.effects };
        }
        case 'userSpeechEnd': {
            const metrics = s.botTurnId === undefined && !s.llmBusy ? {} : s.metrics;
            return {
                state: {
                    ...s,
                    userSpeaking: false,
                    sttPending: s.sttPending + 1,
                    phase: 'transcribing',
                    metrics: { ...metrics, silenceAt: ev.silenceAt, endDetectedAt: ev.at },
                },
                effects: [],
            };
        }
        case 'transcript': {
            const text = ev.text.trim();
            let next: ConvState = { ...s, sttPending: Math.max(0, s.sttPending - 1), metrics: { ...s.metrics, sttDoneAt: ev.at } };
            if (text) {
                next.userBuffer = [...s.userBuffer, text];
                const last = s.entries[s.entries.length - 1];
                next.entries =
                    last?.role === 'user'
                        ? [...s.entries.slice(0, -1), { role: 'user', text: `${last.text} ${text}` }]
                        : [...s.entries, { role: 'user', text }];
            }
            return tryPrompt(next, ev.at);
        }
        case 'llmText': {
            if (s.botTurnId === undefined) {
                return { state: s, effects: [] };
            }
            const turnId = s.botTurnId;
            // Nothing queued or playing (start of reply, or TTS ran dry): cut early at a comma.
            const { sentences, rest } = takeSentences(s.textBuffer + ev.delta, !s.audioActive);
            let next = updateBot(s, turnId, (b) => ({ ...b, generated: b.generated + ev.delta }));
            next = {
                ...next,
                textBuffer: rest,
                metrics: { ...s.metrics, firstTextAt: s.metrics.firstTextAt ?? ev.at },
            };
            if (sentences.length) {
                next.audioActive = true;
            }
            return { state: next, effects: sentences.map((text) => ({ type: 'speak', turnId, text })) };
        }
        case 'llmEnd': {
            // Also arrives for a cancelled turn: the LLM is free again, so a waiting prompt can go out.
            let next: ConvState = { ...s, llmBusy: false };
            const effects: Effect[] = [];
            const turnId = s.botTurnId;
            if (turnId !== undefined) {
                const tail = flushSentence(s.textBuffer);
                if (tail) {
                    effects.push({ type: 'speak', turnId, text: tail });
                    next.audioActive = true;
                }
                next = updateBot({ ...next, textBuffer: '' }, turnId, (b) => ({ ...b, llmDone: true }));
            }
            if (ev.error) {
                next.entries = [...next.entries, { role: 'note', text: `LLM 错误：${ev.error}` }];
            }
            const finished = maybeFinish(next);
            const followUp = tryPrompt(finished, ev.at);
            return { state: followUp.state, effects: [...effects, ...followUp.effects] };
        }
        case 'sentencePlaying': {
            const next = updateBot(s, ev.turnId, (b) => ({ ...b, playing: ev.text }));
            return {
                state: {
                    ...next,
                    phase: s.userSpeaking ? 'userSpeaking' : 'speaking',
                    metrics: { ...s.metrics, firstAudioAt: s.metrics.firstAudioAt ?? ev.at },
                },
                effects: [],
            };
        }
        case 'sentencePlayed': {
            return {
                state: updateBot(s, ev.turnId, (b) => ({
                    ...b,
                    spoken: [...b.spoken, ev.text],
                    playing: b.playing === ev.text ? undefined : b.playing,
                })),
                effects: [],
            };
        }
        case 'audioIdle': {
            return { state: maybeFinish({ ...s, audioActive: false }), effects: [] };
        }
        case 'shutUp': {
            const cut = interrupt(s);
            return { state: { ...cut.state, phase: settledPhase(cut.state) }, effects: cut.effects };
        }
        case 'toggleMute':
            return { state: { ...s, muted: !s.muted }, effects: [] };
        case 'toggleHalfDuplex':
            return { state: { ...s, halfDuplex: !s.halfDuplex }, effects: [] };
    }
}
