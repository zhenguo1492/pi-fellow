/**
 * Runs the built-in voice engine (./server.ts) for the extension host: downloads its models on first
 * use, starts it as a child process (VS Code's Electron as Node) and starts it again when it crashes.
 * A server loads only the models of the features it is started with (speech-to-text, the voice, the
 * voiceprint, noise reduction); asked for one it lacks, it is started again with it added.
 * No `vscode` import: the host passes in what it needs, so scripts can drive it too.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as readline from 'node:readline';
import { FEATURE_MODELS, downloadModels, installedBytes, isInstalled, modelDir, planModelDownload, type EngineFeature } from './models';
import type { BuiltinVoiceStatus } from '../../shared/protocol';
import type { EngineConfig } from './server';

export interface EngineHost {
    /** out/voice-engine/server.js */
    serverPath: string;
    modelRoot: string;
    /** The features the voice settings use now: a (re)start loads these too, so one server serves them all. */
    features(): readonly EngineFeature[];
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

const specsOf = (features: Iterable<EngineFeature>) => [...new Set(features)].map((f) => FEATURE_MODELS[f]);

export class BuiltinVoiceEngine {
    /** Kept across restarts, as is the port, so clients made with the old URL keep working. */
    private readonly _token = randomBytes(16).toString('hex');
    private _port = 0;
    private _url: Promise<string> | undefined;
    /** What the server of `_url` loads (or will, once started). */
    private _features = new Set<EngineFeature>();
    /** The running server; a stopped or replaced one's exit is not a crash. */
    private _child: ChildProcess | undefined;
    private _crashes: number[] = [];
    private _disposed = false;
    /** Size of the pending download of each feature set, listed once for the settings page. */
    private readonly _downloadBytes = new Map<string, Promise<number>>();

    constructor(private readonly _host: EngineHost) {}

    /**
     * `http://127.0.0.1:<port>/<token>/v1` of a server running `needs`: the first call downloads the
     * models and starts it; a server lacking one of them is started again with it added (after the
     * current start, if one is under way). Its port is kept, so earlier URLs stay valid.
     */
    url(needs: readonly EngineFeature[]): Promise<string> {
        if (this._disposed) {
            return Promise.reject(new Error('The built-in voice engine is shut down'));
        }
        if (this._url && needs.every((f) => this._features.has(f))) {
            return this._url;
        }
        const previous = this._url;
        const features = new Set([...(previous ? this._features : []), ...this._host.features(), ...needs]);
        this._features = features;
        const url = (previous ?? Promise.resolve('')).catch(() => '').then(() => this._start(features));
        this._url = url;
        url.catch(() => {
            if (this._url === url) {
                this._url = undefined;
                this._features = new Set();
                this._stopChild();
            }
        });
        return url;
    }

    dispose(): void {
        this._disposed = true;
        this._stopChild();
    }

    /** Whether the models of `features` are downloaded, and their size (on disk, or to download). */
    async status(features: readonly EngineFeature[]): Promise<BuiltinVoiceStatus> {
        const { modelRoot } = this._host;
        const specs = specsOf(features);
        // Up, or starting (downloading its models first), with these features.
        const running = this._url !== undefined && features.every((f) => this._features.has(f));
        const downloaded = (await Promise.all(specs.map((spec) => isInstalled(modelRoot, spec)))).every(Boolean);
        if (downloaded) {
            return { downloaded, bytes: await installedBytes(modelRoot, specs), running };
        }
        const key = [...new Set(features)].sort().join();
        let pending = this._downloadBytes.get(key);
        if (!pending) {
            pending = planModelDownload(modelRoot, specs, AbortSignal.timeout(10_000)).then((plan) => plan.total);
            this._downloadBytes.set(key, pending);
        }
        const bytes = await pending.catch(() => {
            this._downloadBytes.delete(key);
            return undefined;
        });
        return { downloaded, bytes, running };
    }

    /** Downloads what `features` lack, then replaces the running server (if any) with one loading them all. */
    private async _start(features: ReadonlySet<EngineFeature>): Promise<string> {
        const { modelRoot } = this._host;
        const plan = await planModelDownload(modelRoot, specsOf(features), AbortSignal.timeout(30_000));
        if (plan.items.length > 0) {
            await this._host.withDownloadProgress(plan.total, (report, signal) => downloadModels(modelRoot, plan, report, signal));
            this._downloadBytes.clear();
        }
        if (this._disposed) {
            throw new Error('The built-in voice engine is shut down');
        }
        this._stopChild();
        return this._spawn(features);
    }

    private _stopChild(): void {
        const child = this._child;
        this._child = undefined;
        child?.kill();
    }

    private _spawn(features: ReadonlySet<EngineFeature>): Promise<string> {
        const dir = (feature: EngineFeature) => (features.has(feature) ? modelDir(this._host.modelRoot, FEATURE_MODELS[feature]) : undefined);
        const config: EngineConfig = {
            token: this._token,
            port: this._port,
            sttDir: dir('stt'),
            ttsDir: dir('tts'),
            speakerDir: dir('speaker'),
            denoiseDir: dir('denoise'),
        };
        const child = spawn(process.execPath, [this._host.serverPath], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OMP_VOICE_ENGINE: JSON.stringify(config) },
            // stdin stays open: the server exits when it closes, i.e. when this process is gone.
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this._child = child;
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
            this._host.log(`listening on 127.0.0.1:${this._port} (pid ${child.pid}; ${[...features].join(', ')})`);
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
            if (this._child !== child) {
                return; // stopped: replaced by a server with more features, or shut down
            }
            this._child = undefined;
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
            this.url([...features]).catch((err: unknown) => this._host.log(`restart failed: ${err instanceof Error ? err.message : String(err)}`));
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

/** The URL of the extension's engine running `features`, started (and its models downloaded) if needed. */
export function builtinVoiceEngineUrl(features: readonly EngineFeature[]): Promise<string> {
    return _active ? _active.url(features) : Promise.reject(new Error('The built-in voice engine is not available'));
}

/** The models of `features` and whether the engine runs them, for the settings page. */
export function builtinVoiceStatus(features: readonly EngineFeature[]): Promise<BuiltinVoiceStatus> {
    return _active ? _active.status(features) : Promise.reject(new Error('The built-in voice engine is not available'));
}
