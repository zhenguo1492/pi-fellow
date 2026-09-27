import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: vi.fn() } }));

import { resolveImageOpenPath } from '../../../../webview/chat/attachments';

describe('resolveImageOpenPath', () => {
    const byBase = new Map([['shot.png', '/work/assets/Shot.png']]);

    it('returns absolute POSIX and Windows paths unchanged (trimmed)', () => {
        expect(resolveImageOpenPath({ name: ' /tmp/x/Other.PNG ' }, byBase)).toBe('/tmp/x/Other.PNG');
        expect(resolveImageOpenPath({ name: 'C:\\img\\a.png' }, byBase)).toBe('C:\\img\\a.png');
        expect(resolveImageOpenPath({ name: 'd:/img/a.png' }, byBase)).toBe('d:/img/a.png');
    });

    it('looks up relative names by case-insensitive basename', () => {
        expect(resolveImageOpenPath({ name: 'SHOT.png' }, byBase)).toBe('/work/assets/Shot.png');
        expect(resolveImageOpenPath({ name: 'sub/dir/Shot.PNG' }, byBase)).toBe('/work/assets/Shot.png');
        expect(resolveImageOpenPath({ name: 'sub\\Shot.png' }, byBase)).toBe('/work/assets/Shot.png');
    });

    it('returns undefined for unknown basenames and empty names', () => {
        expect(resolveImageOpenPath({ name: 'missing.png' }, byBase)).toBeUndefined();
        expect(resolveImageOpenPath({ name: '   ' }, byBase)).toBeUndefined();
        expect(resolveImageOpenPath({}, byBase)).toBeUndefined();
    });
});
