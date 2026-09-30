/**
 * Models of the built-in voice engine (./server.ts). Not bundled: downloaded on first use from
 * Hugging Face at a pinned commit, each file checked against that commit's hash (sha256 for LFS
 * files, the git blob sha1 for the rest) before its model directory is published.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ModelSpec {
    /** Directory name, and the id the server answers to. */
    id: string;
    repo: string;
    /** The commit files and hashes come from. */
    revision: string;
    /** Files the server opens; the download fails when the commit lacks one. */
    required: readonly string[];
    /** Further files to fetch. */
    extra?: (file: string) => boolean;
}

/** Moonshine base (English), int8, as sherpa-onnx exports it. */
export const STT_MODEL = {
    id: 'moonshine-base-en',
    repo: 'csukuangfj/sherpa-onnx-moonshine-base-en-int8',
    revision: '052b0798ad1bf046a140fdd4efcd9426530fa3f5',
    required: ['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx', 'tokens.txt'],
} as const satisfies ModelSpec;

/** Piper en_US lessac (medium), with the espeak-ng data it phonemizes with (only the English dictionary). */
export const TTS_VOICE = {
    id: 'en_US-lessac-medium',
    repo: 'csukuangfj/vits-piper-en_US-lessac-medium',
    revision: '83f7470750b36549037551ef7007fa3b4b8697e0',
    required: ['en_US-lessac-medium.onnx', 'tokens.txt', 'espeak-ng-data/phontab', 'espeak-ng-data/en_dict'],
    extra: (file: string) => file.startsWith('espeak-ng-data/') && (!file.endsWith('_dict') || file === 'espeak-ng-data/en_dict'),
} as const satisfies ModelSpec;

/**
 * 3D-Speaker CAM++ speaker embeddings (192 values), trained on Chinese and English speech: the
 * voiceprint. Measured on sherpa-onnx's test recordings it separates speakers far better than the
 * English-only CAM++ and ResNet34 exports of the same repo.
 */
export const SPEAKER_MODEL = {
    id: 'campplus-zh-en-advanced',
    repo: 'csukuangfj/speaker-embedding-models',
    revision: '0743f301363dec56491a490f6d6cbc9d67f9a3bf',
    required: ['3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'],
} as const satisfies ModelSpec;

/** GTCRN speech enhancement (16 kHz), for noise reduction before speech-to-text and the voiceprint check. */
export const DENOISE_MODEL = {
    id: 'gtcrn-simple',
    repo: 'csukuangfj/speech-enhancement-models',
    revision: 'ccf4b25730940483dbb210d7d251d56e1531d0b4',
    required: ['gtcrn_simple.onnx'],
} as const satisfies ModelSpec;

/** The model id the server lists and `/audio/speech` requests name (see resolveTtsConfig). */
export const TTS_MODEL_ID = 'piper';

/** What the engine can run; each needs its models loaded (a server loads only those it is started with). */
export type EngineFeature = 'stt' | 'tts' | 'speaker' | 'denoise';

export const FEATURE_MODELS: Record<EngineFeature, ModelSpec> = {
    stt: STT_MODEL,
    tts: TTS_VOICE,
    speaker: SPEAKER_MODEL,
    denoise: DENOISE_MODEL,
};

const DOWNLOAD_CONCURRENCY = 6;

export interface RemoteFile {
    type: 'file' | 'directory';
    path: string;
    size: number;
    /** Git blob sha1. */
    oid: string;
    lfs?: { oid: string };
}

export function modelDir(root: string, spec: ModelSpec): string {
    return path.join(root, `${spec.id}-${spec.revision.slice(0, 12)}`);
}

/** Published directories are complete: a download only renames its directory into place at the end. */
export async function isInstalled(root: string, spec: ModelSpec): Promise<boolean> {
    return fs.stat(modelDir(root, spec)).then(
        (s) => s.isDirectory(),
        () => false,
    );
}

/** What a download of the specs not installed yet fetches: their files, and the bytes over all of them. */
export interface ModelDownloadPlan {
    total: number;
    items: Array<{ spec: ModelSpec; files: RemoteFile[] }>;
}

