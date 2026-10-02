import { describe, it, expect } from 'vitest';
import { AnchorStream, boardTarget, parseAnchor, type ReplyPart } from '../../../voiceAgent/codeAnchors';

function stream(deltas: string[]): ReplyPart[] {
    const anchors = new AnchorStream();
    const parts = deltas.flatMap((delta) => anchors.push(delta));
    anchors.flush();
    // Adjacent text parts are one run of text, however the deltas fell.
    return parts.reduce<ReplyPart[]>((merged, part) => {
        const prev = merged[merged.length - 1];
        if ('text' in part && prev && 'text' in prev) {
            merged[merged.length - 1] = { text: prev.text + part.text };
        } else {
            merged.push(part);
        }
        return merged;
    }, []);
}

describe('code anchors', () => {
    it('takes an anchor split across deltas out of the text, in place', () => {
        expect(stream(['入口在这里。⟦src/voice', '/stt.ts:139-1', '41⟧它把 PCM 包成 wav。'])).toEqual([
            { text: '入口在这里。' },
            { anchor: { path: 'src/voice/stt.ts', startLine: 139, endLine: 141 } },
            { text: '它把 PCM 包成 wav。' },
        ]);
    });

    it('passes a bracket that is not an anchor through, and drops one that never closes', () => {
        expect(stream(['区间 ⟦0, 1', '\n) 是半开的。'])).toEqual([{ text: '区间 ⟦0, 1\n) 是半开的。' }]);
        expect(stream(['看这里 ⟦src/a.ts:1'])).toEqual([{ text: '看这里 ' }]);
    });

    it('reads lines, a symbol, or a whole file', () => {
        expect(parseAnchor('a.ts:20-12')).toEqual({ path: 'a.ts', startLine: 12, endLine: 20 });
        expect(parseAnchor(' src/voiceMode.ts#Speaker.enqueue ')).toEqual({ path: 'src/voiceMode.ts', symbol: 'Speaker.enqueue' });
        expect(parseAnchor('README.md')).toEqual({ path: 'README.md' });
        expect(parseAnchor('a.ts:0')).toBeUndefined();
        expect(parseAnchor('#name')).toBeUndefined();
        expect(parseAnchor('a.ts:12#total')).toEqual({ path: 'a.ts', startLine: 12, endLine: 12, symbol: 'total' });
        expect(parseAnchor('a.ts:0#total')).toBeUndefined();
    });
});

describe('boardTarget', () => {
    const target = (body: string) => boardTarget(parseAnchor(body)!);

    it('reads board markers: a block, code lines, a passage or node, another board', () => {
        expect(parseAnchor('board:c1:3-5')).toEqual({ path: 'board:c1', startLine: 3, endLine: 5 });
        expect(parseAnchor('board:p2#refresh token')).toEqual({ path: 'board:p2', symbol: 'refresh token' });
        expect(target('board:d1')).toEqual({ block: 'd1' });
        expect(target('board:c1:3-5')).toEqual({ block: 'c1', startLine: 3, endLine: 5 });
        expect(target('board:c1:4')).toEqual({ block: 'c1', startLine: 4, endLine: 4 });
        expect(target('board:p2#refresh token')).toEqual({ block: 'p2', text: 'refresh token' });
        expect(target('board:b2/d1#Client')).toEqual({ board: 'b2', block: 'd1', text: 'Client' });
    });

    it('leaves code anchors alone, a file named board included', () => {
        expect(target('src/board.ts:3')).toBeUndefined();
        expect(target('board/notes.md')).toBeUndefined();
        expect(target('board:')).toBeUndefined();
    });
});
