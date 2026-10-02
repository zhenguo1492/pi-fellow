/**
 * Pixel-art avatars to pick instead of a picture (`voiceAgent.userAvatar` / `botAvatar` set to
 * `preset:<id>`; empty: the otaku for you, the gentleman for the voice agent). Each is a 16×16 map,
 * one character per pixel (`.` transparent) with its palette, drawn as an SVG at 64 px (the Bot
 * view's 32 px avatar at 2x), so pixels stay square and sharp. The background is left transparent:
 * the avatar box's tint shows through, as behind the icons.
 *
 * Each has its own thinking animation (`think`), played while the voice agent thinks
 * (src/webview/avatarMotion.ts): the boy scratches his head, the woman looks up at a thought
 * bubble filling with dots, the uncle holds a steaming mug of coffee, the otaku's pupils circle in
 * his lenses, the cat dozes off, the gentleman's eyebrows go up and down on their own while his
 * eyes look left and right, his monocle glints and his moustache tips flatten for a moment.
 * Some also talk (`talk`), played while the voice plays: the mouth closed, half or wide open with
 * the voice's level; the gentleman's left moustache tip lies flat and now and then, for one
 * syllable, he raises one brow (the right or the left, never both); the otaku glances left and right.
 *
 * An animation is made of tracks, parts that change on their own (brows, eyes, mouth): each has
 * states, the rows that differ from the resting map, and what picks the state shown (`pick`). A
 * frame is drawn for every combination of the tracks' states, each track changing the pixels where
 * its rows differ from the resting map (a later track wins on a pixel both change).
 */
import type { VoiceSpeakerId } from './voiceSpeakers';

export const AVATAR_PRESET_PREFIX = 'preset:';

/** The preset an empty avatar setting shows: the otaku for you, the gentleman for the voice agent. */
export const DEFAULT_AVATAR_PRESETS: Readonly<Record<VoiceSpeakerId, string>> = { user: 'otaku', bot: 'gentleman' };

/**
 * The line icons, also offered as presets (`preset:user`, `preset:robot`), so either speaker can
 * have the person or the robot. Drawn in the avatar box's colour, not as pictures.
 */
export const ICON_PRESETS: ReadonlyArray<{ id: string; label: string; icon: VoiceSpeakerId }> = [
    { id: 'user', label: 'Person', icon: 'user' },
    { id: 'robot', label: 'Robot', icon: 'bot' },
];

/** Rows that differ from the resting map, by row index. */
type Rows = Readonly<Record<number, string>>;

/** What picks a track's state; plain data, as it goes to the webview with the frames. */
export type AvatarTrackPick =
    /** A fixed list of [state, ms], looping from the animation's start. */
    | { kind: 'loop'; play: Array<[state: number, ms: number]> }
    /** Another state at random, each held for a random time between `hold`'s two ms. */
    | { kind: 'random'; hold: [min: number, max: number] }
    /** Talking: how many of `steps` the voice's level (`--talk`, 0..1) reaches, closed, half or open for a mouth. */
    | { kind: 'level'; steps: number[] }
    /** Talking: state 0 while the `level` track is at 0; each time it leaves 0 (a syllable), state i + 1 picked with weight `weights[i]`. */
    | { kind: 'syllable'; weights: number[] };

/** An animation as defined here: rows changed all along it, and its tracks. */
interface Animation {
    rows?: Rows;
    tracks: ReadonlyArray<{ states: readonly Rows[]; pick: AvatarTrackPick }>;
}

interface PixelAvatar {
    id: string;
    label: string;
    palette: Record<string, string>;
    rows: readonly string[];
    think: Animation;
    talk?: Animation;
}

/**
 * An animation as the webview plays it: a frame (data URI) for every combination of its tracks'
 * states, at {@link frameIndex}, and each track's number of states and what picks it.
 */
