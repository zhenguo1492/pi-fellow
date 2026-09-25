/**
 * PROTOTYPE (voice loop) — microphone and speaker in a browser tab, the way
 * pipecat's web client does it. Chrome's WebRTC echo canceller (AEC3) only
 * removes audio the browser itself plays, so capture and playback live in the
 * same page; the prototype process exchanges raw PCM with it over a WebSocket.
 *
 * page → process: binary, 16 kHz mono s16le mic audio (echo-cancelled)
 * process → page: binary, [u32 LE sample rate][s16le mono PCM] to play;
 *                 text {"type":"flush"} to drop everything queued (barge-in)
 * page → process: text {"type":"log","message":…} (the hidden tab has no visible console)
 *
 * The page runs in a hidden (headless) Chrome the prototype starts itself, so
 * the user sees no window; without Chrome it falls back to a normal browser tab.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The slice of Bun's server API used here (the repo has no Bun type package; the prototype runs under Bun). */
interface BunSocket {
    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
}
declare const Bun: {
    serve(options: {
        port: number;
        hostname: string;
        fetch(req: Request, server: { upgrade(req: Request): boolean }): Response | undefined;
        websocket: {
            open(ws: BunSocket): void;
            message(ws: BunSocket, data: string | Uint8Array): void;
            close(ws: BunSocket): void;
        };
    }): { port: number; stop(force: boolean): void };
};

export interface BrowserAudio {
    readonly url: string;
    readonly connected: boolean;
    /** Mic audio from the page. */
    onMic: (chunk: Buffer) => void;
    play(pcm: Buffer, sampleRate: number): void;
    flush(): void;
    close(): void;
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>PROTOTYPE 语音环路</title>
<style>
  body { font: 15px system-ui, sans-serif; margin: 2em; background: #111; color: #ddd; }
  button { font-size: 1.2em; padding: .5em 1.5em; }
  #meter { height: 10px; background: #2a2; width: 0; transition: width 80ms; margin: 1em 0; }
  #log { white-space: pre-wrap; font: 12px monospace; color: #999; }
</style>
<h2>[PROTOTYPE] 语音环路 · 浏览器音频</h2>
<p>麦克风和扬声器都在这个页面里，Chrome 内置回声消除（AEC3）。对话显示在终端里。保持此标签页打开。</p>
<button id="start" hidden>开始</button>
<div id="status">连接中…</div>
<div id="meter"></div>
<div id="log"></div>
<script>
const logEl = document.getElementById('log');
const log = (m) => {
  logEl.textContent = new Date().toLocaleTimeString() + ' ' + m + '\\n' + logEl.textContent.slice(0, 3000);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'log', message: m }));
};
const status = (m) => { document.getElementById('status').textContent = m; };

const WORKLET = \`
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('capture', Capture);\`;

let ws, playCtx, capCtx, nextTime = 0;
const sources = new Set();

function connect() {
  ws = new WebSocket('ws://' + location.host + '/ws');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { status('已连接'); log('websocket open'); };
  ws.onclose = () => { status('已断开，重连中…'); setTimeout(connect, 1000); };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      if (JSON.parse(ev.data).type === 'flush') flush();
      return;
    }
    play(ev.data);
  };
}

function play(buf) {
  if (!playCtx) return;
  const rate = new DataView(buf).getUint32(0, true);
  const pcm = new Int16Array(buf, 4);
  const audio = playCtx.createBuffer(1, pcm.length, rate);
  const ch = audio.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = playCtx.createBufferSource();
  src.buffer = audio;
  src.connect(playCtx.destination);
  const at = Math.max(playCtx.currentTime + 0.02, nextTime);
  src.start(at);
  nextTime = at + audio.duration;
  sources.add(src);
  src.onended = () => sources.delete(src);
}

function flush() {
  for (const s of sources) { try { s.stop(); } catch {} }
  sources.clear();
  nextTime = 0;
}

async function start() {
  document.getElementById('start').hidden = true;
  // ?ec=0 / ?ns=0 / ?agc=0 switch off one stage of Chrome's processing (diagnostics).
  const on = (k) => new URLSearchParams(location.search).get(k) !== '0';
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: on('ec'), noiseSuppression: on('ns'), autoGainControl: on('agc'), channelCount: 1 },
  });
  const settings = stream.getAudioTracks()[0].getSettings();
  log('mic ' + stream.getAudioTracks()[0].label + ' ec=' + settings.echoCancellation + ' ns=' + settings.noiseSuppression + ' agc=' + settings.autoGainControl);
  playCtx = new AudioContext();
  capCtx = new AudioContext({ sampleRate: 16000 });
  await capCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
  const node = new AudioWorkletNode(capCtx, 'capture');
  capCtx.createMediaStreamSource(stream).connect(node);
  let pending = new Int16Array(512), filled = 0, peak = 0;
  node.port.onmessage = (ev) => {
    for (const x of ev.data) {
      const s = Math.max(-1, Math.min(1, x));
      peak = Math.max(peak, Math.abs(s));
      pending[filled++] = s * 32767;
      if (filled === pending.length) {
        if (ws.readyState === 1) ws.send(pending.buffer);
        pending = new Int16Array(512);
        filled = 0;
        document.getElementById('meter').style.width = Math.min(100, peak * 300) + '%';
        peak = 0;
      }
    }
  };
  if (playCtx.state === 'suspended' || capCtx.state === 'suspended') throw new Error('需要点击开始');
  status('运行中：请对着麦克风说话');
}

connect();
start().catch((e) => {
  log('自动开始失败：' + e.message);
  const b = document.getElementById('start');
  b.hidden = false;
  b.onclick = () => start().catch((e2) => log('失败：' + e2.message));
});
</script>`;

