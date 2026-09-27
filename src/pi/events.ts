import type { PiAgentEvent } from './rpcTypes';

export type EventHandler = (event: PiAgentEvent) => void;

export class EventRouter {
    private _handlers = new Map<string, Set<EventHandler>>();
    private _globalHandlers = new Set<EventHandler>();

    on(eventType: string, handler: EventHandler): () => void {
        let set = this._handlers.get(eventType);
        if (!set) {
            set = new Set();
            this._handlers.set(eventType, set);
        }
        set.add(handler);
        return () => set!.delete(handler);
    }

    onAll(handler: EventHandler): () => void {
        this._globalHandlers.add(handler);
        return () => this._globalHandlers.delete(handler);
    }

    dispatch(event: PiAgentEvent): void {
        for (const handler of this._globalHandlers) {
            try {
                handler(event);
            } catch {
                /* swallow listener errors */
            }
        }
        const set = this._handlers.get(event.type);
        if (set) {
            for (const handler of set) {
                try {
                    handler(event);
                } catch {
                    /* swallow listener errors */
                }
            }
        }
    }

    clear(): void {
        this._handlers.clear();
        this._globalHandlers.clear();
    }
}
