import { resolvePiCliInvocation, runPrintMode } from '../pi/piCliPaths';
import type { VoiceTranscriptStore } from './transcriptStore';
import type { WorkerController, WorkerTask } from './workerController';

/** User turns in a task's voice conversation before it gets a name: enough to say what it is about. */
export const TITLE_AFTER_TURNS = 2;
/** What the title model reads: the first few things said, each clipped. */
const TITLE_INPUT_TURNS = 6;
const TITLE_INPUT_CHARS = 300;
const TITLE_CHARS = 60;
const FALLBACK_CHARS = 40;
const TITLE_TIMEOUT_MS = 60_000;

const TITLE_PROMPT = `You name a conversation between a developer and their voice assistant. Reply with only the title: 2 to 6 words saying what the developer wants, in the language the developer speaks. No quotes, no trailing punctuation, nothing else.`;

/** The first thing said, cut at a word where one ends near the limit: the name when the model gives none. */
export function fallbackTitle(utterances: readonly string[]): string | undefined {
    const first = utterances.map((u) => u.replace(/\s+/g, ' ').trim()).find(Boolean);
    if (!first) {
        return undefined;
    }
    const chars = [...first];
    if (chars.length <= FALLBACK_CHARS) {
        return first;
    }
    const cut = chars.slice(0, FALLBACK_CHARS).join('');
    const space = cut.lastIndexOf(' ');
    return `${(space > cut.length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The model's reply as a title: its first line without a label, quotes, markup or closing punctuation. */
export function cleanTitle(reply: string): string | undefined {
    const line = reply
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean);
    if (!line) {
        return undefined;
    }
    const title = line
        .replace(/^[#>*\-\s]+/, '')
        .replace(/^(title|标题)\s*[:：]\s*/i, '')
        .replace(/^["'`*“”‘’「」『』《》\s]+/, '')
        .replace(/["'`*“”‘’「」『』《》\s.。!！?？,，;；:：…]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    return title ? [...title].slice(0, TITLE_CHARS).join('') : undefined;
}

/** One `-p` run of the voice agent's model with no tools, over what the user said. */
export async function generateTitle(utterances: readonly string[], cwd: string, model: string | undefined): Promise<string> {
    const invocation = await resolvePiCliInvocation();
    const args = ['-p', '--no-session', '--no-tools', '--no-skills', '--thinking', 'off', '--system-prompt', TITLE_PROMPT];
    if (invocation.backend === 'omp') {
        args.push('--no-extensions', '--no-rules', '--no-lsp', '--no-title');
    } else {
        // Extensions stay on: a pi package may provide the model.
        args.push('--no-prompt-templates', '--no-context-files');
    }
    if (model) {
        args.push('--model', model);
    }
    const said = utterances
        .slice(0, TITLE_INPUT_TURNS)
        .map((u) => `- ${[...u.trim()].slice(0, TITLE_INPUT_CHARS).join('')}`)
        .join('\n');
    const title = cleanTitle(await runPrintMode(invocation, args, `The developer said, in order:\n${said}`, cwd, { timeoutMs: TITLE_TIMEOUT_MS }));
    if (!title) {
        throw new Error('the model gave no title');
    }
    return title;
}

/**
 * Names each worker session after what the user wanted in its voice conversation, once they said
 * enough: the name shows on the tab and in the resume list. Never replaces a name the session has.
 */
export class SessionTitler {
    private readonly _pending = new Set<string>();

    constructor(
        private readonly _store: VoiceTranscriptStore,
        private readonly _worker: WorkerController,
        private readonly _generate: (utterances: readonly string[]) => Promise<string>,
        private readonly _log: (line: string) => void,
    ) {}

    /** A user turn in `task`'s voice conversation ended; `task` as it was when the turn began. */
    noteTurn(task: WorkerTask | undefined): void {
        const sessionFile = task?.sessionFile;
        if (!task || !sessionFile || task.sessionName || this._pending.has(sessionFile) || this._store.isNamed(sessionFile)) {
            return;
        }
        const utterances = this._store.userUtterances(sessionFile);
        if (utterances.length < TITLE_AFTER_TURNS) {
            return;
        }
        this._pending.add(sessionFile);
        void this._generate(utterances)
            .catch((err: unknown) => {
                this._log(`Session title: ${err instanceof Error ? err.message : String(err)}; named after the first thing said.`);
                return fallbackTitle(utterances);
            })
            .then(async (title) => {
                if (title && this._store.nameTask(sessionFile, title, 'auto')) {
                    await this._worker.nameTask(task.tabId, sessionFile, title);
                }
            })
            .catch((err: unknown) => this._log(`Session title not set: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => this._pending.delete(sessionFile));
    }
}