export function startBrowserAudio(port: number, log: (m: string) => void): BrowserAudio {
    let socket: BunSocket | undefined;
    const server = Bun.serve({
        port,
        hostname: '127.0.0.1',
        fetch(req, srv) {
            if (new URL(req.url).pathname === '/ws') {
                return srv.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 });
            }
            return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        },
        websocket: {
            open(ws) {
                if (socket) {
                    socket.close(1000, 'replaced by a newer tab');
                }
                socket = ws;
                log('浏览器音频页已连接');
            },
            message(ws, data) {
                if (ws !== socket) {
                    return;
                }
                if (typeof data === 'string') {
                    const msg = JSON.parse(data) as { type?: string; message?: string };
                    if (msg.type === 'log') {
                        log(`浏览器：${msg.message}`);
                    }
                    return;
                }
                audio.onMic(Buffer.from(data));
            },
            close(ws) {
                if (ws === socket) {
                    socket = undefined;
                    log('浏览器音频页已断开');
                }
            },
        },
    });
    const audio: BrowserAudio = {
        url: `http://127.0.0.1:${server.port}/`,
        get connected() {
            return socket !== undefined;
        },
        onMic: () => {},
        play(pcm, sampleRate) {
            const out = Buffer.allocUnsafe(4 + pcm.length);
            out.writeUInt32LE(sampleRate, 0);
            pcm.copy(out, 4);
            socket?.send(out);
        },
        flush() {
            socket?.send(JSON.stringify({ type: 'flush' }));
        },
        close() {
            server.stop(true);
        },
    };
    return audio;
}

/** Chromium-family browsers that do WebRTC echo cancellation, most common first. */
function chromeCandidates(): string[] {
    if (process.platform === 'darwin') {
        const apps = ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser'];
        return [
            ...apps.map((a) => `/Applications/${a}.app/Contents/MacOS/${a}`),
            ...apps.map((a) => path.join(os.homedir(), `Applications/${a}.app/Contents/MacOS/${a}`)),
        ];
    }
    if (process.platform === 'win32') {
        const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(
            (r): r is string => !!r,
        );
        return roots.flatMap((r) => [
            path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ]);
    }
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    return names.flatMap((n) => dirs.map((d) => path.join(d, n)));
}

export function findChrome(): string | undefined {
    return chromeCandidates().find((p) => {
        try {
            fs.accessSync(p, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
}

/**
 * Opens `url` in a windowless Chrome with its own throwaway profile, the mic
 * permission pre-granted and autoplay allowed (no user gesture exists headless).
 * The profile is deleted when the process exits.
 */
export function launchHiddenChrome(chrome: string, url: string, log: (m: string) => void): ChildProcess {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-proto-chrome-'));
    const proc = spawn(
        chrome,
        [
            '--headless=new',
            `--user-data-dir=${profile}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            url,
        ],
        { stdio: 'ignore' },
    );
    proc.on('error', (err) => log(`隐藏 Chrome 启动失败：${err.message}`));
    proc.on('exit', (code, signal) => {
        log(`隐藏 Chrome 退出 code=${code} signal=${signal}`);
        fs.rmSync(profile, { recursive: true, force: true });
    });
    process.on('exit', () => {
        proc.kill();
        fs.rmSync(profile, { recursive: true, force: true });
    });
    log(`隐藏 Chrome：${chrome}`);
    return proc;
}
