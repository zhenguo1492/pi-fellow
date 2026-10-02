/**
 * Avatar markup for the user and the voice agent (`VoiceAvatar`), shared by the Bot view and the
 * settings page. Pictures are scaled down to a small square first: the setting's data URI can be
 * megabytes, and the Bot view repeats the avatar on every turn.
 */
import type { AvatarAnimations } from '../shared/avatarPresets';
import { escapeHtml } from '../shared/html';
import type { VoiceAvatar, VoiceSpeakerId } from '../shared/voiceSpeakers';

/**
 * The robot: the voice agent's line icon (`preset:robot`), and the button that starts voice mode. Its face
 * holds a screen of log lines (`.av-screen`, hidden by its `visibility` attribute) that replaces the
 * eyes (`.av-eyes`) and scrolls while the voice agent thinks (styles/chat/voiceBar.css); the lines
 * repeat every 8 units, one tile past the screen, so the scroll wraps seamlessly.
 */
export const ICON_ROBOT =
    '<svg class="av-robot" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="5" width="11" height="8.5" rx="2.5"/><path d="M8 5V2.75"/><circle cx="8" cy="2.25" r=".75" fill="currentColor" stroke="none"/><g class="av-eyes" fill="currentColor" stroke="none"><circle cx="5.75" cy="9" r="1"/><circle cx="10.25" cy="9" r="1"/></g><svg class="av-screen" x="4" y="6.5" width="8" height="5.5" viewBox="0 0 8 5.5" visibility="hidden"><g class="av-log" fill="currentColor" stroke="none"><rect y=".5" width="7" height="1" rx=".5"/><rect y="2.5" width="4" height="1" rx=".5"/><rect y="4.5" width="5.5" height="1" rx=".5"/><rect y="6.5" width="3" height="1" rx=".5"/><rect y="8.5" width="7" height="1" rx=".5"/><rect y="10.5" width="4" height="1" rx=".5"/><rect y="12.5" width="5.5" height="1" rx=".5"/></g></svg><path d="M1 8.25v2M15 8.25v2"/></svg>';

/** Shown until the avatars arrive, and when an avatar setting can't be resolved or its picture does not load. */
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
 * Animations of the pictures drawn (pixel-art presets), frames scaled as the picture is, by the
 * picture's `src`: kept here rather than in the markup, which the Bot view repeats on every turn.
 */
const animations = new Map<string, AvatarAnimations>();

/** The thinking and talking animations of a picture from {@link avatarMarkup} (`img[data-animated]`), by its resting `src`. */
export function avatarAnimations(src: string): AvatarAnimations | undefined {
    return animations.get(src);
}

/**
 * The inside of an avatar box: the picture, the text, one of the line icons, or `fallback` (the
 * speaker's own line icon) when there is no avatar or the picture does not load. A picture with
 * animations is marked `data-animated`; their frames are decoded ahead, so swapping to one never
 * flickers.
 */
export async function avatarMarkup(avatar: VoiceAvatar | undefined, fallback: string): Promise<string> {
    if (avatar?.kind === 'icon') {
        return DEFAULT_AVATAR[avatar.icon];
    }
    if (avatar?.kind === 'text') {
        return `<span class="av-text">${escapeHtml(avatar.text)}</span>`;
    }
    if (avatar?.kind === 'image') {
        const kinds = (['think', 'talk'] as const).filter((kind) => avatar[kind]);
        const [src, ...frames] = await Promise.all([avatar.src, ...kinds.flatMap((kind) => avatar[kind]!.frames)].map(shrink));
        if (!src) {
            return fallback;
        }
        if (kinds.length > 0 && frames.every((frame): frame is string => frame !== undefined)) {
            await Promise.all(
                frames.map((frame) => {
                    const img = new Image();
                    img.src = frame;
                    return img.decode().catch(() => undefined);
                }),
            );
            const scaled: AvatarAnimations = {};
            let at = 0;
            for (const kind of kinds) {
                const { frames: own, tracks } = avatar[kind]!;
                scaled[kind] = { frames: frames.slice(at, (at += own.length)), tracks };
            }
            animations.set(src, scaled);
            return `<img class="av-img" src="${src}" data-animated alt="">`;
        }
        return `<img class="av-img" src="${src}" alt="">`;
    }
    return fallback;
}
