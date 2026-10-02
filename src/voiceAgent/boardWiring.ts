/** How the voice agent's replies and contexts reach the blackboards (docs/blackboard.md). */
import type { AgentCursor } from './agentCursor';
import type { Blackboards } from './blackboard';
import { boardTarget, type CodeAnchor } from './codeAnchors';
import type { VoiceContextMemory } from './voiceAgent';

/** Board markers point on their board; the code anchors go to Pi's cursor, where the first one wins as ever. */
export function routeAnchors(anchors: readonly CodeAnchor[], boards: Pick<Blackboards, 'pointAnchor'>, cursor: Pick<AgentCursor, 'point'>): void {
    const code: CodeAnchor[] = [];
    for (const anchor of anchors) {
        const target = boardTarget(anchor);
        if (target) {
            boards.pointAnchor(target);
        } else {
            code.push(anchor);
        }
    }
    if (code.length > 0) {
        cursor.point(code);
    }
}

/**
 * `contexts` whose voice context, once bound, also binds its boards: they belong to the voice
 * conversation. Awaited, so the turn's `<boards>` lists them; a board that fails to reopen is logged,
 * never the turn's failure.
 */
export function withBoards(contexts: VoiceContextMemory, boards: Pick<Blackboards, 'bindSession'>, log: (line: string) => void): VoiceContextMemory {
    return {
        savedContext: (task) => contexts.savedContext(task),
        bindContext: async (task, sessionFile, resumed) => {
            await contexts.bindContext(task, sessionFile, resumed);
            await boards.bindSession(sessionFile, resumed).catch((err: unknown) => log(`Boards of ${sessionFile}: ${err instanceof Error ? err.message : String(err)}`));
        },
    };
}
