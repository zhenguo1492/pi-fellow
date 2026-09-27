import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOST_TOOLS_FILE_ENV } from '../../../pi/hostToolsProtocol';
import { PiHostTools } from '../../../pi/piHostTools';
import type { PiRpcOutbound, RpcHostToolDefinition } from '../../../pi/rpcTypes';
import hostToolsExtension from '../../../piExtension/hostTools';

type RegisteredTool = Parameters<Parameters<typeof hostToolsExtension>[0]['registerTool']>[0];

const tool = (name: string): RpcHostToolDefinition => ({
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
});

/**
 * Pi's side, reduced to what the bundled extension touches: the tool registry and active set, and
 * RPC-mode dialogs, whose frames go through the bridge's PiHostTools like stdout lines would.
 */
function fakePi(host: PiHostTools) {
    const tools = new Map<string, RegisteredTool>();
    let active = ['read', 'grep'];
    let command: (() => Promise<void>) | undefined;
    const emitted: PiRpcOutbound[] = [];
    const dialogs = new Map<string, (value: string | undefined) => void>();
    let nextId = 1;
    const emit = (frame: PiRpcOutbound) => {
        const out = host.translate(frame);
        if (out) {
            emitted.push(out);
        }
    };
    const ctx = {
        ui: {
            input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined> {
                const id = `ui${nextId++}`;
                const { promise, resolve } = Promise.withResolvers<string | undefined>();
                dialogs.set(id, resolve);
                // Like pi's RPC mode: an aborted dialog resolves undefined and forgets its id.
                opts?.signal?.addEventListener('abort', () => {
                    dialogs.delete(id);
                    resolve(undefined);
                });
                emit({ type: 'extension_ui_request', id, method: 'input', title, placeholder } as PiRpcOutbound);
                return promise;
            },
            setStatus(key: string, text: string | undefined) {
                emit({ type: 'extension_ui_request', id: `ui${nextId++}`, method: 'setStatus', statusKey: key, statusText: text } as PiRpcOutbound);
            },
        },
    };
    hostToolsExtension({
        registerCommand: (_name, options) => {
            command = () => options.handler('', ctx);
        },
        registerTool: (def) => {
            tools.set(def.name, def);
            active = [...new Set([...active, def.name])];
        },
        getActiveTools: () => active,
        setActiveTools: (names) => {
            active = names;
        },
    });
    return {
        tools,
        emitted,
        active: () => active,
        reload: () => command!(),
        call: (name: string, args: unknown, signal?: AbortSignal) => tools.get(name)!.execute(`call-${name}`, args, signal, undefined, ctx),
        /** The bridge writing an extension_ui_response line. */
        answer: (response: { id: string; value: string }) => dialogs.get(response.id)?.(response.value),
    };
}

describe('Pi host tools emulation', () => {
    let host: PiHostTools;

    beforeEach(() => {
        host = new PiHostTools();
        process.env[HOST_TOOLS_FILE_ENV] = host.file;
    });

    afterEach(() => {
        host.dispose();
        delete process.env[HOST_TOOLS_FILE_ENV];
    });

    it('registers the tool set from the file on load, as after a session switch', () => {
        host.writeTools([tool('tell_worker'), tool('stop_worker')]);
        const pi = fakePi(host);
        expect([...pi.tools.keys()]).toEqual(['tell_worker', 'stop_worker']);
        expect(pi.active()).toEqual(['read', 'grep', 'tell_worker', 'stop_worker']);
    });

    it('replaces the active host tools on reload and keeps the built-ins', async () => {
        host.writeTools([tool('a'), tool('b')]);
        const pi = fakePi(host);
        host.writeTools([{ ...tool('b'), description: 'new b' }, tool('c')]);
        await pi.reload();
        expect(pi.active()).toEqual(['read', 'grep', 'b', 'c']);
        expect(pi.tools.get('b')!.description).toBe('new b');
    });

    it('turns a call into host_tool_call and the host result into the tool result', async () => {
        host.writeTools([tool('echo')]);
        const pi = fakePi(host);
        const result = pi.call('echo', { text: 'hi' });
        expect(pi.emitted).toEqual([{ type: 'host_tool_call', id: 'ui1', toolName: 'echo', arguments: { text: 'hi' } }]);
        pi.answer(host.response('ui1', { content: [{ type: 'text', text: 'echoed hi' }] }) as { id: string; value: string });
        await expect(result).resolves.toEqual({ content: [{ type: 'text', text: 'echoed hi' }], details: undefined });
    });

    it('fails the tool call for an error result', async () => {
        host.writeTools([tool('echo')]);
        const pi = fakePi(host);
        const result = pi.call('echo', {});
        pi.answer(host.response('ui1', { content: [{ type: 'text', text: 'worker is busy' }], isError: true }) as { id: string; value: string });
        await expect(result).rejects.toThrow('worker is busy');
    });

    it('withdraws an aborted call with host_tool_cancel naming the call id, once', async () => {
        host.writeTools([tool('echo')]);
        const pi = fakePi(host);
        const ctl = new AbortController();
        const result = pi.call('echo', {}, ctl.signal);
        ctl.abort();
        await expect(result).rejects.toThrow('echo was cancelled');
        expect(pi.emitted[1]).toEqual({ type: 'host_tool_cancel', targetId: 'ui1' });
        // A late cancel status for the same call (or any answered one) is swallowed.
        expect(host.translate({ type: 'extension_ui_request', id: 'x', method: 'setStatus', statusKey: 'vscode-host-tool-cancel', statusText: 'call-echo' } as PiRpcOutbound)).toBeNull();
    });

    it('passes other extension UI requests through untouched', () => {
        const frame = { type: 'extension_ui_request', id: 'u9', method: 'input', title: 'Your name?' } as PiRpcOutbound;
        expect(host.translate(frame)).toBe(frame);
    });
});
