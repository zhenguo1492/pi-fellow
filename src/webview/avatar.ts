/**
 * Avatar markup for the user and the voice agent (`VoiceAvatar`), shared by the Bot view and the
 * settings page. Pictures are scaled down to a small square first: the setting's data URI can be
 * megabytes, and the Bot view repeats the avatar on every turn.
 */
import { escapeHtml } from '../shared/html';
import type { VoiceAvatar, VoiceSpeakerId } from '../shared/voiceSpeakers';

/**
 * The robot: the voice agent's default avatar, and the button that starts voice mode. Its mouth
 * (`.av-mouth`) and antenna light (`.av-antenna`) move in the voice bar (avatarMotion.ts); the
 * mouth is hidden elsewhere.
 */
export const ICON_ROBOT =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="5" width="11" height="8.5" rx="2.5"/><path d="M8 5V2.75"/><circle class="av-antenna" cx="8" cy="2.25" r=".75" fill="currentColor" stroke="none"/><circle cx="5.75" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="10.25" cy="9" r="1" fill="currentColor" stroke="none"/><rect class="av-mouth" x="5.5" y="10.4" width="5" height="2.3" rx=".7" fill="currentColor" stroke="none" opacity="0"/><path d="M1 8.25v2M15 8.25v2"/></svg>';

/** Shown when no avatar is set, or its picture does not load. */
export const DEFAULT_AVATAR: Readonly<Record<VoiceSpeakerId, string>> = {
    user: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 14a5.25 5.25 0 0 1 10.5 0"/></svg>',
    bot: ICON_ROBOT,
};

/** Pixels per side of a scaled picture: the avatar is drawn at 32 CSS px, so this is sharp at 2x. */
const AVATAR_PX = 64;

/** A picture cropped to its centre square and scaled to `AVATAR_PX`, as a PNG data URI; undefined when it does not load. */
async function shrink(src: string): Promise<string | undefined> {
    const img = new Image();
    img.src = src;
    try {
        await img.decode();
    } catch {
        return undefined;
    }
    // An SVG without a size reports 0: draw it at the avatar's size.
    const w = img.naturalWidth || AVATAR_PX;
    const h = img.naturalHeight || AVATAR_PX;
    const side = Math.min(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_PX;
    canvas.height = AVATAR_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return undefined;
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
    return canvas.toDataURL('image/png');
}

/**
 * The inside of an avatar box: the picture, the text, one of the default icons, or `fallback` (the
 * speaker's own default icon) when there is no avatar or the picture does not load. A picture with
 * talking frames carries them in `data-mouth` (space-separated, half then wide open), decoded ahead
 * so swapping to them never flickers.
 */
export async function avatarMarkup(avatar: VoiceAvatar | undefined, fallback: string): Promise<string> {
    if (avatar?.kind === 'icon') {
        return DEFAULT_AVATAR[avatar.icon];
    }
    if (avatar?.kind === 'text') {
        return `<span class="av-text">${escapeHtml(avatar.text)}</span>`;
    }
    if (avatar?.kind === 'image') {
        const [src, ...shrunk] = await Promise.all([avatar.src, ...(avatar.mouthSrcs ?? [])].map(shrink));
        const mouth = shrunk.filter((frame) => frame !== undefined);
        // Loaded once in this document, a swap to a frame is synchronous.
        await Promise.all(
            mouth.map((frame) => {
                const img = new Image();
                img.src = frame;
                return img.decode().catch(() => undefined);
            }),
        );
        if (src) {
            return `<img class="av-img" src="${src}"${mouth.length ? ` data-mouth="${mouth.join(' ')}"` : ''} alt="">`;
        }
    }
    return fallback;
}
