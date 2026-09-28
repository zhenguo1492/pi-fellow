/**
 * Decides whether speech heard while the bot talks is
 * the user or leftover echo / STT noise. Pure; no I/O.
 *
 * Measured false barge-ins (WebRTC AEC on HDMI speakers + Studio Display mic)
 * transcribe as fragments of the bot's own sentence: "不好意思", "没关系",
 * "这个顾设是4800万像" while it said "主摄是四千八百万像素". Whisper also invents
 * video-outro lines on non-speech ("请不吝点赞 订阅 转发…").
 */

/** Phrases Whisper produces from silence/noise, never from this user. */
const HALLUCINATION_MARKERS = [
    '点赞',
    '订阅',
    '打赏',
    '字幕',
    '独播剧场',
    '明镜',
    '谢谢观看',
    '感谢观看',
    'amara',
    'television',
    'thanks for watching',
    'thank you for watching',
    'subscribe',
];
/** Whole transcripts Whisper emits for near-silence (measured: "Thank you." on echo tail). */
const HALLUCINATION_EXACT: Record<string, true> = { thankyou: true, thanks: true, you: true, bye: true, 谢谢: true, 谢谢大家: true };
/** Share of the transcript's token pairs found in the bot's text at or above which it is echo. */
const ECHO_BIGRAM_RATIO = 0.5;
/** Fewer tokens (Han characters / words) than this cannot justify cutting the bot off... */
const MIN_TOKENS = 2;
/** ...unless it is one of these, said while the bot did not say it. */
const STOP_WORDS: Record<string, true> = { 停: true, 等等: true, 等一下: true, 打住: true, stop: true, wait: true, holdon: true };

const DIGITS = '零一二三四五六七八九';
const DIGIT_UNITS = ['', '十', '百', '千'];

/** 0..9999 read the way TTS says it ("4800" → "四千八百"). */
function readSection(n: number): string {
    let out = '';
    let pendingZero = false;
    for (let i = 3; i >= 0; i--) {
        const d = Math.floor(n / 10 ** i) % 10;
        if (d === 0) {
            pendingZero = out.length > 0;
            continue;
        }
        if (pendingZero) {
            out += '零';
            pendingZero = false;
        }
        out += DIGITS[d] + DIGIT_UNITS[i];
    }
    return out;
}

/** Arabic numerals → spoken Chinese, so "4800万" and "四千八百万" compare equal. */
function readNumber(digits: string): string {
    const n = Number(digits);
    if (digits.length > 8 || digits.startsWith('0') || n === 0) {
        return [...digits].map((d) => DIGITS[Number(d)]).join('');
    }
    const high = Math.floor(n / 10000);
    const low = n % 10000;
    let out = high ? `${readSection(high)}万` : '';
    if (low) {
        out += (high && low < 1000 ? '零' : '') + readSection(low);
    }
    return out.replace(/^一十/, '十');
}

/**
 * Comparable tokens: each Han character, each Latin word; numbers spelled out in Chinese
 * first so "4800万" and "四千八百万" match. Letter pairs would be useless for English ("th", "he").
 */
export function tokenize(text: string): string[] {
    return text.toLowerCase().replace(/\d+/g, readNumber).match(/\p{Script=Han}|[\p{Script=Latin}\p{N}]+|\p{L}/gu) ?? [];
}

export type BargeInVerdict = { kind: 'user' } | { kind: 'reject'; reason: string };

/** Is `transcript` (heard while the bot said `botText`) a real interruption? */
export function classifyBargeIn(transcript: string, botText: string): BargeInVerdict {
    if (isHallucination(transcript)) {
        return { kind: 'reject', reason: 'STT 幻听' };
    }
    const heard = tokenize(transcript);
    const said = tokenize(botText);
    const heardJoined = heard.join('');
    if (STOP_WORDS[heardJoined]) {
        return said.join('').includes(heardJoined) ? { kind: 'reject', reason: '像回声（打断词）' } : { kind: 'user' };
    }
    if (heard.length < MIN_TOKENS) {
        return { kind: 'reject', reason: heard.length ? '太短' : '空' };
    }
    const ratio = echoRatio(heard, said);
    return ratio >= ECHO_BIGRAM_RATIO ? { kind: 'reject', reason: `像回声（重合 ${Math.round(ratio * 100)}%）` } : { kind: 'user' };
}

/** Share of `heard`'s token pairs (at least two tokens) that `said` also has. */
function echoRatio(heard: string[], said: string[]): number {
    const saidPairs = new Set<string>();
    for (let i = 0; i + 1 < said.length; i++) {
        saidPairs.add(`${said[i]} ${said[i + 1]}`);
    }
    let echoed = 0;
    for (let i = 0; i + 1 < heard.length; i++) {
        if (saidPairs.has(`${heard[i]} ${heard[i + 1]}`)) {
            echoed++;
        }
    }
    return echoed / (heard.length - 1);
}

/**
 * Is `transcript` the microphone hearing `text` played back (a replayed message)? Unlike a barge-in
 * check, a short transcript is not rejected for being short: one word counts as echo only if `text` has it.
 */
export function isEchoOf(transcript: string, text: string): boolean {
    const heard = tokenize(transcript);
    const said = tokenize(text);
    if (heard.length === 0) {
        return false;
    }
    return heard.length === 1 ? said.includes(heard[0]) : echoRatio(heard, said) >= ECHO_BIGRAM_RATIO;
}

export function isHallucination(transcript: string): boolean {
    const t = transcript.toLowerCase();
    return HALLUCINATION_EXACT[tokenize(t).join('')] === true || HALLUCINATION_MARKERS.some((m) => t.includes(m));
}
