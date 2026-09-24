import * as fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionInfo } from '../shared/protocol';
import type { AgentBackend, AgentLayout } from './agentBackend';

function realpathOrResolve(p: string): string {
    const resolved = path.resolve(p);
    try {
        return fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

/**
 * Per-cwd session directory name, matching each CLI.
 * - pi: `--<abs path, separators → '-'>--`.
 * - omp: home-relative `-<rel>` (home itself `-`), tmp-relative `-tmp-<rel>`, else the pi form.
 */
export function encodeSessionCwd(
    cwd: string,
    backend: AgentBackend,
    home: string = os.homedir(),
    tmp: string = os.tmpdir(),
): string {
    const absForm = (p: string): string => `--${p.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    if (backend === 'pi') {
        return absForm(path.resolve(cwd));
    }
    const resolved = realpathOrResolve(cwd);
    for (const [root, prefix] of [[home, '-'], [tmp, '-tmp']] as const) {
        const rel = path.relative(realpathOrResolve(root), resolved);
        if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
            const suffix = rel.replace(/[/\\:]/g, '-');
            if (!suffix) {
                return prefix;
            }
            return prefix.endsWith('-') ? `${prefix}${suffix}` : `${prefix}-${suffix}`;
        }
    }
    return absForm(resolved);
}

export function getSessionDirForCwd(cwd: string, layout: AgentLayout): string {
    return path.join(layout.agentDir, 'sessions', encodeSessionCwd(cwd, layout.backend));
}

/** Match Pi CLI session selector (realpath when possible). */
export function canonicalizeSessionPath(filePath: string | undefined): string {
    if (!filePath) {
        return '';
    }
    try {
        return fs.realpathSync(filePath);
    } catch {
        return path.resolve(filePath);
    }
}

function canonicalizePath(filePath: string | undefined): string | undefined {
    if (!filePath) {
        return filePath;
    }
    return canonicalizeSessionPath(filePath);
}

function extractTextContent(message: unknown): string {
    if (!message || typeof message !== 'object') {
        return '';
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter((part): part is { type?: string; text?: string } => typeof part === 'object' && part !== null)
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n');
}

function getLastActivityTime(entries: Array<Record<string, unknown>>): number | undefined {
    let last: number | undefined;
    for (const entry of entries) {
        if (entry.type !== 'message') {
            continue;
        }
        const message = entry.message as { timestamp?: number; role?: string } | undefined;
        if (typeof message?.timestamp === 'number') {
            last = Math.max(last ?? 0, message.timestamp);
            continue;
        }
        const entryTs = entry.timestamp;
        if (typeof entryTs === 'string') {
            const parsed = new Date(entryTs).getTime();
            if (!Number.isNaN(parsed)) {
                last = Math.max(last ?? 0, parsed);
            }
        }
    }
    return last;
}

const sessionInfoByPath = new Map<string, { mtimeMs: number; info: SessionInfo }>();

/** Drop cached session metadata (e.g. after resume or new session). */
export function clearSessionInfoCache(): void {
    sessionInfoByPath.clear();
}

/** Drop one file from the session metadata cache (after rename/delete). */
export function invalidateSessionInfoPath(sessionPath: string): void {
    sessionInfoByPath.delete(sessionPath);
    try {
        sessionInfoByPath.delete(canonicalizeSessionPath(sessionPath));
    } catch {
        /* best-effort */
    }
}

async function buildSessionInfoFromFileLiteAsync(filePath: string): Promise<SessionInfo | null> {
    let fileStat: fs.Stats;
    try {
        fileStat = await stat(filePath);
    } catch {
        return null;
    }

    return new Promise((resolve) => {
        let header: Record<string, unknown> | null = null;
        let messageCount = 0;
        let turnCount = 0;
        let firstMessage = '';
        let name: string | undefined;
        let lastActivity = fileStat.mtimeMs;

        const stream = createReadStream(filePath, { encoding: 'utf8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });

        const finish = (): void => {
            if (!header) {
                resolve(null);
                return;
            }

            const headerTs =
                typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : NaN;
            const modified =
                lastActivity > 0
                    ? lastActivity
                    : !Number.isNaN(headerTs)
                      ? headerTs
                      : fileStat.mtimeMs;

            const match = /^(.+)_(.+)\.jsonl$/.exec(path.basename(filePath));
            const id =
                typeof header.id === 'string' ? header.id : match?.[2] ?? path.basename(filePath);

            resolve({
                id,
                name: name ?? id,
                path: filePath,
                cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
                messageCount,
                turnCount,
                sizeBytes: fileStat.size,
                firstMessage: firstMessage || '(no messages)',
                created: !Number.isNaN(headerTs) ? headerTs : fileStat.mtimeMs,
                lastModified: modified,
            });
        };

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) {
                return;
            }
            let entry: Record<string, unknown>;
            try {
                entry = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
                return;
            }

            // pi: header is line 1. omp: a `title` entry precedes it.
            if (!header && entry.type === 'session') {
                header = entry;
                const headerTs =
                    typeof header.timestamp === 'string'
                        ? new Date(header.timestamp).getTime()
                        : NaN;
                if (!Number.isNaN(headerTs)) {
                    lastActivity = Math.max(lastActivity, headerTs);
                }
                return;
            }

            if (entry.type === 'title' && typeof entry.title === 'string' && entry.title.trim()) {
                name = entry.title.trim();
            }
            if (entry.type === 'session_info') {
                const raw = (entry as { name?: string }).name?.trim();
                if (raw) {
                    name = raw;
                }
            }
            if (entry.type === 'session_name' && typeof entry.name === 'string' && entry.name.trim()) {
                name = entry.name.trim();
            }
            if (entry.type !== 'message') {
                return;
            }

            messageCount++;
            const message = entry.message as { role?: string; timestamp?: number } | undefined;
            if (typeof message?.timestamp === 'number') {
                lastActivity = Math.max(lastActivity, message.timestamp);
            } else {
                const entryTs = entry.timestamp;
                if (typeof entryTs === 'string') {
                    const parsed = new Date(entryTs).getTime();
                    if (!Number.isNaN(parsed)) {
                        lastActivity = Math.max(lastActivity, parsed);
                    }
                }
            }

            if (message?.role === 'user') {
                turnCount++;
            }
            if (!firstMessage && message?.role === 'user') {
                const textContent = extractTextContent(message)
                    .replace(/[\x00-\x1f\x7f]/g, ' ')
                    .trim();
                if (textContent) {
                    firstMessage = textContent;
                }
            }
        });

        rl.on('close', finish);
        stream.on('error', () => resolve(null));
    });
}

async function buildSessionInfoCachedAsync(filePath: string): Promise<SessionInfo | null> {
    try {
        const fileStat = await stat(filePath);
        const cached = sessionInfoByPath.get(filePath);
        if (cached && cached.mtimeMs === fileStat.mtimeMs) {
            return cached.info;
        }
        const info = await buildSessionInfoFromFileLiteAsync(filePath);
        if (info) {
            sessionInfoByPath.set(filePath, { mtimeMs: fileStat.mtimeMs, info });
        } else {
            sessionInfoByPath.delete(filePath);
        }
        return info;
    } catch {
        return null;
    }
}

async function buildSessionInfoFromFileAsync(filePath: string): Promise<SessionInfo | null> {
    return buildSessionInfoCachedAsync(filePath);
}

/** Read one Pi session .jsonl file into SessionInfo (same fields as Pi CLI session selector). */
export function buildSessionInfoFromFile(filePath: string): SessionInfo | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    let statResult: fs.Stats;
    try {
        statResult = fs.statSync(filePath);
    } catch {
        return null;
    }

    let text: string;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }

    return parseSessionInfoFromText(filePath, text, statResult);
}

function parseSessionInfoFromText(filePath: string, text: string, fileStat: fs.Stats): SessionInfo | null {
    const entries: Array<Record<string, unknown>> = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            entries.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
            /* skip malformed line */
        }
    }

    if (entries.length === 0) {
        return null;
    }

    // pi: header is line 1. omp: a `title` entry precedes it.
    const header = entries.find((entry) => entry.type === 'session');
    if (!header) {
        return null;
    }

    let messageCount = 0;
    let turnCount = 0;
    let firstMessage = '';
    let name: string | undefined;

    for (const entry of entries) {
        if (entry.type === 'title' && typeof entry.title === 'string' && entry.title.trim()) {
            name = entry.title.trim();
        }
        if (entry.type === 'session_info') {
            const raw = (entry as { name?: string }).name?.trim();
            name = raw || undefined;
        }
        if (entry.type === 'session_name' && typeof entry.name === 'string' && entry.name.trim()) {
            name = entry.name.trim();
        }
        if (entry.type !== 'message') {
            continue;
        }
        messageCount++;
        const message = entry.message as { role?: string } | undefined;
        if (message?.role === 'user') {
            turnCount++;
        }
        const textContent = extractTextContent(message).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
        if (!textContent) {
            continue;
        }
        if (!firstMessage && message?.role === 'user') {
            firstMessage = textContent;
        }
    }

    const headerTs = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : NaN;
    const lastActivity = getLastActivityTime(entries);
    const modified =
        lastActivity && lastActivity > 0
            ? lastActivity
            : !Number.isNaN(headerTs)
              ? headerTs
              : fileStat.mtimeMs;

    const match = /^(.+)_(.+)\.jsonl$/.exec(path.basename(filePath));
    const id = typeof header.id === 'string' ? header.id : match?.[2] ?? path.basename(filePath);

    return {
        id,
        name: name ?? id,
        path: filePath,
        cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
        messageCount,
        turnCount,
        sizeBytes: fileStat.size,
        firstMessage: firstMessage || '(no messages)',
        created: !Number.isNaN(headerTs) ? headerTs : fileStat.mtimeMs,
        lastModified: modified,
    };
}

function listSessionFilesInDir(dir: string): string[] {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith('.jsonl')) {
            files.push(path.join(dir, entry));
        }
    }
    return files;
}

const MAX_CONCURRENT_SESSION_INFO_LOADS = 24;

/** Same concurrency model as Pi CLI SessionManager.listAll. */
async function buildSessionInfosWithConcurrency(
    files: string[],
    onLoaded?: () => void,
): Promise<(SessionInfo | null)[]> {
    const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
    const inFlight = new Set<Promise<void>>();
    let nextIndex = 0;

    const startNext = (): void => {
        const index = nextIndex++;
        const file = files[index];
        if (!file) {
            return;
        }
        const task = buildSessionInfoFromFileAsync(file)
            .then((info) => {
                results[index] = info;
            })
            .catch(() => {
                results[index] = null;
            })
            .finally(() => {
                inFlight.delete(task);
                onLoaded?.();
            });
        inFlight.add(task);
    };

    while (nextIndex < files.length || inFlight.size > 0) {
        while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
            startNext();
        }
        if (inFlight.size > 0) {
            await Promise.race(inFlight);
        }
    }

    return results;
}

function sortSessionsByModified(sessions: SessionInfo[]): SessionInfo[] {
    return sessions.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
}

/** Sessions for one workspace cwd (the CLI's `/resume` current-folder scope). */
export async function listPiSessionsForCwdAsync(
    cwd: string,
    layout: AgentLayout,
    onProgress?: (loaded: number, total: number) => void,
): Promise<SessionInfo[]> {
    const sessionDir = getSessionDirForCwd(cwd, layout);
    const files = listSessionFilesInDir(sessionDir);
    let loaded = 0;
    const results = await buildSessionInfosWithConcurrency(files, () => {
        loaded++;
        onProgress?.(loaded, files.length);
    });
    return sortSessionsByModified(results.filter((info): info is SessionInfo => info !== null));
}

function matchesQuery(session: SessionInfo, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) {
        return true;
    }
    const haystack = [
        session.name,
        session.id,
        session.firstMessage,
        session.path,
        session.cwd,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return haystack.includes(q);
}

function hasMeaningfulContent(session: SessionInfo): boolean {
    const hasName = !!session.name && session.name !== session.id;
    if (hasName) return true;
    return (session.messageCount ?? 0) > 0;
}

/** Sessions shown in the resume list, newest activity first. */
export function buildSessionDisplayList(sessions: SessionInfo[], query = ''): SessionInfo[] {
    return sessions
        .filter((s) => hasMeaningfulContent(s) && matchesQuery(s, query))
        .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
}

export interface SessionListRow {
    sessionPath: string;
    label: string;
    meta: string;
    isCurrent: boolean;
}

/** Resolve the same title shown by the resume-session list. */
export function getSessionDisplayTitle(session: SessionInfo): string {
    const hasName = !!session.name && session.name !== session.id;
    const title = (hasName ? session.name : session.firstMessage || session.id) ?? session.id;
    return title.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

/** Rows for the resume panel: one line each — title, then `turns · size · age`. */
export function buildSessionListRows(
    sessions: SessionInfo[],
    query: string,
    currentSessionPath: string | undefined,
): SessionListRow[] {
    const currentCanon = currentSessionPath ? canonicalizePath(currentSessionPath) : undefined;

    return buildSessionDisplayList(sessions, query).map((session) => {
        const turns = session.turnCount ?? 0;
        const meta = [
            `${turns} ${turns === 1 ? 'turn' : 'turns'}`,
            formatSessionSize(session.sizeBytes),
            formatSessionAge(session.lastModified),
        ]
            .filter(Boolean)
            .join(' · ');
        const sessionCanon = canonicalizePath(session.path) ?? session.path;
        return {
            sessionPath: session.path,
            label: getSessionDisplayTitle(session),
            meta,
            isCurrent: !!currentCanon && currentCanon === sessionCanon,
        };
    });
}

/** Session file size, e.g. `812 B`, `14 KB`, `1.4 MB`. */
export function formatSessionSize(bytes: number | undefined): string {
    if (bytes === undefined) {
        return '';
    }
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    const mb = kb / 1024;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function formatSessionAge(ms: number | undefined): string {
    if (!ms) {
        return '';
    }
    const diffMs = Date.now() - ms;
    const diffMins = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffDays = Math.floor(diffMs / 86_400_000);
    if (diffMins < 1) return 'now';
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
    return `${Math.floor(diffDays / 365)}y`;
}
