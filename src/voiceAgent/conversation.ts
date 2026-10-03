/**
 * Conversation state machine of voice mode (docs/voice-agent-design.md §4.3), adapted from the
 * voice-loop prototype. Pure reducer: `reduce(state, event) → { state, effects }`. The executor
 * (voiceMode.ts) feeds it microphone, STT, reply and playback events and runs the effects.
 *
 * - The user always wins: speech over the reply's voice (or a typed message) cancels the reply in
 *   progress. With the voiceprint check on, speech is first only a sound (`soundDetected`): it holds
 *   the floor, so no reply goes out or starts over it, but only once it is found to be the user's
 *   voice does it become `userSpeaking` and cut the reply off (or its words do, when they come in).
 * - Speech while the reply is still silent (thinking, or working through tool calls) cuts nothing
 *   yet: the reply's text is held while the user has the floor. A short remark (`isRemark`) then goes
 *   into the running reply at its next turn boundary (`steer`, pi's Agent.steer) and the held text is
 *   spoken; anything longer, or a stop word, cuts the reply off and goes out as a new prompt.
 * - A prompt goes out only once the user has stopped talking AND every transcription has landed,
 *   so an utterance split by a pause is one turn.
 * - A reply cut off leaves an `<interrupted>` note saying what the user actually heard; it goes
 *   with the next prompt, because the LLM's context holds the full text.
 * - The voice agent may start a reply on its own (a proactive turn); it only gets the floor
 *   when nobody is talking and nothing is waiting to be said.
 * - Whether the bot is speaking is decided only by what the audio page reports as actually
 *   playing (pipecat's output transport, BotStarted/StoppedSpeaking). Once started, the bot keeps
 *   speaking across the gaps between the sentences of one reply; it stops when the reply's audio
 *   is over, when nothing has been playing or synthesizing for a while mid-reply (a tool call),
 *   or when it is cut off.
 * - Without text-to-speech (`voiced: false`) replies are only shown as text: nothing goes to TTS,
 *   the status goes from thinking back to listening once the reply is generated.
 *
 * Cancellation contract: every reply is one cancellation scope in the executor. `cancelTurn`
 * aborts it, and the executor delivers no further event of that turn. So no stale-event checks
 * are needed beyond matching the current turn id.
 */
import type { VoiceAttachments } from '../shared/voiceViewProtocol';
import { flushSentence, takeSentences } from './sentences';

/**
 * `standby`: another VS Code window has the voice; this one neither listens nor speaks.
 * `soundDetected`: a sound is being heard that the voiceprint check has not yet found to be the user's.
 * `synthesizing`: sentences are with TTS but nothing is playing yet.
 */
export type Phase = 'standby' | 'listening' | 'soundDetected' | 'userSpeaking' | 'transcribing' | 'synthesizing' | 'thinking' | 'speaking';

export interface BotTurn {
    turnId: number;
    /** Everything generated for this reply so far. */
    generated: string;
    /** Sentences fully played. */
    spoken: string[];
    /** Sentence playing right now. */
    playing?: string;
    llmDone: boolean;
}

/** Epoch ms of each hop of one exchange, for the latency log and `onMetrics`. */
export interface Metrics {
    silenceAt?: number;
    endDetectedAt?: number;
    sttDoneAt?: number;
    promptAt?: number;
    firstTextAt?: number;
    /** The first sentence went to TTS. */
    firstSpeakAt?: number;
    /** The first sentence started playing, as the audio page reported it. */
    firstAudioAt?: number;
    llmDoneAt?: number;
    /** The reply was cut off. */
    cutAt?: number;
}

