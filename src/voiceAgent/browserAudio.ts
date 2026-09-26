/**
 * Microphone and speaker in a browser page (docs/voice-agent-design.md §5.1). Webviews cannot open
 * the microphone, and Chrome's echo canceller (AEC3) only removes audio the browser itself plays,
 * so capture and playback live in one page in a hidden Chrome; the extension exchanges raw PCM
 * with it over a local WebSocket. Protocol (voice-loop prototype doc §3.2):
 *
 * page → extension: binary, 16 kHz mono s16le, echo-cancelled, 512 samples per message
 * extension → page: binary, [u32 LE clip id][u32 LE sample rate][s16le mono PCM], one sentence
 *                   per message, played back to back;
 *                   text {"type":"flush"} drops everything queued (barge-in);
 *                   text {"type":"mic","on":false} turns the microphone track off while another
 *                   VS Code window has the voice, and on again when this one gets it back
 * page → extension: text {"type":"started","id":…,"at":…,"durationMs":…} as a clip's audio
 *                   actually starts (epoch ms, output latency included);
 *                   text {"type":"ended","id":…,"at":…} as it finishes, or at once if the page
 *                   cannot play it; flushed clips report nothing;
 *                   text {"type":"log","message":…} (the hidden page has no visible console)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

export interface BrowserAudio {
    /** The audio page; carries the token that admits it. */
    readonly url: string;
    readonly connected: boolean;
    /** Queues a clip after everything sent before; `clipId` names it in the page's playback reports. */
    play(clipId: number, pcm: Buffer, sampleRate: number): void;
    /** Drops every queued and playing sentence; none of them is reported any more. */
    flush(): void;
    /** Turns the page's microphone track on or off; kept across page reconnects. */
    setMic(on: boolean): void;
    close(): void;
}

/** What the page reports of a clip: real playback, not an estimate. Times are epoch ms. */
export type PlaybackReport =
    | { type: 'started'; clipId: number; at: number; durationMs: number }
    | { type: 'ended'; clipId: number; at: number };

