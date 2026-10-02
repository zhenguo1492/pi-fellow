import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('vscode', () => ({
    workspace: { getConfiguration: () => ({ get: (key: string) => settings.values[key] }), workspaceFolders: undefined },
}));

import { avatarPresetSrc } from '../../../shared/avatarPresets';
import { resolveSpeakers } from '../../../voiceAgent/speakers';

beforeEach(() => {
    settings.values = {};
});

describe('resolveSpeakers avatars', () => {
    it('shows the otaku for you and the gentleman for the voice agent when the avatars are empty, both talking', async () => {
        settings.values = { userAvatar: '', botAvatar: '  ' };
        const { speakers, errors } = await resolveSpeakers();
        expect(errors).toEqual({});
        expect(speakers.user.avatar).toMatchObject({ kind: 'image', src: avatarPresetSrc('otaku') });
        expect(speakers.bot.avatar).toMatchObject({ kind: 'image', src: avatarPresetSrc('gentleman') });
        for (const id of ['user', 'bot'] as const) {
            const avatar = speakers[id].avatar;
            expect(avatar?.kind === 'image' && avatar.think && avatar.talk ? 'animated' : 'still', id).toBe('animated');
        }
    });

    it('keeps the person and the robot selectable, for either speaker', async () => {
        settings.values = { userAvatar: 'preset:robot', botAvatar: 'preset:user' };
        const { speakers } = await resolveSpeakers();
        expect(speakers.user.avatar).toEqual({ kind: 'icon', icon: 'bot' });
        expect(speakers.bot.avatar).toEqual({ kind: 'icon', icon: 'user' });
    });
});
