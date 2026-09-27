import type { AgentLayout } from '../pi/agentBackend';
import {
    canonicalizeSessionPath,
    clearSessionInfoCache,
    invalidateSessionInfoPath,
    listPiSessionsForCwdAsync,
} from '../pi/sessionCatalog';
import type { SessionInfo } from '../shared/protocol';

/** One session store folder: the CLI's `/resume` current-folder scope. */
export interface SessionListScope {
    cwd: string;
    layout: AgentLayout;
}

export type ListSessions = (
    cwd: string,
    layout: AgentLayout,
    onProgress?: (loaded: number, total: number) => void,
) => Promise<SessionInfo[]>;

/**
 * Last session listing per folder: the resume panel shows it instantly, then revalidates from disk.
 * Concurrent listings of one folder share a single read.
 */
export class SessionListCache {
    private readonly _lists = new Map<string, SessionInfo[]>();
    private readonly _inFlight = new Map<string, Promise<SessionInfo[]>>();
    /** Bumped on invalidation so listings started earlier do not repopulate the cache. */
    private _epoch = 0;

    constructor(private readonly _listSessions: ListSessions = listPiSessionsForCwdAsync) {}

    cached(scope: SessionListScope): SessionInfo[] | undefined {
        return this._lists.get(cacheKey(scope));
    }

    /**
     * List from disk (per-file metadata is mtime-cached, so repeat listings are cheap). A read already
     * in flight for the folder is shared, and only its first caller's `onProgress` hears from it.
     */
    fetch(scope: SessionListScope, onProgress?: (loaded: number, total: number) => void): Promise<SessionInfo[]> {
        const key = cacheKey(scope);
        const inFlight = this._inFlight.get(key);
        if (inFlight) {
            return inFlight;
        }
        const epoch = this._epoch;
        const pending = this._listSessions(scope.cwd, scope.layout, onProgress)
            .then((sessions) => {
                if (epoch === this._epoch) {
                    this._lists.set(key, sessions);
                }
                return sessions;
            })
            .finally(() => {
                if (this._inFlight.get(key) === pending) {
                    this._inFlight.delete(key);
                }
            });
        this._inFlight.set(key, pending);
        return pending;
    }

    /** Sessions were created, renamed or moved: forget every listing and the per-file metadata. */
    invalidate(): void {
        this._epoch++;
        this._lists.clear();
        this._inFlight.clear();
        clearSessionInfoCache();
    }

    /** A deleted session leaves every cached listing. */
    removeSession(sessionPath: string): void {
        const canon = canonicalizeSessionPath(sessionPath);
        for (const [key, list] of this._lists) {
            this._lists.set(
                key,
                list.filter((s) => canonicalizeSessionPath(s.path) !== canon),
            );
        }
        invalidateSessionInfoPath(sessionPath);
    }
}

function cacheKey(scope: SessionListScope): string {
    return `${scope.layout.agentDir}\0${scope.cwd}`;
}
