import { describe, it, expect } from 'vitest';
import { findViewers, languageOf, matchesFilenamePattern, runPreviewCommand, type ExtensionManifest } from '../../../voiceAgent/viewers';

/** The discoverPreviewCommands setting: off by default. */
const OFF = { thirdPartyCommands: false };
const ON = { thirdPartyCommands: true };

/** Trimmed from the real manifests of hediet.vscode-drawio and VS Code's built-in Markdown extension. */
const DRAWIO: ExtensionManifest = {
    id: 'hediet.vscode-drawio',
    builtin: false,
    packageJSON: {
        contributes: {
            customEditors: [
                { viewType: 'hediet.vscode-drawio', displayName: 'Draw.io (Binary)', selector: [{ filenamePattern: '*.drawio.png' }, { filenamePattern: '*.dio.png' }], priority: 'default' },
                {
                    viewType: 'hediet.vscode-drawio-text',
                    displayName: 'Draw.io',
                    selector: [{ filenamePattern: '*.drawio' }, { filenamePattern: '*.dio' }, { filenamePattern: '*.dio.svg' }, { filenamePattern: '*.drawio.svg' }],
                    priority: 'default',
                },
                { viewType: 'drawio-inline-editor.drawioEditor', displayName: 'Draw.io Inline Editor', selector: [{ filenamePattern: '*.drawio' }, { filenamePattern: '*.dio' }], priority: 'option' },
            ],
            commands: [{ command: 'drawio-inline-editor.previewDiagram', title: 'Preview Diagram', category: 'Draw.io' }],
            languages: [{ id: 'drawio', extensions: ['.drawio', '.dio', '.dio.svg', '.drawio.svg', '.drawio.png', '.dio.png'] }],
        },
    },
};

const MARKDOWN_LANGS = '/^(markdown|prompt|instructions|chatagent|skill)$/';
const MARKDOWN: ExtensionManifest = {
    id: 'vscode.markdown-language-features',
    builtin: true,
    packageJSON: {
        contributes: {
            customEditors: [
                { viewType: 'vscode.markdown.preview.editor', displayName: 'Markdown Preview', priority: { diffEditor: 'option', textEditor: 'option' }, selector: [{ filenamePattern: '*.md' }] },
            ],
            commands: [
                { command: 'markdown.showPreview', title: 'Open Preview', category: 'Markdown' },
                { command: 'markdown.showPreviewToSide', title: '%markdown.previewSide.title%', category: 'Markdown' },
                { command: 'markdown.showLockedPreviewToSide', title: 'Open Locked Preview to the Side', category: 'Markdown' },
                { command: 'markdown.preview.toggleLock', title: 'Toggle Preview Locking', category: 'Markdown' },
                { command: 'markdown.showSource', title: 'Show Source', category: 'Markdown' },
            ],
            menus: {
                'editor/title': [
                    {
                        command: 'markdown.showPreviewToSide',
                        when: `editorLangId =~ ${MARKDOWN_LANGS} && !notebookEditorFocused && !hasCustomMarkdownPreview`,
                        alt: 'markdown.showPreview',
                    },
                    { command: 'markdown.showSource', when: "activeWebviewPanelId == 'markdown.preview'" },
                ],
                commandPalette: [
                    { command: 'markdown.showLockedPreviewToSide', when: `editorLangId =~ ${MARKDOWN_LANGS} && !notebookEditorFocused` },
                    { command: 'markdown.preview.toggleLock', when: "activeWebviewPanelId == 'markdown.preview' || activeCustomEditorId == 'vscode.markdown.preview.editor'" },
                ],
            },
            languages: [{ id: 'markdown', extensions: ['.md', '.markdown'] }],
        },
    },
};

