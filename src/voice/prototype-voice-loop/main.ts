/**
 * PROTOTYPE — throwaway terminal shell; not part of the extension build.
 *
 * Question: does a full-duplex voice loop — mic → Silero VAD → STT → omp (RPC,
 * no tools) → sentence-by-sentence TTS → speaker, with barge-in — feel natural
 * enough to build the voice agent on? Watch the turn-end timing, per-hop
 * latency, how cutting the bot off feels, and whether the `<interrupted>` note
 * keeps the bot coherent. The policy lives in ./conversation.ts (pure); this
 * file only wires devices and draws the screen.
 *
 * Run:   npm run proto:voice -- [--voice af_heart] [--model sonnet] [--stop-secs 1.2]
 *        English by default (Kokoro's Chinese voices sound poor). Chinese: --language zh --voice zf_xiaobei --reply-language zh
 *        Mic + speaker run in a hidden Chrome it starts itself (Chrome AEC3, as in pipecat's web
 *        client); no window. Without Chrome, or with --audio tab, it opens a normal browser tab.
 *        npm run proto:voice -- --audio pulse               (parecord/pacat + PipeWire WebRTC AEC)
 *        npm run proto:voice -- --tts omp --voice af_heart  (omp say, English voices only)
 *        npm run proto:voice -- --mic-file /tmp/user.raw     (scripted user: raw 16 kHz s16le mono)
 * Needs: Chrome (or pulse tools), `omp` on PATH, STT at --stt-url, TTS at --tts-url.
 * Log:   $TMPDIR/voice-proto.log
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { parseArgs } from 'node:util';
import { SileroVad, VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE } from '../sileroVad';
import { SpeechSegmenter } from '../speechSegmenter';
import { SttClient } from '../stt';
import { initialState, reduce, type BotEntry, type ConvEvent, type ConvState, type Effect, type Metrics } from './conversation';
import { classifyBargeIn, isHallucination, type BargeInVerdict } from './echoFilter';
import { findChrome, launchHiddenChrome, startBrowserAudio, type BrowserAudio } from './browserAudio';
import { cleanForSpeech } from './sentences';

const { values: opt } = parseArgs({
    options: {
        'stt-url': { type: 'string', default: 'http://127.0.0.1:8010/v1' },
        'stt-model': { type: 'string', default: '' },
        /** STT language hint; "" = auto-detect. */
        language: { type: 'string', default: 'en' },
        /** Language the bot must answer in; must match the TTS voice. */
        'reply-language': { type: 'string', default: 'en' },
        tts: { type: 'string', default: 'openai' },
        'tts-url': { type: 'string', default: 'http://127.0.0.1:8880/v1' },
        'tts-model': { type: 'string', default: 'kokoro' },
        voice: { type: 'string' },
        speed: { type: 'string', default: '1.0' },
        model: { type: 'string' },
        'stop-secs': { type: 'string', default: '1.2' },
        'vad-confidence': { type: 'string', default: '0.5' },
        'mic-file': { type: 'string' },
        'no-aec': { type: 'boolean', default: false },
        /** headless: hidden Chrome owns mic + speaker (AEC3); tab: same page in a visible tab; pulse: parecord/pacat. */
        audio: { type: 'string', default: 'headless' },
        port: { type: 'string', default: '7861' },
        'no-open': { type: 'boolean', default: false },
        /** Browser mic processing overrides, e.g. "ec=1&ns=0&agc=0" (diagnostics). */
        'mic-processing': { type: 'string', default: '' },
        /** [DEBUG-dump] raw 16 kHz mic as the browser sends it (≈2 MB/min), overwritten each run; "" disables. */
        'dump-mic': { type: 'string', default: path.join(os.tmpdir(), 'voice-proto-mic.raw') },
    },
});
const ttsBackend = opt.tts === 'omp' ? 'omp' : 'openai';
const voice = opt.voice ?? (opt['reply-language'] === 'zh' && ttsBackend !== 'omp' ? 'zf_xiaobei' : 'af_heart');
let stopSecs = Number(opt['stop-secs']);

const REPO_ROOT = path.resolve(__dirname, '../../..');
const LOG_FILE = path.join(os.tmpdir(), 'voice-proto.log');
/** pacat buffer + device; added to playback-time estimates. */
const OUTPUT_LATENCY_MS = 80;
const audioMode = opt['mic-file'] ? 'file' : opt.audio === 'pulse' ? 'pulse' : 'browser';
/** PipeWire WebRTC echo canceller; only the pulse path needs it (the browser has its own). */
const aec = audioMode === 'pulse' && !opt['no-aec'];
const AEC_SOURCE = 'voiceproto_ec_source';
const AEC_SINK = 'voiceproto_ec_sink';
/**
 * Bot audio the WebRTC canceller must hear before its residual echo stops tripping the VAD.
 * Measured on HDMI speakers + Studio Display mic: first ~4 s leak (VAD 0.5–0.9), then ≤ 0.4.
 * Until then the mic is ignored while the bot talks.
 */
const AEC_WARMUP_MS = 5000;
/**
 * While the bot talks, evidence (confident VAD or loud frames) needed before the audio goes to STT
 * for a barge-in check. The bot keeps talking until STT shows real words that are not its own echo.
 */
