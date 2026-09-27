import { describe, it, expect } from 'vitest';
import type { ClientMessage, ServerMessage, SerializedAgentState } from '../../../shared/protocol';

describe('Protocol types', () => {
    it('client messages serialize correctly', () => {
        const messages: ClientMessage[] = [
            { type: 'prompt', text: 'hello' },
            { type: 'abort' },
            { type: 'setModel', provider: 'ollama', modelId: 'test/model' },
            { type: 'setThinkingLevel', level: 'high' },
            { type: 'newSession' },
            { type: 'getModels' },
            { type: 'openResumePicker' },
            { type: 'toggleSessionPanel' },
            { type: 'loadSessionList', query: '' },
            { type: 'resumeSession', sessionPath: '/tmp/s.jsonl' },
            { type: 'deleteSession', sessionPath: '/tmp/s.jsonl' },
            { type: 'renameSession', sessionPath: '/tmp/s.jsonl', name: 'My session' },
            { type: 'closeSessionPanel' },
            { type: 'createTab', backend: 'pi' },
            { type: 'getState' },
        ];

        for (const msg of messages) {
            const serialized = JSON.stringify(msg);
            const deserialized = JSON.parse(serialized) as ClientMessage;
            expect(deserialized.type).toBe(msg.type);
        }
    });

    it('server messages serialize correctly', () => {
        const state: SerializedAgentState = {
            messages: [{ role: 'user', content: 'hello' }],
            isStreaming: false,
            tools: ['bash', 'read', 'write', 'edit'],
            sessionId: 'test-id',
            model: { provider: 'ollama', id: 'test/model', name: 'Test Model' },
            thinkingLevel: 'off',
            activeBackend: 'omp',
        };

        const messages: ServerMessage[] = [
            { type: 'ready' },
            { type: 'stateSync', state },
            { type: 'error', message: 'something went wrong' },
            {
                type: 'models',
                models: [{ provider: 'ollama', id: 'test', name: 'Test' }],
                favorites: ['ollama/test'],
            },
        ];

        for (const msg of messages) {
            const roundTripped = JSON.parse(JSON.stringify(msg)) as ServerMessage;
            expect(roundTripped.type).toBe(msg.type);
        }
    });

    it('state with streaming message serializes', () => {
        const state: SerializedAgentState = {
            messages: [],
            isStreaming: true,
            streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'streaming...' }] },
            tools: [],
        };

        const msg: ServerMessage = { type: 'stateSync', state };
        const parsed = JSON.parse(JSON.stringify(msg));
        expect(parsed.state.isStreaming).toBe(true);
        expect(parsed.state.streamingMessage).toBeDefined();
    });
});
