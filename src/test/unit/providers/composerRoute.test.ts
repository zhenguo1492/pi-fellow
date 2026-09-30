import { describe, expect, it } from 'vitest';
import { routeComposerSend } from '../../../providers/composerRoute';
import type { ClientMessage } from '../../../shared/protocol';

const prompt: ClientMessage = { type: 'prompt', text: '  fix the tests  ' };
const voiceSend: ClientMessage = { type: 'voiceAgent', action: { type: 'send', text: 'fix the tests' } };

describe('routeComposerSend', () => {
    it('sends to the worker while the tab shows its conversation', () => {
        expect(routeComposerSend(prompt, false)).toEqual({ deliver: prompt });
        expect(routeComposerSend(voiceSend, false)).toEqual({ deliver: { type: 'prompt', text: 'fix the tests' } });
    });

    it('sends to the voice agent in the Bot view', () => {
        expect(routeComposerSend(voiceSend, true)).toEqual({ deliver: voiceSend });
        expect(routeComposerSend(prompt, true)).toEqual({ deliver: voiceSend });
        // Only attachments: the host sends them along with the empty text.
        expect(routeComposerSend({ type: 'prompt', text: '', attachments: [{ id: 'a' }] }, true)).toEqual({
            deliver: { type: 'voiceAgent', action: { type: 'send', text: '' } },
        });
        // Worker-only sends never reach the worker from the Bot view.
        expect(routeComposerSend({ type: 'slashCommand', text: '/model' }, true)).toHaveProperty('refuse');
        expect(routeComposerSend({ type: 'steer', text: 'faster' }, true)).toHaveProperty('refuse');
        expect(routeComposerSend({ type: 'queueMessage', text: 'later' }, true)).toHaveProperty('refuse');
    });

    it('lets everything else through', () => {
        const abort: ClientMessage = { type: 'abort' };
        const start: ClientMessage = { type: 'voiceAgent', action: { type: 'start' } };
        expect(routeComposerSend(abort, true)).toEqual({ deliver: abort });
        expect(routeComposerSend(start, true)).toEqual({ deliver: start });
    });
});
