/**
 * The native runtime of the built-in voice engine: sherpa-onnx-node and the prebuilt binaries of
 * this platform. Not bundled, so one VSIX serves every platform: downloaded on first use from the
 * npm registry at SHERPA_ONNX_VERSION, each tarball checked against the integrity hash the registry
 * lists for it, and unpacked as `<root>/<version>-<platform>-<arch>/node_modules/<package>` (the
 * layout sherpa-onnx-node's loader expects: the binaries in its sibling package). The directory is
 * published by renaming its `.partial` directory once both packages are unpacked.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

/** The sherpa-onnx release the engine runs on (server.ts); every package is fetched at exactly this version. */
export const SHERPA_ONNX_VERSION = '1.13.8';

const REGISTRY = 'https://registry.npmjs.org';
/** Where server.ts requires sherpa-onnx from, under node_modules. */
const NODE_PACKAGE = 'sherpa-onnx-node';
/** The platforms sherpa-onnx-node has binary packages for (its optionalDependencies), named its way: `win`, not `win32`. */
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win-ia32', 'win-x64'];

const gunzipAsync = promisify(gunzip);

/** `sherpa-onnx-<win|linux|darwin>-<arch>`, the binary package of a platform; throws for one without. */
export function platformPackage(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
    const target = `${platform === 'win32' ? 'win' : platform}-${arch}`;
    if (!PLATFORMS.includes(target)) {
        throw new Error(
            `The built-in voice engine does not run on ${platform}-${arch}: sherpa-onnx ${SHERPA_ONNX_VERSION} has builds for ${PLATFORMS.join(', ')} only. Use your own speech server instead (Settings → Voice).`,
        );
    }
    return `sherpa-onnx-${target}`;
}

/** The installed runtime of `binaryPackage`: complete when it exists. */
export function runtimeDir(root: string, binaryPackage: string = platformPackage()): string {
    return path.join(root, `${SHERPA_ONNX_VERSION}-${binaryPackage.slice('sherpa-onnx-'.length)}`);
}

/** The sherpa-onnx-node package directory in a runtime directory: what server.ts requires. */
export function sherpaModulePath(dir: string): string {
    return path.join(dir, 'node_modules', NODE_PACKAGE);
}

export async function isRuntimeInstalled(dir: string): Promise<boolean> {
    return fs.stat(dir).then(
        (s) => s.isDirectory(),
        () => false,
    );
}

export interface RuntimePackage {
    name: string;
    tarball: string;
    /** Subresource Integrity, as the registry lists it (`sha512-<base64>`). */
    integrity: string;
    /** Bytes of its files unpacked: progress counts these. */
    size: number;
}

/** What installing the runtime into `dir` fetches: nothing when it is installed. */
export interface RuntimeDownloadPlan {
    dir: string;
    /** Bytes unpacked over all packages. */
    total: number;
    packages: RuntimePackage[];
}

/** Looks the packages up in the registry (one request each) unless the runtime is installed. */
export async function planRuntimeDownload(root: string, signal: AbortSignal, binaryPackage: string = platformPackage()): Promise<RuntimeDownloadPlan> {
    const dir = runtimeDir(root, binaryPackage);
    if (await isRuntimeInstalled(dir)) {
        return { dir, total: 0, packages: [] };
    }
    const packages = await Promise.all([NODE_PACKAGE, binaryPackage].map((name) => lookUp(name, signal)));
    return { dir, total: packages.reduce((sum, p) => sum + p.size, 0), packages };
}

/** Downloads, checks and unpacks what `plan` lists, then publishes its directory; `onProgress` gets bytes done and the plan's total. */
export async function downloadRuntime(plan: RuntimeDownloadPlan, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<void> {
    if (plan.packages.length === 0) {
        return;
    }
    const partial = `${plan.dir}.partial`;
    await fs.rm(partial, { recursive: true, force: true });
    let done = 0;
    onProgress(0, plan.total);
    try {
        for (const pkg of plan.packages) {
            const tgz = await fetchTarball(pkg, signal, (bytes) => {
                done += bytes;
                onProgress(done, plan.total);
            });
            await extractTarball(tgz, path.join(partial, 'node_modules', pkg.name));
        }
        await fs.rename(partial, plan.dir);
    } catch (err) {
        await fs.rm(partial, { recursive: true, force: true });
        throw err;
    }
}

async function lookUp(name: string, signal: AbortSignal): Promise<RuntimePackage> {
    const url = `${REGISTRY}/${name}/${SHERPA_ONNX_VERSION}`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
        throw new Error(`GET ${url} → HTTP ${res.status}`);
    }
    const { dist } = (await res.json()) as { dist?: { tarball?: unknown; integrity?: unknown; unpackedSize?: unknown } };
    if (typeof dist?.tarball !== 'string' || typeof dist.integrity !== 'string') {
        throw new Error(`${name}@${SHERPA_ONNX_VERSION}: the registry lists no tarball with an integrity hash`);
    }
    return { name, tarball: dist.tarball, integrity: dist.integrity, size: typeof dist.unpackedSize === 'number' ? dist.unpackedSize : 0 };
}