export interface ConvState {
    /** This window has the microphone and speakers (design §13 R9). */
    active: boolean;
    /** Replies are spoken; false when voice mode runs without text-to-speech and replies are only shown. */
    voiced: boolean;
    /** TTS came or went while a reply was being given: `voiced` takes this once that reply is over. */
    nextVoiced?: boolean;
    userSpeaking: boolean;
    /** A sound is being heard, not yet known to be the user's voice: it holds the floor but cuts nothing off. */
    soundDetected: boolean;
    sttPending: number;
    /** Transcripts still to come that a typed message voided: dropped when they land. */
    sttDiscard: number;
    /** The sound or speech in progress when a message was typed: it counts for nothing when it ends. */
    muteSegment: boolean;
    /** Heard or typed, not yet sent; typed messages may carry the composer's attachments. */
    userBuffer: Array<{ text: string; source: 'text' | 'stt'; attachments?: VoiceAttachments }>;
    /**
     * Sentences of the current reply are being synthesized, queued or played: set when one goes to
     * TTS, cleared when TTS and the page run dry (`audioIdle`) or the reply is cut off.
     */
    ttsActive: boolean;
    /**
     * Audio of the current reply is coming out of the speakers, as the page reports it: from the
     * first sentence that starts playing until the reply's audio is over, the mid-reply fallback
     * (`botStoppedSpeaking`), or a cut-off. Gaps between sentences do not end it.
     */
    botSpeaking: boolean;
    /** Streamed reply text not yet cut into a sentence. */
    textBuffer: string;
    /** The reply being generated or played; cleared when it ends or is cut off. */
    bot?: BotTurn;
    /** Generated text of earlier replies, newest last: what an echo would repeat. */
    recentReplies: string[];
    nextTurnId: number;
    /** What the user heard of the last reply that was cut off; goes with the next prompt. */
    interruptedNote?: string;
    metrics: Metrics;
    /** Metrics of the last finished exchange. */
    lastMetrics?: Metrics;
}

export type ConvEvent =
    | { type: 'userSpeechStart'; at: number }
    /** Speech started while the voiceprint check is on: a sound until it is found to be the user's voice (`userSpeechStart`). */
    | { type: 'userSoundStart'; at: number }
    /** The sound ended without a segment to transcribe (another path took its audio over). */
    | { type: 'userSoundEnd'; at: number }
    | { type: 'userSpeechEnd'; at: number; silenceAt: number }
    | { type: 'transcript'; text: string; at: number }
    /** A message typed while voice mode is on: it cuts the reply off like speech does. */
    | { type: 'typed'; text: string; attachments?: VoiceAttachments; at: number }
    /** A remark could not be steered into the reply (it had just ended): it goes out as a new prompt. */
    | { type: 'steerFailed'; text: string; at: number }
    /** The voice agent wants to speak up on its own (design §5.9). */
    | { type: 'proactiveStart'; at: number }
    | { type: 'llmText'; turnId: number; delta: string; at: number }
    | { type: 'llmEnd'; turnId: number; at: number }
    /** Reported by the audio page as the sentence's audio, `durationMs` long, actually starts playing at `at`. */
    | { type: 'sentencePlaying'; turnId: number; text: string; durationMs: number; at: number }
    | { type: 'sentencePlayed'; turnId: number; text: string; at: number }
    /** Nothing of the turn is synthesizing, queued or playing any more. */
    | { type: 'audioIdle'; turnId: number; at: number }
    /** Mid-reply, nothing has played or synthesized for a while (pipecat's 3 s fallback): the bot fell silent. */
    | { type: 'botStoppedSpeaking'; turnId: number; at: number }
    /** This window gained or lost the voice (focus moved between VS Code windows in voice mode). */
    | { type: 'active'; active: boolean; at: number }
    /** The user stopped the reply without saying anything (voice panel, Esc). */
    | { type: 'hush'; at: number }
    /** Text-to-speech became available (or not): from the next reply on, replies are spoken (or only shown). */
    | { type: 'voiced'; voiced: boolean; at: number };

export type Effect =
    | { type: 'prompt'; turnId: number; text: string; source: 'text' | 'stt'; interrupted?: string; attachments?: VoiceAttachments }
    /** A proactive turn got the floor: scope its reply to `turnId`. */
    | { type: 'adopt'; turnId: number }
    | { type: 'speak'; turnId: number; text: string }
    /** A short remark of the user's goes into the running reply `turnId` at its next turn boundary, which goes on. */
    | { type: 'steer'; turnId: number; text: string }
    /** Stop everything of this turn: generation, pending TTS, queued and playing audio. `metrics`: the cut-off exchange's hops. */
    | { type: 'cancelTurn'; turnId: number; metrics: Metrics };

export interface Step {
    state: ConvState;
    effects: Effect[];
}

