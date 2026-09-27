import { describe, expect, it, vi } from 'vitest';
import type { AgentLayout } from '../../../pi/agentBackend';
import { SessionListCache, type SessionListScope } from '../../../providers/sidebarSessionListCache';
import type { SessionInfo } from '../../../shared/protocol';

const layout: AgentLayout = { backend: 'pi', agentDir: '/home/u/.pi/agent' };
const project: SessionListScope = { cwd: '/work/project', layout };
const other: SessionListScope = { cwd: '/work/other', layout };

function session(path: string): SessionInfo {
    return { id: path, path };
}

/** A lister whose reads stay pending until the test settles them, in call order. */
function controlledLister() {
    const reads: PromiseWithResolvers<SessionInfo[]>[] = [];
    const list = vi.fn((_cwd: string, _layout: AgentLayout) => {
        const read = Promise.withResolvers<SessionInfo[]>();
        reads.push(read);
        return read.promise;
    });
    return { list, reads };
}

describe('SessionListCache', () => {
    it('shares one disk read between concurrent listings of a folder, not across folders', async () => {
        const { list, reads } = controlledLister();
        const cache = new SessionListCache(list);

        const first = cache.fetch(project);
        const second = cache.fetch(project);
        void cache.fetch(other);
        expect(list).toHaveBeenCalledTimes(2);

        const sessions = [session('/s/a.jsonl')];
        reads[0].resolve(sessions);
        expect(await first).toBe(sessions);
        expect(await second).toBe(sessions);
        expect(cache.cached(project)).toBe(sessions);
        expect(cache.cached(other)).toBeUndefined();
    });

    it('keeps a listing started before invalidation out of the cache without evicting the newer read', async () => {
        const { list, reads } = controlledLister();
        const cache = new SessionListCache(list);

        const stale = cache.fetch(project);
        cache.invalidate();
        const fresh = cache.fetch(project);
        expect(list).toHaveBeenCalledTimes(2);

        reads[0].resolve([session('/s/deleted.jsonl')]);
        await stale;
        expect(cache.cached(project)).toBeUndefined();
        // The stale read settling must not drop the newer read from the in-flight table.
        expect(cache.fetch(project)).toBe(fresh);
        expect(list).toHaveBeenCalledTimes(2);

        const current = [session('/s/current.jsonl')];
        reads[1].resolve(current);
        await fresh;
        expect(cache.cached(project)).toBe(current);
    });

    it('does not cache a failed listing and reads again on the next fetch', async () => {
        const { list, reads } = controlledLister();
        const cache = new SessionListCache(list);

        const failed = cache.fetch(project);
        reads[0].reject(new Error('EACCES'));
        await expect(failed).rejects.toThrow('EACCES');
        expect(cache.cached(project)).toBeUndefined();

        void cache.fetch(project);
        expect(list).toHaveBeenCalledTimes(2);
    });

    it('drops a deleted session from every cached listing, matching its canonical path', async () => {
        const { list, reads } = controlledLister();
        const cache = new SessionListCache(list);
        const inProject = cache.fetch(project);
        const inOther = cache.fetch(other);
        reads[0].resolve([session('/s/a.jsonl'), session('/s/b.jsonl')]);
        reads[1].resolve([session('/s/a.jsonl')]);
        await Promise.all([inProject, inOther]);

        cache.removeSession('/s/sub/../a.jsonl');

        expect(cache.cached(project)?.map((s) => s.path)).toEqual(['/s/b.jsonl']);
        expect(cache.cached(other)).toEqual([]);
    });
});
