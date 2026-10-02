import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Lines of the fixture workspace's src/app.ts: `line 1` … `line 20`, so a test can check where a link lands. */
const APP_LINES = 20;

async function main() {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    // Set when run from VS Code's own terminal or an extension host: the downloaded VS Code would start as plain Node and reject its options.
    delete process.env.ELECTRON_RUN_AS_NODE;
    // A workspace folder of its own, for what resolves against one (board links).
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-it-workspace-'));
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'src', 'app.ts'), Array.from({ length: APP_LINES }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
    try {
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [workspace, '--disable-extensions'],
        });
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error('Failed to run tests:', err);
    process.exit(1);
});
