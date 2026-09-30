/**
 * Pixel-art avatars to pick instead of a picture (`voiceAgent.userAvatar` / `botAvatar` set to
 * `preset:<id>`). Each is a 16×16 map, one character per pixel (`.` transparent) with its palette,
 * drawn as an SVG at 64 px (the Bot view's 32 px avatar at 2x), so pixels stay square and sharp.
 * The background is left transparent: the avatar box's tint shows through, as behind the icons.
 * Each has its own thinking animation (`think`), played while the voice agent thinks
 * (src/webview/avatarMotion.ts): the boy scratches his head, the woman looks up at a thought
 * bubble filling with dots, the uncle holds a steaming mug of coffee, the otaku's glasses glare
 * white and spirals spin in them, the cat dozes off, the gentleman raises an eyebrow, his monocle
 * glints and his moustache twitches.
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
    /** Thinking: frames, each the rows that differ from `rows`, and the order they play in as [frame, ms], looping. */
    think: {
        frames: ReadonlyArray<Readonly<Record<number, string>>>;
        play: ReadonlyArray<readonly [frame: number, ms: number]>;
    };
}

/** A preset's thinking animation as the webview plays it: frames as data URIs, and the order they play in as [frame, ms], looping. */
export interface AvatarThinking {
    frames: string[];
    play: Array<[frame: number, ms: number]>;
}

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
        think: {
            frames: [
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
            play: [[0, 280], [1, 280], [2, 280]],
        },
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
        think: {
            frames: [
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
            play: [[0, 130], [1, 130], [0, 130], [1, 130], [0, 130], [1, 130], [0, 130], [1, 130], [0, 700]],
        },
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
        think: {
            frames: [
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
            play: [[0, 500], [1, 500], [2, 600], [3, 500]],
        },
    },
    {
        id: 'otaku',
        label: 'Otaku with thick glasses',
        palette: { ...INK, h: '#26262e', s: '#f3dcc8', g: '#15151a', l: '#cfe4f5', m: '#7a4a40', c: '#7d8791', C: '#5f6870', W: '#ffffff', q: '#4f6fb0' },
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
        // The lenses glare white, then a spiral turns in each, a quarter turn a frame.
        think: {
            frames: [
                {
                    6: '.gWWWWggggWWWWg.',
                    7: '.gWWWWgssgWWWWg.',
                    8: '.gWWWWgssgWWWWg.',
                    9: '.gWWWWgssgWWWWg.',
                },
                {
                    6: '.gqqqqggggqqqqg.',
                    7: '.gWWWqgssgWWWqg.',
                    8: '.gWqWqgssgWqWqg.',
                    9: '.gWqqqgssgWqqqg.',
                },
                {
                    6: '.gWWWqggggWWWqg.',
                    7: '.gqqWqgssgqqWqg.',
                    8: '.gqWWqgssgqWWqg.',
                    9: '.gqqqqgssgqqqqg.',
                },
                {
                    6: '.gqqqWggggqqqWg.',
                    7: '.gqWqWgssgqWqWg.',
                    8: '.gqWWWgssgqWWWg.',
                    9: '.gqqqqgssgqqqqg.',
                },
                {
                    6: '.gqqqqggggqqqqg.',
                    7: '.gqWWqgssgqWWqg.',
                    8: '.gqWqqgssgqWqqg.',
                    9: '.gqWWWgssgqWWWg.',
                },
            ],
            play: [
                [0, 200],
                ...[1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4].map((frame) => [frame, 110] as const),
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
        think: {
            frames: [
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
            play: [[0, 400], [1, 350], [2, 350], [3, 900]],
        },
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
        // One eyebrow raised, a glint runs round the monocle, then the moustache twitches: "hmm, indeed".
        think: {
            frames: [
                { 5: '..kGsssssMMsGk..', 6: '..kGsMMsssssGk..' },
                { 5: '..kGsssssMMsGk..', 6: '..kGsMMsssssGk..', 7: '.kSssssssWossSk.' },
                { 5: '..kGsssssMMsGk..', 6: '..kGsMMsssssGk..', 7: '.kSssssssoWssSk.' },
                { 5: '..kGsssssMMsGk..', 6: '..kGsMMsssssGk..', 8: '.kSsswesoweWsSk.' },
                { 5: '..kGsssssMMsGk..', 6: '..kGsMMsssssGk..', 9: '..kssssSsoossk..', 10: '..kMMMMMMMMMMk..' },
            ],
            play: [[0, 500], [1, 90], [2, 90], [3, 90], [0, 400], [4, 160], [0, 160], [4, 160], [0, 500]],
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

/** A preset's thinking animation; undefined for an unknown id. */
export function avatarPresetThinking(id: string): AvatarThinking | undefined {
    const avatar = PIXEL_AVATARS.find((a) => a.id === id);
    if (!avatar) {
        return undefined;
    }
    return {
        frames: avatar.think.frames.map((changed) => pixelSrc(avatar.palette, avatar.rows.map((row, y) => changed[y] ?? row))),
        play: avatar.think.play.map(([frame, ms]) => [frame, ms]),
    };
}