export interface AvatarAnimation {
    frames: string[];
    tracks: Array<{ states: number; pick: AvatarTrackPick }>;
}

/** A preset's animations: thinking, and talking for those that talk. */
export interface AvatarAnimations {
    think?: AvatarAnimation;
    talk?: AvatarAnimation;
}

/** The frame of a combination of track states: the first track's state is the most significant digit. */
export function frameIndex(tracks: ReadonlyArray<{ states: number }>, states: readonly number[]): number {
    return tracks.reduce((index, track, i) => index * track.states + (states[i] ?? 0), 0);
}

/** An animation of a single track that plays `frames` in the fixed order `play`, looping. */
function loop(frames: readonly Rows[], play: Array<[frame: number, ms: number]>): Animation {
    return { tracks: [{ states: frames, pick: { kind: 'loop', play } }] };
}

/** The level steps of a talking mouth: closed below the first, half open below the second, open above. */
const MOUTH_STEPS = [0.25, 0.6];

/** Outline, eye whites and pupils: the same in all of them. */
const INK = { k: '#2b1e18', w: '#ffffff', e: '#2b1e18' };

const PIXEL_AVATARS: readonly PixelAvatar[] = [
    {
        id: 'uncle',
        label: 'Bearded uncle with glasses',
        palette: { ...INK, h: '#5a4636', G: '#9a948e', B: '#4a3829', s: '#efbf98', S: '#d49c77', g: '#2e2420', l: '#cfe6f3', b: '#6b5140', m: '#8c4a3c', c: '#4d6a8c', C: '#3c5470', W: '#f4f1ea', D: '#3a2214', R: '#d0433a', Q: '#8e2a22', z: '#d5d8dc' },
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
        // A red mug of coffee in his hand, steam curling up beside his face.
        think: loop(
            [
                {
                    1: '....kkkkkkkk..z.',
                    2: '...khhhhhhhhk.z.',
                    4: '..kGssssssssGk.z',
                    5: '..kGBBssssBBGkz.',
                    7: '.kSslelsslelszk.',
                    8: '.kSslllsslllzSk.',
                    9: '..kssssSSsWDDW..',
                    10: '..kbsBBBBBRRRRRR',
                    11: '..kbbbsmmsRRRR.R',
                    12: '...kbbbbbsRRRRRR',
                    13: '....kkbbbsRRRR..',
                    14: '..kcccCssCQQQQ..',
                },
                {
                    0: '...............z',
                    1: '....kkkkkkkk..z.',
                    3: '..khhhhhhhhhhk.z',
                    4: '..kGssssssssGk.z',
                    6: '..ksggggggggskz.',
                    7: '.kSslelsslelszk.',
                    9: '..kssssSSsWDDW..',
                    10: '..kbsBBBBBRRRRRR',
                    11: '..kbbbsmmsRRRR.R',
                    12: '...kbbbbbsRRRRRR',
                    13: '....kkbbbsRRRR..',
                    14: '..kcccCssCQQQQ..',
                },
                {
                    0: '...............z',
                    2: '...khhhhhhhhk.z.',
                    3: '..khhhhhhhhhhk.z',
                    5: '..kGBBssssBBGkz.',
                    6: '..ksggggggggskz.',
                    8: '.kSslllsslllzSk.',
                    9: '..kssssSSsWDDW..',
                    10: '..kbsBBBBBRRRRRR',
                    11: '..kbbbsmmsRRRR.R',
                    12: '...kbbbbbsRRRRRR',
                    13: '....kkbbbsRRRR..',
                    14: '..kcccCssCQQQQ..',
                },
            ],
            [[0, 280], [1, 280], [2, 280]],
        ),
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
        // Mouth pursed, he scratches the top of his head (hand up and down, a tuft of hair flicking), then stops to think.
        think: loop(
            [
                {
                    0: '.........k.k.k..',
                    1: '.....kkkkskskk..',
                    2: '...kkhhhksssssk.',
                    3: '..khhhhhhkssssk.',
                    4: '..khhhhhhhhksssk',
                    5: '..khhshhhhshkssk',
                    6: '..khsssssssshksk',
                    7: '.kSswesssswesSck',
                    8: '.kSseesssseesSck',
                    9: '..krrssssssrrkck',
                    10: '..ksssssssssskck',
                    11: '..ksssssmmssskck',
                    12: '...kssssssssk.ck',
                    13: '....kkkkkkkk..ck',
                    14: '..kccccsscccccck',
                    15: '.kccccccccccccck',
                },
                {
                    0: '.....h.h........',
                    1: '.....kkkkkkk.k..',
                    2: '...kkhhhkskskk..',
                    3: '..khhhhhksssssk.',
                    4: '..khhhhhhkssssk.',
                    5: '..khhshhhhsksssk',
                    6: '..khsssssssskssk',
                    7: '.kSswesssswesksk',
                    8: '.kSseesssseesSck',
                    9: '..krrssssssrrkck',
                    10: '..ksssssssssskck',
                    11: '..ksssssmmssskck',
                    12: '...kssssssssk.ck',
                    13: '....kkkkkkkk..ck',
                    14: '..kccccsscccccck',
                    15: '.kccccccccccccck',
                },
            ],
            [[0, 130], [1, 130], [0, 130], [1, 130], [0, 130], [1, 130], [0, 130], [1, 130], [0, 700]],
        ),
    },
    {
        id: 'cat',
        label: 'Lazy orange cat',
        palette: { ...INK, o: '#f2992e', O: '#c96a14', p: '#f4a6a0', c: '#fbe3b8', n: '#e8707a', z: '#ffffff' },
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
        // Dozes off: eyes shut, a small z and then a big Z rising between the ears as the head nods down.
        think: loop(
            [
                {
                    6: '.kooooooooooook.',
                    7: '.kooooooooooook.',
                    8: '.kokkkkookkkkok.',
                    9: '.kooooooooooook.',
                },
                {
                    0: '.........zzz....',
                    1: '..k.......z..k..',
                    2: '..kk.....zzzkk..',
                    6: '.kooooooooooook.',
                    7: '.kooooooooooook.',
                    8: '.kokkkkookkkkok.',
                    9: '.kooooooooooook.',
                },
                {
                    0: '......zzzz......',
                    1: '........zz......',
                    2: '..k...zz.....k..',
                    3: '..kk..zzzz..kk..',
                    4: '..kpkkkkkkkkpk..',
                    5: '..koooOooOoook..',
                    6: '.koooooOOoooook.',
                    7: '.kooooooooooook.',
                    8: '.kooooooooooook.',
                    9: '.kokkkkookkkkok.',
                    10: '.kooooooooooook.',
                    11: '.koooccnnccoook.',
                    12: '.kOoccckkcccoOk.',
                    13: '.kOocckcckccoOk.',
                    14: '..kooccccccook..',
                    15: '...kkkkkkkkkk...',
                },
                {
                    1: '................',
                    2: '..k..........k..',
                    3: '..kk........kk..',
                    4: '..kpkkkkkkkkpk..',
                    5: '..koooOooOoook..',
                    6: '.koooooOOoooook.',
                    7: '.kooooooooooook.',
                    8: '.kooooooooooook.',
                    9: '.kokkkkookkkkok.',
                    10: '.kooooooooooook.',
                    11: '.koooccnnccoook.',
                    12: '.kOoccckkcccoOk.',
                    13: '.kOocckcckccoOk.',
                    14: '..kooccccccook..',
                    15: '...kkkkkkkkkk...',
                },
            ],
            [[0, 500], [1, 500], [2, 600], [3, 500]],
        ),
    },
    {
        id: 'otaku',
        label: 'Otaku with thick glasses (your default)',
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
        // The glare leaves the lenses and the pupils circle in a small ring in the middle of each, a step every 150 ms.
        think: loop(
            [
                { 6: '.gllllggggllllg.', 7: '.glellgssglellg.', 8: '.gllllgssgllllg.', 9: '.gllllgssgllllg.' },
                { 6: '.gllllggggllllg.', 7: '.gllelgssgllelg.', 8: '.gllllgssgllllg.', 9: '.gllllgssgllllg.' },
                { 6: '.gllllggggllllg.', 7: '.gllllgssgllllg.', 8: '.gllelgssgllelg.', 9: '.gllllgssgllllg.' },
                { 6: '.gllllggggllllg.', 7: '.gllllgssgllllg.', 8: '.glellgssglellg.', 9: '.gllllgssgllllg.' },
            ],
            [[0, 150], [1, 150], [2, 150], [3, 150]],
        ),
        // The mouth follows the voice; the eyes glance left and back now and then.
        talk: {
            tracks: [
                {
                    states: [{}, { 12: '..ksssskkssssk..' }, { 12: '..ksssmkkmsssk..', 13: '...ksssmmsssk...' }],
                    pick: { kind: 'level', steps: MOUTH_STEPS },
                },
                { states: [{}, { 8: '.glellgssglellg.' }], pick: { kind: 'random', hold: [500, 1200] } },
            ],
        },
    },
    {
        id: 'woman',
        label: 'Woman with long hair',
        palette: { ...INK, h: '#5b2c1f', H: '#7b3e2a', s: '#f8d5bd', r: '#f3a3a0', l: '#d23a4e', c: '#b23a6a', W: '#ffffff' },
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
        // Eyes turned up to a thought bubble over her head, which fills with dots one by one.
        think: loop(
            [
                {
                    0: '..........WWWWW.',
                    1: '.....kkkkWWWWWWW',
                    2: '...kkhhhhhWWWWW.',
                    3: '..khhhhhWhhhhk..',
                    4: '.khhhhhWhhHhhhk.',
                    7: '.khhswksswkshhk.',
                    8: '.khhswwsswwshhk.',
                },
                {
                    0: '..........WWWWW.',
                    1: '.....kkkkWeWWWWW',
                    2: '...kkhhhhhWWWWW.',
                    3: '..khhhhhWhhhhk..',
                    4: '.khhhhhWhhHhhhk.',
                    7: '.khhswksswkshhk.',
                    8: '.khhswwsswwshhk.',
                },
                {
                    0: '..........WWWWW.',
                    1: '.....kkkkWeWeWWW',
                    2: '...kkhhhhhWWWWW.',
                    3: '..khhhhhWhhhhk..',
                    4: '.khhhhhWhhHhhhk.',
                    7: '.khhswksswkshhk.',
                    8: '.khhswwsswwshhk.',
                },
                {
                    0: '..........WWWWW.',
                    1: '.....kkkkWeWeWeW',
                    2: '...kkhhhhhWWWWW.',
                    3: '..khhhhhWhhhhk..',
                    4: '.khhhhhWhhHhhhk.',
                    7: '.khhswksswkshhk.',
                    8: '.khhswwsswwshhk.',
                },
            ],
            [[0, 400], [1, 350], [2, 350], [3, 900]],
        ),
    },
    {
        id: 'gentleman',
        label: "Old English gentleman (the voice agent's default)",
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
            '..ksMssSsooMsk..',
            '..ksMMMMMMMMsk..',
            '..kssssmmssssk..',
            '...kssssssssk...',
            '...krrWWWWrrk...',
            '..kjrrrRRrrrjk..',
            '.kjjrrWWWWrrjjk.',
        ],
        // "Hmm, indeed": each eyebrow goes up and down on its own, the eyes look left and right, a glint
        // runs round the monocle, then the moustache twitches, its tips flattening for a moment.
        think: {
            tracks: [
                { states: [{}, { 5: '..kGsMMsssssGk..', 6: '..kGsssssMMsGk..' }], pick: { kind: 'random', hold: [400, 2000] } },
                { states: [{}, { 5: '..kGsssssMMsGk..', 6: '..kGsMMsssssGk..' }], pick: { kind: 'random', hold: [400, 2000] } },
                { states: [{}, { 8: '.kSssewsoewosSk.' }], pick: { kind: 'random', hold: [650, 950] } },
                {
                    states: [{}, { 7: '.kSssssssWossSk.' }, { 7: '.kSssssssoWssSk.' }, { 8: '.kSsswesoweWsSk.' }, { 9: '..kssssSsoossk..' }],
                    pick: { kind: 'loop', play: [[0, 500], [1, 90], [2, 90], [3, 90], [0, 400], [4, 160], [0, 160], [4, 160], [0, 500]] },
                },
            ],
        },
        // The left moustache tip lies flat and the mouth follows the voice; now and then one brow, the
        // right or the left, goes up for a syllable and drops again when the mouth closes.
        talk: {
            rows: { 9: '..kssssSsooMsk..' },
            tracks: [
                {
                    states: [{}, { 11: '..ksssskkssssk..' }, { 11: '..ksssmkkmsssk..', 12: '...ksssmmsssk...' }],
                    pick: { kind: 'level', steps: MOUTH_STEPS },
                },
                {
                    // State 1 is the brows at rest: about one syllable in five raises one brow, the right or the left, just for that syllable.
                    states: [{}, {}, { 5: '..kGsssssMMsGk..', 6: '..kGsMMsssssGk..' }, { 5: '..kGsMMsssssGk..', 6: '..kGsssssMMsGk..' }],
                    pick: { kind: 'syllable', weights: [8, 1, 1] },
                },
            ],
        },
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

/** The resting rows with an animation's rows and each track's state (`states[i]`, 0 when left out) changed over them. */
function frameRows(avatar: PixelAvatar, animation: Animation | undefined, states: readonly number[]): string[] {
    const changes = animation ? [animation.rows ?? {}, ...animation.tracks.map((track, i) => track.states[states[i] ?? 0])] : [];
    return avatar.rows.map((row, y) => {
        const pixels = [...row];
        for (const changed of changes) {
            const to = changed[y];
            for (let x = 0; to !== undefined && x < row.length; x++) {
                if (to[x] !== row[x]) {
                    pixels[x] = to[x];
                }
            }
        }
        return pixels.join('');
    });
}

/**
 * A preset's pixel rows: at rest, or the frame of its `think` or `talk` animation with each track
 * in `states` (0 when left out); undefined for an unknown id or an animation it does not have.
 */
export function avatarPresetRows(id: string, animation?: 'think' | 'talk', states: readonly number[] = []): string[] | undefined {
    const avatar = PIXEL_AVATARS.find((a) => a.id === id);
    if (!avatar || (animation && !avatar[animation])) {
        return undefined;
    }
    return frameRows(avatar, animation && avatar[animation], states);
}

/** A preset's animations, a frame drawn for every combination of each one's track states; undefined for an unknown id. */
export function avatarPresetAnimations(id: string): AvatarAnimations | undefined {
    const avatar = PIXEL_AVATARS.find((a) => a.id === id);
    if (!avatar) {
        return undefined;
    }
    const draw = (animation: Animation): AvatarAnimation => {
        const tracks = animation.tracks.map(({ states, pick }) => ({ states: states.length, pick }));
        // In frameIndex order: the first track's state counts slowest.
        const combinations = tracks.reduce<number[][]>((all, { states }) => all.flatMap((c) => Array.from({ length: states }, (_, s) => [...c, s])), [[]]);
        return { frames: combinations.map((states) => pixelSrc(avatar.palette, frameRows(avatar, animation, states))), tracks };
    };
    return { think: draw(avatar.think), talk: avatar.talk && draw(avatar.talk) };
}