export interface BrowserAudioEvents {
    mic(chunk: Buffer): void;
    playback(report: PlaybackReport): void;
    connected(connected: boolean): void;
    log(message: string): void;
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Oh My Pi Chater · voice audio</title>
<style>body { font: 14px system-ui, sans-serif; margin: 2em; background: #111; color: #ddd; }</style>
<p>Microphone and speaker of Oh My Pi Chater's voice mode (Chrome echo cancellation). Keep this tab open while voice mode is on.</p>
<button id="start" hidden>Start</button>
<div id="status">Connecting…</div>
<script>
const status = (m) => { document.getElementById('status').textContent = m; };
const send = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const log = (m) => send({ type: 'log', message: m });
const WORKLET = \`
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('capture', Capture);\`;

let ws, playCtx, capCtx, micTrack, micOn = true, nextTime = 0;
/** Clips scheduled and not yet ended, by id: their source and the marker that reports their start. */
const clips = new Map();

function connect() {
  ws = new WebSocket('ws://' + location.host + '/ws' + location.search);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => status('Connected');
  ws.onclose = () => { status('Disconnected, reconnecting…'); setTimeout(connect, 1000); };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'flush') flush();
      if (msg.type === 'mic') { micOn = msg.on; if (micTrack) { micTrack.enabled = micOn; log('mic ' + (micOn ? 'on' : 'off')); } }
      return;
    }
    play(ev.data);
  };
}

/** Epoch ms at which what the audio clock renders now reaches the speakers. */
const heardAt = () => Date.now() + (playCtx.outputLatency || 0) * 1000;

function play(buf) {
  const view = new DataView(buf);
  const id = view.getUint32(0, true);
  if (!playCtx) { send({ type: 'ended', id, at: Date.now() }); return; }
  try {
    const pcm = new Int16Array(buf, 8);
    const audio = playCtx.createBuffer(1, pcm.length, view.getUint32(4, true));
    const ch = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = playCtx.createBufferSource();
    src.buffer = audio;
    src.connect(playCtx.destination);
    const at = Math.max(playCtx.currentTime + 0.02, nextTime);
    src.start(at);
    nextTime = at + audio.duration;
    // A silent source that ends as the clip starts: its onended runs on the audio clock, where a
    // timer would drift, and would fire up to a second late in a background tab.
    const mark = playCtx.createConstantSource();
    mark.offset.value = 0;
    mark.connect(playCtx.destination);
    mark.start();
    mark.stop(at);
    mark.onended = () => send({ type: 'started', id, at: heardAt(), durationMs: audio.duration * 1000 });
    src.onended = () => {
      clips.delete(id);
      send({ type: 'ended', id, at: heardAt() });
    };
    clips.set(id, { src, mark });
  } catch (e) {
    log('clip ' + id + ' not played: ' + e.message);
    send({ type: 'ended', id, at: Date.now() });
  }
}

/** Stops every clip without reporting it: the extension already dropped the turn they belong to. */
function flush() {
  for (const { src, mark } of clips.values()) {
    src.onended = null;
    mark.onended = null;
    try { src.stop(); } catch {}
    try { mark.stop(); } catch {}
  }
  clips.clear();
  nextTime = 0;
}

async function start() {
  document.getElementById('start').hidden = true;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const track = stream.getAudioTracks()[0];
  micTrack = track;
  track.enabled = micOn;
  const settings = track.getSettings();
  log('mic ' + track.label + ' ec=' + settings.echoCancellation + ' ns=' + settings.noiseSuppression + ' agc=' + settings.autoGainControl);
  playCtx = new AudioContext();
  capCtx = new AudioContext({ sampleRate: 16000 });
  await capCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
  const node = new AudioWorkletNode(capCtx, 'capture');
  capCtx.createMediaStreamSource(stream).connect(node);
  let pending = new Int16Array(512), filled = 0;
  node.port.onmessage = (ev) => {
    for (const x of ev.data) {
      pending[filled++] = Math.max(-1, Math.min(1, x)) * 32767;
      if (filled === pending.length) {
        if (ws.readyState === 1) ws.send(pending.buffer);
        pending = new Int16Array(512);
        filled = 0;
      }
    }
  };
  if (playCtx.state === 'suspended' || capCtx.state === 'suspended') throw new Error('audio needs a click to start');
  status('Running: voice mode is listening');
}

connect();
start().catch((e) => {
  log('automatic start failed: ' + e.message);
  const b = document.getElementById('start');
  b.hidden = false;
  b.onclick = () => start().catch((e2) => log('start failed: ' + e2.message));
});
</script>`;

/** Serves the audio page on 127.0.0.1; only a page opened with this session's token may connect. */
export async function startBrowserAudio(events: BrowserAudioEvents): Promise<BrowserAudio> {
    const token = randomBytes(16).toString('hex');
    const admitted = (url: string | undefined) => new URL(url ?? '/', 'http://127.0.0.1').searchParams.get('token') === token;
    const server = http.createServer((req, res) => {
        if (!admitted(req.url)) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    });
    const wss = new WebSocketServer({
        server,
        path: '/ws',
        verifyClient: (info: { req: http.IncomingMessage }) => admitted(info.req.url),
    });
    let socket: WebSocket | undefined;
    let micOn = true;
    /** Clips sent to the page that have neither ended nor been flushed. */
    const playing = new Set<number>();
    /** The page that had them is gone: they will never be reported, so they count as ended now. */
    const dropPlaying = () => {
        const at = Date.now();
        for (const clipId of playing) {
            events.playback({ type: 'ended', clipId, at });
        }
        playing.clear();
    };
    wss.on('connection', (ws) => {
        // One page at a time: a reloaded or reopened page replaces the old one.
        socket?.close(1000, 'replaced by a newer page');
        socket = ws;
        dropPlaying();
        events.connected(true);
        ws.send(JSON.stringify({ type: 'mic', on: micOn }));
        ws.on('message', (data, isBinary) => {
            if (ws !== socket) {
                return;
            }
            if (isBinary) {
                // The default binaryType ('nodebuffer') delivers one Buffer per message.
                events.mic(data as Buffer);
                return;
            }
            const msg = JSON.parse(data.toString()) as { type?: string; message?: string; id?: number; at?: number; durationMs?: number };
            if (msg.type === 'log') {
                events.log(`audio page: ${msg.message}`);
                return;
            }
            // Reports of flushed clips still in flight are dropped here.
            const clipId = msg.id ?? -1;
            if (!playing.has(clipId)) {
                return;
            }
            if (msg.type === 'started') {
                events.playback({ type: 'started', clipId, at: msg.at ?? Date.now(), durationMs: msg.durationMs ?? 0 });
            } else if (msg.type === 'ended') {
                playing.delete(clipId);
                events.playback({ type: 'ended', clipId, at: msg.at ?? Date.now() });
            }
        });
        ws.on('close', () => {
            if (ws === socket) {
                socket = undefined;
                dropPlaying();
                events.connected(false);
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/?token=${token}`,
        get connected() {
            return socket !== undefined;
        },
        play(clipId, pcm, sampleRate) {
            playing.add(clipId);
            if (!socket) {
                // Reported like any clip the page cannot play, after the caller has recorded it.
                queueMicrotask(dropPlaying);
                return;
            }
            const out = Buffer.allocUnsafe(8 + pcm.length);
            out.writeUInt32LE(clipId, 0);
            out.writeUInt32LE(sampleRate, 4);
            pcm.copy(out, 8);
            socket.send(out);
        },
        flush() {
            playing.clear();
            socket?.send(JSON.stringify({ type: 'flush' }));
        },
        setMic(on) {
            micOn = on;
            socket?.send(JSON.stringify({ type: 'mic', on }));
        },
        close() {
            for (const client of wss.clients) {
                client.terminate();
            }
            wss.close();
            server.close();
        },
    };
}

/** Chromium-family browsers with WebRTC echo cancellation, most common first. */
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
 * Opens `url` in a windowless Chrome with a throwaway profile, the microphone permission
 * pre-granted and autoplay allowed (headless has no user gesture). The profile is deleted once it exits.
 */
export function launchHiddenChrome(
    chrome: string,
    url: string,
    extraArgs: string[],
    log: (message: string) => void,
): { kill(): void } {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-chater-voice-chrome-'));
    const proc: ChildProcess = spawn(
        chrome,
        [
            '--headless=new',
            `--user-data-dir=${profile}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            ...extraArgs,
            url,
        ],
        { stdio: 'ignore' },
    );
    proc.on('error', (err) => log(`hidden Chrome failed to start: ${err.message}`));
    proc.on('exit', (code, signal) => {
        log(`hidden Chrome exited (code ${code}, signal ${signal})`);
        // Only once it is gone: Chrome writes to the profile until it exits (ENOTEMPTY otherwise).
        fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }, () => undefined);
    });
    return {
        kill() {
            proc.kill();
        },
    };
}
