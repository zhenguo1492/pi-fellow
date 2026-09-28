import { describe, expect, it } from 'vitest';
import { parseAvatarSetting, speakerName } from '../../../shared/voiceSpeakers';

describe('avatar setting', () => {
    it('reads a path from a slash, a leading ~ or an image extension; anything else is text', () => {
        expect(parseAvatarSetting('~/pics/me.png')).toEqual({ kind: 'path', path: '~/pics/me.png' });
        expect(parseAvatarSetting('C:\\Users\\me\\a.jpg')).toEqual({ kind: 'path', path: 'C:\\Users\\me\\a.jpg' });
        expect(parseAvatarSetting('avatar.webp')).toEqual({ kind: 'path', path: 'avatar.webp' });
        expect(parseAvatarSetting('ZG')).toEqual({ kind: 'text', text: 'ZG' });
        expect(parseAvatarSetting('  ')).toEqual({ kind: 'none' });
        expect(parseAvatarSetting(undefined)).toEqual({ kind: 'none' });
        // A preset has no slash or extension, and is not cut to two characters as text would be.
        expect(parseAvatarSetting('preset:otaku')).toEqual({ kind: 'preset', id: 'otaku' });
    });

    it('keeps two characters as the user sees them, not code units', () => {
        // A family emoji is one character of several code points joined by ZWJ.
        expect(parseAvatarSetting('👨‍👩‍👧🦊x')).toEqual({ kind: 'text', text: '👨‍👩‍👧🦊' });
        expect(parseAvatarSetting('小智同学')).toEqual({ kind: 'text', text: '小智' });
    });
});

describe('speaker name', () => {
    it('falls back to User / Bot when empty, and collapses whitespace', () => {
        expect(speakerName('user', '')).toBe('User');
        expect(speakerName('bot', '   ')).toBe('Bot');
        expect(speakerName('bot', ' 小 \n 智 ')).toBe('小 智');
    });
});
