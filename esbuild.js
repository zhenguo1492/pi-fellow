const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

const extensionConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode'],
    // The bundle is CJS, but `import` statements would pick ort's ESM node build,
    // which needs import.meta.url; use its CommonJS node build instead.
    alias: { 'onnxruntime-web': './node_modules/onnxruntime-web/dist/ort.node.min.js' },
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    minify: false,
};

const webviewConfig = {
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    outfile: 'out/webview/main.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: false,
};

const settingsWebviewConfig = {
    entryPoints: ['src/webview/settings.ts'],
    bundle: true,
    outfile: 'out/webview/settings.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: false,
};

/**
 * The webviews' stylesheets: each entry @imports its modules (src/webview/styles/chat/, tokens.css,
 * xterm's CSS) into one file. SVG masks are inlined as data URLs (the webview CSP allows data:).
 */
const stylesConfig = {
    entryPoints: ['src/webview/styles/main.css', 'src/webview/styles/settings.css'],
    bundle: true,
    outdir: 'out/webview/styles',
    loader: { '.svg': 'dataurl' },
    target: 'chrome130',
    sourcemap: true,
    minify: false,
};

/**
 * Loaded by Pi/omp (not VS Code): host tools on the pi backend (src/piExtension/hostTools.ts) and the
 * permission gate of every chat worker (src/piExtension/permissionGate.ts).
 * ESM: Pi's loader rejects a CommonJS `exports.default` as "not a valid factory function".
 */
const piExtensionConfig = {
    entryPoints: ['src/piExtension/hostTools.ts', 'src/piExtension/permissionGate.ts'],
    bundle: true,
    outdir: 'out/pi-extension',
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    minify: false,
};

/**
 * The built-in voice engine, a separate process (src/voice/builtinEngine/server.ts). Its native
 * runtime (sherpa-onnx) is not bundled: it is downloaded on first use (src/voice/builtinEngine/runtime.ts).
 */
const voiceEngineConfig = {
    entryPoints: ['src/voice/builtinEngine/server.ts'],
    bundle: true,
    outfile: 'out/voice-engine/server.js',
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    minify: false,
};

/** onnxruntime-web loads these at runtime for the voice-input VAD (src/voice/sileroVad.ts). */
async function copyOrtRuntime() {
    const outDir = path.join('out', 'vad');
    await fs.promises.mkdir(outDir, { recursive: true });
    const distDir = path.dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
    for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
        await fs.promises.copyFile(path.join(distDir, file), path.join(outDir, file));
    }
}

async function build() {
    if (isWatch) {
        await copyOrtRuntime();
        const extCtx = await esbuild.context(extensionConfig);
        const webCtx = await esbuild.context(webviewConfig);
        const settingsCtx = await esbuild.context(settingsWebviewConfig);
        const stylesCtx = await esbuild.context(stylesConfig);
        const piExtensionCtx = await esbuild.context(piExtensionConfig);
        const voiceEngineCtx = await esbuild.context(voiceEngineConfig);
        await Promise.all([extCtx.watch(), webCtx.watch(), settingsCtx.watch(), stylesCtx.watch(), piExtensionCtx.watch(), voiceEngineCtx.watch()]);
        console.log('Watching for changes...');
    } else {
        await esbuild.build(extensionConfig);
        await esbuild.build(webviewConfig);
        await esbuild.build(settingsWebviewConfig);
        await esbuild.build(stylesConfig);
        await esbuild.build(piExtensionConfig);
        await esbuild.build(voiceEngineConfig);
        await copyOrtRuntime();
        console.log('Build complete.');
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
