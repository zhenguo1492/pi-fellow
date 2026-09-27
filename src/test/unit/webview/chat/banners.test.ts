import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: vi.fn() } }));

import { connectionBannerTitle } from '../../../../webview/chat/banners';

describe('connectionBannerTitle', () => {
    it('shows attempt/max while retrying when both are known', () => {
        expect(connectionBannerTitle({ phase: 'retrying', attempt: 2, maxAttempts: 5 })).toBe('Reconnecting (2/5)…');
        expect(connectionBannerTitle({ phase: 'retrying', attempt: 0, maxAttempts: 3 })).toBe('Reconnecting (0/3)…');
    });

    it('shows the attempt alone when the maximum is unknown', () => {
        expect(connectionBannerTitle({ phase: 'retrying', attempt: 3 })).toBe('Reconnecting (attempt 3)…');
    });

    it('omits the counter without an attempt number', () => {
        expect(connectionBannerTitle({ phase: 'retrying' })).toBe('Reconnecting…');
        expect(connectionBannerTitle({ phase: 'retrying', maxAttempts: 4 })).toBe('Reconnecting…');
    });

    it('reports failure without an attempt counter', () => {
        expect(connectionBannerTitle({ phase: 'failed', attempt: 3, maxAttempts: 3, message: 'down' })).toBe(
            'Connection failed',
        );
    });
});
