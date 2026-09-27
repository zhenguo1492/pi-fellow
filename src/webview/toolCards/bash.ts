/** `bash`: prompt line with env prefix, flag badges, output tail. */
import { badge, badges, h, invalidArg, resultImages, resultText, row } from './parts';
import type { ToolRenderer } from './types';
import { detailsRecord, display, isRecord, normalizeWs, num, resultTextOf, shortenPath, str, truncate } from './util';

/** Values safe to show unquoted in a `NAME=value` shell prefix. */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
/** Footer the bash tool appends when long output was spilled to an artifact. */
const ARTIFACT_NOTICE = /\[raw output: artifact:\/\/([\w-]+)\]/;

function envPrefix(env: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const key in env) {
        const value = display(env[key]);
        parts.push(`${key}=${SHELL_SAFE.test(value) ? value : JSON.stringify(value)}`);
    }
    return parts.join(' ');
}

export const bashRenderer: ToolRenderer = {
    summary({ args, result }) {
        const command = args.command === undefined ? '…' : str(args.command);
        if (command === null) return [invalidArg('command')];
        return [h('span', result?.isError ? 'tv-err-text' : undefined, truncate(normalizeWs(command) || '…', 80))];
    },

    body({ args, result }) {
        const command = args.command === undefined ? '…' : str(args.command);
        const prefix = isRecord(args.env) ? envPrefix(args.env) : '';
        const cwd = str(args.cwd);
        const head = num(args.head);
        const tail = num(args.tail);

        const details = detailsRecord(result);
        const exitCode = num(details?.exitCode);
        const wallTimeMs = num(details?.wallTimeMs);
        const timeoutSeconds = num(args.timeout) ?? num(details?.timeoutSeconds);
        const requestedTimeoutSeconds = num(details?.requestedTimeoutSeconds);
        const job = isRecord(details?.async) ? details.async : null;
        const jobState = str(job?.state);
        const jobId = str(job?.jobId);
        const artifactId = ARTIFACT_NOTICE.exec(resultTextOf(result))?.[1];

        const stats: string[] = [];
        if (wallTimeMs !== null) {
            stats.push(wallTimeMs < 1000 ? `wall ${Math.round(wallTimeMs)}ms` : `wall ${(wallTimeMs / 1000).toFixed(1)}s`);
        }
        if (requestedTimeoutSeconds !== null && requestedTimeoutSeconds !== timeoutSeconds) {
            stats.push(`requested timeout ${requestedTimeoutSeconds}s clamped`);
        }
        if (jobState && jobId) stats.push(`job ${jobId}`);
        if (artifactId) stats.push(`artifact ${artifactId}`);

        let jobTone: 'err' | 'accent' | 'ok' = 'ok';
        if (jobState === 'failed') jobTone = 'err';
        else if (jobState === 'running') jobTone = 'accent';

        return [
            h(
                'div',
                'tv-cmd',
                h('span', 'tv-cmd-prompt', '$'),
                h('span', 'tv-cmd-text', prefix && h('span', 'tv-cmd-env', `${prefix} `), command ?? invalidArg('command')),
            ),
            badges([
                cwd && `cwd=${shortenPath(cwd)}`,
                timeoutSeconds !== null && `timeout=${timeoutSeconds}s`,
                args.pty === true && badge('pty', 'accent'),
                !jobState && args.async === true && badge('async', 'accent'),
                head !== null && `head=${head}`,
                tail !== null && `tail=${tail}`,
                exitCode !== null && badge(`exit ${exitCode}`, 'err'),
                jobState && badge(`async ${jobState}`, jobTone),
            ]),
            resultImages(result),
            resultText(result, { maxLines: 12 }),
            stats.length > 0 && row(null, stats.join(' · ')),
        ];
    },
};
