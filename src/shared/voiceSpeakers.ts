import { AVATAR_PRESET_PREFIX, type AvatarThinking } from './avatarPresets';

/**
 * Who talks in the Bot view: the user and the voice agent, each with a name and an avatar
 * (`voiceAgent.userName` / `userAvatar`, `voiceAgent.botName` / `botAvatar`). Shared by the
 * extension host, the Bot view and the settings page.
 */

export type VoiceSpeakerId = 'user' | 'bot';

export const DEFAULT_SPEAKER_NAMES: Readonly<Record<VoiceSpeakerId, string>> = { user: 'User', bot: 'Bot' };

/** Longest name kept; longer ones are cut. */
export const MAX_SPEAKER_NAME = 40;

/** A text avatar is its first few characters (user-perceived: an emoji with modifiers is one). */
const MAX_AVATAR_CHARS = 2;

/**
 * `text`: an emoji or initials; `image`: a data URI of the picture (`think`: a pixel-art preset's
 * thinking animation); `icon`: one of the default line icons (the person or the robot), drawn in
 * the avatar box's colour. Absent: the speaker's own default icon.
 */
export type VoiceAvatar = { kind: 'text'; text: string } | { kind: 'image'; src: string; think?: AvatarThinking } | { kind: 'icon'; icon: VoiceSpeakerId };

export interface VoiceSpeaker {
    name: string;
    avatar?: VoiceAvatar;
}

export type VoiceSpeakers = Record<VoiceSpeakerId, VoiceSpeaker>;

/** A name as shown: trimmed, cut to `MAX_SPEAKER_NAME`, the default when empty. */
export function speakerName(id: VoiceSpeakerId, raw: unknown): string {
    const name = typeof raw === 'string' ? [...raw.replace(/\s+/g, ' ').trim()].slice(0, MAX_SPEAKER_NAME).join('') : '';
    return name || DEFAULT_SPEAKER_NAMES[id];
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

/**
 * What an avatar setting says: nothing (the default icon), a pixel-art preset (`preset:<id>`,
 * avatarPresets.ts), an image file (`path`, as written: `~` and workspace-relative paths are the
 * host's to resolve), or text, cut to its first two characters. A path is anything with a slash,
 * starting with `~`, or ending in an image extension.
 */
export function parseAvatarSetting(
    raw: unknown,
): { kind: 'none' } | { kind: 'preset'; id: string } | { kind: 'path'; path: string } | { kind: 'text'; text: string } {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
        return { kind: 'none' };
    }
    if (value.startsWith(AVATAR_PRESET_PREFIX)) {
        return { kind: 'preset', id: value.slice(AVATAR_PRESET_PREFIX.length) };
    }
    if (/[\\/]/.test(value) || value.startsWith('~') || IMAGE_EXT.test(value)) {
        return { kind: 'path', path: value };
    }
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const text = Array.from(segmenter.segment(value), (s) => s.segment)
        .slice(0, MAX_AVATAR_CHARS)
        .join('');
    return { kind: 'text', text };
}

/** The MIME type of an avatar image file, by its extension; undefined for other files. */
export function avatarImageMime(path: string): string | undefined {
    const ext = IMAGE_EXT.exec(path)?.[1].toLowerCase();
    switch (ext) {
        case undefined:
            return undefined;
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'svg':
            return 'image/svg+xml';
        case 'ico':
            return 'image/x-icon';
        default:
            return `image/${ext}`;
    }
}
