import * as path from 'node:path';

/** `inner` is `outer` or lies inside it; `..cache` is a name, `../cache` is not inside. */
function within(outer: string, inner: string): boolean {
    const relative = path.relative(outer, inner);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * The files and folders the worker's current task has changed or is about to change, as the
 * permission gate reports them (NDJSON `{"paths": [...]}` lines, protocol in permissionPolicy.ts):
 * the lock that keeps the voice agent's own file changes off them. Emptied when the task ends.
 */
export class WorkerEditLocks {
    private readonly _paths = new Set<string>();

    /** Takes whole lines of the gate's output; lines that are not a report are skipped. */
    ingest(lines: string): void {
        for (const line of lines.split('\n')) {
            let report: unknown;
            try {
                report = JSON.parse(line);
            } catch {
                continue;
            }
            if (typeof report === 'object' && report !== null && 'paths' in report && Array.isArray(report.paths)) {
                for (const p of report.paths) {
                    if (typeof p === 'string' && path.isAbsolute(p)) {
                        this._paths.add(path.normalize(p));
                    }
                }
            }
        }
    }

    /**
     * The locked paths that overlap `targets` (absolute): the same path, a locked folder a target lies
     * in, or a locked file inside a target folder.
     */
    overlapping(targets: readonly string[]): string[] {
        return [...this._paths].filter((locked) => targets.some((target) => within(locked, target) || within(target, locked)));
    }

    clear(): void {
        this._paths.clear();
    }
}
