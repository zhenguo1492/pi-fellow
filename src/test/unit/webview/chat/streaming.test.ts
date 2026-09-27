import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: vi.fn() } }));
vi.mock('../../../../webview/modelStatus', () => ({ setModelWorkingStatus: vi.fn() }));

import { streamActivityLabel } from '../../../../webview/chat/streaming';

describe('streamActivityLabel', () => {
    it('labels thinking and writing regardless of detail', () => {
        expect(streamActivityLabel('thinking', 'ignored', true)).toBe('Thinking…');
        expect(streamActivityLabel('writing', 'ignored', true)).toBe('Writing response…');
    });

    it('names the running tool when a label is known, otherwise a generic tool label', () => {
        expect(streamActivityLabel('tool', 'Read src/a.ts', true)).toBe('Running Read src/a.ts…');
        expect(streamActivityLabel('tool', '', true)).toBe('Running tool…');
    });

    it('shows the waiting detail verbatim, falling back to a generic label', () => {
        expect(streamActivityLabel('waiting', 'Compacting context', true)).toBe('Compacting context');
        expect(streamActivityLabel('waiting', '', true)).toBe('Working…');
    });

    it('idle shows a working label only while streaming', () => {
        expect(streamActivityLabel('idle', '', true)).toBe('Pi is working…');
        expect(streamActivityLabel('idle', '', false)).toBe('');
    });
});
