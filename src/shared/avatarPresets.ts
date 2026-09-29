/**
 * Pixel-art avatars to pick instead of a picture (`voiceAgent.userAvatar` / `botAvatar` set to
 * `preset:<id>`). Each is a 16×16 map, one character per pixel (`.` transparent) with its palette,
 * drawn as an SVG at 64 px (the Bot view's 32 px avatar at 2x), so pixels stay square and sharp.
 * The background is left transparent: the avatar box's tint shows through, as behind the icons.
 * `mouth` holds the talking frames, half and wide open (the rows that differ), shown while the
 * voice agent's reply plays (src/webview/avatarMotion.ts).
 */
import type { VoiceSpeakerId } from './voiceSpeakers';

export const AVATAR_PRESET_PREFIX = 'preset:';

/**
 * The default line icons, also offered as presets (`preset:user`, `preset:robot`), so the voice
 * agent can have the person or you the robot. Drawn in the avatar box's colour, not as pictures.
 */
export const ICON_PRESETS: ReadonlyArray<{ id: string; label: string; icon: VoiceSpeakerId }> = [
    { id: 'user', label: 'Person (your default)', icon: 'user' },
    { id: 'robot', label: "Robot (the voice agent's default)", icon: 'bot' },
];

interface PixelAvatar {
    id: string;
    label: string;
    palette: Record<string, string>;
    rows: readonly string[];
    /** The talking frames, half then wide open: row index to its replacement. */
    mouth: readonly [Readonly<Record<number, string>>, Readonly<Record<number, string>>];
}

/** Outline, eye whites and pupils, and an open mouth (red inside, pink tongue): the same in all of them. */
const INK = { k: '#2b1e18', w: '#ffffff', e: '#2b1e18', x: '#a3222e', u: '#f08a93' };

