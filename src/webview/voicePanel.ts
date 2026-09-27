/**
 * The Bot view (docs/voice-agent-design.md §11), shown by a chat tab in place of its conversation:
 * at the top, the engines voice mode uses and the voice context's token use; below, the cards and
 * the voice conversation. It only shows: everything typed goes through the chat's composer. Renders
 * the host's `VoiceViewState` snapshots, which arrive many times a second while a reply streams, so
 * the transcript is updated per entry id and per part, keeping scroll position, open folds and
 * running CSS animations intact.
 */
import type { ClientMessage } from '../shared/protocol';
import {
    VOICE_MODE_LABEL,
    type VoiceCallUsage,
    type VoiceEntry,
    type VoiceProposalCard,
    type VoiceResearchCard,
    type VoiceSentence,
    type VoiceToolEntry,
    type VoiceViewClientMessage,
    type VoiceViewHostMessage,
    type VoiceViewState,
} from '../shared/voiceViewProtocol';
import { formatTokenCount } from './tokenStatsBar';
import { ICON_ROBOT } from './voiceBar';
import { vscode } from './vscodeApi';

/** Within this many pixels of the bottom, the transcript follows new content. */
const FOLLOW_SLACK_PX = 40;
/** LLM calls listed under the token totals, newest first. */
const CALLS_SHOWN = 50;
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
/** Avatars per speaker; the bot's is the robot that starts voice mode. */
const AVATAR: Record<'user' | 'bot' | 'narr' | 'sys', string> = {
    user: `${SVG_OPEN}<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 14a5.25 5.25 0 0 1 10.5 0"/></svg>`,
    bot: ICON_ROBOT,
    narr: `${SVG_OPEN}<path d="M3 12h10l-1.25-1.5V7a3.75 3.75 0 0 0-7.5 0v3.5z"/><path d="M6.5 13.75a1.5 1.5 0 0 0 3 0"/></svg>`,
    sys: `${SVG_OPEN}<path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/></svg>`,
};

function post(message: VoiceViewClientMessage): void {
    vscode.postMessage({ type: 'voice', message } satisfies ClientMessage);
}

