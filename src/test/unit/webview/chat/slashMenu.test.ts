import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../webview/vscodeApi', () => ({ vscode: { postMessage: vi.fn() } }));

import type { SkillInfo, SlashCommandListItem } from '../../../../shared/protocol';
import {
    applySlashSelection,
    filterSlashMenuItems,
    getSlashMenuCandidates,
    slashTokenBeforeCursor,
} from '../../../../webview/chat/slashMenu';

function skill(name: string, description = ''): SkillInfo {
    return { name, description, filePath: `/skills/${name}.md`, source: 'user', disableModelInvocation: false };
}

describe('getSlashMenuCandidates', () => {
    it('falls back to the built-in commands when the agent reports none', () => {
        const invocations = getSlashMenuCandidates([], []).map((c) => c.invocation);
        expect(invocations).toEqual(['/login', '/logout', '/model', '/new', '/reload']);
    });

    it('uses the agent commands instead of the fallbacks and appends skills as /skill:name', () => {
        const commands: SlashCommandListItem[] = [{ invocation: '/compact', name: 'compact', source: 'builtin' }];
        const items = getSlashMenuCandidates(commands, [skill('review', 'Review code')]);
        expect(items).toEqual([
            { invocation: '/compact', name: 'compact', source: 'builtin' },
            { invocation: '/skill:review', name: 'skill:review', description: 'Review code', source: 'skill' },
        ]);
    });

    it('dedupes by invocation keeping the first occurrence', () => {
        const commands: SlashCommandListItem[] = [
            { invocation: '/skill:review', name: 'review-cmd', description: 'from agent', source: 'extension' },
            { invocation: '/new', name: 'new', source: 'builtin' },
            { invocation: '/new', name: 'new-dup', source: 'prompt' },
        ];
        const items = getSlashMenuCandidates(commands, [skill('review', 'from skill')]);
        expect(items.map((i) => [i.invocation, i.name])).toEqual([
            ['/skill:review', 'review-cmd'],
            ['/new', 'new'],
        ]);
    });
});

describe('filterSlashMenuItems', () => {
    const items: SlashCommandListItem[] = [
        { invocation: '/model', name: 'model', description: 'Select model', source: 'builtin' },
        { invocation: '/skill:deploy', name: 'skill:deploy', description: 'Ship to PROD', source: 'skill' },
        { invocation: '/new', name: 'fresh', source: 'builtin' },
    ];

    it('keeps every item for an empty query', () => {
        expect(filterSlashMenuItems(items, '')).toEqual(items);
    });

    it('matches invocation, name, and description case-insensitively', () => {
        expect(filterSlashMenuItems(items, 'MOD').map((i) => i.invocation)).toEqual(['/model']);
        expect(filterSlashMenuItems(items, 'fresh').map((i) => i.invocation)).toEqual(['/new']);
        expect(filterSlashMenuItems(items, 'prod').map((i) => i.invocation)).toEqual(['/skill:deploy']);
    });

    it('does not match the leading slash of the invocation', () => {
        expect(filterSlashMenuItems(items, '/')).toEqual([]);
    });
});

describe('slashTokenBeforeCursor', () => {
    it('finds a token at the start of the text', () => {
        expect(slashTokenBeforeCursor('/mo', 3)).toBe('/mo');
        expect(slashTokenBeforeCursor('/', 1)).toBe('/');
    });

    it('finds a token after whitespace', () => {
        expect(slashTokenBeforeCursor('hello /ne', 9)).toBe('/ne');
        expect(slashTokenBeforeCursor('line\n/skill:x', 13)).toBe('/skill:x');
    });

    it('ignores a slash in the middle of a word', () => {
        expect(slashTokenBeforeCursor('a/b', 3)).toBeNull();
    });

    it('only considers text before the cursor', () => {
        expect(slashTokenBeforeCursor('/model rest', 3)).toBe('/mo');
        expect(slashTokenBeforeCursor('/model rest', 11)).toBeNull();
    });
});

describe('applySlashSelection', () => {
    it('replaces the token before the cursor, appends a space, and keeps text after the cursor', () => {
        expect(applySlashSelection('say /mo tail', 7, '/model')).toEqual({ value: 'say /model  tail', cursor: 11 });
    });

    it('replaces only the partial token when the cursor is inside a word', () => {
        expect(applySlashSelection('/modxyz', 4, '/model')).toEqual({ value: '/model xyz', cursor: 7 });
    });

    it('returns null when there is no slash token before the cursor', () => {
        expect(applySlashSelection('plain text', 5, '/model')).toBeNull();
        expect(applySlashSelection('a/b', 3, '/model')).toBeNull();
    });
});
