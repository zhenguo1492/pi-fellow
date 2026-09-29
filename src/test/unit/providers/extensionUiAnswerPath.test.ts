import { describe, expect, it, vi } from 'vitest';
import type { SidebarHost } from '../../../providers/sidebarHost';
import { conversationHandlers } from '../../../providers/sidebarMessageHandlers';
import type { TabState } from '../../../providers/sidebarTabState';

vi.mock('vscode', () => ({ commands: { executeCommand: async () => undefined }, window: {}, workspace: {} }));
vi.mock('../../../pi/piAgentConfig', () => ({ updatePiDefaults: () => undefined }));
vi.mock('../../../providers/settings-panel', () => ({ SettingsPanel: {} }));
vi.mock('../../../providers/plan-document', () => ({ openPlanDocument: async () => undefined }));
vi.mock('../../../providers/sidebarTabState', () => ({}));
vi.mock('../../../providers/sidebarPermission', () => ({ applyTabPermission: () => undefined }));

describe('extensionUiResponse: one card UI, two answer paths', () => {
    function setup() {
        const rpc = { respond: vi.fn(() => true) };
        const tui = { owns: (id: string) => id.startsWith('tui-'), respond: vi.fn(() => true) };
        const tab = { session: { rpcExtensionUi: rpc } } as unknown as TabState;
        const handlers = conversationHandlers({} as SidebarHost, {} as never, tui);
        return { rpc, tui, tab, respond: (msg: object) => handlers.extensionUiResponse!({ type: 'extensionUiResponse', ...msg } as never, tab) };
    }

    it("types a TUI dialog card's answer into the TUI, and sends a worker's back over its RPC", () => {
        const { rpc, tui, respond } = setup();
        respond({ id: 'tui-tab-1-1', value: 'Approve' });
        respond({ id: 'ui_7', confirmed: false });
        expect(tui.respond).toHaveBeenCalledExactlyOnceWith({ id: 'tui-tab-1-1', cancelled: undefined, value: 'Approve', confirmed: undefined });
        expect(rpc.respond).toHaveBeenCalledExactlyOnceWith({ id: 'ui_7', cancelled: undefined, value: undefined, confirmed: false });
    });
});