const PYTHON_PREVIEW: ExtensionManifest = {
    id: 'someone.py-preview',
    builtin: false,
    packageJSON: {
        contributes: {
            commands: [
                { command: 'py.preview', title: 'Preview Output' },
                // "Preview" only in its prefix: not a preview command.
                { command: 'pyPreview.close', title: 'Close' },
            ],
            menus: {
                'editor/title': [
                    { command: 'py.preview', when: '(resourceLangId == python || resourceExtname == .pyw) && !isWeb' },
                    { command: 'pyPreview.close', when: 'resourceLangId == python' },
                ],
            },
        },
    },
};

/** Trimmed from MermaidChart.vscode-mermaid-chart 2.8.1: a palette command, and its right-click twin the palette hides. */
const MERMAID: ExtensionManifest = {
    id: 'mermaidchart.vscode-mermaid-chart',
    builtin: false,
    packageJSON: {
        contributes: {
            commands: [
                { command: 'mermaidChart.preview', title: 'Mermaid: Preview Diagram' },
                { command: 'mermaidChart.previewFromContextMenu', title: 'Mermaid: Preview Diagram' },
                // "Review" hides "preview" in its letters: not a preview command.
                { command: 'mermaidChart.appReviewAccept', title: 'Accept' },
            ],
            menus: {
                commandPalette: [{ command: 'mermaidChart.previewFromContextMenu', when: 'false' }],
                'editor/context': [
                    { command: 'mermaidChart.previewFromContextMenu', when: 'resourceExtname =~ /^\\.(mmd|mermaid)$/ || resourceLangId =~ /^mermaid/', group: 'navigation' },
                ],
            },
            languages: [
                { id: 'mermaid', extensions: ['.mmd', '.mermaid'] },
                { id: 'mermaid.sequenceDiagram', extensions: ['.mmd', '.mermaid'] },
            ],
        },
    },
};

const ALL = [DRAWIO, MARKDOWN, PYTHON_PREVIEW, MERMAID];

describe('viewers: custom editor filename patterns', () => {
    it('matches draw.io patterns on the file name, whatever folder it is in, case-insensitively', () => {
        expect(matchesFilenamePattern('*.drawio', 'docs/flow.drawio')).toBe(true);
        expect(matchesFilenamePattern('*.drawio', '/ws/docs/Flow.DRAWIO')).toBe(true);
        expect(matchesFilenamePattern('*.dio', 'a.dio')).toBe(true);
        expect(matchesFilenamePattern('*.drawio.svg', 'img/arch.drawio.svg')).toBe(true);
        expect(matchesFilenamePattern('*.drawio.svg', 'C:\\ws\\img\\arch.drawio.svg')).toBe(true);
    });

    it('does not match other extensions, longer names or a plain svg', () => {
        expect(matchesFilenamePattern('*.drawio', 'flow.drawio.svg')).toBe(false);
        expect(matchesFilenamePattern('*.drawio.svg', 'logo.svg')).toBe(false);
        expect(matchesFilenamePattern('*.dio', 'audio')).toBe(false);
        expect(matchesFilenamePattern('*.dio', 'a.diox')).toBe(false);
    });

    it('matches the whole path when the pattern has a folder, with ** and braces', () => {
        expect(matchesFilenamePattern('**/diagrams/*.{mmd,mermaid}', '/ws/src/diagrams/flow.mmd')).toBe(true);
        expect(matchesFilenamePattern('**/diagrams/*.{mmd,mermaid}', 'diagrams/flow.mermaid')).toBe(true);
        expect(matchesFilenamePattern('**/diagrams/*.{mmd,mermaid}', '/ws/flow.mmd')).toBe(false);
        expect(matchesFilenamePattern('*.[ch]', 'x.c')).toBe(true);
        expect(matchesFilenamePattern('*.[ch]', 'x.cpp')).toBe(false);
    });
});

