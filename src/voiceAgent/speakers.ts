import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AVATAR_PRESETS, ICON_PRESETS, avatarPresetSrc, avatarPresetThinking } from '../shared/avatarPresets';
import {
    avatarImageMime,
    parseAvatarSetting,
    speakerName,
    type VoiceAvatar,
    type VoiceSpeakerId,
    type VoiceSpeakers,
} from '../shared/voiceSpeakers';

/** Larger pictures are refused: the Bot view scales them down to the avatar's size anyway. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const SECTION = 'oh-my-pi-chater.voiceAgent';
const NAME_KEY: Record<VoiceSpeakerId, string> = { user: 'userName', bot: 'botName' };
const AVATAR_KEY: Record<VoiceSpeakerId, string> = { user: 'userAvatar', bot: 'botAvatar' };

/** Whether a configuration change touches a name or avatar. */
export function affectsSpeakers(e: vscode.ConfigurationChangeEvent): boolean {
    return (['user', 'bot'] as const).some(
        (id) => e.affectsConfiguration(`${SECTION}.${NAME_KEY[id]}`) || e.affectsConfiguration(`${SECTION}.${AVATAR_KEY[id]}`),
    );
}

/** The names as set (the defaults when empty); read at every turn, so a change applies at once. */
export function speakerNames(): Record<VoiceSpeakerId, string> {
    const config = vscode.workspace.getConfiguration(SECTION);
    return { user: speakerName('user', config.get(NAME_KEY.user)), bot: speakerName('bot', config.get(NAME_KEY.bot)) };
}

export interface ResolvedSpeakers {
    speakers: VoiceSpeakers;
    /** Why an avatar setting shows the default icon instead (a picture that could not be read). */
    errors: Partial<Record<VoiceSpeakerId, string>>;
}

/** The names and avatars as the views show them, image files read into data URIs. */
export async function resolveSpeakers(): Promise<ResolvedSpeakers> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const names = speakerNames();
    const errors: ResolvedSpeakers['errors'] = {};
    const speakers = {} as VoiceSpeakers;
    await Promise.all(
        (['user', 'bot'] as const).map(async (id) => {
            let avatar: VoiceAvatar | undefined;
            try {
                avatar = await resolveAvatar(config.get(AVATAR_KEY[id]));
            } catch (err) {
                errors[id] = err instanceof Error ? err.message : String(err);
            }
            speakers[id] = { name: names[id], avatar };
        }),
    );
    return { speakers, errors };
}

async function resolveAvatar(raw: unknown): Promise<VoiceAvatar | undefined> {
    const setting = parseAvatarSetting(raw);
    if (setting.kind === 'none') {
        return undefined;
    }
    if (setting.kind === 'text') {
        return { kind: 'text', text: setting.text };
    }
    if (setting.kind === 'preset') {
        const icon = ICON_PRESETS.find((p) => p.id === setting.id);
        if (icon) {
            return { kind: 'icon', icon: icon.icon };
        }
        const src = avatarPresetSrc(setting.id);
        if (!src) {
            const ids = [...ICON_PRESETS, ...AVATAR_PRESETS].map((p) => p.id).join(', ');
            throw new Error(`There is no avatar preset "${setting.id}": pick one of ${ids}.`);
        }
        return { kind: 'image', src, think: avatarPresetThinking(setting.id) };
    }
    const file = avatarPath(setting.path);
    const mime = avatarImageMime(file);
    if (!mime) {
        throw new Error(`${setting.path} is not a picture: use a PNG, JPEG, GIF, WebP or SVG file.`);
    }
    let size: number;
    try {
        size = (await fs.stat(file)).size;
    } catch {
        throw new Error(`Can't find ${setting.path}.`);
    }
    if (size > MAX_AVATAR_BYTES) {
        throw new Error(`${setting.path} is too large (${(size / 1024 / 1024).toFixed(1)} MB): pick a picture under 2 MB.`);
    }
    const data = await fs.readFile(file);
    return { kind: 'image', src: `data:${mime};base64,${data.toString('base64')}` };
}

/** `~` is the home folder; a relative path is from the first workspace folder. */
function avatarPath(raw: string): string {
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
        return path.join(os.homedir(), raw.slice(1));
    }
    if (path.isAbsolute(raw)) {
        return raw;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, raw) : path.resolve(raw);
}

/** "Choose picture…" on the settings page: saves the picked file as the avatar. */
export async function pickAvatar(id: VoiceSpeakerId): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Use as avatar',
        title: id === 'user' ? 'Your avatar' : "The voice agent's avatar",
        filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'] },
    });
    const file = picked?.[0];
    if (file) {
        await vscode.workspace.getConfiguration(SECTION).update(AVATAR_KEY[id], file.fsPath, vscode.ConfigurationTarget.Global);
    }
}
