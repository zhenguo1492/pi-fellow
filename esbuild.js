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

/** The voice panel in its own view in the bottom panel (src/voiceAgent/voicePanelView.ts). */
const voiceViewConfig = {
    ...settingsWebviewConfig,
    entryPoints: ['src/webview/voiceView.ts'],
    outfile: 'out/webview/voiceView.js',
};

async function copyStyles() {
    const stylesDir = path.join('out', 'webview', 'styles');
    await fs.promises.mkdir(stylesDir, { recursive: true });
    const srcDir = path.join('src', 'webview', 'styles');
    for (const file of await fs.promises.readdir(srcDir)) {
        await fs.promises.copyFile(path.join(srcDir, file), path.join(stylesDir, file));
    }
    await fs.promises.copyFile(
        require.resolve('@xterm/xterm/css/xterm.css'),
        path.join(stylesDir, 'xterm.css'),
    );
}

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
        await Promise.all([copyStyles(), copyOrtRuntime()]);
        const extCtx = await esbuild.context(extensionConfig);
        const webCtx = await esbuild.context(webviewConfig);
        const settingsCtx = await esbuild.context(settingsWebviewConfig);
        const voiceCtx = await esbuild.context(voiceViewConfig);
        await Promise.all([extCtx.watch(), webCtx.watch(), settingsCtx.watch(), voiceCtx.watch()]);
        console.log('Watching for changes...');
    } else {
        await esbuild.build(extensionConfig);
        await esbuild.build(webviewConfig);
        await esbuild.build(settingsWebviewConfig);
        await esbuild.build(voiceViewConfig);
        await Promise.all([copyStyles(), copyOrtRuntime()]);
        console.log('Build complete.');
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
