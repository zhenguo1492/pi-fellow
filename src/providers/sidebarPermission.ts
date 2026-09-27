import type * as vscode from 'vscode';
import { readAllowedTools, readDefaultPermissionLevel } from '../pi/permissionGate';
import { isPermissionLevel } from '../pi/permissionPolicy';
import { canonicalizeSessionPath } from '../pi/sessionCatalog';
import type { PermissionLevel } from '../shared/protocol';
import type { SidebarHost } from './sidebarHost';
import type { MessageHandlers } from './sidebarMessageHandlers';
import { tabPlanMode, type TabState } from './sidebarTabState';

/** A conversation's permission level (the composer's menu). */
interface PersistedPermission {
    base: Exclude<PermissionLevel, 'plan'>;
    plan: boolean;
}

/** The level last picked in the menu in this workspace: the level of new tabs. */
const LAST_PICK_STATE_KEY = 'oh-my-pi-chater.lastPermissionLevel';
/** Per conversation (canonical session path), so reopening it restores its level. */
const SESSION_PERMISSIONS_STATE_KEY = 'oh-my-pi-chater.sessionPermissions';
/** Oldest conversations are forgotten past this many. */
const MAX_SESSION_PERMISSIONS = 500;

/** Level of a new tab: the last pick in the menu; before any pick, the `defaultPermissionLevel` setting. */
export function newTabPermissionLevel(state: vscode.Memento): PermissionLevel {
    const picked: unknown = state.get(LAST_PICK_STATE_KEY);
    return isPermissionLevel(picked) ? picked : readDefaultPermissionLevel();
}

/** Changing the `defaultPermissionLevel` setting drops the last pick, so the setting applies to new tabs. */
export function forgetPermissionPick(state: vscode.Memento): Thenable<void> {
    return state.update(LAST_PICK_STATE_KEY, undefined);
}

function readSessionPermissions(state: vscode.Memento): Record<string, PersistedPermission> {
    const saved: unknown = state.get(SESSION_PERMISSIONS_STATE_KEY);
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...(saved as Record<string, PersistedPermission>) } : {};
}

/** Records the levels of the tabs that have a session file; most recent last, capped. */
export async function rememberSessionPermissions(state: vscode.Memento, tabs: Iterable<TabState>): Promise<void> {
    const saved = readSessionPermissions(state);
    let changed = false;
    for (const tab of tabs) {
        const sessionFile = tab.session.session?.sessionFile;
        if (!sessionFile) continue;
        const key = canonicalizeSessionPath(sessionFile);
        const previous = saved[key];
        if (previous?.base === tab.permissionBase && previous.plan === tab.readOnlyPlan) continue;
        delete saved[key];
        saved[key] = { base: tab.permissionBase, plan: tab.readOnlyPlan };
        changed = true;
    }
    if (!changed) return;
    const keys = Object.keys(saved);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SESSION_PERMISSIONS))) {
        delete saved[key];
    }
    await state.update(SESSION_PERMISSIONS_STATE_KEY, saved);
}

/** Gives `tab` the level its conversation last had; keeps the tab's own when it has none. */
export function applySessionPermission(state: vscode.Memento, tab: TabState, sessionPath: string): void {
    // Persisted workspace state: validated, not trusted.
    const saved: unknown = readSessionPermissions(state)[canonicalizeSessionPath(sessionPath)];
    if (!saved || typeof saved !== 'object') return;
    const { base, plan } = saved as Record<string, unknown>;
    tab.permissionBase = isPermissionLevel(base) && base !== 'plan' ? base : 'ask';
    tab.readOnlyPlan = plan === true;
    applyTabPermission(tab);
}

/** What the composer's permission menu shows for the tab. On pi, Plan is also pi's own plan mode being on. */
export function tabPermissionLevel(tab: TabState, piPlanEnabled?: boolean): PermissionLevel {
    if (tab.readOnlyPlan) {
        return 'plan';
    }
    if (tab.session.backend === 'pi' && (piPlanEnabled ?? tabPlanMode(tab).planMode.enabled)) {
        return 'plan';
    }
    return tab.permissionBase;
}

/**
 * Hands the tab's level to its worker's permission gate. While pi's own plan mode is on the gate
 * defers to it and the base level is what applies once pi leaves plan mode.
 */
export function applyTabPermission(tab: TabState): void {
    tab.session.setPermission({ level: tab.readOnlyPlan ? 'plan' : tab.permissionBase, allowedTools: readAllowedTools() });
}

/**
 * pi: once pi's own plan mode is on it owns the plan (and leaving it, e.g. "implement here" in its
 * menu), so the gate stops enforcing Plan itself. Called after entering plan mode and on each
 * state sync of the tab.
 */
export function releasePlanToPi(tab: TabState, piPlanEnabled: boolean): boolean {
    if (!tab.readOnlyPlan || tab.session.backend !== 'pi' || !piPlanEnabled) {
        return false;
    }
    tab.readOnlyPlan = false;
    applyTabPermission(tab);
    return true;
}

/**
 * The tab starts in Plan (default level): pi turns on its own plan mode. Until it confirms, and
 * when it has no plan mode (pi-plan-mode not installed), the gate enforces Plan.
 */
export async function enterPiPlanMode(host: SidebarHost, tab: TabState): Promise<void> {
    tab.planModeOverride = 'plan';
    try {
        await tab.session.setAgentMode('plan');
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        host.outputChannel.appendLine(`pi plan mode: ${message}; the permission gate keeps this tab read-only.`);
    } finally {
        tab.planModeOverride = undefined;
        releasePlanToPi(tab, tabPlanMode(tab).planMode.enabled);
    }
}

async function setPermissionLevel(host: SidebarHost, tab: TabState, level: PermissionLevel): Promise<void> {
    const isPi = tab.session.backend === 'pi';
    if (level === 'plan') {
        // Read-only at once, before pi (if pi) has switched its plan mode on.
        tab.readOnlyPlan = true;
        applyTabPermission(tab);
        if (!isPi) {
            return;
        }
        if (tabPlanMode(tab).planMode.enabled) {
            releasePlanToPi(tab, true);
        } else {
            await enterPiPlanMode(host, tab);
        }
        return;
    }
    tab.permissionBase = level;
    tab.readOnlyPlan = false;
    applyTabPermission(tab);
    if (isPi && tabPlanMode(tab).planMode.enabled) {
        tab.planModeOverride = 'agent';
        try {
            await tab.session.setAgentMode('agent');
        } finally {
            if (!tab.session.getPlanModeInfo().enabled) {
                tab.planModeOverride = undefined;
            }
        }
    }
}

export function permissionHandlers(host: SidebarHost, persist: () => void): MessageHandlers {
    return {
        setPermissionLevel: async (msg, tab) => {
            if (!isPermissionLevel(msg.level)) {
                throw new Error('Invalid permission level');
            }
            try {
                await setPermissionLevel(host, tab, msg.level);
                await host.workspaceState.update(LAST_PICK_STATE_KEY, msg.level);
            } finally {
                persist();
                await host.pushStateSync();
            }
        },
    };
}