function esc(text: string): string {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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
    <button type="button" class="vp-sum" aria-expanded="false" title="Show engines and token use"><span class="vp-sum-v"></span><span class="vp-car">▶</span></button>
    <button type="button" class="vp-hist" title="Past voice conversations" aria-label="Past voice conversations">${HISTORY_ICON}</button>
    <div class="vp-detail">
        <div class="vp-eng"></div>
        <details class="vp-tokens">
            <summary title="Every LLM call of the voice agent in this session"><span class="vp-k">Tokens</span><span class="vp-tok-sum"></span><span class="vp-car">▶</span></summary>
            <div class="vp-calls"></div>
        </details>
    </div>
</div>
<div class="vp-cards"></div>
<div class="vp-banner">Viewing a past session — read only</div>
<div class="vp-stream" role="log" aria-live="polite"><div class="vp-empty"></div></div>`;

const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
const headEl = q('.vp-head');
const sumBtn = q<HTMLButtonElement>('.vp-sum');
const sumEl = q('.vp-sum-v');
const engEl = q('.vp-eng');
const tokensEl = q<HTMLDetailsElement>('.vp-tokens');
const tokSumEl = q('.vp-tok-sum');
const callsEl = q('.vp-calls');
const cardsEl = q('.vp-cards');
const stream = q('.vp-stream');
/** Stays last in the stream, shown only while there are no turns. */
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

// ── Header: engines, context window, tokens ──

function row(key: string, value: string, title = ''): string {
    return `<div class="vp-row"${title ? ` title="${esc(title)}"` : ''}><span class="vp-k">${esc(key)}</span><span class="vp-v">${value}</span></div>`;
}

function renderHead(s: VoiceViewState): void {
    const { llm, stt, tts, running } = s.engines;
    const sep = '<span class="vp-sep">·</span>';
    const rows = [
        row(
            'LLM',
            [esc(llm.model ?? 'the chat tab’s model'), `thinking ${esc(llm.thinking)}`, `${VOICE_MODE_LABEL[s.mode]} mode`].join(sep),
            'oh-my-pi-chater.voiceAgent.model / thinking',
        ),
        row('STT', [esc(shortUrl(stt.url)), esc(stt.model), `language ${esc(stt.language)}`].join(sep), 'oh-my-pi-chater.voice.*'),
        row(
            'TTS',
            [esc(tts.provider), esc(shortUrl(tts.url)), esc(tts.model), `voice ${esc(tts.voice)}`, `speed ${tts.speed}`, `language: ${esc(tts.language)}`].join(sep),
            'oh-my-pi-chater.voiceAgent.tts.*',
        ),
    ];
    const context = s.usage?.context;
    if (context && context.contextWindow > 0) {
        const pct = context.percent === null ? undefined : Math.max(0, Math.min(100, context.percent));
        const used = context.tokens === null ? '—' : formatTokenCount(context.tokens);
        rows.push(
            row(
                'Context',
                `<span class="vp-meter-bar"><i style="width:${pct ?? 0}%"></i></span>${pct === undefined ? '' : `${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%${sep}`}${used} / ${formatTokenCount(context.contextWindow)}`,
                'How much of the voice model’s context window this task’s voice context uses',
            ),
        );
    }
    setHtml(engEl, rows.join(''));
    root.classList.toggle('vp-configured', !running);
    engEl.title = running ? '' : 'Voice mode is off: these are the settings it will use.';

    const calls = s.entries.flatMap((e) =>
        e.kind === 'assistant' ? (e.usage ?? []).map((u) => ({ u, who: e.proactive ? `Update · ${e.proactive}` : 'Reply' })) : [],
    );
    const u = s.usage;
    tokensEl.hidden = !u && calls.length === 0;
    const tokens = u
        ? [
              `in ${formatTokenCount(u.input)}`,
              `out ${formatTokenCount(u.output)}`,
              `cache read ${formatTokenCount(u.cacheRead)}`,
              `write ${formatTokenCount(u.cacheWrite)}`,
              cost(u.cost),
          ].join(sep)
        : `${calls.length} call${calls.length === 1 ? '' : 's'} in this session`;
    setHtml(tokSumEl, tokens);
    setHtml(callsEl, callsTable(calls.slice(-CALLS_SHOWN).reverse()));

    const brief = (key: string, value: string) => `<span class="vp-sk">${key}</span> ${value}`;
    setHtml(
        sumEl,
        [
            brief('LLM', esc(llm.model ?? 'chat tab’s model')),
            brief('STT', esc(shortUrl(stt.url))),
            brief('TTS', esc(tts.provider)),
            ...(u ? [brief('Tokens', `${formatTokenCount(u.input + u.output)}${sep}${cost(u.cost)}`)] : calls.length ? [brief('Tokens', `${calls.length} call${calls.length === 1 ? '' : 's'}`)] : []),
        ].join(sep),
    );
}

function callsTable(calls: Array<{ u: VoiceCallUsage; who: string }>): string {
    if (calls.length === 0) {
        return '<div class="vp-calls-empty">No LLM calls yet.</div>';
    }
    const body = calls
        .map(
            ({ u, who }) =>
                `<tr><td>${new Date(u.at).toLocaleTimeString()}</td><td>${esc(who)}</td><td>${formatTokenCount(u.input)}</td><td>${formatTokenCount(u.cacheRead)}</td><td>${formatTokenCount(u.cacheWrite)}</td><td>${formatTokenCount(u.output)}</td><td>${cost(u.cost)}</td></tr>`,
        )
        .join('');
    return `<table><thead><tr><th>Time</th><th>For</th><th>In</th><th>Cache read</th><th>Cache write</th><th>Out</th><th>Cost</th></tr></thead><tbody>${body}</tbody></table>`;
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
    body: HTMLElement;
    post: HTMLElement;
    error: HTMLElement;
    chips: HTMLElement;
    /** Stopwatch button after the header's time, shown on hover; toggles `timingBody` (the turn's latency breakdown). */
    timing: HTMLButtonElement;
    timingBody: HTMLElement;
    /** Whether `body` holds per-sentence spans or plain text. */
    mode?: 'sentences' | 'text';
}

const turns = new Map<string, TurnView>();
/** Keys of expanded chips (`<entry id>:<chip>`), kept across re-renders and snapshots. */
const openChips = new Set<string>();
let sessionId: string | undefined;

function createTurn(): TurnView {
    const el = document.createElement('div');
    el.innerHTML =
        '<div class="vp-av" aria-hidden="true"></div><time class="vp-gtime"></time><div class="vp-who"><span class="vp-name"></span><time class="vp-time"></time><button type="button" class="vp-timing" aria-expanded="false" hidden>' +
        TIMING_ICON +
        '</button></div><div class="vp-txt"><div class="vp-attach"></div><div class="vp-line"><span class="vp-pre"></span><span class="vp-body"></span><span class="vp-post"></span></div><div class="vp-err" hidden></div><div class="vp-chips"></div><div class="vp-chip-body vp-timing-body" hidden></div></div>';
    const part = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
    return {
        el,
        avatar: part('.vp-av'),
        who: part('.vp-name'),
        time: part('.vp-time'),
        gutterTime: part('.vp-gtime'),
        attach: part('.vp-attach'),
        pre: part('.vp-pre'),
        body: part('.vp-body'),
        post: part('.vp-post'),
        error: part('.vp-err'),
        chips: part('.vp-chips'),
        timing: part<HTMLButtonElement>('.vp-timing'),
        timingBody: part('.vp-timing-body'),
    };
}

/** Who said a turn, for grouping: a user's spoken and typed turns get separate headers (the header shows the source). */
function speaker(entry: VoiceEntry): string {
    return entry.kind === 'user' ? `user:${entry.source}` : entry.kind === 'system' ? 'sys' : entry.proactive ? 'narr' : 'bot';
}

function renderStream(s: VoiceViewState): void {
    if (s.session.id !== sessionId) {
        sessionId = s.session.id;
        turns.clear();
        openChips.clear();
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
    for (const entry of entries) {
        let view = turns.get(entry.id);
        if (!view) {
            view = createTurn();
            turns.set(entry.id, view);
        }
        updateTurn(view, entry, s.debug);
        const grouped = prevEntry !== undefined && speaker(prevEntry) === speaker(entry) && entry.at - prevEntry.at < GROUP_MS;
        view.el.classList.toggle('cont', grouped);
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
    const emptyText = s.session.readonly
        ? 'Nothing was said in this session.'
        : s.phase === 'off'
          ? 'Voice mode is off. Start it with the robot above the chat’s input box.'
          : 'Say something, or type in the chat’s input box.';
    if (emptyEl.textContent !== emptyText) {
        emptyEl.textContent = emptyText;
    }
    if (follow) {
        stream.scrollTop = stream.scrollHeight;
    }
}

function updateTurn(view: TurnView, entry: VoiceEntry, debug: boolean): void {
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
        setHtml(view.avatar, AVATAR.user);
        const [icon, title] = SOURCE_ICON[entry.source] ?? SOURCE_ICON.text;
        setHtml(view.who, `User<span class="vp-src" title="${title}">${icon}</span>`);
        setHtml(view.attach, '');
        setHtml(view.pre, entry.bargeIn ? '<span class="vp-barge">Barged in</span>' : '');
        setText(view, entry.text);
        setHtml(view.post, '');
        setError(view, undefined);
        setHtml(view.chips, '');
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
        setHtml(view.avatar, AVATAR.sys);
        setHtml(view.who, 'Setting');
        setHtml(view.attach, '');
        setHtml(view.pre, '');
        setText(view, entry.text);
        setHtml(view.post, '');
        setError(view, undefined);
        setHtml(view.chips, '');
        setTiming(view, entry.id, []);
        return;
    }

    const kind = entry.proactive ? 'narr' : 'bot';
    view.el.className = `vp-turn ${kind}${entry.silent ? ' silent' : ''}`;
    setHtml(view.avatar, AVATAR[kind]);
    setHtml(view.who, `${entry.proactive ? 'Update' : 'Bot'}<span class="vp-badge">AI</span>`);
    setHtml(view.attach, debug && entry.input ? esc(entry.input) : '');
    setHtml(view.pre, entry.proactive ? `<span class="vp-kind ${esc(entry.proactive)}">${esc(entry.proactive)}</span>` : '');

    const sentences = entry.sentences ?? [];
    const cut = sentences.some((x) => x.state === 'cut');
    if (entry.silent) {
        const said = entry.text.replace(/<silent\s*\/>/g, '').trim();
        setText(view, said);
        setHtml(view.post, '<span class="vp-partial">&lt;silent/&gt; · not spoken</span>');
    } else {
        if (sentences.length > 0) {
            setSentences(view, sentences);
        } else if (!entry.done && !entry.text) {
            view.mode = 'text';
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
    renderChips(view.chips, entry.id, entry.tools, entry.lookups);
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
    const open = openChips.has(key);
    view.timing.dataset.key = key;
    view.timing.title = summary ? `Timing: ${summary}\n${detail}` : `Timing\n${detail}`;
    view.timing.setAttribute('aria-expanded', String(open));
    view.timing.classList.toggle('open', open);
    if (view.timingBody.textContent !== detail) {
        view.timingBody.textContent = detail;
    }
    view.timingBody.hidden = !open;
}

function setText(view: TurnView, text: string): void {
    if (view.mode !== 'text' || htmlCache.has(view.body) || view.body.textContent !== text) {
        view.body.textContent = text;
        htmlCache.delete(view.body);
    }
    view.mode = 'text';
}

function setError(view: TurnView, error: string | undefined): void {
    view.error.hidden = !error;
    view.error.textContent = error ? `⚠ ${error}` : '';
}

/** Scripts written without spaces between words. */
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

function setSentences(view: TurnView, sentences: VoiceSentence[]): void {
    if (view.mode !== 'sentences') {
        view.mode = 'sentences';
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

interface Chip {
    key: string;
    cls: string;
    html: string;
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstLine(text: string): string {
    return text.trim().split('\n', 1)[0] ?? '';
}

function toolChip(tool: VoiceToolEntry): { cls: string; label: string; title: string; status?: [string, string]; detail?: string } {
    const args = tool.args ?? {};
    const result = tool.result ?? '';
    const done: [string, string] = ['vp-st-ok', '✓'];
    switch (tool.name) {
        case 'tell_worker': {
            const proposed = /^not sent yet/i.test(result.trim());
            const opts = [str(args.when) && `when: ${str(args.when)}`, typeof args.readOnly === 'boolean' && `readOnly: ${args.readOnly}`]
                .filter(Boolean)
                .join(' · ');
            return {
                cls: proposed ? 'proposal' : 'dispatch',
                label: proposed ? 'Proposed' : 'Sent to worker',
                title: str(args.message) ?? '',
                status: proposed ? ['vp-st-wait', 'awaiting confirmation'] : done,
                detail: [opts, str(args.message)].filter(Boolean).join('\n\n'),
            };
        }
        case 'confirm_task':
            return { cls: 'confirm', label: 'Confirmed task', title: firstLine(result), status: done };
        case 'answer_worker': {
            const answer =
                str(args.value) ??
                (typeof args.confirmed === 'boolean' ? (args.confirmed ? 'Yes' : 'No') : args.cancel === true ? 'Cancelled' : undefined);
            return { cls: 'answer', label: 'Answered worker', title: answer ?? firstLine(result), status: done };
        }
        case 'stop_worker':
            return { cls: 'stop', label: 'Stopped worker', title: firstLine(result), status: done };
        case 'research':
            return { cls: 'research', label: 'Research', title: str(args.question) ?? '', detail: str(args.question) };
        case 'worker_status':
            return { cls: 'status', label: 'Checked worker', title: firstLine(result) };
        default: {
            const main = str(args.message) ?? str(args.question);
            return { cls: 'status', label: tool.name, title: main ?? firstLine(result), detail: main };
        }
    }
}

function chipHtml(label: string, title: string, rawName: string | undefined, status: [string, string] | undefined, body: string): string {
    const st = status ? `<span class="${status[0]}">${esc(status[1])}</span>` : '';
    const tn = `<span class="vp-tn"${rawName ? ` title="${esc(rawName)}"` : ''}>${esc(label)}</span>`;
    return `<summary><span class="vp-car">▶</span>${tn}<span class="vp-t">${esc(title)}</span>${st}</summary>${body ? `<div class="vp-chip-body">${body}</div>` : ''}`;
}

function renderChips(container: HTMLElement, entryId: string, tools: VoiceToolEntry[], lookups: string[]): void {
    const chips: Chip[] = tools.map((tool, i) => {
        const c = toolChip(tool);
        const status: [string, string] | undefined = tool.isError ? ['vp-st-no', '✗'] : c.status;
        const parts: string[] = [];
        if (c.detail) {
            parts.push(esc(c.detail));
        }
        if (tool.result) {
            parts.push(`<span class="vp-res">${esc(tool.result)}</span>`);
        }
        return {
            key: `${entryId}:t${i}`,
            cls: `vp-chip ${c.cls}${tool.isError ? ' failed' : ''}`,
            html: chipHtml(c.label, c.title, tool.name, status, parts.join('')),
        };
    });
    if (lookups.length > 0) {
        const title = lookups.length > 1 ? `${lookups[0]} +${lookups.length - 1}` : lookups[0];
        chips.push({
            key: `${entryId}:lookups`,
            cls: 'vp-chip read',
            html: chipHtml('Looked up', title, undefined, undefined, esc(lookups.join('\n'))),
        });
    }
    const existing = container.children;
    chips.forEach((chip, i) => {
        const el = existing[i] as HTMLDetailsElement | undefined;
        if (el && el.dataset.key === chip.key && el.className === chip.cls && htmlCache.get(el) === chip.html) {
            return;
        }
        const details = document.createElement('details');
        details.className = chip.cls;
        details.dataset.key = chip.key;
        details.innerHTML = chip.html;
        htmlCache.set(details, chip.html);
        details.open = openChips.has(chip.key);
        if (el) {
            el.replaceWith(details);
        } else {
            container.append(details);
        }
    });
    while (existing.length > chips.length) {
        existing[existing.length - 1].remove();
    }
}

// `toggle` does not bubble; listen in the capture phase.
stream.addEventListener(
    'toggle',
    (e) => {
        const details = e.target as HTMLElement;
        if (!(details instanceof HTMLDetailsElement) || !details.dataset.key) {
            return;
        }
        if (details.open) {
            openChips.add(details.dataset.key);
        } else {
            openChips.delete(details.dataset.key);
        }
    },
    true,
);

stream.addEventListener('click', (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>('.vp-timing');
    const key = button?.dataset.key;
    if (!button || !key) {
        return;
    }
    const open = !openChips.delete(key);
    if (open) {
        openChips.add(key);
    }
    button.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
    button.closest('.vp-turn')!.querySelector<HTMLElement>('.vp-timing-body')!.hidden = !open;
});

// ── Cards above the transcript: tasks to confirm, background research ──
// The worker and its requests are not repeated here: the chat around the panel shows them.

const cardEls = new Map<string, Element>();

function renderCards(s: VoiceViewState): void {
    const cards: Array<{ key: string; html: string }> = [];
    if (!s.session.readonly) {
        for (const p of s.proposals) {
            cards.push({ key: `prop:${p.id}`, html: proposalCardHtml(p) });
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

function proposalCardHtml(p: VoiceProposalCard): string {
    return `<div class="vp-card vp-ask" title="It changes files, so it needs your go-ahead. Say “go ahead” or “cancel”.">
        <span class="vp-card-h">Confirm task</span>
        <span class="vp-q" title="${esc(p.message)}">${esc(p.message)}</span>
        <span class="vp-card-btns"><button type="button" class="vp-pbtn" data-act="proposal" data-action="confirm" data-id="${esc(p.id)}">Confirm</button><button type="button" class="vp-pbtn sec" data-act="proposal" data-action="cancel" data-id="${esc(p.id)}">Cancel</button></span>
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
        <span class="vp-card-h">Research</span>${glyph}<span class="vp-q" title="${esc(r.question)}">${esc(r.question)}</span>${time}${more}
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
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-act="proposal"]');
    if (target) {
        post({ type: 'proposal', id: target.dataset.id!, action: target.dataset.action === 'confirm' ? 'confirm' : 'cancel' });
    }
});

// ── Snapshot ──

export function handleVoiceMessage(msg: VoiceViewHostMessage): void {
    const s = msg.state;
    root.dataset.state = s.phase;
    root.classList.toggle('readonly', s.session.readonly);
    renderHead(s);
    renderCards(s);
    renderStream(s);
}

post({ type: 'ready' });
