import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSessionTree } from '../../../pi/sessionTree';

describe('formatSessionTree', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('returns empty array when tree is empty', () => {
        const result = formatSessionTree([], null);
        expect(result).toEqual([]);
    });

    it('processes simple tree and marks active path and current leaf', () => {
        const rawTree = [
            {
                entry: {
                    id: 'node-1',
                    type: 'message',
                    timestamp: 1000,
                    message: {
                        role: 'user',
                        content: 'Hello world',
                    },
                },
                children: [
                    {
                        entry: {
                            id: 'node-2',
                            parentId: 'node-1',
                            type: 'message',
                            timestamp: 2000,
                            message: {
                                role: 'assistant',
                                content: [{ type: 'text', text: 'Hi! How can I help?' }],
                            },
                        },
                        children: [],
                    },
                ],
            },
        ];

        const formatted = formatSessionTree(rawTree as any, 'node-2');
        expect(formatted).toHaveLength(2);

        expect(formatted[0].id).toBe('node-1');
        expect(formatted[0].role).toBe('user');
        expect(formatted[0].textPreview).toBe('Hello world');
        expect(formatted[0].isActivePath).toBe(true);
        expect(formatted[0].isCurrentLeaf).toBe(false);
        expect(formatted[0].depth).toBe(0);

        expect(formatted[1].id).toBe('node-2');
        expect(formatted[1].role).toBe('assistant');
        expect(formatted[1].textPreview).toBe('Hi! How can I help?');
        expect(formatted[1].isActivePath).toBe(true);
        expect(formatted[1].isCurrentLeaf).toBe(true);
        expect(formatted[1].depth).toBe(1);
    });

    it('correctly handles branch summary and compaction entries', () => {
        const rawTree = [
            {
                entry: {
                    id: 'sum-1',
                    type: 'branch_summary',
                    timestamp: 1000,
                    summary: 'Summarized work from previous branch',
                },
                children: [],
            },
        ];

        const formatted = formatSessionTree(rawTree as any, 'sum-1');
        expect(formatted).toHaveLength(1);
        expect(formatted[0].role).toBe('branch_summary');
        expect(formatted[0].textPreview).toContain('Summarized work');
    });

    it('correctly parses custom, custom_message, and toolResult entries', () => {
        vi.stubEnv('HOME', '/home/test-user');
        const rawTree = [
            {
                entry: {
                    id: 'custom-1',
                    type: 'custom',
                    customType: 'subagent_start',
                },
                children: [
                    {
                        entry: {
                            id: 'custom-msg-1',
                            type: 'custom_message',
                            customType: 'subagent_result',
                            content: 'Done background search',
                        },
                        children: [
                            {
                                entry: {
                                    id: 'asst-1',
                                    type: 'message',
                                    message: {
                                        role: 'assistant',
                                        content: [
                                            {
                                                type: 'toolCall',
                                                id: 'tc-1',
                                                name: 'read',
                                                arguments: { path: '/home/test-user/test.ts', offset: 1, limit: 10 },
                                            },
                                        ],
                                    },
                                },
                                children: [
                                    {
                                        entry: {
                                            id: 'tool-res-1',
                                            type: 'message',
                                            message: {
                                                role: 'toolResult',
                                                toolCallId: 'tc-1',
                                                content: 'file contents',
                                            },
                                        },
                                        children: [],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ];

        const formatted = formatSessionTree(rawTree as any, 'tool-res-1');
        expect(formatted).toHaveLength(4);

        // custom
        expect(formatted[0].role).toBe('custom');
        expect(formatted[0].displayText).toBe('[custom: subagent_start]');
        expect(formatted[0].indent).toBe(0);

        // custom_message
        expect(formatted[1].role).toBe('custom_message');
        expect(formatted[1].displayText).toBe('[subagent_result]: Done background search');
        expect(formatted[1].indent).toBe(0);

        // assistant with toolCall (single-child keeps indent flat)
        expect(formatted[2].indent).toBe(0);

        // toolResult mapped to toolCall
        expect(formatted[3].role).toBe('toolResult');
        expect(formatted[3].displayText).toBe('[read: ~/test.ts:1-10]');
        expect(formatted[3].indent).toBe(0);
    });

    it('creates branch indents and connectors when a node has multiple children', () => {
        const rawTree = [
            {
                entry: {
                    id: 'root',
                    type: 'message',
                    message: { role: 'user', content: 'Root question' },
                },
                children: [
                    {
                        entry: {
                            id: 'branch-1',
                            type: 'message',
                            message: { role: 'assistant', content: [{ type: 'text', text: 'Answer 1' }] },
                        },
                        children: [],
                    },
                    {
                        entry: {
                            id: 'branch-2',
                            type: 'message',
                            message: { role: 'assistant', content: [{ type: 'text', text: 'Answer 2' }] },
                        },
                        children: [],
                    },
                ],
            },
        ];

        const formatted = formatSessionTree(rawTree as any, 'branch-1');
        expect(formatted).toHaveLength(3);
        expect(formatted[0].indent).toBe(0);
        // Children of branching root have indent 1 and connector prefixes
        expect(formatted[1].indent).toBe(1);
        expect(formatted[1].treePrefix).toContain('├─');
        expect(formatted[2].indent).toBe(1);
        expect(formatted[2].treePrefix).toContain('└─');
    });
});
