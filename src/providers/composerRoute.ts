import type { ClientMessage } from '../shared/protocol';

/** What the composer sends to the worker. */
const WORKER_SENDS: Partial<Record<ClientMessage['type'], true>> = {
    slashCommand: true,
    prompt: true,
    steer: true,
    queueMessage: true,
    interruptAndSend: true,
    resendUserMessage: true,
};

export type ComposerRoute = { deliver: ClientMessage } | { refuse: string };

/**
 * The composer talks to what the active tab shows: its conversation → the worker, the Bot view →
 * the voice agent (by voice mode while it is on, a text chat otherwise). Other messages pass
 * through. Text sent to the wrong side is delivered to the right one.
 */
export function routeComposerSend(msg: ClientMessage, botView: boolean): ComposerRoute {
    const voiceText = msg.type === 'voiceAgent' && msg.action.type === 'send' ? msg.action.text : undefined;
    if (voiceText === undefined && !WORKER_SENDS[msg.type]) {
        return { deliver: msg };
    }
    if (!botView) {
        return { deliver: voiceText === undefined ? msg : { type: 'prompt', text: voiceText } };
    }
    if (voiceText !== undefined) {
        return { deliver: msg };
    }
    if (msg.type === 'prompt' && (msg.text.trim() || msg.attachments?.length)) {
        return { deliver: { type: 'voiceAgent', action: { type: 'send', text: msg.text.trim() } } };
    }
    return { refuse: 'The Bot view talks to the voice agent: go back to the worker conversation to send this.' };
}
