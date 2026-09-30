/**
 * The Bot view (docs/voice-agent-design.md §11), shown by a chat tab in place of its conversation:
 * at the top, the engines voice mode uses and the voice context's token use; below, the cards and
 * the voice conversation. It only shows: everything typed goes through the chat's composer. Renders
 * the host's `VoiceViewState` snapshots, which arrive many times a second while a reply streams, so
 * the transcript is updated per entry id and per part, keeping scroll position, open folds and
 * running CSS animations intact.
 */
import { escapeHtml } from '../shared/html';
import type { ClientMessage, VoiceReadiness, VoiceServiceCheck } from '../shared/protocol';
import {
    type VoiceEntry,
    type VoiceProposalCard,
    type VoiceResearchCard,
    type VoiceSentence,
    type VoiceToolEntry,
    type VoiceReplayPiece,
    type VoiceEngines,
    type VoiceViewClientMessage,
    type VoiceViewHostMessage,
    type VoiceViewState,
} from '../shared/voiceViewProtocol';
import { DEFAULT_SPEAKER_NAMES, type VoiceSpeakers } from '../shared/voiceSpeakers';
import { DEFAULT_AVATAR, avatarMarkup } from './avatar';
import { copyPlainText } from './chat/toast';
import { formatTokenCount } from './tokenCount';
import { handleSentenceMessage } from './sentenceActions';
import { voiceToolRenderer } from './toolCards/voice';
import type { ToolResultPayload } from './toolCards/types';
import { createToolView, toToolResult, updateToolView, type ToolViewPayload } from './toolView';
import { ICON_CALL, callVoiceAgent, setVoiceBarBot } from './voiceBar';
import { paragraphPieces, pickedOf, pieceAt, rangeInNodes, textNodesIn, type PickedSentence, type SentenceSurface } from './sentencePick';
import { vscode } from './vscodeApi';

/** Within this many pixels of the bottom, the transcript follows new content. */
const FOLLOW_SLACK_PX = 40;
/** A speaker's turns this close together share one avatar and header, as in Slack. */
const GROUP_MS = 5 * 60_000;

const SOURCE_ICON: Record<'stt' | 'text' | 'panel', [icon: string, title: string]> = {
    stt: ['🎙', 'Spoken'],
    text: ['⌨', 'Typed'],
    panel: ['🖱', 'Clicked in the Bot view'],
};

/** Stopwatch (reply latency), drawn in the text colour. */
const TIMING_ICON =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="9.2" r="5.3"/><path d="M8 9.2V6.4M6.3 1.6h3.4M12.2 4.6l1-1"/></g></svg>';

/** Clock with a back arrow: past voice conversations. */
const HISTORY_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.25 2.5V5h2.5"/><path d="M8 5v3.25l2 1.25"/></svg>';

const SVG_OPEN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

/** Avatar of a setting change turn. */
const SETTING_AVATAR = `${SVG_OPEN}<path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/></svg>`;

/**
 * The user's and the voice agent's names (escaped) and avatar markup, as set; built once per
 * `speakers` message, so every turn shares the same strings and `setHtml` sees no change.
 */
const speakerView: Record<'user' | 'bot', { name: string; avatar: string }> = {
    user: { name: DEFAULT_SPEAKER_NAMES.user, avatar: DEFAULT_AVATAR.user },
    bot: { name: DEFAULT_SPEAKER_NAMES.bot, avatar: DEFAULT_AVATAR.bot },
};
/** Bumped per `speakers` message: pictures scale asynchronously, and only the newest applies. */
let speakersLoad = 0;

async function applySpeakers(speakers: VoiceSpeakers): Promise<void> {
    const load = ++speakersLoad;
    const [user, bot] = await Promise.all([avatarMarkup(speakers.user.avatar, DEFAULT_AVATAR.user), avatarMarkup(speakers.bot.avatar, DEFAULT_AVATAR.bot)]);
    if (load !== speakersLoad) {
        return;
    }
    speakerView.user = { name: escapeHtml(speakers.user.name), avatar: user };
    speakerView.bot = { name: escapeHtml(speakers.bot.name), avatar: bot };
    setVoiceBarBot(speakers.bot.name, bot);
    if (lastState) {
        renderStream(lastState);
    }
}

function post(message: VoiceViewClientMessage): void {
    vscode.postMessage({ type: 'voice', message } satisfies ClientMessage);
}