describe('viewers: language of a file', () => {
    it('takes the longest contributed extension', () => {
        const svg: ExtensionManifest = { id: 'x.svg', builtin: false, packageJSON: { contributes: { languages: [{ id: 'svg', extensions: ['.svg'] }] } } };
        expect(languageOf([svg, DRAWIO], 'a/arch.drawio.svg')).toBe('drawio');
        expect(languageOf([svg, DRAWIO], 'logo.svg')).toBe('svg');
        expect(languageOf(ALL, 'README.md')).toBe('markdown');
        expect(languageOf(ALL, 'a.unknown')).toBeUndefined();
    });
});

describe('viewers: what can show a file', () => {
    it('offers the draw.io editors for a diagram, the default before the optional, then the text editor', () => {
        const { editors, commands } = findViewers(ALL, '/ws/docs/flow.drawio', 'drawio', OFF);
        expect(editors.map((e) => [e.id, e.extension, e.priority])).toEqual([
            ['hediet.vscode-drawio-text', 'hediet.vscode-drawio', 'default'],
            ['drawio-inline-editor.drawioEditor', 'hediet.vscode-drawio', 'option'],
            ['default', 'built-in', undefined],
        ]);
        // draw.io's own preview command is a third-party one: not offered by default.
        expect(commands).toEqual([]);
        expect(findViewers(ALL, 'img/arch.drawio.svg', 'drawio', OFF).editors.map((e) => e.id)).toEqual(['hediet.vscode-drawio-text', 'default']);
        expect(findViewers(ALL, 'img/arch.drawio.png', 'drawio', OFF).editors.map((e) => e.id)).toEqual(['hediet.vscode-drawio', 'default']);
    });

    it("always offers Markdown's built-in preview editor and commands, editor-title ones first", () => {
        for (const options of [OFF, ON]) {
            const { editors, commands } = findViewers(ALL, '/ws/README.md', 'markdown', options);
            expect(editors.map((e) => [e.id, e.priority])).toEqual([
                ['vscode.markdown.preview.editor', 'option'],
                ['default', undefined],
            ]);
            expect(commands.map((c) => [c.id, c.label])).toEqual([
                ['markdown.showPreview', 'Markdown: Open Preview'],
                // An untranslated title falls back to the id.
                ['markdown.showPreviewToSide', 'markdown.showPreviewToSide'],
                ['markdown.showLockedPreviewToSide', 'Markdown: Open Locked Preview to the Side'],
            ]);
        }
    });

    it('by default offers no third-party preview command, but still their editors', () => {
        expect(findViewers(ALL, '/ws/docs/sequence.mmd', 'mermaid.sequenceDiagram', OFF)).toEqual({
            editors: [expect.objectContaining({ id: 'default' })],
            commands: [],
        });
        expect(findViewers(ALL, 'app.py', 'python', OFF).commands).toEqual([]);
        expect(findViewers(ALL, '/ws/docs/flow.drawio', 'drawio', OFF).editors.map((e) => e.id)).toContain('hediet.vscode-drawio-text');
    });

    it('with the setting on, also offers the preview commands of installed extensions', () => {
        expect(findViewers(ALL, '/ws/docs/flow.drawio', 'drawio', ON).commands.map((c) => c.id)).toEqual(['drawio-inline-editor.previewDiagram']);
        expect(findViewers(ALL, 'flow.mmd', 'mermaid', ON).commands.map((c) => c.id)).toEqual(['mermaidChart.preview']);
    });
});

