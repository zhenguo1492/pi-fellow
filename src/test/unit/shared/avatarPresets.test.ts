import { describe, expect, it } from 'vitest';
import { AVATAR_PRESETS, avatarPresetAnimations, avatarPresetRows, frameIndex } from '../../../shared/avatarPresets';

/** Every combination of states for tracks of these sizes, in frameIndex order. */
function combinations(sizes: number[]): number[][] {
    return sizes.reduce<number[][]>((all, n) => all.flatMap((c) => Array.from({ length: n }, (_, s) => [...c, s])), [[]]);
}

describe('pixel avatar presets', () => {
    it('keeps every frame 16 rows of 16 pixels, each a palette colour, one frame per combination of track states', () => {
        for (const { id } of AVATAR_PRESETS) {
            const animations = avatarPresetAnimations(id)!;
            for (const kind of ['think', 'talk'] as const) {
                const animation = animations[kind];
                if (!animation) {
                    continue;
                }
                const all = combinations(animation.tracks.map((t) => t.states));
                expect(animation.frames, `${id} ${kind}`).toHaveLength(all.length);
                for (const states of all) {
                    const rows = avatarPresetRows(id, kind, states)!;
                    expect(rows, `${id} ${kind} ${states}`).toHaveLength(16);
                    expect(rows.filter((row) => row.length !== 16), `${id} ${kind} ${states}`).toEqual([]);
                    // A character missing from the palette is drawn with fill="undefined".
                    expect(decodeURIComponent(animation.frames[frameIndex(animation.tracks, states)])).not.toContain('undefined');
                }
            }
        }
    });
});

describe('gentleman', () => {
    const rest = avatarPresetRows('gentleman')!;
    // Think tracks: left brow, right brow, eyes, glint and twitch.
    const think = (left: number, right: number, eyes: number, glint: number) => avatarPresetRows('gentleman', 'think', [left, right, eyes, glint])!;
    // Talk tracks: mouth (closed, half, open), brows (rest, rest, right raised, left raised).
    const talk = (mouth: number, brows: number) => avatarPresetRows('gentleman', 'talk', [mouth, brows])!;

    it('rests with the moustache 8 wide and its tips curled up', () => {
        expect(rest[9]).toBe('..ksMssSsooMsk..');
        expect(rest[10]).toBe('..ksMMMMMMMMsk..');
    });

    it('moves each eyebrow on its own while thinking', () => {
        expect(think(1, 0, 0, 0).slice(5, 7)).toEqual(['..kGsMMsssssGk..', '..kGsssssMMsGk..']);
        expect(think(0, 1, 0, 0).slice(5, 7)).toEqual(['..kGsssssMMsGk..', '..kGsMMsssssGk..']);
        expect(think(1, 1, 0, 0).slice(5, 7)).toEqual(['..kGsMMssMMsGk..', '..kGssssssssGk..']);
        expect(think(0, 0, 0, 0).slice(5, 7)).toEqual(rest.slice(5, 7));
    });

    it('looks left or right, the monocle glint showing over either', () => {
        expect(think(0, 0, 0, 0)[8]).toBe('.kSsswesoweosSk.');
        expect(think(0, 0, 1, 0)[8]).toBe('.kSssewsoewosSk.');
        expect(think(0, 0, 1, 3)[8]).toBe('.kSssewsoewWsSk.');
        expect(think(0, 0, 0, 1)[7]).toBe('.kSssssssWossSk.');
        expect(think(0, 0, 0, 2)[7]).toBe('.kSssssssoWssSk.');
    });

    it('flattens the moustache tips when it twitches, keeping it 8 wide', () => {
        expect(think(0, 0, 0, 4).slice(9, 11)).toEqual(['..kssssSsoossk..', '..ksMMMMMMMMsk..']);
    });

    it('talks with the left tip flat, the mouth in three steps and at most one brow raised', () => {
        expect(talk(0, 0).slice(5, 13)).toEqual([rest[5], rest[6], rest[7], rest[8], '..kssssSsooMsk..', rest[10], '..kssssmmssssk..', '...kssssssssk...']);
        expect(talk(1, 1).slice(5, 13)).toEqual([rest[5], rest[6], rest[7], rest[8], '..kssssSsooMsk..', rest[10], '..ksssskkssssk..', '...kssssssssk...']);
        expect(talk(2, 2).slice(5, 13)).toEqual(['..kGsssssMMsGk..', '..kGsMMsssssGk..', rest[7], rest[8], '..kssssSsooMsk..', rest[10], '..ksssmkkmsssk..', '...ksssmmsssk...']);
        expect(talk(2, 3).slice(5, 7)).toEqual(['..kGsMMsssssGk..', '..kGsssssMMsGk..']);
    });
});

describe('otaku', () => {
    const rest = avatarPresetRows('otaku')!;

    it('walks the pupils round a small ring in the middle of both lenses while thinking', () => {
        const lens = (state: number) => avatarPresetRows('otaku', 'think', [state])!.slice(6, 10);
        const blank = '.gllllgssgllllg.';
        expect(lens(0)).toEqual(['.gllllggggllllg.', '.glellgssglellg.', blank, blank]);
        expect(lens(1)).toEqual(['.gllllggggllllg.', '.gllelgssgllelg.', blank, blank]);
        expect(lens(2)).toEqual(['.gllllggggllllg.', blank, '.gllelgssgllelg.', blank]);
        expect(lens(3)).toEqual(['.gllllggggllllg.', blank, '.glellgssglellg.', blank]);
        const think = avatarPresetAnimations('otaku')!.think!;
        expect(think.tracks[0].pick).toEqual({ kind: 'loop', play: [[0, 150], [1, 150], [2, 150], [3, 150]] });
    });

    it('talks with the mouth in three steps and glances left', () => {
        const talk = (mouth: number, gaze: number) => avatarPresetRows('otaku', 'talk', [mouth, gaze])!;
        expect(talk(0, 0)).toEqual(rest);
        expect(talk(1, 0)[12]).toBe('..ksssskkssssk..');
        expect(talk(2, 0).slice(12, 14)).toEqual(['..ksssmkkmsssk..', '...ksssmmsssk...']);
        expect(talk(0, 1)[8]).toBe('.glellgssglellg.');
    });
});
