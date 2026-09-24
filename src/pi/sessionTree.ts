import type { SessionTreeNodeData } from '../shared/protocol';

export interface RawSessionTreeNode {
    entry: {
        id: string;
        parentId?: string | null;
        timestamp?: number | string;
        type: string;
        message?: {
            role?: string;
            content?: unknown;
            command?: string;
            errorMessage?: string;
            stopReason?: string;
            toolCallId?: string;
            toolName?: string;
        };
        summary?: string;
        tokensBefore?: number;
        name?: string;
        label?: string;
        customType?: string;
        content?: unknown;
        modelId?: string;
        thinkingLevel?: string | number;
        replacement?: unknown;
        targetId?: string;
    };
    children?: RawSessionTreeNode[];
    label?: string;
    labelTimestamp?: string;
}

interface ToolCallInfo {
    name: string;
    arguments: Record<string, unknown>;
}

function extractFullContent(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    let result = '';
    for (const block of content) {
        if (typeof block === 'object' && block !== null && 'type' in block) {
            const b = block as { type: string; text?: string };
            if (b.type === 'text') {
                result += b.text ?? '';
            }
        }
    }
    return result;
}

function normalizePreview(text: string, maxLen = 140): string {
    const singleLine = text.replace(/[\r\n\t]+/g, ' ').trim();
    if (singleLine.length <= maxLen) {
        return singleLine;
    }
    return singleLine.slice(0, maxLen) + '…';
}

function shortenPath(p: string): string {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home && p.startsWith(home)) {
        return `~${p.slice(home.length)}`;
    }
    return p;
}

function formatToolCall(name: string, args: Record<string, unknown> = {}): string {
    switch (name) {
        case 'read': {
            const rawPath = String(args.path || args.file_path || '');
            const displayPath = shortenPath(rawPath);
            const offset = args.offset;
            const limit = args.limit;
            let display = displayPath;
            if (offset !== undefined || limit !== undefined) {
                const start = offset ?? 1;
                const end = limit !== undefined ? Number(start) + Number(limit) - 1 : '';
                display += `:${start}${end ? `-${end}` : ''}`;
            }
            return `[read: ${display}]`;
        }
        case 'write': {
            const rawPath = String(args.path || args.file_path || '');
            return `[write: ${shortenPath(rawPath)}]`;
        }
        case 'edit': {
            const rawPath = String(args.path || args.file_path || '');
            return `[edit: ${shortenPath(rawPath)}]`;
        }
        case 'bash': {
            const rawCmd = String(args.command || '');
            const cmd = rawCmd.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 50);
            return `[bash: ${cmd}${rawCmd.length > 50 ? '...' : ''}]`;
        }
        case 'grep': {
            const pattern = String(args.pattern || '');
            const path = shortenPath(String(args.path || '.'));
            return `[grep: /${pattern}/ in ${path}]`;
        }
        case 'find': {
            const pattern = String(args.pattern || '');
            const path = shortenPath(String(args.path || '.'));
            return `[find: ${pattern} in ${path}]`;
        }
        case 'ls': {
            const path = shortenPath(String(args.path || '.'));
            return `[ls: ${path}]`;
        }
        default: {
            const argsStr = JSON.stringify(args) || '{}';
            const slice = argsStr.slice(0, 40);
            return `[${name}: ${slice}${argsStr.length > 40 ? '...' : ''}]`;
        }
    }
}

