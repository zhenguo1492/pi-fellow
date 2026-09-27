import { describe, it, expect } from 'vitest';
import { EventRouter } from '../../../pi/events';
import type { PiAgentEvent } from '../../../pi/rpcTypes';

describe('EventRouter', () => {
    it('dispatches events to global handlers', () => {
        const router = new EventRouter();
        const received: any[] = [];
        router.onAll((e) => received.push(e));

        const fakeEvent: PiAgentEvent = { type: 'agent_start' };
        router.dispatch(fakeEvent);

        expect(received).toHaveLength(1);
        expect(received[0].type).toBe('agent_start');
    });

    it('dispatches events to type-specific handlers', () => {
        const router = new EventRouter();
        const starts: any[] = [];
        const ends: any[] = [];
        router.on('agent_start', (e) => starts.push(e));
        router.on('agent_end', (e) => ends.push(e));

        router.dispatch({ type: 'agent_start' });
        router.dispatch({ type: 'agent_end', messages: [] });

        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
    });

    it('unsubscribe works', () => {
        const router = new EventRouter();
        const received: any[] = [];
        const unsub = router.onAll((e) => received.push(e));

        router.dispatch({ type: 'agent_start' });
        expect(received).toHaveLength(1);

        unsub();
        router.dispatch({ type: 'agent_start' });
        expect(received).toHaveLength(1);
    });

    it('swallows listener errors without crashing', () => {
        const router = new EventRouter();
        const received: any[] = [];
        router.onAll(() => { throw new Error('boom'); });
        router.onAll((e) => received.push(e));

        router.dispatch({ type: 'agent_start' });
        expect(received).toHaveLength(1);
    });

    it('clear removes all handlers', () => {
        const router = new EventRouter();
        const received: any[] = [];
        router.onAll((e) => received.push(e));
        router.on('agent_start', (e) => received.push(e));
        router.clear();

        router.dispatch({ type: 'agent_start' });
        expect(received).toHaveLength(0);
    });
});
