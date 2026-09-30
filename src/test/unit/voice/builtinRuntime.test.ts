import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { SHERPA_ONNX_VERSION, downloadRuntime, planRuntimeDownload, platformPackage, runtimeDir, sherpaModulePath } from '../../../voice/builtinEngine/runtime';

const BINARY = 'sherpa-onnx-linux-x64';

/** A gzipped ustar archive of regular files, as npm packs them (under `package/`). */
function tgz(files: Record<string, string | { body: string; mode: number }>): Buffer {
    const blocks: Buffer[] = [];
    for (const [name, file] of Object.entries(files)) {
        const { body, mode } = typeof file === 'string' ? { body: file, mode: 0o644 } : file;
        const data = Buffer.from(body);
        const header = Buffer.alloc(512);
        header.write(name, 0, 100);
        header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
        header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
        header.write('0', 156);
        header.write('ustar\u000000', 257);
        blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const sri = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`;

interface Published {
    tarball: Buffer;
    /** What the registry lists; defaults to the tarball's hash. */
    integrity?: string;
    unpackedSize: number;
    status?: number;
}

describe('built-in voice engine runtime', () => {
    const originalFetch = globalThis.fetch;
    let root: string;
    let registry: Record<string, Published>;
    let fetched: string[];

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-runtime-'));
        registry = {
            'sherpa-onnx-node': { tarball: tgz({ 'package/package.json': '{"name":"sherpa-onnx-node"}', 'package/addon.js': 'module.exports = 1;' }), unpackedSize: 47 },
            [BINARY]: { tarball: tgz({ 'package/sherpa-onnx.node': { body: 'ELF', mode: 0o755 }, 'package/lib/libonnxruntime.so': 'ELF' }), unpackedSize: 6 },
        };
        fetched = [];
        globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            fetched.push(url);
            for (const [name, pkg] of Object.entries(registry)) {
                const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-${SHERPA_ONNX_VERSION}.tgz`;
                if (url === `https://registry.npmjs.org/${name}/${SHERPA_ONNX_VERSION}`) {
                    return Response.json({ name, version: SHERPA_ONNX_VERSION, dist: { tarball: tarballUrl, integrity: pkg.integrity ?? sri(pkg.tarball), unpackedSize: pkg.unpackedSize } });
                }
                if (url === tarballUrl) {
                    return new Response(new Uint8Array(pkg.tarball), { status: pkg.status ?? 200, headers: { 'content-length': String(pkg.tarball.length) } });
                }
            }
            return new Response('not found', { status: 404 });
        }) as typeof fetch;
    });

    afterEach(async () => {
        globalThis.fetch = originalFetch;
        await fs.rm(root, { recursive: true, force: true });
    });

    const entries = async () => (await fs.readdir(root)).sort();

    it('names the binary package the way sherpa-onnx-node loads it, and refuses platforms without one', () => {
        expect(platformPackage('win32', 'x64')).toBe('sherpa-onnx-win-x64');
        expect(platformPackage('win32', 'ia32')).toBe('sherpa-onnx-win-ia32');
        expect(platformPackage('darwin', 'arm64')).toBe('sherpa-onnx-darwin-arm64');
        expect(platformPackage('linux', 'arm64')).toBe('sherpa-onnx-linux-arm64');
        expect(() => platformPackage('win32', 'arm64')).toThrow(/does not run on win32-arm64/);
        expect(() => platformPackage('freebsd', 'x64')).toThrow(/does not run on freebsd-x64/);
    });

    it('installs both packages side by side, so sherpa-onnx-node finds the binaries in its sibling package', async () => {
        const plan = await planRuntimeDownload(root, AbortSignal.timeout(5000), BINARY);
        expect(plan.total).toBe(53);
        const progress: Array<[number, number]> = [];
        await downloadRuntime(plan, (done, total) => progress.push([done, total]), AbortSignal.timeout(5000));

        const dir = runtimeDir(root, BINARY);
        expect(await entries()).toEqual([path.basename(dir)]);
        expect(await fs.readFile(path.join(sherpaModulePath(dir), 'addon.js'), 'utf8')).toBe('module.exports = 1;');
        const addon = path.join(dir, 'node_modules', BINARY, 'sherpa-onnx.node');
        expect(await fs.readFile(addon, 'utf8')).toBe('ELF');
        expect(await fs.readFile(path.join(dir, 'node_modules', BINARY, 'lib', 'libonnxruntime.so'), 'utf8')).toBe('ELF');
        if (process.platform !== 'win32') {
            expect((await fs.stat(addon)).mode & 0o111).not.toBe(0);
        }
        expect(progress.at(-1)).toEqual([53, 53]);
        expect(progress.every(([done], i) => i === 0 || done >= progress[i - 1][0])).toBe(true);
    });

    it('fetches nothing once installed', async () => {
        await downloadRuntime(await planRuntimeDownload(root, AbortSignal.timeout(5000), BINARY), () => {}, AbortSignal.timeout(5000));
        fetched = [];
        const plan = await planRuntimeDownload(root, AbortSignal.timeout(5000), BINARY);
        expect(plan.packages).toEqual([]);
        expect(plan.total).toBe(0);
        expect(fetched).toEqual([]);
    });

    it('refuses a tarball that does not match its integrity hash, publishing nothing', async () => {
        registry[BINARY].integrity = sri(Buffer.from('another tarball'));
        const plan = await planRuntimeDownload(root, AbortSignal.timeout(5000), BINARY);
        await expect(downloadRuntime(plan, () => {}, AbortSignal.timeout(5000))).rejects.toThrow(/checksum mismatch/);
        expect(await entries()).toEqual([]);
    });

    it('publishes nothing when a later package fails, and downloads both again next time', async () => {
        registry[BINARY].status = 503;
        const plan = await planRuntimeDownload(root, AbortSignal.timeout(5000), BINARY);
        await expect(downloadRuntime(plan, () => {}, AbortSignal.timeout(5000))).rejects.toThrow(/HTTP 503/);
        expect(await entries()).toEqual([]);

        delete registry[BINARY].status;
        const retry = await planRuntimeDownload(root, AbortSignal.timeout(5000), BINARY);
        expect(retry.packages.map((p) => p.name)).toEqual(['sherpa-onnx-node', BINARY]);
        await downloadRuntime(retry, () => {}, AbortSignal.timeout(5000));
        expect(await entries()).toEqual([path.basename(runtimeDir(root, BINARY))]);
    });

    it('refuses a tarball entry that would land outside its package', async () => {
        registry[BINARY] = { tarball: tgz({ 'package/../../../../escaped.node': 'ELF' }), unpackedSize: 3 };
        const plan = await planRuntimeDownload(root, AbortSignal.timeout(5000), BINARY);
        await expect(downloadRuntime(plan, () => {}, AbortSignal.timeout(5000))).rejects.toThrow(/unsafe path/);
        expect(await entries()).toEqual([]);
        await expect(fs.stat(path.join(root, 'escaped.node'))).rejects.toThrow();
    });
});
