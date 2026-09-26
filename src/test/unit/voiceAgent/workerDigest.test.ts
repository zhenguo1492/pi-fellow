import { describe, it, expect } from 'vitest';
import { WorkerDigest } from '../../../voiceAgent/workerDigest';

// Event shapes captured from omp 18.2.11 RPC (tool_execution_*, agent_end with isTerminal).
describe('WorkerDigest', () => {
    it('turns a worker run into readable steps', () => {
        const digest = new WorkerDigest();
        digest.ingest({ type: 'agent_start' }, 0);
        digest.ingest({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'Fix the test' }] } }, 0);
        digest.ingest({ type: 'tool_execution_start', toolName: 'read', args: { path: 'a.txt' }, intent: 'Reading a.txt' }, 1000);
        digest.ingest({ type: 'tool_execution_end', toolName: 'read', isError: false, result: { content: [] } }, 1000);
        digest.ingest({ type: 'tool_execution_start', toolName: 'edit', args: { input: '[src/stt.ts#3030]\nPUT 2.=2:\n+x' } }, 2000);
        digest.ingest({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'npm test' } }, 3000);
        digest.ingest(
            {
                type: 'tool_execution_end',
                toolName: 'bash',
                isError: true,
                result: {
                    content: [{ type: 'text', text: 'Tests: 2 failed, 8 passed\n\n\nWall time: 3.1 seconds\n\nCommand exited with code 1' }],
                    details: { exitCode: 1 },
                },
            },
            6000,
        );
        digest.ingest({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Two tests fail.' }] } }, 7000);
        digest.ingest({ type: 'agent_end', isTerminal: true, messages: [{ stopReason: 'stop' }] }, 9000);

        expect(digest.recent(10).map((e) => e.text)).toEqual([
            'Instruction: Fix the test',
            'Reading a.txt',
            'edit src/stt.ts',
            'Running: npm test',
            '  → exit 1: Tests: 2 failed, 8 passed',
            'Worker said: Two tests fail.',
            'Finished after 9s',
        ]);
    });

    it('only reports the run as over on its terminal agent_end', () => {
        const digest = new WorkerDigest();
        digest.ingest({ type: 'agent_start' }, 0);
        digest.ingest({ type: 'agent_end', isTerminal: false, messages: [] }, 1000);
        expect(digest.recent(10)).toEqual([]);
        digest.ingest({ type: 'agent_end', messages: [{ stopReason: 'aborted' }] }, 2000);
        expect(digest.recent(10).map((e) => e.text)).toEqual(['Stopped by the user after 2s']);
    });

    it('since() returns only entries after a sequence number', () => {
        const digest = new WorkerDigest();
        digest.ingest({ type: 'tool_execution_start', toolName: 'read', intent: 'Reading a' });
        const seen = digest.lastSeq;
        digest.ingest({ type: 'tool_execution_start', toolName: 'read', intent: 'Reading b' });
        expect(digest.since(seen).map((e) => e.text)).toEqual(['Reading b']);
    });
});