/** Lists the files of every spec not installed yet (one request per spec); nothing to fetch when all are installed. */
export async function planModelDownload(root: string, specs: readonly ModelSpec[], signal: AbortSignal): Promise<ModelDownloadPlan> {
    const missing: ModelSpec[] = [];
    for (const spec of specs) {
        if (!(await isInstalled(root, spec))) {
            missing.push(spec);
        }
    }
    const items = await Promise.all(missing.map(async (spec) => ({ spec, files: await listFiles(spec, signal) })));
    return { total: items.reduce((sum, item) => sum + item.files.reduce((s, f) => s + f.size, 0), 0), items };
}

/** The bytes the files under `dir` take on disk. */
export async function directoryBytes(dir: string): Promise<number> {
    let bytes = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        bytes += entry.isDirectory() ? await directoryBytes(full) : (await fs.stat(full)).size;
    }
    return bytes;
}

/** The bytes the installed specs take on disk. */
export async function installedBytes(root: string, specs: readonly ModelSpec[]): Promise<number> {
    let total = 0;
    for (const spec of specs) {
        if (await isInstalled(root, spec)) {
            total += await directoryBytes(modelDir(root, spec));
        }
    }
    return total;
}

/** Downloads what `plan` lists; `onProgress` gets bytes done and the plan's total. */
export async function downloadModels(
    root: string,
    plan: ModelDownloadPlan,
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
): Promise<void> {
    const { total } = plan;
    let done = 0;
    onProgress(0, total);
    for (const { spec, files } of plan.items) {
        const dir = modelDir(root, spec);
        const partial = `${dir}.partial`;
        await fs.rm(partial, { recursive: true, force: true });
        const queue = [...files];
        // One failed file stops the others rather than letting them fetch the rest for nothing.
        const failed = new AbortController();
        const stop = AbortSignal.any([signal, failed.signal]);
        let firstError: unknown;
        const worker = async (): Promise<void> => {
            try {
                for (let file = queue.shift(); file; file = queue.shift()) {
                    await downloadFile(spec, file, path.join(partial, file.path), stop, (bytes) => {
                        done += bytes;
                        onProgress(done, total);
                    });
                }
            } catch (err) {
                // The others then fail with an AbortError; the first error says what went wrong.
                if (!stop.aborted) {
                    firstError = err;
                    failed.abort();
                }
                firstError ??= err;
            }
        };
        // Workers do not reject: once all are done, none writes into the partial directory any more.
        await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
        if (firstError !== undefined) {
            await fs.rm(partial, { recursive: true, force: true });
            throw firstError;
        }
        await fs.rename(partial, dir);
    }
}

async function listFiles(spec: ModelSpec, signal: AbortSignal): Promise<RemoteFile[]> {
    const url = `https://huggingface.co/api/models/${spec.repo}/tree/${spec.revision}?recursive=1`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
        throw new Error(`GET ${url} → HTTP ${res.status}`);
    }
    const all = (await res.json()) as RemoteFile[];
    const files = all.filter((f) => f.type === 'file' && (spec.required.includes(f.path) || spec.extra?.(f.path)));
    const absent = spec.required.filter((name) => !files.some((f) => f.path === name));
    if (absent.length > 0) {
        throw new Error(`${spec.repo}@${spec.revision} lacks ${absent.join(', ')}`);
    }
    for (const f of files) {
        if (path.isAbsolute(f.path) || path.normalize(f.path).startsWith('..')) {
            throw new Error(`${spec.repo} lists an unsafe path: ${f.path}`);
        }
    }
    return files;
}

async function downloadFile(spec: ModelSpec, file: RemoteFile, dest: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
    const url = `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${file.path}`;
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) {
        throw new Error(`GET ${url} → HTTP ${res.status}`);
    }
    // LFS files are named by their sha256; the rest by their git blob id, sha1("blob <size>\0" + content).
    const hash = createHash(file.lfs ? 'sha256' : 'sha1');
    if (!file.lfs) {
        hash.update(`blob ${file.size}\0`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const out = await fs.open(dest, 'w');
    let size = 0;
    try {
        const reader = res.body.getReader();
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
            hash.update(read.value);
            await out.write(read.value);
            size += read.value.length;
            onBytes(read.value.length);
        }
    } finally {
        await out.close();
    }
    const expected = file.lfs?.oid ?? file.oid;
    const actual = hash.digest('hex');
    if (size !== file.size || actual !== expected) {
        throw new Error(`${file.path}: checksum mismatch (got ${size} bytes ${actual}, expected ${file.size} bytes ${expected})`);
    }
}