const BARGE_IN_MS = 400;
/**
 * A rejected check is retried whenever the evidence has grown this much more, with no limit: the
 * user's real words may only start after some echo.
 */
const BARGE_IN_RECHECK_MS = 600;
/** Each check transcribes only the latest audio, so earlier echo does not drown the user's words. */
const BARGE_IN_WINDOW_FRAMES = Math.round(1500 / ((VAD_FRAME_SAMPLES / VAD_SAMPLE_RATE) * 1000));
/** A candidate that goes quiet before its first check still gets one if it held this much evidence. */
const MIN_FINAL_CHECK_MS = 150;
/** Quiet that ends an unconfirmed candidate. */
const BARGE_IN_GAP_MS = 800;
/** Frames kept in front of a barge-in (0.5 s). */
const BARGE_IN_PREROLL_FRAMES = 16;
/** Stricter than the normal VAD threshold; converged residual echo peaks around 0.4. */
const BARGE_IN_CONFIDENCE = 0.6;
/**
 * A frame this loud counts as barge-in evidence even when VAD scores it low. Chrome AEC3 chops the
 * user's voice while the bot plays (double-talk): measured user speech −12…−27 dBFS with VAD only
 * flickering. Converged residual echo stays at −41…−62 dBFS, but during the first reply after
 * Chrome starts (AEC not converged) echo reached −4 dBFS — loudness only opens a candidate; the STT
 * check (echo/hallucination filter) is what decides.
 */
const BARGE_IN_DB = -35;
const FRAME_MS = (VAD_FRAME_SAMPLES / VAD_SAMPLE_RATE) * 1000;

const SYSTEM_PROMPT = `You are a voice chat companion talking with the user in real time through a microphone and speakers.
- Everything you say is read aloud by speech synthesis: use natural spoken language and short sentences, usually one to three; go longer only when the user asks for detail.
- No Markdown, bullet points, code blocks, emoji or URLs.
- The user's words come from speech recognition and may contain misheard words; go with the most plausible meaning, and if you really cannot tell, briefly ask them to say it again.
- ${
    opt['reply-language'] === 'zh'
        ? '用中文回答，即使用户说的是英文。'
        : 'Always reply in English, even if the user speaks another language: the synthesized voice can only speak English.'
}
- A message may start with an <interrupted> note: the user cut off your previous reply, and the note says what they actually heard. Do not assume they heard the rest, and do not repeat the unsaid part unless asked.`;

// ── log ────────────────────────────────────────────────────────────────────
const logs: string[] = [];
fs.writeFileSync(LOG_FILE, '');
function log(message: string): void {
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
    logs.push(line);
    if (logs.length > 50) {
        logs.shift();
    }
    fs.appendFileSync(LOG_FILE, `${line}\n`);
}

function which(bin: string): string | undefined {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(dir, bin);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // keep looking
        }
    }
    return undefined;
}

/** Puts a WebRTC echo canceller between the default mic and speaker; removed again on exit. */
function loadAec(): void {
    const pactl = (...args: string[]) => execFileSync('pactl', args, { encoding: 'utf8' }).trim();
    for (const line of pactl('list', 'short', 'modules').split('\n')) {
        if (line.includes('module-echo-cancel') && line.includes(AEC_SOURCE)) {
            pactl('unload-module', line.split('\t')[0]); // left over from a crashed run
        }
    }
    const source = pactl('get-default-source');
    const sink = pactl('get-default-sink');
    const index = pactl(
        'load-module',
        'module-echo-cancel',
        'aec_method=webrtc',
        `source_master=${source}`,
        `sink_master=${sink}`,
        `source_name=${AEC_SOURCE}`,
        `sink_name=${AEC_SINK}`,
    );
    process.on('exit', () => {
        try {
            execFileSync('pactl', ['unload-module', index]);
        } catch {
            // already gone
        }
    });
    log(`回声消除：WebRTC（模块 ${index}）麦克风 ${source} → 扬声器 ${sink}`);
}

// ── conversation state ─────────────────────────────────────────────────────
let state: ConvState = initialState();

function dispatch(ev: ConvEvent): void {
    if (ev.type !== 'llmText') {
        log(`事件 ${ev.type}${'text' in ev && ev.text ? ` “${ev.text}”` : ''}`);
    }
    const step = reduce(state, ev);
    state = step.state;
    for (const effect of step.effects) {
        runEffect(effect);
    }
}

/**
 * The bot turn in progress. Its AbortController is the only cancellation mechanism: the LLM, every
 * TTS request, every playback timer and the audio page queue subscribe to its signal, and after
 * abort none of them emits another event for this turn except the LLM's `llmEnd`.
 */
let currentTurn: { id: number; ctl: AbortController } | undefined;

function runEffect(effect: Effect): void {
    switch (effect.type) {
        case 'prompt':
            currentTurn = { id: effect.turnId, ctl: new AbortController() };
            log(`→ LLM ${JSON.stringify(effect.message)}`);
            llm.prompt(effect.message, currentTurn.ctl.signal);
            break;
        case 'speak':
            if (currentTurn?.id === effect.turnId) {
                speaker.enqueue(currentTurn.ctl.signal, effect.turnId, effect.text);
            }
            break;
        case 'cancelTurn':
            if (currentTurn?.id === effect.turnId) {
                log(`取消第 ${effect.turnId} 轮`);
                currentTurn.ctl.abort();
            }
            break;
    }
}