export function parseEntryText(
    entry: RawSessionTreeNode['entry'],
    toolCallMap: Map<string, ToolCallInfo> = new Map(),
): {
    role: string;
    preview: string;
    displayText: string;
    fullText: string;
} {
    const type = entry.type;

    if (type === 'message' && entry.message) {
        const msg = entry.message;
        const role = msg.role ?? 'unknown';

        if (role === 'user') {
            const full = extractFullContent(msg.content);
            const content = normalizePreview(full);
            return {
                role: 'user',
                fullText: full,
                preview: content,
                displayText: `user: ${content}`,
            };
        }
        if (role === 'assistant') {
            const full = extractFullContent(msg.content);
            if (full) {
                const content = normalizePreview(full);
                return {
                    role: 'assistant',
                    fullText: full,
                    preview: content,
                    displayText: `assistant: ${content}`,
                };
            }
            if (msg.stopReason === 'aborted') {
                return {
                    role: 'assistant',
                    fullText: '(aborted)',
                    preview: '(aborted)',
                    displayText: 'assistant: (aborted)',
                };
            }
            if (msg.errorMessage) {
                const errMsg = normalizePreview(msg.errorMessage, 80);
                return {
                    role: 'assistant',
                    fullText: msg.errorMessage,
                    preview: `Error: ${errMsg}`,
                    displayText: `assistant: Error: ${errMsg}`,
                };
            }
            return {
                role: 'assistant',
                fullText: '',
                preview: '(no content)',
                displayText: 'assistant: (no content)',
            };
        }
        if (role === 'toolResult') {
            const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : undefined;
            const full = extractFullContent(msg.content);
            if (toolCall) {
                const formatted = formatToolCall(toolCall.name, toolCall.arguments);
                return {
                    role: 'toolResult',
                    fullText: full,
                    preview: formatted,
                    displayText: formatted,
                };
            }
            const name = msg.toolName ?? 'tool';
            const display = `[${name}]`;
            return {
                role: 'toolResult',
                fullText: full,
                preview: display,
                displayText: display,
            };
        }
        if (role === 'bashExecution') {
            const cmd = (msg.command ?? '').replace(/[\r\n\t]+/g, ' ').trim();
            const display = `[bash]: ${cmd.slice(0, 50)}${cmd.length > 50 ? '...' : ''}`;
            return {
                role: 'bashExecution',
                fullText: msg.command ?? '',
                preview: display,
                displayText: display,
            };
        }
        return {
            role,
            fullText: extractFullContent(msg.content),
            preview: `[${role}]`,
            displayText: `[${role}]`,
        };
    }

    if (type === 'custom_message') {
        const full = typeof entry.content === 'string' ? entry.content : extractFullContent(entry.content);
        const content = normalizePreview(full);
        const customType = entry.customType || 'custom';
        const display = `[${customType}]: ${content}`;
        return {
            role: 'custom_message',
            fullText: full,
            preview: display,
            displayText: display,
        };
    }

    if (type === 'custom') {
        const customType = entry.customType || 'unknown';
        const display = `[custom: ${customType}]`;
        return {
            role: 'custom',
            fullText: '',
            preview: display,
            displayText: display,
        };
    }

    if (type === 'compaction') {
        const tokens = Math.round(Number(entry.tokensBefore ?? 0) / 1000);
        const sum = entry.summary ?? '';
        const display = `[compaction: ${tokens}k tokens]`;
        return {
            role: 'compaction',
            fullText: sum,
            preview: display,
            displayText: display,
        };
    }

    if (type === 'branch_summary') {
        const sum = (entry.summary ?? '').replace(/[\r\n\t]+/g, ' ').trim();
        const display = `[branch summary]: ${normalizePreview(sum)}`;
        return {
            role: 'branch_summary',
            fullText: entry.summary ?? '',
            preview: display,
            displayText: display,
        };
    }

    if (type === 'model_change') {
        const display = `[model: ${entry.modelId || ''}]`;
        return {
            role: 'model_change',
            fullText: '',
            preview: display,
            displayText: display,
        };
    }

    if (type === 'thinking_level_change') {
        const display = `[thinking: ${entry.thinkingLevel || ''}]`;
        return {
            role: 'thinking_level_change',
            fullText: '',
            preview: display,
            displayText: display,
        };
    }

    if (type === 'context_edit') {
        const display = `[context ${entry.replacement === null ? 'omit' : 'replace'}: ${entry.targetId || ''}]`;
        return {
            role: 'context_edit',
            fullText: '',
            preview: display,
            displayText: display,
        };
    }

    if (type === 'label') {
        const display = `[label: ${entry.label ?? '(cleared)'}]`;
        return {
            role: 'label',
            fullText: '',
            preview: display,
            displayText: display,
        };
    }

    if (type === 'session_info') {
        const name = entry.name ? entry.name : 'empty';
        const display = `[title: ${name}]`;
        return {
            role: 'session_info',
            fullText: entry.name ?? '',
            preview: display,
            displayText: display,
        };
    }

    return {
        role: type,
        fullText: '',
        preview: `[${type}]`,
        displayText: `[${type}]`,
    };
}

interface FlattenStackItem {
    node: RawSessionTreeNode;
    indent: number;
    justBranched: boolean;
    showConnector: boolean;
    isLast: boolean;
    gutters: Array<{ position: number; show: boolean }>;
    isVirtualRootChild: boolean;
    depth: number;
}

