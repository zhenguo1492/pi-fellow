/** `write`: file create/overwrite with content preview and diagnostics. */
import { badge, badges, codeBlock, invalidArg, note, output, pathText, resultText } from './parts';
import type { ToolRenderer } from './types';
import { detailsRecord, isRecord, languageFromPath, str, strings } from './util';

export const writeRenderer: ToolRenderer = {
    summary({ args }) {
        const path = str(args.file_path ?? args.path);
        const content = str(args.content);
        const lines = content ? content.split('\n').length : 0;
        return [path === null ? invalidArg('path') : pathText(path), lines > 1 && badge(`${lines} lines`)];
    },

    body({ args, result }) {
        const path = str(args.file_path ?? args.path);
        const content = str(args.content);
        const details = detailsRecord(result);
        const diag = isRecord(details?.diagnostics) ? details.diagnostics : null;
        const messages = strings(diag?.messages);
        const summary = str(diag?.summary);
        const server = str(diag?.server);
        const errored = diag?.errored === true;
        return [
            badges([
                details?.madeExecutable === true && badge('made executable', 'ok'),
                summary && badge(`${server ? `${server}: ` : ''}${summary}`, errored ? 'err' : 'warn'),
            ]),
            content === null
                ? note('err', invalidArg('content'), ' — expected string')
                : codeBlock(content, path ? languageFromPath(path) : null, undefined, 12),
            resultText(result, { maxLines: 4 }),
            messages.length > 0 && output(messages.join('\n'), { title: 'diagnostics', error: errored, maxLines: 8 }),
        ];
    },
};