/** The strongest hash of an SRI string that Node computes; npm lists sha512. */
function parseIntegrity(sri: string): { algorithm: string; digest: string } {
    const hashes = sri.trim().split(/\s+/).map((token) => {
        const dash = token.indexOf('-');
        return { algorithm: token.slice(0, dash), digest: token.slice(dash + 1).split('?')[0] };
    });
    for (const algorithm of ['sha512', 'sha384', 'sha256']) {
        const hash = hashes.find((h) => h.algorithm === algorithm);
        if (hash) {
            return hash;
        }
    }
    throw new Error(`unsupported integrity hash: ${sri}`);
}

/** The tarball, checked against its integrity hash. `onBytes` gets its share of the unpacked size as it arrives. */
async function fetchTarball(pkg: RuntimePackage, signal: AbortSignal, onBytes: (n: number) => void): Promise<Buffer> {
    const { algorithm, digest } = parseIntegrity(pkg.integrity);
    const res = await fetch(pkg.tarball, { signal });
    if (!res.ok || !res.body) {
        throw new Error(`GET ${pkg.tarball} → HTTP ${res.status}`);
    }
    const length = Number(res.headers.get('content-length')) || 0;
    const hash = createHash(algorithm);
    const chunks: Uint8Array[] = [];
    let received = 0;
    let reported = 0;
    const reader = res.body.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
        hash.update(read.value);
        chunks.push(read.value);
        received += read.value.length;
        if (length > 0) {
            const share = Math.min(pkg.size, Math.floor((pkg.size * received) / length));
            onBytes(share - reported);
            reported = share;
        }
    }
    const actual = hash.digest('base64');
    if (actual !== digest) {
        throw new Error(`${pkg.name}@${SHERPA_ONNX_VERSION}: checksum mismatch (got ${algorithm}-${actual}, expected ${algorithm}-${digest})`);
    }
    onBytes(pkg.size - reported);
    return Buffer.concat(chunks);
}

/** A NUL-terminated header field. */
function field(header: Buffer, offset: number, length: number): string {
    const bytes = header.subarray(offset, offset + length);
    const end = bytes.indexOf(0);
    return bytes.toString('utf8', 0, end === -1 ? length : end);
}

function octal(header: Buffer, offset: number, length: number): number {
    const text = field(header, offset, length).trim();
    return text ? parseInt(text, 8) : 0;
}

/** `path` of pax extended header records (`<length> <key>=<value>\n`). */
function paxPath(body: Buffer): string | undefined {
    let found: string | undefined;
    for (let at = 0; at < body.length; ) {
        const space = body.indexOf(0x20, at);
        const length = parseInt(body.toString('utf8', at, space), 10);
        if (space === -1 || !(length > 0)) {
            break;
        }
        const record = body.toString('utf8', space + 1, at + length - 1);
        const eq = record.indexOf('=');
        if (record.slice(0, eq) === 'path') {
            found = record.slice(eq + 1);
        }
        at += length;
    }
    return found;
}

/**
 * Unpacks the regular files and directories of an npm tarball into `dest`, without its top
 * directory (`package/`), as npm installs it. Any other entry (links, devices) or a path leaving
 * `dest` is refused.
 */
export async function extractTarball(tgz: Buffer, dest: string): Promise<void> {
    const tar = await gunzipAsync(tgz);
    const root = path.resolve(dest);
    await fs.mkdir(root, { recursive: true });
    let longName: string | undefined;
    for (let offset = 0; offset + 512 <= tar.length; ) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((b) => b === 0)) {
            break; // end of archive
        }
        const size = octal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 0x30);
        const body = tar.subarray(offset + 512, offset + 512 + size);
        if (body.length < size) {
            throw new Error('truncated tarball');
        }
        offset += 512 + Math.ceil(size / 512) * 512;
        if (type === 'x' || type === 'L') {
            // The name of the next entry: a pax header's path, or a GNU long name.
            longName = type === 'x' ? paxPath(body) : field(body, 0, body.length);
            continue;
        }
        if (type === 'g') {
            continue;
        }
        const prefix = field(header, 345, 155);
        const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
        longName = undefined;
        const relative = name.split('/').slice(1).join('/');
        if (!relative) {
            continue;
        }
        const target = path.resolve(root, relative);
        if (!target.startsWith(root + path.sep)) {
            throw new Error(`unsafe path in tarball: ${name}`);
        }
        if (type === '5') {
            await fs.mkdir(target, { recursive: true });
        } else if (type === '0' || type === '7') {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, body, { mode: octal(header, 100, 8) & 0o777 || 0o644 });
        } else {
            throw new Error(`unsupported tarball entry (type ${type}): ${name}`);
        }
    }
}