export function formatSessionTree(
    roots: RawSessionTreeNode[],
    currentLeafId: string | null,
): SessionTreeNodeData[] {
    if (!roots || roots.length === 0) {
        return [];
    }

    // 1. Tool call map & parent map index
    const toolCallMap = new Map<string, ToolCallInfo>();
    const parentMap = new Map<string, string | null>();

    function indexData(nodes: RawSessionTreeNode[], parentId: string | null) {
        for (const n of nodes) {
            const id = n.entry.id;
            parentMap.set(id, parentId);

            // Index tool calls from assistant message
            if (n.entry.type === 'message' && n.entry.message?.role === 'assistant') {
                const content = n.entry.message.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (typeof block === 'object' && block !== null && 'type' in block) {
                            const b = block as { type: string; id?: string; name?: string; arguments?: Record<string, unknown> };
                            if (b.type === 'toolCall' && b.id && b.name) {
                                toolCallMap.set(b.id, { name: b.name, arguments: b.arguments || {} });
                            }
                        }
                    }
                }
            }

            if (n.children && n.children.length > 0) {
                indexData(n.children, id);
            }
        }
    }
    indexData(roots, null);

    // 2. Trace active path from currentLeafId to root
    const activePathIds = new Set<string>();
    let curr = currentLeafId;
    while (curr) {
        activePathIds.add(curr);
        curr = parentMap.get(curr) ?? null;
    }

    // 3. Mark subtrees that contain active leaf for sorting
    const containsActive = new Map<RawSessionTreeNode, boolean>();
    {
        const allNodes: RawSessionTreeNode[] = [];
        const preOrderStack = [...roots];
        while (preOrderStack.length > 0) {
            const node = preOrderStack.pop()!;
            allNodes.push(node);
            const children = node.children || [];
            for (let i = children.length - 1; i >= 0; i--) {
                preOrderStack.push(children[i]);
            }
        }
        for (let i = allNodes.length - 1; i >= 0; i--) {
            const node = allNodes[i];
            let has = currentLeafId !== null && node.entry.id === currentLeafId;
            const children = node.children || [];
            for (const child of children) {
                if (containsActive.get(child)) {
                    has = true;
                }
            }
            containsActive.set(node, has);
        }
    }

    // 4. Flatten tree with exact TUI-style branch indent & gutters
    const multipleRoots = roots.length > 1;
    const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
    const stack: FlattenStackItem[] = [];

    for (let i = orderedRoots.length - 1; i >= 0; i--) {
        const isLast = i === orderedRoots.length - 1;
        stack.push({
            node: orderedRoots[i],
            indent: multipleRoots ? 1 : 0,
            justBranched: multipleRoots,
            showConnector: multipleRoots,
            isLast,
            gutters: [],
            isVirtualRootChild: multipleRoots,
            depth: 0,
        });
    }

    const result: SessionTreeNodeData[] = [];

    while (stack.length > 0) {
        const {
            node,
            indent,
            justBranched,
            showConnector,
            isLast,
            gutters,
            isVirtualRootChild,
            depth,
        } = stack.pop()!;

        const entry = node.entry;

        // Skip pure usage entries (matches CLI TUI TreeSelectorComponent)
        if (entry.type === 'usage') {
            continue;
        }

        const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
        const connector = showConnector && !isVirtualRootChild ? (isLast ? '└─ ' : '├─ ') : '';
        const connectorPosition = connector ? displayIndent - 1 : -1;

        // Build prefix chars
        const totalChars = displayIndent * 3;
        const prefixChars: string[] = [];
        for (let i = 0; i < totalChars; i++) {
            const level = Math.floor(i / 3);
            const posInLevel = i % 3;
            const gutter = gutters.find((g) => g.position === level);
            if (gutter) {
                if (posInLevel === 0) {
                    prefixChars.push(gutter.show ? '│' : ' ');
                } else {
                    prefixChars.push(' ');
                }
            } else if (connector && level === connectorPosition) {
                if (posInLevel === 0) {
                    prefixChars.push(isLast ? '└' : '├');
                } else if (posInLevel === 1) {
                    prefixChars.push('─');
                } else {
                    prefixChars.push(' ');
                }
            } else {
                prefixChars.push(' ');
            }
        }
        const treePrefix = prefixChars.join('');

        const { role, preview, displayText, fullText } = parseEntryText(entry, toolCallMap);
        const ts = typeof entry.timestamp === 'number'
            ? entry.timestamp
            : typeof entry.timestamp === 'string'
              ? new Date(entry.timestamp).getTime()
              : Date.now();

        result.push({
            id: entry.id,
            parentId: entry.parentId ?? null,
            timestamp: isNaN(ts) ? Date.now() : ts,
            type: entry.type,
            role,
            textPreview: preview,
            displayText,
            fullText,
            label: node.label ?? entry.label,
            labelTimestamp: node.labelTimestamp,
            isActivePath: activePathIds.has(entry.id),
            isCurrentLeaf: entry.id === currentLeafId,
            childrenCount: node.children?.length ?? 0,
            depth,
            indent: displayIndent,
            treePrefix,
            customType: entry.customType,
        });

        const children = (node.children || []).filter((c) => c.entry.type !== 'usage');
        const multipleChildren = children.length > 1;

        // Prioritize branch containing active leaf
        const orderedChildren = (() => {
            const prioritized: RawSessionTreeNode[] = [];
            const rest: RawSessionTreeNode[] = [];
            for (const child of children) {
                if (containsActive.get(child)) {
                    prioritized.push(child);
                } else {
                    rest.push(child);
                }
            }
            return [...prioritized, ...rest];
        })();

        // Calculate child indent: stay flat on single-child chain!
        let childIndent: number;
        if (multipleChildren) {
            childIndent = indent + 1;
        } else if (justBranched && indent > 0) {
            childIndent = indent + 1;
        } else {
            childIndent = indent;
        }

        const connectorDisplayed = showConnector && !isVirtualRootChild;
        const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
        const connPos = Math.max(0, currentDisplayIndent - 1);
        const childGutters = connectorDisplayed
            ? [...gutters, { position: connPos, show: !isLast }]
            : gutters;

        for (let i = orderedChildren.length - 1; i >= 0; i--) {
            const childIsLast = i === orderedChildren.length - 1;
            stack.push({
                node: orderedChildren[i],
                indent: childIndent,
                justBranched: multipleChildren,
                showConnector: multipleChildren,
                isLast: childIsLast,
                gutters: childGutters,
                isVirtualRootChild: false,
                depth: depth + 1,
            });
        }
    }

    return result;
}