function mmss(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const mm = `${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return h > 0 ? `${h}:${mm}` : mm;
}

/** Seconds with two decimals, as the output channel's latency line. */
function secs(ms: number): string {
    return `${(ms / 1000).toFixed(2)}s`;
}

/** Message time in the header, as Slack shows it, with seconds ("7:18:05 AM"). */
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
/** The avatar column's shorter time ("7:18"), shown on hover for grouped turns. */
const GUTTER_CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function cost(usd: number): string {
    return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** Host and path of a service URL, without the scheme. */
function shortUrl(url: string): string {
    return url.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'not set';
}

/** A model id without its provider or organisation: `anthropic/claude-opus-5-5` → `claude-opus-5-5`. */
function shortModel(model: string): string {
    return model.slice(model.lastIndexOf('/') + 1) || model;
}

/** Audio length: `12.3s`, `4m 05s`. */
function audioLength(ms: number): string {
    const s = Math.round(ms / 100) / 10;
    if (s < 60) {
        return `${s.toFixed(1)}s`;
    }
    const whole = Math.round(s);
    return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}

function count(n: number, noun: string): string {
    return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

/** Last assigned markup per element, so unchanged parts are not re-parsed (which would reset animations and selection). */
const htmlCache = new WeakMap<Element, string>();

function setHtml(el: Element, html: string): void {
    if (htmlCache.get(el) !== html) {
        el.innerHTML = html;
        htmlCache.set(el, html);
    }
}

// ── Skeleton ──

const root = document.createElement('section');
root.className = 'vp';
root.dataset.state = 'off';
root.setAttribute('aria-label', 'Voice agent');
root.innerHTML = `
<div class="vp-head">
    <button type="button" class="vp-sum" aria-expanded="false" title="Show token use"><span class="vp-sum-v"></span><span class="vp-car">▶</span></button>
    <button type="button" class="vp-hist" title="Past voice conversations" aria-label="Past voice conversations">${HISTORY_ICON}</button>
    <div class="vp-detail"></div>
</div>
<div class="vp-cards"></div>
<div class="vp-banner">Viewing a past session — read only</div>
<div class="vp-stream" role="log" aria-live="polite"><div class="vp-empty"></div></div>`;

const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
const headEl = q('.vp-head');
const sumBtn = q<HTMLButtonElement>('.vp-sum');
const sumEl = q('.vp-sum-v');
const detailEl = q('.vp-detail');
const cardsEl = q('.vp-cards');
const stream = q('.vp-stream');
/** Stays last in the stream, shown only while there are no turns: a new conversation's welcome, or a note on a past one. */
const emptyEl = q('.vp-empty');

function isFollowing(): boolean {
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight < FOLLOW_SLACK_PX;
}

/** Puts the view in its host: the chat's Bot view container, which it fills. */
export function mountVoicePanel(host: HTMLElement): void {
    host.appendChild(root);
}

// The header is one summary line; clicking it floats the details over the transcript. Leaving the
// header, clicking the line again, clicking elsewhere or Escape closes them.
function setHeadOpen(open: boolean): void {
    headEl.classList.toggle('open', open);
    sumBtn.setAttribute('aria-expanded', String(open));
}
sumBtn.addEventListener('click', () => setHeadOpen(!headEl.classList.contains('open')));
q('.vp-hist').addEventListener('click', () => post({ type: 'history' }));
headEl.addEventListener('mouseleave', () => setHeadOpen(false));
document.addEventListener('click', (e) => {
    if (!headEl.contains(e.target as Node)) {
        setHeadOpen(false);
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        setHeadOpen(false);
    }
});

// ── Header: the engines on one line (full settings on hover); details: context window, token use ──

/** `sub`: a detail of the row above, indented under it. */
function row(key: string, value: string, title = '', sub = false): string {
    return `<div class="vp-row${sub ? ' vp-sub' : ''}"${title ? ` title="${escapeHtml(title)}"` : ''}><span class="vp-k">${escapeHtml(key)}</span><span class="vp-v">${value}</span></div>`;
}

const SEP = '<span class="vp-sep">·</span>';

/** One engine as a short name; the full settings show on hover. */
function engine(key: string, name: string, details: string[]): string {
    return `<span title="${escapeHtml(details.join(' · '))}"><span class="vp-sk">${key}</span> ${escapeHtml(name)}</span>`;
}

function renderHead(s: VoiceViewState): void {
    const { llm, stt, tts, running } = s.engines;
    const llmModel = llm.model ?? 'chat tab’s model';
    const off = running ? [] : ['voice mode is off: the settings it will use'];
    const context = contextUse(s);
    const pct = context?.percent == null ? undefined : Math.max(0, Math.min(100, context.percent));
    const pctText = pct === undefined ? undefined : `${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%`;
    const engines = [
        engine('LLM', shortModel(llmModel), [llmModel, `thinking ${llm.thinking}`, ...off]),
        ...(pctText === undefined ? [] : [`<span title="Context window use of the voice LLM"><span class="vp-sk">ctx</span> ${pctText}</span>`]),
        engine('STT', shortModel(stt.model), [shortUrl(stt.url), stt.model, `language ${stt.language}`, ...off]),
        engine('TTS', shortModel(tts.model), [tts.engine, shortUrl(tts.url), tts.model, `voice ${tts.voice}`, `speed ${tts.speed}`, `language: ${tts.language}`, ...off]),
    ].join(SEP);
    root.classList.toggle('vp-configured', !running);

    const llmTokens = llmUsage(s);
    const rows: string[] = [];
    if (context) {
        const used = context.tokens === null ? '—' : formatTokenCount(context.tokens);
        rows.push(
            row(
                'Context',
                `<span class="vp-meter-bar"><i style="width:${pct ?? 0}%"></i></span>${pctText === undefined ? '' : `${pctText}${SEP}`}${used} / ${formatTokenCount(context.contextWindow)}`,
                'How much of the voice model’s context window the voice conversation uses',
            ),
        );
    }
    // Like the worker's model status: one short row each, so nothing is cut off at the panel's edge.
    rows.push(
        row(
            'LLM',
            llmTokens
                ? [count(llmTokens.calls, 'call'), `in ${formatTokenCount(llmTokens.input)}`, `out ${formatTokenCount(llmTokens.output)}`, cost(llmTokens.cost)].join(SEP)
                : 'no calls yet',
            'Tokens of the voice agent’s LLM calls in this conversation: input not read from cache, output, and their cost',
        ),
        ...(llmTokens && (llmTokens.cacheRead > 0 || llmTokens.cacheWrite > 0)
            ? [row('Cache', [`read ${formatTokenCount(llmTokens.cacheRead)}`, `write ${formatTokenCount(llmTokens.cacheWrite)}`].join(SEP), 'Prompt tokens the voice LLM read from and wrote to the provider’s cache', true)]
            : []),
        row(
            'STT',
            s.speech?.stt
                ? [
                      count(s.speech.stt.calls, 'request'),
                      `${audioLength(s.speech.stt.audioMs)} audio`,
                      ...(s.speech.stt.input !== undefined ? [`in ${formatTokenCount(s.speech.stt.input)}`] : []),
                      ...(s.speech.stt.output !== undefined ? [`out ${formatTokenCount(s.speech.stt.output)}`] : []),
                  ].join(SEP)
                : 'no requests yet',
            'Audio sent to speech-to-text in this conversation. Tokens show only when the server reports them (OpenAI’s gpt-4o-transcribe does, Whisper servers do not).',
        ),
        row(
            'TTS',
            s.speech?.tts
                ? [count(s.speech.tts.calls, 'request'), count(s.speech.tts.chars, 'char'), `${audioLength(s.speech.tts.audioMs)} audio`].join(SEP)
                : 'no requests yet',
            'Characters sent to text-to-speech in this conversation and the audio it returned; speech servers report no tokens.',
        ),
    );
    setHtml(detailEl, rows.join(''));

    setHtml(sumEl, [engines, ...(llmTokens ? [`<span class="vp-sk">Tokens</span> ${formatTokenCount(llmTokens.input + llmTokens.output)}${SEP}${cost(llmTokens.cost)}`] : [])].join(SEP));
}

/**
 * The voice LLM's context window use: omp's figure for the loaded voice context while live, else
 * what the conversation's last call left (all its tokens) against the window it reported.
 * Undefined when neither is known (before the first call; transcripts from before calls recorded the window).
 */
function contextUse(s: VoiceViewState): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
    const live = s.usage?.context;
    if (live && live.contextWindow > 0) {
        return live;
    }
    for (let i = s.entries.length - 1; i >= 0; i--) {
        const e = s.entries[i];
        const last = e.kind === 'assistant' ? e.usage?.at(-1) : undefined;
        if (last) {
            if (!last.contextWindow) {
                return undefined;
            }
            const tokens = last.input + last.output + last.cacheRead + last.cacheWrite;
            return { tokens, contextWindow: last.contextWindow, percent: (tokens / last.contextWindow) * 100 };
        }
    }
    return undefined;
}

/**
 * The voice LLM's tokens: the loaded voice context's totals while live, else the sum of the
 * conversation's calls; `calls` counts the calls. Undefined before the first call.
 */
function llmUsage(s: VoiceViewState): { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | undefined {
    const calls = s.entries.flatMap((e) => (e.kind === 'assistant' ? (e.usage ?? []) : []));
    if (s.usage) {
        return { ...s.usage, calls: calls.length };
    }
    if (calls.length === 0) {
        return undefined;
    }
    const sum = { calls: calls.length, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const c of calls) {
        sum.input += c.input;
        sum.output += c.output;
        sum.cacheRead += c.cacheRead;
        sum.cacheWrite += c.cacheWrite;
        sum.cost += c.cost;
    }
    return sum;
}

// ── Transcript: Slack-style messages, avatar + name and time over the text ──

interface TurnView {
    el: HTMLElement;
    avatar: HTMLElement;
    who: HTMLElement;
    time: HTMLElement;
    /** The time in the avatar column, shown on hover when the header is left out (`.cont`). */
    gutterTime: HTMLElement;
    attach: HTMLElement;
    pre: HTMLElement;
    /** Holds `pre`, `body` and `post`; clamped to three lines for long user / setting texts. */
    line: HTMLElement;
    /** `dataset.mode`: per-sentence spans (`sentences`) or plain text (`text`); the Alt gestures read it too. */
    body: HTMLElement;
    post: HTMLElement;
    error: HTMLElement;
    /** The reply's tool calls and lookups, as the worker's tool cards. */
    tools: HTMLElement;
    /** Show more / Copy under a clamped `line`; hidden unless the text overflows three lines. */
    clamp: HTMLElement;
    more: HTMLButtonElement;
    /** The full text of a user / setting turn (clampable); undefined for the bot's replies. */
    clampText?: string;
    /** Stopwatch button after the header's time, shown on hover; toggles `timingBody` (the turn's latency breakdown). */
    timing: HTMLButtonElement;
    timingBody: HTMLElement;
}

const turns = new Map<string, TurnView>();
/** Keys of expanded latency breakdowns (`<entry id>:timing`), kept across re-renders and snapshots. */
const openTimings = new Set<string>();
/** Entry ids of long user / setting turns the user expanded. */
const expandedTurns = new Set<string>();
let sessionId: string | undefined;
/** The avatar animated (`.av-motion`): of the reply being read aloud, else of the latest reply; undefined when neither is shown. */
let liveAvatar: HTMLElement | undefined;
/** The latest entry's group avatar when that entry is a reply. */
let latestReplyAvatar: HTMLElement | undefined;
/** Each reply's group avatar (grouped turns leave theirs out), by entry id. */
const replyAvatars = new Map<string, HTMLElement>();
/** The entry being read aloud (Alt+click), as the host last said. */
let readEntryId: string | undefined;

/** One talking avatar in the Bot view: the reply being read aloud's, else the latest reply's (avatarMotion.ts). */
function placeLiveAvatar(): void {
    const live = (readEntryId !== undefined ? replyAvatars.get(readEntryId) : undefined) ?? latestReplyAvatar;
    if (live !== liveAvatar) {
        liveAvatar?.classList.remove('av-motion');
        live?.classList.add('av-motion');
        liveAvatar = live;
    }
}

function createTurn(): TurnView {
    const el = document.createElement('div');
    el.innerHTML =
        '<div class="vp-av" aria-hidden="true"></div><time class="vp-gtime"></time><div class="vp-who"><span class="vp-name"></span><time class="vp-time"></time><button type="button" class="vp-timing" aria-expanded="false" hidden>' +
        TIMING_ICON +
        '</button></div><div class="vp-txt"><div class="vp-attach"></div><div class="vp-line"><span class="vp-pre"></span><span class="vp-body"></span><span class="vp-post"></span></div><div class="vp-clamp" hidden><button type="button" class="vp-more"></button><button type="button" class="vp-copy" title="Copy message">Copy</button></div><div class="vp-err" hidden></div><div class="vp-tools"></div><div class="vp-timing-body" hidden></div></div>';
    const part = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
    return {
        el,
        avatar: part('.vp-av'),
        who: part('.vp-name'),
        time: part('.vp-time'),
        gutterTime: part('.vp-gtime'),
        attach: part('.vp-attach'),
        pre: part('.vp-pre'),
        line: part('.vp-line'),
        body: part('.vp-body'),
        post: part('.vp-post'),
        error: part('.vp-err'),
        tools: part('.vp-tools'),
        clamp: part('.vp-clamp'),
        more: part<HTMLButtonElement>('.vp-more'),
        timing: part<HTMLButtonElement>('.vp-timing'),
        timingBody: part('.vp-timing-body'),
    };
}

/**
 * Who said a turn, for grouping: a user's spoken and typed turns get separate headers (the header
 * shows the source); the voice agent's replies, asked for or on its own, are one speaker.
 */
function speaker(entry: VoiceEntry): string {
    return entry.kind === 'user' ? `user:${entry.source}` : entry.kind === 'system' ? 'sys' : 'bot';
}

function renderStream(s: VoiceViewState): void {
    if (s.session.id !== sessionId) {
        sessionId = s.session.id;
        turns.clear();
        openTimings.clear();
        expandedTurns.clear();
        stream.replaceChildren(emptyEl);
    }
    const follow = isFollowing();
    const entries = s.debug ? s.entries : s.entries.filter((e) => !(e.kind === 'assistant' && e.silent));
    // Gone turns go first: left in place, they would push every later turn to be moved.
    const ids = new Set(entries.map((e) => e.id));
    for (const [id, view] of turns) {
        if (!ids.has(id)) {
            view.el.remove();
            turns.delete(id);
        }
    }
    let prev: Element | null = null;
    let prevEntry: VoiceEntry | undefined;
    /** The turn showing the avatar of the latest entry's group (grouped turns leave it out). */
    let header: TurnView | undefined;
    replyAvatars.clear();
    for (const entry of entries) {
        let view = turns.get(entry.id);
        if (!view) {
            view = createTurn();
            turns.set(entry.id, view);
        }
        updateTurn(view, entry, s.debug);
        const grouped = prevEntry !== undefined && speaker(prevEntry) === speaker(entry) && entry.at - prevEntry.at < GROUP_MS;
        view.el.classList.toggle('cont', grouped);
        if (!grouped) {
            header = view;
        }
        if (entry.kind === 'assistant') {
            replyAvatars.set(entry.id, header!.avatar);
        }
        prevEntry = entry;
        const expected: Element | null = prev ? prev.nextElementSibling : stream.firstElementChild;
        if (expected !== view.el) {
            if (view.el.isConnected) {
                // Re-inserting a shown turn would replay its entry animation.
                view.el.dataset.settled = '';
            }
            stream.insertBefore(view.el, expected);
        }
        prev = view.el;
    }
    emptyEl.hidden = entries.length > 0;
    latestReplyAvatar = prevEntry?.kind === 'assistant' ? header?.avatar : undefined;
    placeLiveAvatar();
    if (entries.length === 0) {
        emptyEl.classList.toggle('vp-welcome', !s.session.readonly);
        setHtml(emptyEl, s.session.readonly ? 'Nothing was said in this session.' : welcomeHtml(s));
    }
    if (follow) {
        stream.scrollTop = stream.scrollHeight;
    }
}

/** Green check: a speech service that answered its last check. */
const ICON_SVC_OK = `${SVG_OPEN}<path d="M3.5 8.5l3 3 6-7"/></svg>`;
/** Red cross: a speech service not set up, or failing. */
const ICON_SVC_BAD = `${SVG_OPEN}<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`;

/** STT and TTS readiness from the host (chat `stateSync`); absent until it reports them. */
let readiness: VoiceReadiness | undefined;

/** The host's STT and TTS readiness changed: the welcome's service rows follow it. */
export function setVoicePanelReadiness(next: VoiceReadiness): void {
    if (JSON.stringify(next) === JSON.stringify(readiness)) {
        return;
    }
    readiness = next;
    if (lastState) {
        renderStream(lastState);
    }
}

/** One speech service in the welcome: what is configured, and whether it works (click: Settings → Voice). */
function serviceHtml(label: string, service: 'stt' | 'tts', config: VoiceEngines['stt'] | VoiceEngines['tts'], check: VoiceServiceCheck | undefined): string {
    const state = !check || check.checking ? 'checking' : check.ok ? 'ok' : 'bad';
    const icon = state === 'ok' ? ICON_SVC_OK : state === 'bad' ? ICON_SVC_BAD : '<span class="vp-svc-spin" aria-hidden="true"></span>';
    const status = state === 'ok' ? 'Ready' : state === 'bad' ? (check?.reason ?? 'Unavailable.') : 'Checking…';
    const setup = `${shortModel(config.model)} · ${shortUrl(config.url)}`;
    return `<button type="button" class="vp-svc" data-service="${service}" data-state="${state}" title="${escapeHtml(`${label}: ${setup}\n${status}\nClick to open Settings → Voice`)}">
<span class="vp-svc-ic">${icon}</span><span class="vp-svc-body"><span class="vp-svc-head"><span class="vp-svc-k">${label}</span><span class="vp-svc-v">${escapeHtml(setup)}</span></span>${
        state === 'ok' ? '' : `<span class="vp-svc-why">${escapeHtml(status)}</span>`
    }${state === 'bad' ? '<span class="vp-svc-link">Open Settings → Voice to set it up</span>' : ''}</span></button>`;
}

/** A new conversation's empty Bot view: who the voice agent is, what it does, whether its speech services work, and how to start talking. */
function welcomeHtml(s: VoiceViewState): string {
    const bot = speakerView.bot;
    const phase = s.phase;
    const start =
        phase === 'off'
            ? `<button type="button" class="vp-welcome-call" title="Start voice mode: microphone, speech services and voice model">${ICON_CALL}<span>Call ${bot.name}</span></button>
<div class="vp-welcome-hint">Or type in the input box below: without a call it is a text chat.</div>`
            : phase === 'standby'
              ? '<div class="vp-welcome-hint">Voice mode is on, but another VS Code window has the microphone: focus this window to talk here.</div>'
              : phase === 'muted'
                ? '<div class="vp-welcome-hint">Voice mode is on and the microphone is muted: unmute it with the mic in the input box, or type there.</div>'
                : '<div class="vp-welcome-hint">Voice mode is on: just start talking, or type in the input box below.</div>';
    return `<div class="vp-welcome-av">${bot.avatar}</div>
<div class="vp-welcome-title">${bot.name}</div>
<div class="vp-welcome-sub">Your voice pair programmer. Talk through the code out loud while the agent in this tab does the heavy lifting.</div>
<ul class="vp-welcome-list">
<li><b>Talks in real time.</b> Speak naturally and cut in any time: it stops and listens.</li>
<li><b>Sees what you see.</b> Your open file, cursor and selection; it points at the lines it explains.</li>
<li><b>Reads and changes code.</b> Looks things up, makes small edits, runs commands in the terminal.</li>
<li><b>Directs the agent.</b> Hands big jobs to this tab's agent, keeps you posted, and passes on its questions and approvals.</li>
<li><b>Researches.</b> Digs through the codebase in the background and reports back.</li>
</ul>
<div class="vp-welcome-svcs">
${serviceHtml('Speech-to-text', 'stt', s.engines.stt, readiness?.stt)}
${serviceHtml('Text-to-speech', 'tts', s.engines.tts, readiness?.tts)}
</div>
${start}`;
}

function updateTurn(view: TurnView, entry: VoiceEntry, debug: boolean): void {
    view.el.dataset.id = entry.id;
    if (!view.time.textContent) {
        // An entry's time never changes: set once, not on every snapshot.
        const when = new Date(entry.at).toLocaleString();
        view.time.textContent = CLOCK.format(entry.at);
        // The avatar column is narrow: no seconds or AM/PM there.
        view.gutterTime.textContent = GUTTER_CLOCK.formatToParts(entry.at)
            .filter((p) => p.type !== 'dayPeriod')
            .map((p) => p.value)
            .join('')
            .trim();
        view.time.title = when;
        view.gutterTime.title = when;
    }
    if (entry.kind === 'user') {
        view.el.className = 'vp-turn user';
        setHtml(view.avatar, speakerView.user.avatar);
        const [icon, title] = SOURCE_ICON[entry.source] ?? SOURCE_ICON.text;
        setHtml(view.who, `<span class="vp-nm">${speakerView.user.name}</span><span class="vp-src" title="${title}">${icon}</span>`);
        setHtml(view.attach, '');
        setHtml(view.pre, entry.bargeIn ? '<span class="vp-barge">Barged in</span>' : '');
        setText(view, entry.text);
        setClampText(view, entry.text);
        setHtml(view.post, '');
        setError(view, undefined);
        view.tools.replaceChildren();
        const heard = entry.latency;
        const toText = heard?.endOfTurn !== undefined && heard.stt !== undefined ? heard.endOfTurn + heard.stt : undefined;
        setTiming(
            view,
            entry.id,
            [
                ['End of turn detected', heard?.endOfTurn],
                ['Speech-to-text', heard?.stt],
            ],
            toText !== undefined ? `${secs(toText)} from stopped talking to the transcript` : undefined,
        );
        return;
    }
    if (entry.kind === 'system') {
        view.el.className = 'vp-turn sys';
        setHtml(view.avatar, SETTING_AVATAR);
        setHtml(view.who, 'Setting');
        setHtml(view.attach, '');
        setHtml(view.pre, '');
        setText(view, entry.text);
        setClampText(view, entry.text);
        setHtml(view.post, '');
        setError(view, undefined);
        view.tools.replaceChildren();
        setTiming(view, entry.id, []);
        return;
    }

    // A reply the agent started on its own is still the agent's: its kind shows as a tag before the text.
    view.el.className = `vp-turn bot${entry.silent ? ' silent' : ''}`;
    setClampText(view, undefined);
    setHtml(view.avatar, speakerView.bot.avatar);
    setHtml(view.who, `<span class="vp-nm">${speakerView.bot.name}</span><span class="vp-badge">AI</span>`);
    setHtml(view.attach, debug && entry.input ? escapeHtml(entry.input) : '');
    setHtml(view.pre, entry.proactive ? `<span class="vp-kind ${escapeHtml(entry.proactive)}">${escapeHtml(entry.proactive)}</span>` : '');

    const sentences = entry.sentences ?? [];
    const cut = sentences.some((x) => x.state === 'cut');
    if (entry.silent) {
        setText(view, entry.text.replace(/<silent\s*\/>/g, '').trim());
        setHtml(view.post, '<span class="vp-partial">&lt;silent/&gt; · not spoken</span>');
    } else {
        if (sentences.length > 0) {
            setSentences(view, sentences);
        } else if (!entry.done && !entry.text) {
            view.body.dataset.mode = 'text';
            setHtml(view.body, '<span class="vp-dots"><i></i><i></i><i></i></span>');
        } else {
            setText(view, entry.text);
        }
        setHtml(
            view.post,
            cut
                ? '<span class="vp-cut-tag">Cut off · not heard</span>'
                : entry.interrupted
                  ? '<span class="vp-cut-tag">Interrupted</span>'
                  : '',
        );
    }
    setError(view, entry.error);
    renderTools(view.tools, entry.id, entry.tools);
    const latency = entry.latency;
    setTiming(
        view,
        entry.id,
        [
            ['LLM first text', latency?.llmFirstText],
            ['LLM whole reply', latency?.llmTotal],
            ['TTS to first sound', latency?.ttsFirstAudio],
            ['Stopped talking → heard the reply', latency?.total],
            ['Prompt → cut off', latency?.cutOff],
        ],
        latency?.total !== undefined
            ? `${secs(latency.total)} to the first sound`
            : latency?.llmFirstText !== undefined
              ? `${secs(latency.llmFirstText)} to the first text`
              : latency?.cutOff !== undefined
                ? `cut off after ${secs(latency.cutOff)}`
                : undefined,
    );
}

/** The stopwatch beside the speaker: hidden unless some part was measured; `summary` heads its tooltip. */
function setTiming(view: TurnView, entryId: string, parts: Array<[string, number | undefined]>, summary?: string): void {
    const detail = parts
        .filter((p): p is [string, number] => p[1] !== undefined)
        .map(([label, ms]) => `${label}: ${secs(ms)}`)
        .join('\n');
    view.timing.hidden = detail === '';
    if (detail === '') {
        view.timingBody.hidden = true;
        return;
    }
    const key = `${entryId}:timing`;
    const open = openTimings.has(key);
    view.timing.dataset.key = key;
    view.timing.title = summary ? `Timing: ${summary}\n${detail}` : `Timing\n${detail}`;
    view.timing.setAttribute('aria-expanded', String(open));
    view.timing.classList.toggle('open', open);
    if (view.timingBody.textContent !== detail) {
        view.timingBody.textContent = detail;
    }
    view.timingBody.hidden = !open;
}

/** Plain text in `body`. */
function setText(view: TurnView, text: string): void {
    if (view.body.dataset.mode !== 'text' || htmlCache.has(view.body) || view.body.textContent !== text) {
        view.body.textContent = text;
        htmlCache.delete(view.body);
        view.body.dataset.mode = 'text';
    }
}

/** Lines a long user / setting turn shows until expanded. */
const TURN_LINE_CLAMP = 3;
let clampFrame = 0;

/** Measures the clamps on the next frame: after the snapshot's DOM writes, before paint. */
function scheduleClamps(): void {
    if (!clampFrame) {
        clampFrame = requestAnimationFrame(() => {
            clampFrame = 0;
            measureClamps();
        });
    }
}

function setClampText(view: TurnView, text: string | undefined): void {
    if (view.clampText === text) {
        return;
    }
    view.clampText = text;
    if (text === undefined) {
        view.line.classList.remove('vp-clamped');
        view.clamp.hidden = true;
    } else {
        scheduleClamps();
    }
}

/**
 * Clamps long user / setting turns to three lines behind Show more, and offers More on a task card
 * whose one line is cut off. All class writes come before all reads: one layout for the transcript.
 * A hidden view measures as zero and keeps its last state; the resize observer retries it once shown.
 */
function measureClamps(): void {
    const views = [...turns].filter(([, view]) => view.clampText !== undefined);
    for (const [id, view] of views) {
        view.line.classList.toggle('vp-clamped', !expandedTurns.has(id));
    }
    const lineHeight = views.length > 0 ? parseFloat(getComputedStyle(views[0][1].line).lineHeight) : NaN;
    const maxHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight * TURN_LINE_CLAMP : 60;
    const overflows = views.map(([id, view]) => {
        const shown = view.line.clientHeight;
        if (shown === 0) {
            return undefined;
        }
        return expandedTurns.has(id) ? shown > maxHeight + 4 : view.line.scrollHeight > shown + 1;
    });
    const cards = [...cardsEl.querySelectorAll<HTMLElement>('.vp-ask:not(.open)')];
    const cut = cards.map((card) => {
        const text = card.querySelector<HTMLElement>('.vp-q')!;
        return text.clientWidth === 0 ? undefined : text.scrollWidth > text.clientWidth;
    });
    views.forEach(([id, view], i) => {
        const overflow = overflows[i];
        if (overflow === undefined) {
            return;
        }
        view.clamp.hidden = !overflow;
        const expanded = expandedTurns.has(id);
        view.more.textContent = expanded ? 'Show less' : 'Show more';
        view.more.setAttribute('aria-expanded', String(expanded));
    });
    cards.forEach((card, i) => {
        if (cut[i] !== undefined) {
            card.querySelector<HTMLButtonElement>('.vp-more')!.hidden = !cut[i];
        }
    });
}
new ResizeObserver(scheduleClamps).observe(stream);

function setError(view: TurnView, error: string | undefined): void {
    view.error.hidden = !error;
    view.error.textContent = error ? `⚠ ${error}` : '';
}

/** Scripts written without spaces between words. */
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

function setSentences(view: TurnView, sentences: VoiceSentence[]): void {
    if (view.body.dataset.mode !== 'sentences') {
        view.body.dataset.mode = 'sentences';
        view.body.replaceChildren();
        htmlCache.delete(view.body);
    }
    const spans = view.body.children;
    sentences.forEach((sentence, i) => {
        const next = sentences[i + 1]?.text ?? '';
        const gap = next && !/\s$/.test(sentence.text) && !/^\s/.test(next) && !CJK.test(sentence.text.slice(-1)) ? ' ' : '';
        let span = spans[i] as HTMLElement | undefined;
        if (!span) {
            span = document.createElement('span');
            view.body.append(span);
        }
        // Rebuilt only when something shown changes; the space before the next sentence is a
        // trailing text node, added without a rebuild.
        const key = `${sentence.state}|${sentence.text}`;
        if (span.dataset.key !== key) {
            span.dataset.key = key;
            span.dataset.gap = '';
            span.className = `vp-s ${sentence.state}`;
            span.textContent = sentence.text;
        }
        if (span.dataset.gap !== gap) {
            if (span.dataset.gap) {
                span.lastChild?.remove();
            }
            if (gap) {
                span.append(gap);
            }
            span.dataset.gap = gap;
        }
    });
    while (spans.length > sentences.length) {
        spans[spans.length - 1].remove();
    }
}

/** What a card shows of a tool entry: snapshots arrive many times a second, and cards are redrawn only when it changes. */
const cardShown = new WeakMap<Element, string>();

/**
 * How a tool entry looks in the Bot view, as the chips before it: a plain-language label, and a kind
 * that colours it (`data-kind`, voice.css). Lookups keep their tool names.
 */
function toolLook(tool: VoiceToolEntry): { label: string; kind: string } {
    if (tool.id !== undefined) {
        return { label: tool.name, kind: 'read' };
    }
    switch (tool.name) {
        case 'tell_worker':
            return /^not sent yet/i.test(tool.result.trim()) ? { label: 'Proposed', kind: 'proposal' } : { label: 'Sent to worker', kind: 'dispatch' };
        case 'confirm_task':
            return { label: 'Confirmed task', kind: 'confirm' };
        case 'answer_worker':
            return { label: 'Answered worker', kind: 'answer' };
        case 'stop_worker':
            return { label: 'Stopped worker', kind: 'stop' };
        case 'research':
            return { label: 'Research', kind: 'research' };
        case 'worker_status':
            return { label: 'Checked worker', kind: 'status' };
        case 'show_text':
            return { label: 'Snippet', kind: 'snippet' };
        // Lookups saved as descriptions only, before they were tool entries.
        case 'lookup':
            return { label: 'Looked up', kind: 'read' };
        default:
            return { label: tool.name, kind: 'status' };
    }
}

/**
 * A host tool call or lookup as a tool card. `research` only starts a job: its card runs until the job
 * settles, then holds the findings. Every field is set, so an update clears what no longer applies.
 */
function toolCard(tool: VoiceToolEntry, label: string): ToolViewPayload {
    const { research } = tool;
    let result: ToolResultPayload | undefined;
    if (research) {
        result = research.status === 'running' ? undefined : toToolResult(research.result ?? '', research.status === 'failed');
    } else if (!tool.running) {
        result = toToolResult(tool.result, tool.isError);
    }
    return {
        name: tool.name,
        label,
        args: tool.args,
        result,
        running: tool.running === true || research?.status === 'running',
        // Lookups are the worker's own tools; host tools have renderers of their own.
        renderer: tool.id === undefined ? voiceToolRenderer(tool.name) : undefined,
        // Shown instead of spoken: open from the start. Others keep whether the user opened them.
        defaultOpen: tool.id === undefined && tool.name === 'show_text' ? true : undefined,
    };
}

function renderTools(container: HTMLElement, entryId: string, tools: VoiceToolEntry[]): void {
    const existing = container.children;
    tools.forEach((tool, i) => {
        // A tool entry's arguments never change; its result and research state fill in once.
        const shown = `${tool.name}|${tool.running}|${tool.isError}|${tool.result.length}|${tool.research?.status}|${tool.research?.result?.length}`;
        let card = existing[i] as HTMLElement | undefined;
        if (card && cardShown.get(card) === shown) {
            return;
        }
        const { label, kind } = toolLook(tool);
        if (card) {
            updateToolView(card, toolCard(tool, label));
        } else {
            card = createToolView(`${entryId}:t${i}`, toolCard(tool, label));
            container.append(card);
        }
        card.dataset.kind = kind;
        cardShown.set(card, shown);
    });
    while (existing.length > tools.length) {
        existing[existing.length - 1].remove();
    }
}

stream.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.vp-welcome-call')) {
        callVoiceAgent();
        return;
    }
    if ((e.target as Element).closest('.vp-svc')) {
        vscode.postMessage({ type: 'openSettings', section: 'voice' } satisfies ClientMessage);
        return;
    }
    const clampButton = (e.target as Element).closest<HTMLButtonElement>('.vp-more, .vp-copy');
    const id = clampButton?.closest<HTMLElement>('.vp-turn')?.dataset.id;
    const view = id ? turns.get(id) : undefined;
    if (id && view?.clampText !== undefined) {
        if (clampButton!.classList.contains('vp-copy')) {
            copyPlainText(view.clampText);
        } else if (!expandedTurns.delete(id)) {
            expandedTurns.add(id);
        }
        scheduleClamps();
        return;
    }
    const button = (e.target as Element).closest<HTMLButtonElement>('.vp-timing');
    const key = button?.dataset.key;
    if (!button || !key) {
        return;
    }
    const open = !openTimings.delete(key);
    if (open) {
        openTimings.add(key);
    }
    button.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
    button.closest('.vp-turn')!.querySelector<HTMLElement>('.vp-timing-body')!.hidden = !open;
});

/**
 * The Bot view's user turns and replies, for the Alt gestures (sentenceActions.ts): plain text cut
 * into sentences as TTS reads it, or a spoken reply's own sentences, one span each. A paragraph
 * (Alt+Shift) is the message's text up to a blank line. Setting lines are left out.
 */
export const botSentences: SentenceSurface = {
    name: 'bot',
    pick(node, offset, scope) {
        const body = node.parentElement?.closest<HTMLElement>('.vp-body');
        const turn = body?.closest<HTMLElement>('.vp-turn');
        const entryId = turn?.dataset.id;
        if (!body || !turn || !entryId || turn.classList.contains('sys') || !stream.contains(turn)) {
            return undefined;
        }
        if (body.dataset.mode === 'sentences' && scope === 'sentence') {
            const span = node.parentElement!.closest('.vp-s');
            const index = span ? Array.prototype.indexOf.call(body.children, span) : -1;
            const text = span?.firstChild;
            return index >= 0 && text instanceof Text && text.data.trim()
                ? { surface: botSentences, entryId, piece: { text: text.data, sentence: index }, source: text.data }
                : undefined;
        }
        const nodes = textNodesIn(body);
        const shown = nodes.map((n) => n.data).join('');
        let pieces: VoiceReplayPiece[];
        if (body.dataset.mode === 'sentences') {
            // A spoken reply is one paragraph (voice mode's sentences hold no blank lines), read
            // sentence by sentence as it was spoken, so each comes from the audio kept of it.
            pieces = [];
            let seen = 0;
            for (const t of nodes) {
                if (t.parentElement?.parentElement === body && t.parentElement.firstChild === t && t.data.trim()) {
                    pieces.push({ text: t.data, range: [seen, seen + t.length] });
                }
                seen += t.length;
            }
        } else {
            let at = offset;
            for (const t of nodes) {
                if (t === node) {
                    break;
                }
                at += t.length;
            }
            pieces = scope === 'paragraph' ? paragraphPieces(shown, at) : [pieceAt(shown, at)].filter((p) => p !== undefined);
        }
        return pickedOf(botSentences, entryId, shown, pieces);
    },
    holds(node) {
        const turn = (node instanceof Element ? node : node.parentElement)?.closest('.vp-body')?.closest('.vp-turn');
        return turn != null && !turn.classList.contains('sys') && stream.contains(turn);
    },
    rangeOf({ entryId, piece, source }: PickedSentence) {
        const body = stream.querySelector<HTMLElement>(`.vp-turn[data-id="${CSS.escape(entryId)}"] .vp-body`);
        if (!body) {
            return undefined;
        }
        if (piece.sentence !== undefined) {
            const node = body.dataset.mode === 'sentences' ? body.children[piece.sentence]?.firstChild : undefined;
            if (!(node instanceof Text) || node.data !== source) {
                return undefined;
            }
            const range = document.createRange();
            range.selectNodeContents(node);
            return range;
        }
        // A range is in the text as shown, whether plain or a spoken reply's spans (its paragraph).
        const nodes = piece.range ? textNodesIn(body) : [];
        return nodes.map((n) => n.data).join('').slice(...piece.range!) === source && nodes.length > 0 ? rangeInNodes(nodes, ...piece.range!) : undefined;
    },
};

// ── Cards above the transcript: tasks to confirm, background research ──
// The worker and its requests are not repeated here: the chat around the panel shows them.

const cardEls = new Map<string, Element>();
/** Ids of task cards the user expanded to read the whole task. */
const openProposals = new Set<string>();
/** The snapshot the cards were last drawn from, redrawn when a card is expanded or folded. */
let lastState: VoiceViewState | undefined;

function renderCards(s: VoiceViewState): void {
    lastState = s;
    const cards: Array<{ key: string; html: string }> = [];
    for (const id of openProposals) {
        if (!s.proposals.some((p) => p.id === id)) {
            openProposals.delete(id);
        }
    }
    if (!s.session.readonly) {
        for (const p of s.proposals) {
            cards.push({ key: `prop:${p.id}`, html: proposalCardHtml(p, openProposals.has(p.id)) });
        }
        if (s.research.length > 0) {
            cards.push({ key: 'research', html: researchCardHtml(s.research) });
        }
    }
    const seen = new Set<string>();
    let prev: Element | null = null;
    for (const card of cards) {
        seen.add(card.key);
        let el = cardEls.get(card.key);
        if (!el || htmlCache.get(el) !== card.html) {
            const tpl = document.createElement('template');
            tpl.innerHTML = card.html.trim();
            const next = tpl.content.firstElementChild!;
            htmlCache.set(next, card.html);
            if (el) {
                // Swapped in place without replaying its entry animation.
                next.classList.add('settled');
                el.replaceWith(next);
            }
            el = next;
            cardEls.set(card.key, el);
            scheduleClamps();
        }
        const expected: Element | null = prev ? prev.nextElementSibling : cardsEl.firstElementChild;
        if (expected !== el) {
            cardsEl.insertBefore(el, expected);
        }
        prev = el;
    }
    for (const [key, el] of cardEls) {
        if (!seen.has(key)) {
            el.remove();
            cardEls.delete(key);
        }
    }
    tick();
}

/** A task to confirm: one cut-off line with More when it does not fit, the whole task when `open`. */
function proposalCardHtml(p: VoiceProposalCard, open: boolean): string {
    const id = escapeHtml(p.id);
    const text = escapeHtml(p.message);
    return `<div class="vp-card vp-ask${open ? ' open' : ''}" title="It changes files, so it needs your go-ahead. Say “go ahead” or “cancel”.">
        <span class="vp-card-h">Confirm task</span>
        <span class="vp-q"${open ? '' : ` title="${text}"`}>${text}</span>
        <span class="vp-card-btns"><button type="button" class="vp-more" data-act="proposal-more" data-id="${id}" aria-expanded="${open}"${open ? '' : ' hidden'}>${open ? 'Less' : 'More'}</button><button type="button" class="vp-copy" data-act="proposal-copy" data-id="${id}" title="Copy the task">Copy</button><button type="button" class="vp-pbtn" data-act="proposal" data-action="confirm" data-id="${id}">Confirm</button><button type="button" class="vp-pbtn sec" data-act="proposal" data-action="cancel" data-id="${id}">Cancel</button></span>
    </div>`;
}

/** The running (else newest) research job, with how many there are. */
function researchCardHtml(research: VoiceResearchCard[]): string {
    const order = { running: 0, done: 1, failed: 1 } as const;
    const [r] = [...research].sort(
        (a, b) => order[a.status] - order[b.status] || (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt),
    );
    const glyph =
        r.status === 'running' ? '<span class="vp-spin"></span>' : r.status === 'done' ? '<span class="vp-st-ok">✓</span>' : '<span class="vp-st-no">✗</span>';
    const time =
        r.status === 'running'
            ? `<span class="vp-m" data-tick="since" data-at="${r.startedAt}"></span>`
            : `<span class="vp-m">${r.status === 'failed' ? 'failed · ' : ''}${mmss((r.finishedAt ?? r.startedAt) - r.startedAt)}</span>`;
    const more = research.length > 1 ? `<span class="vp-m">+${research.length - 1}</span>` : '';
    return `<div class="vp-card vp-research ${r.status}">
        <span class="vp-card-h">Research</span>${glyph}<span class="vp-q" title="${escapeHtml(r.question)}">${escapeHtml(r.question)}</span>${time}${more}
    </div>`;
}

/** Updates the ticking parts of the cards (timers) without re-rendering them. */
function tick(): void {
    const now = Date.now();
    for (const el of cardsEl.querySelectorAll<HTMLElement>('[data-tick="since"]')) {
        el.textContent = mmss(now - Number(el.dataset.at));
    }
}
setInterval(tick, 1000);

cardsEl.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    const id = target?.dataset.id;
    if (!target || !id) {
        return;
    }
    switch (target.dataset.act) {
        case 'proposal':
            post({ type: 'proposal', id, action: target.dataset.action === 'confirm' ? 'confirm' : 'cancel' });
            return;
        case 'proposal-copy': {
            const proposal = lastState?.proposals.find((p) => p.id === id);
            if (proposal) {
                copyPlainText(proposal.message);
            }
            return;
        }
        case 'proposal-more':
            if (!openProposals.delete(id)) {
                openProposals.add(id);
            }
            if (lastState) {
                renderCards(lastState);
            }
            return;
    }
});

// ── Host messages ──

export function handleVoiceMessage(msg: VoiceViewHostMessage): void {
    if (msg.type === 'state') {
        root.dataset.state = msg.state.phase;
        root.classList.toggle('readonly', msg.state.session.readonly);
        renderHead(msg.state);
        renderCards(msg.state);
        renderStream(msg.state);
    } else if (msg.type === 'speakers') {
        void applySpeakers(msg.speakers);
    } else {
        handleSentenceMessage(msg);
        if (msg.type === 'sentenceActions') {
            readEntryId = msg.replay?.entryId;
            placeLiveAvatar();
        }
    }
}

post({ type: 'ready' });