// ── LLM: hidden omp RPC process, no tools ──────────────────────────────────
/** extension_ui_request methods that block the agent until answered. */
const BLOCKING_UI_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

class OmpLlm {
    model = '启动中…';
    private readonly proc: ChildProcess;
    /** Signal of the prompt omp is working on; undefined when idle. */
    private running: AbortSignal | undefined;

    constructor() {
        const args = ['--mode', 'rpc', '--no-tools', '--no-skills', '--no-rules', '--no-extensions', '--no-lsp'];
        args.push('--no-session', '--no-title', '--thinking', 'off', '--system-prompt', SYSTEM_PROMPT);
        if (opt.model) {
            args.push('--model', opt.model);
        }
        this.proc = spawn('omp', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc.stdin!.on('error', () => {});
        this.proc.stderr!.on('data', (chunk: Buffer) => log(`omp stderr: ${chunk.toString().trim().slice(0, 300)}`));
        this.proc.on('exit', (code) => {
            this.model = `已退出 (${code})`;
            log(`omp 进程退出 code=${code}`);
        });
        readline.createInterface({ input: this.proc.stdout! }).on('line', (line) => this.onLine(line));
    }

    /** One prompt at a time (the reducer guarantees it); `signal` aborts the generation. */
    prompt(message: string, signal: AbortSignal): void {
        this.running = signal;
        this.send({ type: 'prompt', message });
        signal.addEventListener(
            'abort',
            () => {
                if (this.running === signal) {
                    log('→ LLM abort');
                    this.send({ type: 'abort' });
                }
            },
            { once: true },
        );
    }

    send(command: object): void {
        this.proc.stdin!.write(`${JSON.stringify(command)}\n`);
    }

    close(): void {
        this.proc.stdin!.end();
        setTimeout(() => this.proc.kill(), 1000).unref();
    }

    private onLine(line: string): void {
        let msg: Record<string, any>;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        switch (msg.type) {
            case 'ready':
                this.send({ id: 'state', type: 'get_state' });
                break;
            case 'response':
                if (msg.command === 'get_state' && msg.success) {
                    this.model = `${msg.data.model.provider}/${msg.data.model.id}`;
                    log(`omp 就绪，模型 ${this.model}`);
                } else if (msg.success === false) {
                    log(`omp ${msg.command} 失败: ${msg.error}`);
                    if (msg.command === 'prompt') {
                        this.running = undefined;
                        dispatch({ type: 'llmEnd', at: Date.now(), error: String(msg.error) });
                    }
                }
                break;
            case 'message_update':
                // Text after a cancel is the tail of an aborted generation.
                if (msg.assistantMessageEvent?.type === 'text_delta' && !this.running?.aborted) {
                    dispatch({ type: 'llmText', delta: msg.assistantMessageEvent.delta, at: Date.now() });
                }
                break;
            case 'agent_end': {
                const last = (msg.messages as { stopReason?: string; errorMessage?: string }[] | undefined)?.at(-1);
                const error = last?.stopReason === 'error' ? (last.errorMessage ?? 'unknown') : undefined;
                this.running = undefined;
                dispatch({ type: 'llmEnd', at: Date.now(), error });
                break;
            }
            case 'extension_ui_request':
                // No extensions are loaded; never leave a blocking dialog hanging.
                if (BLOCKING_UI_METHODS[msg.method]) {
                    this.send({ type: 'extension_ui_response', id: msg.id, cancelled: true });
                }
                break;
        }
    }
}

// ── TTS ────────────────────────────────────────────────────────────────────
interface Pcm {
    rate: number;
    data: Buffer;
}

/** 16-bit mono WAV → raw PCM + sample rate. */
function parseWav(buf: Buffer): Pcm {
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error(`TTS 返回的不是 WAV: ${buf.subarray(0, 80).toString()}`);
    }
    let rate = 0;
    let bits = 0;
    let channels = 0;
    for (let off = 12; off + 8 <= buf.length; ) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') {
            channels = buf.readUInt16LE(off + 10);
            rate = buf.readUInt32LE(off + 12);
            bits = buf.readUInt16LE(off + 22);
        } else if (id === 'data') {
            if (bits !== 16 || channels !== 1) {
                throw new Error(`需要 16-bit 单声道 WAV，收到 ${bits}-bit ${channels} 声道`);
            }
            const end = Math.min(buf.length, off + 8 + size);
            return { rate, data: buf.subarray(off + 8, end - ((end - off - 8) % 2)) };
        }
        off += 8 + size + (size % 2);
    }
    throw new Error('WAV 缺少 data 块');
}