describe('viewers: finding third-party preview commands (setting on)', () => {
    it('follows the when clause: language or extension alternatives, and nothing for another language', () => {
        expect(findViewers(ALL, 'app.py', 'python', ON).commands.map((c) => c.id)).toEqual(['py.preview']);
        expect(findViewers(ALL, 'app.pyw', undefined, ON).commands.map((c) => c.id)).toEqual(['py.preview']);
        expect(findViewers(ALL, 'app.ts', 'typescript', ON).commands).toEqual([]);
        expect(findViewers(ALL, 'notes.txt', 'plaintext', ON)).toEqual({ editors: [expect.objectContaining({ id: 'default' })], commands: [] });
    });

    it("prefers a general preview command over its context-menu variant with the same title", () => {
        const { commands } = findViewers(ALL, '/ws/docs/sequence.mmd', 'mermaid.sequenceDiagram', ON);
        expect(commands.map((c) => [c.id, c.label])).toEqual([['mermaidChart.preview', 'Mermaid: Preview Diagram']]);
        // Found by extension too, before the language is known.
        expect(findViewers(ALL, 'flow.mermaid', undefined, ON).commands.map((c) => c.id)).toEqual(['mermaidChart.preview']);
    });

    it('keeps a context-menu command that has no general twin, after the general ones', () => {
        const contextOnly: ExtensionManifest = {
            id: 'someone.mmd-extra',
            builtin: false,
            packageJSON: {
                contributes: {
                    commands: [{ command: 'mmdExtra.previewFromContextMenu', title: 'Preview in Browser' }],
                    menus: { 'explorer/context': [{ command: 'mmdExtra.previewFromContextMenu', when: 'resourceExtname == .mmd' }] },
                },
            },
        };
        expect(findViewers([contextOnly, ...ALL], 'flow.mmd', 'mermaid', ON).commands.map((c) => c.id)).toEqual(['mermaidChart.preview', 'mmdExtra.previewFromContextMenu']);
    });

    it('does not offer a palette-wide preview command of an extension that is not for this file', () => {
        expect(findViewers(ALL, 'app.ts', 'typescript', ON).commands).toEqual([]);
        expect(findViewers(ALL, 'README.md', 'markdown', ON).commands.map((c) => c.id)).not.toContain('mermaidChart.preview');
    });
});

describe('viewers: running a preview command', () => {
    const uri = 'file:///ws/flow.mmd';

    function recorder(behave: (args: unknown[]) => PromiseLike<unknown>) {
        const calls: unknown[][] = [];
        const execute = (...args: unknown[]) => {
            calls.push(args);
            return behave(args);
        };
        return { calls, execute };
    }

    it('runs it once with the uri when that shows something', async () => {
        const { calls, execute } = recorder(async () => undefined);
        expect(await runPreviewCommand(execute, uri, async () => true, 1000)).toEqual({ status: 'shown', withUri: true });
        expect(calls).toEqual([[uri]]);
    });

    it('runs it again without arguments, on the active editor, when the uri call throws or shows nothing', async () => {
        const throwing = recorder(async (args) => {
            if (args.length > 0) {
                throw new Error('bad argument');
            }
        });
        expect(await runPreviewCommand(throwing.execute, uri, async () => true, 1000)).toEqual({ status: 'shown', withUri: false });
        expect(throwing.calls).toEqual([[uri], []]);

        let shows = 0;
        const silent = recorder(async () => undefined);
        expect(await runPreviewCommand(silent.execute, uri, async () => ++shows === 2, 1000)).toEqual({ status: 'shown', withUri: false });
        expect(silent.calls).toEqual([[uri], []]);
    });

    it('says so when neither call shows anything, or both fail', async () => {
        expect(await runPreviewCommand(recorder(async () => undefined).execute, uri, async () => false, 1000)).toEqual({ status: 'unchanged' });
        const failing = recorder(() => {
            throw new Error('no active editor');
        });
        expect(await runPreviewCommand(failing.execute, uri, async () => true, 1000)).toEqual({ status: 'failed', error: 'no active editor' });
        expect(failing.calls).toHaveLength(2);
    });

    it('stops waiting on a command that never returns, and does not run it a second time', async () => {
        const hanging = recorder(() => Promise.withResolvers<never>().promise);
        const started = Date.now();
        expect(await runPreviewCommand(hanging.execute, uri, async () => true, 50)).toEqual({ status: 'timeout' });
        expect(Date.now() - started).toBeLessThan(1000);
        expect(hanging.calls).toEqual([[uri]]);
    });
});