const PIXEL_AVATARS: readonly PixelAvatar[] = [
    {
        id: 'uncle',
        label: 'Bearded uncle with glasses',
        palette: { ...INK, h: '#5a4636', G: '#9a948e', B: '#4a3829', s: '#efbf98', S: '#d49c77', g: '#2e2420', l: '#cfe6f3', b: '#6b5140', m: '#8c4a3c', c: '#4d6a8c', C: '#3c5470' },
        rows: [
            '................',
            '....kkkkkkkk....',
            '...khhhhhhhhk...',
            '..khhhhhhhhhhk..',
            '..kGssssssssGk..',
            '..kGBBssssBBGk..',
            '..ksggggggggsk..',
            '.kSslelsslelsSk.',
            '.kSslllsslllsSk.',
            '..kssssSSssssk..',
            '..kbsBBBBBBsbk..',
            '..kbbbsmmsbbbk..',
            '...kbbbbbbbbk...',
            '....kkbbbbkk....',
            '..kcccCssCccck..',
            '.kccccCssCcccck.',
        ],
        mouth: [
            { 11: '..kbbmxxxxmbbk..' },
            { 11: '..kbbmxxxxmbbk..', 12: '...kbmxuuxmbk...', 13: '....kkbmmbkk....' },
        ],
    },
    {
        id: 'boy',
        label: 'Little boy',
        palette: { ...INK, h: '#7a4a26', s: '#f7cfa8', S: '#e6b48e', r: '#f29a8a', m: '#9c3f33', c: '#e0493b' },
        rows: [
            '................',
            '.....kkkkkk.....',
            '...kkhhhhhhkk...',
            '..khhhhhhhhhhk..',
            '..khhhhhhhhhhk..',
            '..khhshhhhshhk..',
            '..khsssssssshk..',
            '.kSswesssswesSk.',
            '.kSseesssseesSk.',
            '..krrssssssrrk..',
            '..ksssmssmsssk..',
            '..kssssmmssssk..',
            '...kssssssssk...',
            '....kkkkkkkk....',
            '..kccccsscccck..',
            '.kcccccccccccck.',
        ],
        mouth: [
            { 10: '..kssmmmmmmssk..', 11: '..kssmxxxxmssk..', 12: '...kssmmmmssk...' },
            { 10: '..kssmmmmmmssk..', 11: '..kssmxxxxmssk..', 12: '...ksmxuuxmsk...' },
        ],
    },
    {
        id: 'cat',
        label: 'Lazy orange cat',
        palette: { ...INK, o: '#f2992e', O: '#c96a14', p: '#f4a6a0', c: '#fbe3b8', n: '#e8707a' },
        rows: [
            '................',
            '..k..........k..',
            '..kk........kk..',
            '..kpkkkkkkkkpk..',
            '..koooOooOoook..',
            '.koooooOOoooook.',
            '.kokkkkookkkkok.',
            '.koweewooweewok.',
            '.kokwwkookwwkok.',
            '.kookkooookkook.',
            '.koooccnnccoook.',
            '.kOoccckkcccoOk.',
            '.kOocckcckccoOk.',
            '..kooccccccook..',
            '...kkkkkkkkkk...',
            '................',
        ],
        mouth: [
            { 12: '.kOocckxxkccoOk.', 13: '..koocckkccook..' },
            { 12: '.kOockxxxxkcoOk.', 13: '..koockuukcook..' },
        ],
    },
    {
        id: 'otaku',
        label: 'Otaku with thick glasses',
        palette: { ...INK, h: '#26262e', s: '#f3dcc8', g: '#15151a', l: '#cfe4f5', m: '#7a4a40', c: '#7d8791', C: '#5f6870' },
        rows: [
            '.....k..k.......',
            '...kkhkkhkkk....',
            '..khhhhhhhhhk...',
            '..khhhhhhhhhhk..',
            '..khhhhhhhhhhk..',
            '.gggggghhgggggg.',
            '.gwlllggggwlllg.',
            '.glwllgssglwllg.',
            '.gllelgssgllelg.',
            '.glllwgssglllwg.',
            '.ggggggssgggggg.',
            '..kssssssssssk..',
            '..kssssmmssssk..',
            '...kssssssssk...',
            '..kcckkkkkkcck..',
            '.kcccccCCccccck.',
        ],
        mouth: [
            { 12: '..kssmxxxxmssk..', 13: '...kssmmmmssk...' },
            { 12: '..kssmxxxxmssk..', 13: '...ksmxuuxmsk...' },
        ],
    },
    {
        id: 'woman',
        label: 'Woman with long hair',
        palette: { ...INK, h: '#5b2c1f', H: '#7b3e2a', s: '#f8d5bd', r: '#f3a3a0', l: '#d23a4e', c: '#b23a6a' },
        rows: [
            '................',
            '.....kkkkkk.....',
            '...kkhhhhhhkk...',
            '..khhhhhhhhhhk..',
            '.khhhhhhhhHhhhk.',
            '.khhhhhhhsssshk.',
            '.khhhssssssshhk.',
            '.khhskksskkshhk.',
            '.khhseesseeshhk.',
            '.khhrssssssrhhk.',
            '.khhssllllsshhk.',
            '.khhhsssssshhhk.',
            '.khhhhhsshhhhhk.',
            '.khhhhsssshhhhk.',
            '.khhcccccccchhk.',
            'khhcccccccccchhk',
        ],
        mouth: [
            { 10: '.khhsslxxlsshhk.', 11: '.khhhsllllshhhk.' },
            { 10: '.khhslxxxxlshhk.', 11: '.khhhlxuuxlhhhk.', 12: '.khhhhsllshhhhk.' },
        ],
    },
    {
        id: 'gentleman',
        label: 'Old English gentleman',
        palette: { ...INK, t: '#23232b', T: '#7a2433', G: '#5e5852', M: '#4d4741', s: '#efc4a2', S: '#d6a582', o: '#d4a52a', m: '#9c5a4c', j: '#5c5a3e', W: '#f4f1ea', r: '#c0283f', R: '#6e1424' },
        rows: [
            '....kkkkkkkk....',
            '....kttttttk....',
            '....kttttttk....',
            '....kTTTTTTk....',
            '..kttttttttttk..',
            '..kGssssssssGk..',
            '..kGsMMssMMsGk..',
            '.kSssssssoossSk.',
            '.kSsswesoweosSk.',
            '..kMsssSsoosMk..',
            '..ksMMMMMMMMsk..',
            '..kssssmmssssk..',
            '...kssssssssk...',
            '...krrWWWWrrk...',
            '..kjrrrRRrrrjk..',
            '.kjjrrWWWWrrjjk.',
        ],
        mouth: [
            { 11: '..kssmxxxxmssk..', 12: '...kssmmmmssk...' },
            { 11: '..kssmxxxxmssk..', 12: '...ksmxuuxmsk...' },
        ],
    },
];

/** The presets as the settings page offers them. */
export const AVATAR_PRESETS: ReadonlyArray<{ id: string; label: string }> = PIXEL_AVATARS.map(({ id, label }) => ({ id, label }));

/** An SVG data URI, one rect per run of same-coloured pixels in a row. */
function pixelSrc(palette: PixelAvatar['palette'], rows: readonly string[]): string {
    let rects = '';
    rows.forEach((row, y) => {
        for (let x = 0; x < row.length; ) {
            const pixel = row[x];
            let run = 1;
            while (row[x + run] === pixel) {
                run++;
            }
            if (pixel !== '.') {
                rects += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${palette[pixel]}"/>`;
            }
            x += run;
        }
    });
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="64" height="64" shape-rendering="crispEdges">${rects}</svg>`)}`;
}

/** A preset as a data URI (an `<img>` source); undefined for an unknown id. */
export function avatarPresetSrc(id: string): string | undefined {
    const avatar = PIXEL_AVATARS.find((a) => a.id === id);
    return avatar && pixelSrc(avatar.palette, avatar.rows);
}

/** A preset's talking frames, half then wide open, as data URIs; undefined for an unknown id. */
export function avatarPresetMouthSrcs(id: string): string[] | undefined {
    const avatar = PIXEL_AVATARS.find((a) => a.id === id);
    return avatar?.mouth.map((open) => pixelSrc(avatar.palette, avatar.rows.map((row, y) => open[y] ?? row)));
}
