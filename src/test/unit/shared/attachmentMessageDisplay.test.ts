import { describe, expect, it } from 'vitest';
import { isImageFilePath, parseUserMessageForDisplay } from '../../../shared/attachmentMessageDisplay';
import { buildEditorContextFragment } from '../../../shared/editorContext';

describe('parseUserMessageForDisplay', () => {
    it('strips file blocks and keeps user text', () => {
        const raw = `Hello\n<file name="/proj/a.ts">\nconst x = 1;\n</file>\n`;
        const { displayText, fileAttachments } = parseUserMessageForDisplay(raw);
        expect(displayText).toBe('Hello');
        expect(fileAttachments).toHaveLength(1);
        expect(fileAttachments[0].displayName).toBe('a.ts');
    });

    it('detects image paths', () => {
        expect(isImageFilePath('/x/photo.png')).toBe(true);
        expect(isImageFilePath('/x/readme.md')).toBe(false);
    });

    it('keeps image paths in attachment list for chip rendering', () => {
        const raw = `See attached files.\n<file name="/proj/screenshot.png"></file>\n`;
        const { fileAttachments } = parseUserMessageForDisplay(raw);
        expect(fileAttachments.some((f) => f.displayName === 'screenshot.png')).toBe(true);
        expect(isImageFilePath(fileAttachments[0].path)).toBe(true);
    });

    it('hides placeholder-only body when files present', () => {
        const raw = `See attached files.\n<file name="/x.md">\n# Hi\n</file>\n`;
        const { displayText, fileAttachments } = parseUserMessageForDisplay(raw);
        expect(displayText).toBe('');
        expect(fileAttachments).toHaveLength(1);
    });

    it('turns an editor-context selection into a chip carrying its line range', () => {
        const raw = `why?\n${buildEditorContextFragment('/proj/src/a.ts', { startLine: 3, endLine: 7, text: 'const x = 1;' })}`;
        const { displayText, fileAttachments } = parseUserMessageForDisplay(raw);
        expect(displayText).toBe('why?');
        expect(fileAttachments).toEqual([
            { displayName: 'a.ts', path: '/proj/src/a.ts', startLine: 3, endLine: 7 },
        ]);
    });

    it('turns a file-only editor context into a chip without lines', () => {
        const raw = `explain\n${buildEditorContextFragment('/proj/b.py')}`;
        const { displayText, fileAttachments } = parseUserMessageForDisplay(raw);
        expect(displayText).toBe('explain');
        expect(fileAttachments).toEqual([{ displayName: 'b.py', path: '/proj/b.py' }]);
    });
});