const RECENT_REPLIES = 2;
/** A remark steered into a running reply: at most this many words, or CJK characters, and no stop word. */
const REMARK_MAX_WORDS = 12;
const REMARK_MAX_CJK = 20;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
/** Words that mean the user wants the reply to stop or change course: those cut it off. */
const STOP_WORDS = /\b(stop|wait|hold on|cancel|no|nope|never ?mind|forget it|scratch that|quiet|shut up)\b/i;
const STOP_CJK = /(停|等等|等一下|等下|别|不要|不对|不是|取消|算了|闭嘴|安静)/;

/**
 * Words said while a reply is silently at work that it can take in without starting over: short,
 * and not a stop word ("stop", "no", "等等", "不对"…), which cut the reply off instead.
 */
export function isRemark(text: string): boolean {
    const t = text.trim();
    if (!t || STOP_WORDS.test(t) || STOP_CJK.test(t)) {
        return false;
    }
    const cjk = t.match(CJK)?.length ?? 0;
    const words = t.replace(CJK, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    return cjk <= REMARK_MAX_CJK && words <= REMARK_MAX_WORDS;
}

export function initialState(active = true, voiced = true): ConvState {
    return {
        active,
        voiced,
        userSpeaking: false,
        soundDetected: false,
        sttPending: 0,
        sttDiscard: 0,
        muteSegment: false,
        userBuffer: [],
        ttsActive: false,
        botSpeaking: false,
        textBuffer: '',
        recentReplies: [],
        nextTurnId: 1,
        metrics: {},
    };
}

/** The status shown: userSpeaking > speaking > soundDetected > transcribing > synthesizing > thinking > listening. */
export function phaseOf(s: ConvState): Phase {
    if (!s.active) {
        return 'standby';
    }
    if (s.userSpeaking) {
        return 'userSpeaking';
    }
    if (s.botSpeaking) {
        return 'speaking';
    }
    if (s.soundDetected) {
        return 'soundDetected';
    }
    if (s.sttPending > 0) {
        return 'transcribing';
    }
    if (s.ttsActive) {
        return 'synthesizing';
    }
    return s.bot || s.userBuffer.length > 0 ? 'thinking' : 'listening';
}

/** Nobody is talking and nothing is waiting to be said: the voice agent may speak up. */
export function floorFree(s: ConvState): boolean {
    return s.active && !s.userSpeaking && !s.soundDetected && s.sttPending === 0 && s.userBuffer.length === 0 && !s.bot;
}

/** The reply's voice is synthesizing or coming out: speaking over it is a barge-in. */
function botAudible(s: ConvState): boolean {
    return s.botSpeaking || s.ttsActive;
}

/** The user has the floor: talking, a sound being checked, words being transcribed or waiting to go out. A reply's text waits meanwhile. */
function userHolds(s: ConvState): boolean {
    return s.userSpeaking || s.soundDetected || s.sttPending > 0 || s.userBuffer.length > 0;
}

/** What an echo of the bot would repeat: the reply in progress and the one before it. */
export function echoSource(s: ConvState): string {
    return [...s.recentReplies, ...(s.bot ? [s.bot.generated] : [])].slice(-RECENT_REPLIES).join(' ');
}

function withBot(s: ConvState, turnId: number, fn: (b: BotTurn) => BotTurn): ConvState {
    return s.bot?.turnId === turnId ? { ...s, bot: fn(s.bot) } : s;
}

/** The reply is over: it becomes an echo reference, and a change of `voiced` waiting for it applies. */
function retire(s: ConvState, bot: BotTurn): ConvState {
    return {
        ...s,
        bot: undefined,
        voiced: s.nextVoiced ?? s.voiced,
        nextVoiced: undefined,
        recentReplies: [...s.recentReplies, bot.generated].slice(-RECENT_REPLIES),
    };
}

/** What the user heard of the reply being cut off, phrased for the LLM. */
function interruptionNote(s: ConvState, bot: BotTurn): string {
    if (!s.voiced) {
        return 'The user sent a new message while you were still writing your previous reply; they saw only the part written so far.';
    }
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

/** Cuts the bot off: cancel its turn, remember what the user actually heard, close the exchange's metrics. */
function interrupt(s: ConvState, at: number): Step {
    const bot = s.bot;
    if (!bot) {
        return { state: s, effects: [] };
    }
    return {
        state: { ...retire(s, bot), textBuffer: '', ttsActive: false, botSpeaking: false, interruptedNote: interruptionNote(s, bot), metrics: {} },
        effects: [{ type: 'cancelTurn', turnId: bot.turnId, metrics: { ...s.metrics, cutAt: at } }],
    };
}

function newBot(s: ConvState): { state: ConvState; turnId: number } {
    const turnId = s.nextTurnId;
    const bot: BotTurn = { turnId, generated: '', spoken: [], llmDone: false };
    return { state: { ...s, bot, textBuffer: '', nextTurnId: turnId + 1 }, turnId };
}

/** `count` sentences of the reply go to TTS now. */
function toTts(s: ConvState, count: number, at: number): ConvState {
    if (count === 0) {
        return s;
    }
    return { ...s, ttsActive: true, metrics: { ...s.metrics, firstSpeakAt: s.metrics.firstSpeakAt ?? at } };
}

/** Sends what the user said once they are done and every transcript is in. */
function tryPrompt(s: ConvState, at: number): Step {
    if (s.userSpeaking || s.soundDetected || s.sttPending > 0 || s.userBuffer.length === 0) {
        return { state: s, effects: [] };
    }
    const text = s.userBuffer.map((part) => part.text).filter(Boolean).join(' ');
    const source = s.userBuffer.every((part) => part.source === 'text') ? 'text' : 'stt';
    const bot = s.bot;
    if (bot) {
        // The reply went on silently while they spoke: a remark goes into it, anything else replaces it.
        if (source === 'stt' && !bot.llmDone && isRemark(text)) {
            const resumed = resume({ ...s, userBuffer: [] }, at);
            return { state: resumed.state, effects: [{ type: 'steer', turnId: bot.turnId, text }, ...resumed.effects] };
        }
        const cut = interrupt(s, at);
        // The new exchange keeps when the words ended and were transcribed.
        const next = tryPrompt({ ...cut.state, metrics: { silenceAt: s.metrics.silenceAt, endDetectedAt: s.metrics.endDetectedAt, sttDoneAt: s.metrics.sttDoneAt } }, at);
        return { state: next.state, effects: [...cut.effects, ...next.effects] };
    }
    const attached = s.userBuffer.flatMap((part) => (part.attachments ? [part.attachments] : []));
    const attachments: VoiceAttachments | undefined = attached.length
        ? {
              names: attached.flatMap((a) => a.names),
              imageFiles: attached.flatMap((a) => a.imageFiles),
              images: attached.flatMap((a) => a.images),
              files: attached.map((a) => a.files).join(''),
          }
        : undefined;
    const interrupted = s.interruptedNote;
    const { state, turnId } = newBot({ ...s, userBuffer: [], interruptedNote: undefined, metrics: { ...s.metrics, promptAt: at } });
    return { state, effects: [{ type: 'prompt', turnId, text, source, ...(interrupted ? { interrupted } : {}), ...(attachments ? { attachments } : {}) }] };
}

/** The user gave the floor back to a reply that went on silently: the text it held goes to TTS, and a reply generated meanwhile ends. */
function resume(s: ConvState, at: number): Step {
    const bot = s.bot;
    if (!bot || userHolds(s) || !s.voiced) {
        return { state: s, effects: [] };
    }
    const { sentences, rest } = takeSentences(s.textBuffer, !s.ttsActive);
    const tail = bot.llmDone ? flushSentence(rest) : undefined;
    const spoken = tail ? [...sentences, tail] : sentences;
    const next = toTts({ ...s, textBuffer: bot.llmDone ? '' : rest }, spoken.length, at);
    return { state: bot.llmDone ? maybeFinish(next) : next, effects: spoken.map((text) => ({ type: 'speak', turnId: bot.turnId, text })) };
}

/** Reply fully generated and its audio over (or dropped): close the exchange, and the bot falls silent. */
function maybeFinish(s: ConvState): ConvState {
    if (!s.bot?.llmDone || s.ttsActive) {
        return s;
    }
    return { ...retire(s, s.bot), botSpeaking: false, lastMetrics: s.metrics, metrics: {} };
}

export function reduce(s: ConvState, ev: ConvEvent): Step {
    switch (ev.type) {
        case 'userSpeechStart': {
            if (s.muteSegment) {
                return { state: s, effects: [] }; // the speech a typed message voided: it cuts nothing off
            }
            // Over the reply's voice it is a barge-in, cut off at once. A reply still silent (thinking, or at
            // its tool calls) goes on, its text held, until the words show whether it can take them in.
            const cut = s.bot && !botAudible(s) ? { state: s, effects: [] } : interrupt(s, ev.at);
            return { state: { ...cut.state, userSpeaking: true, soundDetected: false }, effects: cut.effects };
        }
        case 'userSoundStart':
            return { state: s.userSpeaking || s.muteSegment ? s : { ...s, soundDetected: true }, effects: [] };
        case 'userSoundEnd': {
            const prompted = tryPrompt({ ...s, soundDetected: false, muteSegment: false }, ev.at);
            const resumed = resume(prompted.state, ev.at);
            return { state: resumed.state, effects: [...prompted.effects, ...resumed.effects] };
        }
        case 'userSpeechEnd': {
            if (s.muteSegment) {
                // Its transcript still comes: drop it when it lands.
                return { state: { ...s, muteSegment: false, sttDiscard: s.sttDiscard + 1 }, effects: [] };
            }
            const metrics = s.bot ? s.metrics : {};
            return {
                state: {
                    ...s,
                    userSpeaking: false,
                    soundDetected: false,
                    sttPending: s.sttPending + 1,
                    metrics: { ...metrics, silenceAt: ev.silenceAt, endDetectedAt: ev.at },
                },
                effects: [],
            };
        }
        case 'transcript': {
            if (s.sttDiscard > 0) {
                return { state: { ...s, sttDiscard: s.sttDiscard - 1 }, effects: [] }; // voided by a typed message
            }
            // Heard before the voice moved to another window: nobody here is listening for the answer.
            const text = s.active ? ev.text.trim() : '';
            // Words the voiceprint check let through only once they were done still cut the reply off
            // when it is speaking; the new exchange keeps when they ended. A silent reply waits for tryPrompt.
            const cut = text && s.bot && botAudible(s) ? interrupt(s, ev.at) : { state: s, effects: [] };
            const metrics = cut.effects.length ? { silenceAt: s.metrics.silenceAt, endDetectedAt: s.metrics.endDetectedAt } : s.metrics;
            const next: ConvState = {
                ...cut.state,
                sttPending: Math.max(0, s.sttPending - 1),
                userBuffer: text ? [...s.userBuffer, { text, source: 'stt' }] : s.userBuffer,
                metrics: { ...metrics, sttDoneAt: ev.at },
            };
            const prompted = tryPrompt(next, ev.at);
            // Nothing came of it (a noise): a reply that went on silently speaks what it held.
            const resumed = resume(prompted.state, ev.at);
            return { state: resumed.state, effects: [...cut.effects, ...prompted.effects, ...resumed.effects] };
        }
        case 'typed': {
            // Typing wins over talking: words still being spoken, transcribed or waiting to go out count
            // for nothing, and the typed message goes out at once.
            const cut = interrupt(s, ev.at);
            const typed = { text: ev.text, source: 'text' as const, attachments: ev.attachments };
            if (!ev.text.trim()) {
                // Only attachments: the words being said are about them, so they wait for those words.
                const joined = tryPrompt({ ...cut.state, userBuffer: [...cut.state.userBuffer, typed] }, ev.at);
                return { state: joined.state, effects: [...cut.effects, ...joined.effects] };
            }
            const voided: ConvState = {
                ...cut.state,
                muteSegment: cut.state.muteSegment || cut.state.userSpeaking || cut.state.soundDetected,
                userSpeaking: false,
                soundDetected: false,
                sttDiscard: cut.state.sttDiscard + cut.state.sttPending,
                sttPending: 0,
                userBuffer: [...cut.state.userBuffer.filter((part) => part.source === 'text'), typed],
            };
            const next = tryPrompt(voided, ev.at);
            return { state: next.state, effects: [...cut.effects, ...next.effects] };
        }
        case 'steerFailed': {
            // The reply it was meant for had just ended: the remark is a new message.
            const cut = interrupt(s, ev.at);
            const next = tryPrompt({ ...cut.state, userBuffer: [...cut.state.userBuffer, { text: ev.text, source: 'stt' }] }, ev.at);
            return { state: next.state, effects: [...cut.effects, ...next.effects] };
        }
        case 'proactiveStart': {
            if (!floorFree(s)) {
                return { state: s, effects: [] };
            }
            const { state, turnId } = newBot({ ...s, metrics: {} });
            return { state, effects: [{ type: 'adopt', turnId }] };
        }
        case 'llmText': {
            if (s.bot?.turnId !== ev.turnId) {
                return { state: s, effects: [] };
            }
            const turnId = ev.turnId;
            const next = withBot(s, turnId, (b) => ({ ...b, generated: b.generated + ev.delta }));
            const metrics = { ...s.metrics, firstTextAt: s.metrics.firstTextAt ?? ev.at };
            if (!s.voiced) {
                return { state: { ...next, metrics }, effects: [] };
            }
            // The user has the floor over a reply still silent: its text waits for them (resume).
            if (userHolds(s)) {
                return { state: { ...next, textBuffer: s.textBuffer + ev.delta, metrics }, effects: [] };
            }
            // Nothing synthesizing, queued or playing (start of reply, or TTS ran dry): cut early at a comma.
            const { sentences, rest } = takeSentences(s.textBuffer + ev.delta, !s.ttsActive);
            return {
                state: toTts({ ...next, textBuffer: rest, metrics }, sentences.length, ev.at),
                effects: sentences.map((text) => ({ type: 'speak', turnId, text })),
            };
        }
        case 'llmEnd': {
            if (s.bot?.turnId !== ev.turnId) {
                return { state: s, effects: [] };
            }
            if (s.voiced && userHolds(s)) {
                // Generated while the user has the floor: its held text waits for them (resume).
                return { state: withBot({ ...s, metrics: { ...s.metrics, llmDoneAt: ev.at } }, ev.turnId, (b) => ({ ...b, llmDone: true })), effects: [] };
            }
            const tail = flushSentence(s.textBuffer);
            const done = withBot({ ...s, textBuffer: '', metrics: { ...s.metrics, llmDoneAt: ev.at } }, ev.turnId, (b) => ({
                ...b,
                llmDone: true,
            }));
            const next = toTts(done, tail === undefined ? 0 : 1, ev.at);
            return {
                state: maybeFinish(next),
                effects: tail ? [{ type: 'speak', turnId: ev.turnId, text: tail }] : [],
            };
        }
        case 'sentencePlaying':
            if (s.bot?.turnId !== ev.turnId) {
                return { state: s, effects: [] };
            }
            return {
                state: {
                    ...withBot(s, ev.turnId, (b) => ({ ...b, playing: ev.text })),
                    botSpeaking: true,
                    metrics: { ...s.metrics, firstAudioAt: s.metrics.firstAudioAt ?? ev.at },
                },
                effects: [],
            };
        case 'sentencePlayed':
            return {
                state: withBot(s, ev.turnId, (b) => ({
                    ...b,
                    spoken: [...b.spoken, ev.text],
                    playing: b.playing === ev.text ? undefined : b.playing,
                })),
                effects: [],
            };
        case 'audioIdle':
            if (s.bot?.turnId !== ev.turnId) {
                return { state: s, effects: [] };
            }
            // Mid-reply the bot stays speaking across the gap; only the fallback or the end silences it.
            return { state: maybeFinish({ ...s, ttsActive: false }), effects: [] };
        case 'botStoppedSpeaking':
            if (s.bot?.turnId !== ev.turnId) {
                return { state: s, effects: [] };
            }
            return { state: { ...s, botSpeaking: false }, effects: [] };
        case 'active': {
            if (ev.active === s.active) {
                return { state: s, effects: [] };
            }
            if (ev.active) {
                return { state: { ...s, active: true }, effects: [] };
            }
            // Another window has the voice now: stop talking, and drop what this one half-heard.
            const cut = interrupt(s, ev.at);
            return { state: { ...cut.state, active: false, userSpeaking: false, soundDetected: false, userBuffer: [] }, effects: cut.effects };
        }
        case 'hush':
            return interrupt(s, ev.at);
        case 'voiced':
            // A reply half shown as text is not voiced from the middle, nor one half spoken muted.
            return { state: s.bot ? { ...s, nextVoiced: ev.voiced } : { ...s, voiced: ev.voiced, nextVoiced: undefined }, effects: [] };
    }
}
