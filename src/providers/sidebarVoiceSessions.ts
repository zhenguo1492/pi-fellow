import * as path from 'node:path';
import type * as vscode from 'vscode';
import {
    buildSessionInfoFromFile,
    canonicalizeSessionPath,
    withVoiceSessions,
    type VoiceSessionSummary,
} from '../pi/sessionCatalog';
import type { SessionInfo } from '../shared/protocol';
import type { VoiceHistory } from '../voiceAgent/workerController';
import type { TabState } from './sidebarTabState';

/** Voice conversations in the resume list: sessions the user only talked to the voice agent about get resumable. */
export class SidebarVoiceSessions {
    /** The voice transcript store. */
    history: VoiceHistory | undefined;

    constructor(private readonly _outputChannel: vscode.OutputChannel) {}

    sessionFor(sessionPath: string): VoiceSessionSummary | undefined {
        const canon = canonicalizeSessionPath(sessionPath);
        return this.history?.voiceSessions().find((v) => canonicalizeSessionPath(v.sessionFile) === canon);
    }

    /** A session as the resume list shows it: its file's metadata with its voice conversation, or only the latter. */
    sessionInfo(sessionPath: string): SessionInfo | null {
        const info = buildSessionInfoFromFile(sessionPath);
        const voice = this.sessionFor(sessionPath);
        return voice ? withVoiceSessions(info ? [info] : [], [voice], path.dirname(voice.sessionFile))[0] : info;
    }

    /**
     * The worker forgot the name its voice conversation gave the session: pi writes nothing before the
     * worker's first reply, so a voice-only session comes back unnamed.
     */
    async adoptTitle(tab: TabState): Promise<void> {
        const session = tab.session.session;
        const title = session?.sessionFile && !session.sessionName?.trim() ? this.sessionFor(session.sessionFile)?.title : undefined;
        if (!title) {
            return;
        }
        try {
            await tab.session.setSessionName(title);
        } catch (err: unknown) {
            this._outputChannel.appendLine(`Restoring the voice session name failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
