/** Shared session types (no Pi SDK dependency). */

export interface PlanModeSessionLike {
    messages?: unknown[];
    sessionManager?: {
        getEntries?: () => Array<{ type: string; customType?: string; data?: unknown }>;
        getBranch?: () => Array<{
            type?: string;
            customType?: string;
            content?: unknown;
            message?: { role?: string; toolName?: string; details?: unknown };
        }>;
    };
    getActiveToolNames?: () => string[];
}
