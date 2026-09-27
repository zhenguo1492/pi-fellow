import { describe, expect, it } from 'vitest';
import { routeComposerSend } from '../../../providers/composerRoute';
import type { ClientMessage } from '../../../shared/protocol';
import { VOICE_OFFLINE_SEND_HINT } from '../../../shared/voiceViewProtocol';

const prompt: ClientMessage = { type: 'prompt', text: '  fix the tests  ' };
const voiceSend: ClientMessage = { type: 'voiceAgent', action: { type: 'send', text: 'fix the tests' } };

describe('routeComposerSend', () => {
    it('sends to the worker while the tab shows its conversation, whatever the voice agent does', () => {
        for (const voiceOn of [false, true]) {
            expect(routeComposerSend(prompt, false, voiceOn)).toEqual({ deliver: prompt });
            expect(routeComposerSend(voiceSend, false, voiceOn)).toEqual({ deliver: { type: 'prompt', text: 'fix the tests' } });
        }
    });

    it('sends to the voice agent in the Bot view while it is online', () => {
        expect(routeComposerSend(voiceSend, true, true)).toEqual({ deliver: voiceSend });
        expect(routeComposerSend(prompt, true, true)).toEqual({ deliver: voiceSend });
        // Worker-only sends never reach the worker from the Bot view.
        expect(routeComposerSend({ type: 'slashCommand', text: '/model' }, true, true)).toHaveProperty('refuse');
        expect(routeComposerSend({ type: 'steer', text: 'faster' }, true, true)).toHaveProperty('refuse');
    });

    it('sends nothing from the Bot view while the voice agent is offline', () => {
        expect(routeComposerSend(voiceSend, true, false)).toEqual({ refuse: VOICE_OFFLINE_SEND_HINT });
        expect(routeComposerSend(prompt, true, false)).toEqual({ refuse: VOICE_OFFLINE_SEND_HINT });
        expect(routeComposerSend({ type: 'queueMessage', text: 'later' }, true, false)).toEqual({ refuse: VOICE_OFFLINE_SEND_HINT });
    });

    it('lets everything else through', () => {
        const abort: ClientMessage = { type: 'abort' };
        const start: ClientMessage = { type: 'voiceAgent', action: { type: 'start' } };
        expect(routeComposerSend(abort, true, false)).toEqual({ deliver: abort });
        expect(routeComposerSend(start, true, false)).toEqual({ deliver: start });
    });
});
