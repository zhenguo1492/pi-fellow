import { extractConversationMessageText } from '../shared/conversationTitle';

/** Unmatched sends kept; beyond this the oldest were almost certainly lost (failed run, aborted steer). */
const MAX_PENDING = 16;

/**
 * Which user messages in a worker tab were dispatched by the voice agent (design §11.3).
 *
 * The session history carries no origin, so each voice send records the exact prompt text it
 * submitted (after `composePrompt`, i.e. with any editor context appended); the first user message
 * whose text matches claims that entry. Claimed messages are keyed by their timestamp, which is
 * stable across message refreshes, rollbacks and switching the tab to another session and back;
 * messages without one fall back to their ordinal among user messages.
 */
export class VoiceOriginTracker {
    private _pending: string[] = [];
    private readonly _keys = new Set<string>();

    /** A voice send is about to submit `text` as a prompt or steer. */
    expect(text: string): void {
        this._pending.push(text.trim());
        if (this._pending.length > MAX_PENDING) {
            this._pending.shift();
        }
    }

    /** The submit for `text` failed: it will never arrive as a user message. */
    cancel(text: string): void {
        const idx = this._pending.indexOf(text.trim());
        if (idx >= 0) {
            this._pending.splice(idx, 1);
        }
    }

    /**
     * A user message arrived (`message_start`); `ordinal` is its index among user messages.
     * Returns whether it is one the voice agent sent.
     */
    claim(message: unknown, ordinal: number): boolean {
        if (this._pending.length === 0) {
            return false;
        }
        const idx = this._pending.indexOf(extractConversationMessageText(message).trim());
        if (idx < 0) {
            return false;
        }
        this._pending.splice(idx, 1);
        this._keys.add(messageKey(message, ordinal));
        return true;
    }

    isFromVoice(message: unknown, ordinal: number): boolean {
        return this._keys.size > 0 && this._keys.has(messageKey(message, ordinal));
    }

    /** The tab moved to another session: drop sends in flight and ordinal keys (they index the old history). */
    resetSession(): void {
        this._pending = [];
        for (const key of this._keys) {
            if (key.startsWith('o:')) {
                this._keys.delete(key);
            }
        }
    }
}

function messageKey(message: unknown, ordinal: number): string {
    const timestamp = (message as { timestamp?: unknown } | null)?.timestamp;
    return typeof timestamp === 'number' ? `t:${timestamp}` : `o:${ordinal}`;
}