async function synthesize(text: string, signal: AbortSignal): Promise<Pcm> {
    if (ttsBackend === 'omp') {
        const file = path.join(os.tmpdir(), `voice-proto-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
        await new Promise<void>((resolve, reject) => {
            const proc = spawn('omp', ['say', text, '--voice', voice, '-o', file], { stdio: ['ignore', 'ignore', 'pipe'], signal });
            let stderr = '';
            proc.stderr!.on('data', (chunk: Buffer) => {
                stderr = (stderr + chunk.toString()).slice(-300);
            });
            proc.on('error', reject);
            proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`omp say exit ${code}: ${stderr.trim()}`))));
        });
        const data = fs.readFileSync(file);
        fs.rmSync(file, { force: true });
        return parseWav(data);
    }
    const res = await fetch(`${opt['tts-url']!.replace(/\/+$/, '')}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            model: opt['tts-model'],
            input: text,
            voice,
            response_format: 'wav',
            speed: Number(opt.speed),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!res.ok) {
        throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return parseWav(Buffer.from(await res.arrayBuffer()));
}

// ── speaker: ordered playback through one long-lived pacat/aplay ───────────
interface Clip {
    turnId: number;
    text: string;
    /** The turn's cancellation signal. */
    signal: AbortSignal;
    audio: Promise<Pcm>;
}

/**
 * Synthesizes sentences concurrently and plays them in order. Everything is scoped to the turn's
 * signal: on abort, queued clips are dropped, in-flight TTS requests and timers cancelled, and the
 * player (pacat or the browser page) silenced.
 */
class Speaker {
    private queue: Clip[] = [];
    private pumping = false;
    private player: { proc: ChildProcess; rate: number } | undefined;
    /** Epoch ms at which everything written so far has finished playing. */
    private playheadEnd = 0;
    /** Signal of the turn whose audio is queued/playing; the abort listener is attached once per turn. */
    private turnSignal: AbortSignal | undefined;
    /** Total bot audio played; the PipeWire echo canceller learns from it. */
    playedMs = 0;

    enqueue(signal: AbortSignal, turnId: number, text: string): void {
        if (signal.aborted) {
            return;
        }
        if (signal !== this.turnSignal) {
            this.turnSignal = signal;
            signal.addEventListener('abort', () => this.silence(), { once: true });
        }
        const started = Date.now();
        const audio = synthesize(text, signal);
        audio.then(
            (pcm) => log(`TTS ${Date.now() - started}ms ${(pcm.data.length / 2 / pcm.rate).toFixed(1)}s “${text}”`),
            () => {},
        );
        this.queue.push({ turnId, text, signal, audio });
        void this.pump();
    }

    private silence(): void {
        this.queue = [];
        this.player?.proc.kill('SIGKILL');
        this.player = undefined;
        browserAudio?.flush();
        this.playheadEnd = 0;
    }

    private async pump(): Promise<void> {
        if (this.pumping) {
            return;
        }
        this.pumping = true;
        let last: AbortSignal | undefined;
        while (this.queue.length > 0) {
            const clip = this.queue[0];
            let pcm: Pcm | undefined;
            try {
                pcm = await clip.audio;
            } catch (err) {
                if (!clip.signal.aborted) {
                    log(`TTS 失败: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (this.queue[0] !== clip) {
                continue; // the turn was cancelled while this clip was being synthesized
            }
            this.queue.shift();
            last = clip.signal;
            if (pcm) {
                this.play(clip, pcm);
            }
        }
        this.pumping = false;
        if (last) {
            this.at(this.playheadEnd, last, () => {
                if (this.queue.length === 0 && !this.pumping && Date.now() >= this.playheadEnd - 5) {
                    dispatch({ type: 'audioIdle', at: Date.now() });
                }
            });
        }
    }

    private play(clip: Clip, pcm: Pcm): void {
        if (browserAudio) {
            browserAudio.play(pcm.data, pcm.rate);
        } else {
            if (this.player?.rate !== pcm.rate) {
                this.player?.proc.stdin!.end();
                this.player = { proc: this.spawnPlayer(pcm.rate), rate: pcm.rate };
            }
            this.player.proc.stdin!.write(pcm.data);
        }
        const start = Math.max(Date.now() + OUTPUT_LATENCY_MS, this.playheadEnd);
        const durationMs = (pcm.data.length / 2 / pcm.rate) * 1000;
        this.playheadEnd = start + durationMs;
        const { turnId, text, signal } = clip;
        this.at(start, signal, () => dispatch({ type: 'sentencePlaying', turnId, text, at: Date.now() }));
        this.at(this.playheadEnd, signal, () => {
            this.playedMs += durationMs;
            dispatch({ type: 'sentencePlayed', turnId, text, at: Date.now() });
        });
    }

    /** Runs `fn` at epoch `when` unless the turn is cancelled first. */
    private at(when: number, signal: AbortSignal, fn: () => void): void {
        if (signal.aborted) {
            return;
        }
        const t = setTimeout(fn, Math.max(0, when - Date.now()));
        signal.addEventListener('abort', () => clearTimeout(t), { once: true });
    }

    private spawnPlayer(rate: number): ChildProcess {
        const pacat = which('pacat');
        const proc = pacat
            ? spawn(pacat, ['--playback', '--format=s16le', `--rate=${rate}`, '--channels=1', '--latency-msec=60', ...(aec ? [`--device=${AEC_SINK}`] : [])], {
                  stdio: ['pipe', 'ignore', 'pipe'],
              })
            : spawn('aplay', ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(rate), '-c', '1'], { stdio: ['pipe', 'ignore', 'pipe'] });
        proc.stdin!.on('error', () => {});
        proc.stderr!.on('data', (chunk: Buffer) => log(`player: ${chunk.toString().trim()}`));
        proc.on('error', (err) => log(`player 启动失败: ${err.message}`));
        return proc;
    }
}

// ── microphone → VAD → segments → STT ──────────────────────────────────────
const RECORDERS: { bin: string; args: string[] }[] = [
    { bin: 'arecord', args: ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw'] },
    // Without --latency-msec parecord hands over audio in 2 s blocks (measured), delaying every VAD decision.
    { bin: 'parecord', args: ['--raw', '--format=s16le', '--rate=16000', '--channels=1', '--latency-msec=30'] },
];

let micLevel = 0;
interface BargeIn {
    /** Frames of evidence (confident VAD or loud) so far. */
    evidenceMs: number;
    /** `evidenceMs` at which the next STT check runs. */
    checkAtMs: number;
    /** Time since the last speech-like frame. */
    quietMs: number;
    verifying: boolean;
    /** The last-chance check for a short "停" / "wait" has been spent. */
    finalChecked: boolean;
    confirmed: boolean;
    /** What the confirming STT check heard; stands in if the whole utterance transcribes badly. */
    heardText?: string;
    /** Audio from just before the speech started until now. */
    frames: Int16Array[];
}

function concatFrames(frames: Int16Array[]): Int16Array {
    const pcm = new Int16Array(frames.length * VAD_FRAME_SAMPLES);
    frames.forEach((f, i) => pcm.set(f, i * VAD_FRAME_SAMPLES));
    return pcm;
}

/** +/- keys: applied once the user is not mid-utterance. */
let pendingStopSecs: number | undefined;
let recorder: ChildProcess | undefined;
let browserAudio: BrowserAudio | undefined;

function segmenterFor(secs: number): SpeechSegmenter {
    return new SpeechSegmenter(
        { confidence: Number(opt['vad-confidence']), startSecs: 0.2, stopSecs: secs, preRollSecs: 0.3, maxSegmentSecs: 28 },
        VAD_FRAME_SAMPLES,
        VAD_SAMPLE_RATE,
    );
}

function startMic(vad: SileroVad, stt: SttClient): void {
    const found = aec
        ? { bin: 'parecord', path: which('parecord'), args: [...RECORDERS[1].args, `--device=${AEC_SOURCE}`] }
        : RECORDERS.map((r) => ({ ...r, path: which(r.bin) })).find((r) => r.path);
    if (!found && audioMode === 'pulse') {
        throw new Error('没有找到录音程序（arecord / parecord）');
    }
    let segmenter = segmenterFor(stopSecs);
    let wasGated = false;
    /**
     * Speech heard while the bot talks. It owns the audio (the segmenter is not fed) until it is
     * rejected, or confirmed by STT and then ended by `stopSecs` of quiet.
     */
    let bargeIn: BargeIn | undefined;
    /** Last few frames, so a barge-in check hears the start of the utterance too. */
    const recent: Int16Array[] = [];
    let delivery: Promise<void> = Promise.resolve();
    let buffered: Buffer = Buffer.alloc(0);
    let draining = false;

    /** `fallback`: text already heard for this utterance (barge-in check), used if the full transcript is unusable. */
    const finishSegment = (pcm: Int16Array, fallback?: string) => {
        const now = Date.now();
        dispatch({ type: 'userSpeechEnd', at: now, silenceAt: now - stopSecs * 1000 });
        const started = now;
        const result = stt.transcribe(pcm, VAD_SAMPLE_RATE).then(
            (text) => ({ text }),
            (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
        );
        delivery = delivery.then(async () => {
            const outcome = await result;
            let text = 'text' in outcome ? outcome.text : '';
            if ('error' in outcome) {
                log(`STT 失败: ${outcome.error}`);
            } else {
                log(`STT ${Date.now() - started}ms ${(pcm.length / VAD_SAMPLE_RATE).toFixed(1)}s`);
            }
            if (isHallucination(text)) {
                log(`丢弃 STT 幻听 “${text}”`);
                text = '';
            }
            if (!text.trim() && fallback) {
                // The bot was already cut off for this speech; replying to nothing leaves it silent.
                log(`整段识别无效，改用插嘴检查听到的 “${fallback}”`);
                text = fallback;
            }
            dispatch({ type: 'transcript', text, at: Date.now() });
        });
    };

    const endBargeIn = () => {
        bargeIn = undefined;
        segmenter = segmenterFor(stopSecs);
        vad.reset();
    };

    const verifyBargeIn = (candidate: BargeIn) => {
        candidate.verifying = true;
        const pcm = concatFrames(candidate.frames.slice(-BARGE_IN_WINDOW_FRAMES));
        const botText = state.entries
            .filter((e): e is BotEntry => e.role === 'bot')
            .slice(-2)
            .map((e) => e.generated)
            .join(' ');
        const started = Date.now();
        stt.transcribe(pcm, VAD_SAMPLE_RATE)
            .then(
                (text) => ({ text, verdict: classifyBargeIn(text, botText) }),
                (err: unknown) => ({ text: '', verdict: { kind: 'reject', reason: `STT 失败 ${String(err)}` } as BargeInVerdict }),
            )
            .then(({ text, verdict }) => {
                if (bargeIn !== candidate) {
                    return; // gated or ended meanwhile
                }
                candidate.verifying = false;
                const took = `${Date.now() - started}ms`;
                if (verdict.kind === 'user') {
                    log(`插嘴确认 ${took} 证据 ${Math.round(candidate.evidenceMs)}ms “${text}”`);
                    candidate.confirmed = true;
                    candidate.heardText = text;
                    dispatch({ type: 'userSpeechStart', at: Date.now() });
                    return;
                }
                log(`插嘴驳回 ${took}（${verdict.reason}）证据 ${Math.round(candidate.evidenceMs)}ms “${text}”`);
                candidate.checkAtMs = candidate.evidenceMs + BARGE_IN_RECHECK_MS;
            });
    };

    /** Barge-in bookkeeping for one frame; the candidate owns the audio while it exists. */
    const onBargeInFrame = (candidate: BargeIn, frame: Int16Array, confidence: number, loud: boolean) => {
        candidate.frames.push(frame);
        const speechLike = confidence >= Number(opt['vad-confidence']) || loud;
        candidate.quietMs = speechLike ? 0 : candidate.quietMs + FRAME_MS;
        if (confidence >= BARGE_IN_CONFIDENCE || loud) {
            candidate.evidenceMs += FRAME_MS;
        }
        if (candidate.confirmed) {
            if (candidate.quietMs >= stopSecs * 1000 || candidate.frames.length * FRAME_MS >= 28_000) {
                finishSegment(concatFrames(candidate.frames), candidate.heardText);
                endBargeIn();
            }
            return;
        }
        if (candidate.verifying) {
            return;
        }
        if (candidate.quietMs < BARGE_IN_GAP_MS) {
            if (candidate.evidenceMs >= candidate.checkAtMs) {
                verifyBargeIn(candidate);
            }
        } else if (!candidate.finalChecked && candidate.evidenceMs >= MIN_FINAL_CHECK_MS) {
            candidate.finalChecked = true;
            verifyBargeIn(candidate); // short "停" / "wait" ended before a periodic check
        } else {
            log(`插嘴未确认（证据 ${Math.round(candidate.evidenceMs)}ms），丢弃`);
            endBargeIn();
        }
    };

    const onFrame = async (frame: Int16Array) => {
        let sum = 0;
        for (const s of frame) {
            sum += s * s;
        }
        const db = 20 * Math.log10(Math.max(Math.sqrt(sum / frame.length) / 32768, 1e-6));
        micLevel = Math.max(micLevel * 0.8, Math.min(1, Math.max(0, (db + 50) / 25)));
        dbg.maxDb = Math.max(dbg.maxDb, db); // [DEBUG-mic]
        const loud = db >= BARGE_IN_DB;

        if (segmenter.inSpeech === false && pendingStopSecs !== undefined) {
            stopSecs = pendingStopSecs;
            pendingStopSecs = undefined;
            segmenter = segmenterFor(stopSecs);
        }
        const warmingUp = aec && speaker.playedMs < AEC_WARMUP_MS;
        const gated = state.muted || (state.audioActive && (state.halfDuplex || warmingUp));
        if (gated) {
            if (!wasGated) {
                const tail = segmenter.flush();
                if (tail && !bargeIn) {
                    finishSegment(tail);
                }
                if (bargeIn?.confirmed) {
                    finishSegment(concatFrames(bargeIn.frames), bargeIn.heardText);
                }
                endBargeIn();
            }
            wasGated = true;
            return;
        }
        wasGated = false;
        const confidence = await vad.confidence(frame);
        dbg.frames++; // [DEBUG-mic]
        dbg.maxConf = Math.max(dbg.maxConf, confidence); // [DEBUG-mic]
        dbg.speechFrames += confidence >= 0.5 ? 1 : 0; // [DEBUG-mic]
        dbg.loudFrames += loud ? 1 : 0; // [DEBUG-mic]
        recent.push(frame);
        if (recent.length > BARGE_IN_PREROLL_FRAMES) {
            recent.shift();
        }
        if (bargeIn) {
            onBargeInFrame(bargeIn, frame, confidence, loud);
            return;
        }
        // While the bot talks, Chrome's echo canceller chops the user's voice (double-talk), so VAD
        // alone rarely holds 0.2 s; loudness far above the residual echo also counts.
        if (state.audioActive && (confidence >= BARGE_IN_CONFIDENCE || loud)) {
            bargeIn = {
                evidenceMs: 0,
                checkAtMs: BARGE_IN_MS,
                quietMs: 0,
                verifying: false,
                finalChecked: false,
                confirmed: false,
                frames: recent.slice(0, -1),
            };
            segmenter = segmenterFor(stopSecs); // the candidate owns this audio now
            onBargeInFrame(bargeIn, frame, confidence, loud);
            return;
        }
        const wasSpeaking = segmenter.inSpeech;
        for (const ev of segmenter.push(frame, confidence)) {
            if (ev.type === 'speechStart') {
                dispatch({ type: 'userSpeechStart', at: Date.now() });
            } else {
                finishSegment(ev.pcm);
            }
        }
        if (wasSpeaking && !segmenter.inSpeech) {
            vad.reset();
        }
    };

    const frameBytes = VAD_FRAME_SAMPLES * 2;
    // [DEBUG-mic] heartbeat: where does the mic chain stop?
    const dbg = { bytes: 0, frames: 0, maxConf: 0, maxDb: -120, speechFrames: 0, loudFrames: 0 };
    setInterval(() => {
        log(
            `[DEBUG-mic] bytes=${dbg.bytes} vadFrames=${dbg.frames} speechFrames=${dbg.speechFrames} loudFrames=${dbg.loudFrames} inSpeech=${segmenter.inSpeech} bargeIn=${bargeIn ? `${Math.round(bargeIn.evidenceMs)}${bargeIn.confirmed ? '✓' : ''}` : '-'} gated=${wasGated} maxConf=${dbg.maxConf.toFixed(2)} maxDb=${dbg.maxDb.toFixed(0)} audioActive=${state.audioActive} phase=${state.phase}`,
        );
        dbg.bytes = 0;
        dbg.frames = 0;
        dbg.maxConf = 0;
        dbg.maxDb = -120;
        dbg.speechFrames = 0;
        dbg.loudFrames = 0;
    }, 2000);
    const drain = async () => {
        draining = true;
        while (buffered.length >= frameBytes) {
            const bytes = buffered.subarray(0, frameBytes);
            buffered = buffered.subarray(frameBytes);
            const frame = new Int16Array(VAD_FRAME_SAMPLES);
            for (let i = 0; i < VAD_FRAME_SAMPLES; i++) {
                frame[i] = bytes.readInt16LE(i * 2);
            }
            await onFrame(frame);
        }
        draining = false;
    };

    const onChunk = (chunk: Buffer) => {
        buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
        if (!draining) {
            void drain();
        }
    };

    if (browserAudio) {
        browserAudio.onMic = (chunk) => {
            dbg.bytes += chunk.length; // [DEBUG-mic]
            if (opt['dump-mic']) {
                fs.appendFileSync(opt['dump-mic'], chunk); // [DEBUG-dump]
            }
            onChunk(chunk);
        };
        log(`麦克风：浏览器 ${browserAudio.url}`);
        return;
    }
    if (opt['mic-file']) {
        // Replays raw 16 kHz s16le mono at real-time pace, then silence: a scripted "user".
        const script = fs.readFileSync(opt['mic-file']);
        let offset = 0;
        setInterval(() => {
            const chunk = Buffer.alloc(frameBytes);
            if (offset < script.length) {
                script.copy(chunk, 0, offset, Math.min(script.length, offset + frameBytes));
            }
            offset += frameBytes;
            onChunk(chunk);
        }, (VAD_FRAME_SAMPLES / VAD_SAMPLE_RATE) * 1000);
        log(`麦克风：回放 ${opt['mic-file']}`);
        return;
    }
    recorder = spawn(found!.path!, found!.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    recorder.stdout!.on('data', (chunk: Buffer) => {
        dbg.bytes += chunk.length; // [DEBUG-mic]
        onChunk(chunk);
    });
    recorder.stderr!.on('data', (chunk: Buffer) => log(`${found!.bin}: ${chunk.toString().trim()}`));
    recorder.on('exit', (code) => log(`${found!.bin} 退出 code=${code}`));
    log(`麦克风：${found!.bin}`);
}

// ── TUI ────────────────────────────────────────────────────────────────────
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const color = (code: number, s: string) => `\x1b[${code}m${s}\x1b[39m`;

const PHASE_LABEL: Record<ConvState['phase'], string> = {
    listening: color(32, '● 聆听中'),
    userSpeaking: color(33, '● 你在说话'),
    transcribing: color(36, '● 识别中'),
    thinking: color(35, '● 思考中'),
    speaking: color(34, '● 说话中'),
};

function secs(from?: number, to?: number): string {
    return from && to ? `${((to - from) / 1000).toFixed(2)}s` : '—';
}

function duplexLabel(s: ConvState): string {
    if (s.halfDuplex) {
        return color(33, '[半双工]');
    }
    if (audioMode === 'browser') {
        return browserAudio?.connected ? color(32, '[浏览器 AEC3·可插嘴]') : color(31, `[等待浏览器页 ${browserAudio?.url ?? ''}]`);
    }
    if (!aec) {
        return dim('[全双工·无回声消除·请戴耳机]');
    }
    return speaker.playedMs < AEC_WARMUP_MS
        ? color(33, `[回声消除学习中 ${(speaker.playedMs / 1000).toFixed(1)}/${AEC_WARMUP_MS / 1000}s·暂不能插嘴]`)
        : color(32, '[WebRTC 回声消除·可插嘴]');
}

function latencyLine(m: Metrics | undefined): string {
    if (!m) {
        return dim('（还没有完整的一轮）');
    }
    return [
        `说完判定 ${secs(m.silenceAt, m.endDetectedAt)}`,
        `STT ${secs(m.endDetectedAt, m.sttDoneAt)}`,
        `LLM首字 ${secs(m.promptAt, m.firstTextAt)}`,
        `首句TTS+播放 ${secs(m.firstTextAt, m.firstAudioAt)}`,
        bold(`停嘴→听到回答 ${secs(m.silenceAt, m.firstAudioAt)}`),
    ].join(dim(' · '));
}

/** Bot text as heard: spoken plain, playing highlighted, rest dim (struck through if cut off). */
function renderBot(b: BotEntry): string {
    const full = cleanForSpeech(b.generated);
    const heard = (b.spoken.join('') + (b.playing ?? '')).replace(/\s/g, '');
    let i = 0;
    for (let h = 0; i < full.length && h < heard.length; i++) {
        if (!/\s/.test(full[i])) {
            h++;
        }
    }
    const spokenLen = Math.max(0, i - (b.playing?.length ?? 0));
    const rest = full.slice(i);
    return (
        full.slice(0, spokenLen) +
        (b.playing ? bold(color(36, full.slice(spokenLen, i))) : '') +
        (rest ? (b.interrupted ? `\x1b[9m${dim(rest)}\x1b[29m` : dim(rest)) : '') +
        (b.interrupted ? color(31, ' ✂ 被打断') : '')
    );
}

function render(): void {
    const rows = process.stdout.rows || 30;
    const s = state;
    const meterCells = Math.round(micLevel * 20);
    const meter = color(32, '▮'.repeat(meterCells)) + dim('▯'.repeat(20 - meterCells));
    const llmState = s.llmBusy ? (s.botTurnId === undefined ? '中止中' : '生成中') : '空闲';
    const header = [
        `${bold('[PROTOTYPE] 语音环路')}  ${dim(`LLM omp ${llm.model} · STT ${opt['stt-url']} · TTS ${ttsBackend} ${voice}`)}`,
        `${PHASE_LABEL[s.phase]}   麦克风 ${meter}  ${s.muted ? color(31, '[已静音]') : ''} ${duplexLabel(s)}`,
        dim(`说完判定 ${stopSecs.toFixed(1)}s${pendingStopSecs !== undefined ? `→${pendingStopSecs.toFixed(1)}s` : ''} · STT 待处理 ${s.sttPending} · LLM ${llmState} · 音频 ${s.audioActive ? '播放队列中' : '—'}`),
        `上一轮  ${latencyLine(s.lastMetrics)}`,
        dim('──── 对话 ────'),
    ];
    const footer = [
        dim(`──── 日志 ${LOG_FILE} ────`),
        ...logs.slice(-3).map((l) => dim(l.slice(0, (process.stdout.columns || 100) - 1))),
        `${bold('[空格]')} 闭嘴  ${bold('[m]')} 静音  ${bold('[h]')} 半双工  ${bold('[+/-]')} 说完判定  ${bold('[q]')} 退出`,
    ];
    const budget = Math.max(3, rows - header.length - footer.length - 1);
    const lines = s.entries.map((e) =>
        e.role === 'user' ? `${color(33, '你')}  ${e.text}` : e.role === 'bot' ? `${color(36, '它')}  ${renderBot(e)}` : color(31, `!! ${e.text}`),
    );
    const body = lines.slice(-budget);
    const frame = [...header, ...body, ...Array(Math.max(0, budget - body.length)).fill(''), ...footer];
    process.stdout.write(`\x1b[H${frame.map((l) => `${l}\x1b[K`).join('\n')}\x1b[J`);
}

// ── main ───────────────────────────────────────────────────────────────────
const llm = new OmpLlm();
const speaker = new Speaker();

function shutdown(): void {
    recorder?.kill();
    currentTurn?.ctl.abort();
    browserAudio?.close();
    llm.close();
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    console.log(`语音环路原型已退出。日志：${LOG_FILE}`);
    setTimeout(() => process.exit(0), 200);
}

async function main(): Promise<void> {
    log(`启动：STT ${opt['stt-url']} TTS ${ttsBackend} ${opt['tts-url']} ${voice}`);
    const vad = await SileroVad.load(
        path.join(REPO_ROOT, 'media', 'vad', 'silero_vad.onnx'),
        path.join(REPO_ROOT, 'node_modules', 'onnxruntime-web', 'dist'),
    );
    const stt = new SttClient({ url: opt['stt-url']!, model: opt['stt-model']!, language: opt.language! });
    if (aec) {
        loadAec();
    }
    if (audioMode === 'browser') {
        browserAudio = startBrowserAudio(Number(opt.port), log);
        log(`浏览器音频页：${browserAudio.url}`);
        if (opt['dump-mic']) {
            fs.writeFileSync(opt['dump-mic'], ''); // [DEBUG-dump]
            log(`麦克风原始录音：${opt['dump-mic']}`);
        }
        const chrome = opt.audio === 'tab' ? undefined : findChrome();
        if (chrome && !opt['no-open']) {
            launchHiddenChrome(chrome, `${browserAudio.url}?${opt['mic-processing']}`, log);
        } else if (!opt['no-open']) {
            log(`${opt.audio === 'tab' ? '' : '没有找到 Chrome/Edge，'}在默认浏览器打开音频页（请保持标签页打开）`);
            spawn('xdg-open', [browserAudio.url], { stdio: 'ignore', detached: true }).unref();
        }
    }
    startMic(vad, stt);

    process.stdout.write('\x1b[?1049h\x1b[?25l');
    setInterval(render, 100);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', (buf: Buffer) => {
        const key = buf.toString();
        if (key === 'q' || key === '\u0003') {
            shutdown();
        } else if (key === ' ') {
            // Holding space auto-repeats; only act when there is something to cut off.
            if (state.llmBusy || state.audioActive) {
                dispatch({ type: 'shutUp', at: Date.now() });
            }
        } else if (key === 'm') {
            dispatch({ type: 'toggleMute' });
        } else if (key === 'h') {
            dispatch({ type: 'toggleHalfDuplex' });
        } else if (key === '+' || key === '=' || key === '-') {
            const base = pendingStopSecs ?? stopSecs;
            pendingStopSecs = Math.min(3, Math.max(0.3, base + (key === '-' ? -0.1 : 0.1)));
        }
    });
    process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    console.error(err);
    process.exit(1);
});
