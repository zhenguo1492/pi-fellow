/**
 * Runs the built-in voice engine (./server.ts) for the extension host: downloads its models on first
 * use, starts it as a child process (VS Code's Electron as Node) and starts it again when it crashes.
 * No `vscode` import: the host passes in what it needs, so scripts can drive it too.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as readline from 'node:readline';
import { STT_MODEL, TTS_VOICE, downloadModels, installedBytes, isInstalled, modelDir, planModelDownload } from './models';
import type { BuiltinVoiceStatus } from '../../shared/protocol';
import type { EngineConfig } from './server';

export interface EngineHost {
    /** out/voice-engine/server.js */
    serverPath: string;
    modelRoot: string;
    log(line: string): void;
    /**
     * Runs the model download of `totalBytes`, showing its progress (bytes done of total) and letting
     * the user cancel it.
     */
    withDownloadProgress(totalBytes: number, download: (report: (done: number, total: number) => void, signal: AbortSignal) => Promise<void>): PromiseLike<void>;
}

const READY_TIMEOUT_MS = 60_000;
/** Crashes within this window beyond MAX_RESTARTS leave it down until the next use. */
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 3;

export class BuiltinVoiceEngine {
    /** Kept across restarts, as is the port, so clients made with the old URL keep working. */
    private readonly _token = randomBytes(16).toString('hex');
    private _port = 0;
    private _url: Promise<string> | undefined;
    private _kill: (() => void) | undefined;
    private _crashes: number[] = [];
    private _disposed = false;
    /** Size of the pending download, listed once for the settings page. */
    private _downloadBytes: Promise<number> | undefined;

    constructor(private readonly _host: EngineHost) {}

    /** `http://127.0.0.1:<port>/<token>/v1` of the running server; the first call downloads the models and starts it. */
    url(): Promise<string> {
        if (this._disposed) {
            return Promise.reject(new Error('The built-in voice engine is shut down'));
        }
        if (!this._url) {
            const url = this._start();
            this._url = url;
            url.catch(() => {
                if (this._url === url) {
                    this._url = undefined;
                }
            });
        }
        return this._url;
    }

    dispose(): void {
        this._disposed = true;
        this._kill?.();
    }

    /** Whether the models are downloaded, and their size (on disk, or to download). */
    async status(): Promise<BuiltinVoiceStatus> {
        const { modelRoot } = this._host;
        const specs = [STT_MODEL, TTS_VOICE];
        // Up, or starting (downloading its models first).
        const running = this._url !== undefined;
        const downloaded = (await Promise.all(specs.map((spec) => isInstalled(modelRoot, spec)))).every(Boolean);
        if (downloaded) {
            return { downloaded, bytes: await installedBytes(modelRoot, specs), running };
        }
        this._downloadBytes ??= planModelDownload(modelRoot, specs, AbortSignal.timeout(10_000)).then((plan) => plan.total);
        const bytes = await this._downloadBytes.catch(() => {
            this._downloadBytes = undefined;
            return undefined;
        });
        return { downloaded, bytes, running };
    }

    private async _start(): Promise<string> {
        const { modelRoot } = this._host;
        const plan = await planModelDownload(modelRoot, [STT_MODEL, TTS_VOICE], AbortSignal.timeout(30_000));
        if (plan.items.length > 0) {
            await this._host.withDownloadProgress(plan.total, (report, signal) => downloadModels(modelRoot, plan, report, signal));
            this._downloadBytes = undefined;
        }
        if (this._disposed) {
            throw new Error('The built-in voice engine is shut down');
        }
        return this._spawn();
    }

    private _spawn(): Promise<string> {
        const config: EngineConfig = {
            token: this._token,
            port: this._port,
            sttDir: modelDir(this._host.modelRoot, STT_MODEL),
            ttsDir: modelDir(this._host.modelRoot, TTS_VOICE),
        };
        const child = spawn(process.execPath, [this._host.serverPath], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OMP_VOICE_ENGINE: JSON.stringify(config) },
            // stdin stays open: the server exits when it closes, i.e. when this process is gone.
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this._kill = () => child.kill();
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        let ready = false;
        let lastLine = '';
        const timer = setTimeout(() => {
            reject(new Error(`The built-in voice engine did not start within ${READY_TIMEOUT_MS / 1000} s`));
            child.kill();
        }, READY_TIMEOUT_MS);
        readline.createInterface({ input: child.stderr }).on('line', (line) => {
            lastLine = line.trim() || lastLine;
            this._host.log(line);
        });
        readline.createInterface({ input: child.stdout }).once('line', (line) => {
            clearTimeout(timer);
            let message: unknown;
            try {
                message = JSON.parse(line);
            } catch {
                // Not the ready line: rejected below.
            }
            if (!message || typeof message !== 'object' || !('port' in message) || typeof message.port !== 'number') {
                reject(new Error(`The built-in voice engine printed an unexpected line: ${line.slice(0, 200)}`));
                child.kill();
                return;
            }
            this._port = message.port;
            ready = true;
            this._host.log(`listening on 127.0.0.1:${this._port} (pid ${child.pid})`);
            resolve(`http://127.0.0.1:${this._port}/${this._token}/v1`);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            const how = signal ?? `code ${code}`;
            if (!ready) {
                reject(new Error(`The built-in voice engine exited (${how}) while starting: ${lastLine}`));
                return;
            }
            this._url = undefined;
            if (this._disposed) {
                return;
            }
            const now = Date.now();
            this._crashes = [...this._crashes.filter((t) => now - t < RESTART_WINDOW_MS), now];
            if (this._crashes.length > MAX_RESTARTS) {
                this._host.log(`exited (${how}), ${this._crashes.length} times within a minute; it starts again on next use`);
                return;
            }
            this._host.log(`exited (${how}); restarting`);
            this.url().catch((err: unknown) => this._host.log(`restart failed: ${err instanceof Error ? err.message : String(err)}`));
        });
        return promise;
    }
}

let _active: BuiltinVoiceEngine | undefined;

/** Creates the extension's engine (it starts on first use); dispose stops it. */
export function activateBuiltinVoiceEngine(host: EngineHost): { dispose(): void } {
    const engine = new BuiltinVoiceEngine(host);
    _active = engine;
    return {
        dispose: () => {
            engine.dispose();
            if (_active === engine) {
                _active = undefined;
            }
        },
    };
}

/** The URL of the extension's engine, started (and its models downloaded) if it is not running yet. */
export function builtinVoiceEngineUrl(): Promise<string> {
    return _active ? _active.url() : Promise.reject(new Error('The built-in voice engine is not available'));
}

/** The extension's engine's models and process, for the settings page. */
export function builtinVoiceStatus(): Promise<BuiltinVoiceStatus> {
    return _active ? _active.status() : Promise.reject(new Error('The built-in voice engine is not available'));
}
