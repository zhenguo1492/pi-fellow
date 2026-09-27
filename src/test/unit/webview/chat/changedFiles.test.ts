import { describe, it, expect, vi } from 'vitest';
import type { FileChangeInfo } from '../../../../shared/protocol';

vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: vi.fn() } }));

import { getFileIcon, uniqueFileChanges } from '../../../../webview/chat/changedFiles';

function change(filePath: string, toolCallId: string): FileChangeInfo {
    return { filePath, toolCallId } as FileChangeInfo;
}

describe('getFileIcon', () => {
    it('maps known extensions case-insensitively', () => {
        expect(getFileIcon('src/a.ts')).toBe('&#128312;');
        expect(getFileIcon('src/A.TSX')).toBe('&#128312;');
        expect(getFileIcon('b.Js')).toBe('&#128313;');
        expect(getFileIcon('c.scss')).toBe('&#128309;');
        expect(getFileIcon('README.md')).toBe('&#128310;');
        expect(getFileIcon('x.py')).toBe('&#128311;');
    });

    it('uses the last extension and a default for unknown or missing ones', () => {
        expect(getFileIcon('archive.ts.bak')).toBe('&#128196;');
        expect(getFileIcon('Makefile')).toBe('&#128196;');
        expect(getFileIcon('dir.ts/file')).toBe('&#128196;');
    });
});

describe('uniqueFileChanges', () => {
    it('keeps the latest change per path in first-seen order', () => {
        const a1 = change('a', '1');
        const b1 = change('b', '2');
        const a2 = change('a', '3');
        const c1 = change('c', '4');
        expect(uniqueFileChanges([a1, b1, a2, c1])).toEqual([a2, b1, c1]);
        expect(uniqueFileChanges([a1, b1, a2, c1])[0]).toBe(a2);
    });

    it('is empty for no changes', () => {
        expect(uniqueFileChanges([])).toEqual([]);
    });
});
