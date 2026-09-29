# Permission modes (Manual / Edit automatically / Plan / Auto)

Mode names follow Claude's. Internal values are `ask` / `edit` / `plan` / `auto` (`PermissionLevel`).

## Choosing a mode

- The button to the right of the model chip, below the composer, opens the "Modes" menu (`src/webview/chat/permission.ts`, message `setPermissionLevel`). The mode is per tab.
- A new tab takes the mode last picked from that menu in this workspace (`workspaceState` key `oh-my-pi-chater.lastPermissionLevel`, `newTabPermissionLevel`). If nothing was ever picked, it uses `oh-my-pi-chater.defaultPermissionLevel`; when that is unset, the legacy `autoApproveTools` applies (true → Auto, otherwise Manual). Changing `defaultPermissionLevel` clears the last-picked mode.
- Each session's mode is remembered per session file (canonical path) in `oh-my-pi-chater.sessionPermissions` (at most 500 entries, oldest dropped first). It is written by `_persistOpenTabs` and on tab close, and applied before loading by `loadSessionIntoTab` (shared by startup restore and the resume panel), so a session that is closed and reopened keeps its own mode.

## The worker gate

Every chat worker (omp and pi) loads `src/piExtension/permissionGate.ts` via `--extension out/pi-extension/permissionGate.js` and decides in its `tool_call` event. The rules live in `toolTier` in `src/pi/permissionPolicy.ts`:

| Tier | Tools |
|---|---|
| `read` | Read-only allowlist, and writes to `local://` / `memory://` / `xd://`. Always allowed in every mode. |
| `write` | `edit`, `write`, `ast_edit`, lsp rename / applying a code action — only changes file contents. |
| `exec` | Everything else (`bash`, `eval`, `task`, `browser`, MCP, unknown tools), plus edits that delete or move files (hashline `REM`/`MV`, apply_patch `*** Delete File:` / `*** Move to:`, patch-form `op: 'delete'` / `rename`). |

| Mode | `write` | `exec` |
|---|---|---|
| Manual | ask | ask |
| Edit automatically | allow | ask |
| Plan | block | block |
| Auto | allow | allow |

- Plan returns `{ block, reason }`, telling the model it is in read-only planning mode.
- An "ask" is a `select` "`Allow tool: <name>` / Approve·Deny" (same format as omp's own approvals). It goes through the `RpcExtensionUiHandler` dialog, so the voice agent can also answer it with `answer_worker`.
- Tools listed in `oh-my-pi-chater.allowedTools` skip approval in Manual / Edit automatically.
- The mode is written to a per-process temp file (`PermissionGateFile` in `src/pi/permissionGate.ts`, env `VSCODE_PI_PERMISSION_FILE`). The gate rereads it on every call, so switching modes needs no restart.
- The gate also reports back: for each call it does not block (allowed, or about to ask), it appends the files the call will change, as one NDJSON line `{"paths":[…]}`, to a second per-process temp file (env `VSCODE_PI_EDITS_FILE`) before the tool runs. The host reads it as the worker file lock that keeps the voice agent off those files until the task ends; see [voice-pair-agent-cursor.md §11](./voice-pair-agent-cursor.md#11-working-beside-the-worker-the-file-lock-2026-09-29).
- In Auto, the host also auto-approves omp's own `Allow tool:` approvals (`RpcExtensionUiHandler.autoApproveTools`).

## Tabs showing their TUI

A tab in TUI mode runs the CLI's own TUI, not the RPC worker, so the gate above is not loaded there: the TUI's own approval settings decide (omp's `tools.approvalMode`, pi has none of its own). Its approval prompts and extension dialogs show as the same dialog cards as a chat tab's (`src/webview/extensionUi.ts`), answered by keys typed into the TUI instead of over RPC; the mode menu does not auto-approve them. See [tabs-and-tui.md](./tabs-and-tui.md#dialog-cards-for-a-tuis-own-dialogs).

## Plan mode on pi

For pi, Plan is pi's own plan mode (pi-plan-mode):

1. Picking Plan first sets `TabState.readOnlyPlan` so the gate is read-only.
2. Once `setAgentMode('plan')` confirms, control is handed to pi (`releasePlanToPi`). While pi's plan mode is on, the gate allows everything; pi-plan-mode blocks tools in its own `tool_call` handler.
3. When pi leaves plan mode (Implement, or its own menu), the gate returns to the tab's `permissionBase` (Manual / Edit automatically / Auto).

The title bar only has the Implement button; there is no second Plan toggle.

## Voice agent tools

`PERMISSION_TIER` in `HostToolRouter` (`src/voiceAgent/hostTools.ts`) splits the voice agent's own tools into `write` (`edit_file`, `create_file`, `create_folder`, `save_file`) and `exec` (`run_in_terminal`, `debug_start`, `delete_file`, `rename_file`). Rules match the worker: Plan refuses; Manual asks for both; Edit automatically asks only for `exec`. Before these checks, the worker file lock refuses a change to a file the worker's running task is changing (a deletion is then not even asked about).

- When approval is needed, `_holdForApproval` raises an approval card above the composer via `WorkerController.requestToolApproval` (`#tool-approval-host`, rebuilt from `pendingToolApprovals` in stateSync, visible in Bot view too). The tool call returns **immediately** with "waiting for approval", so the voice agent can tell the user to click right away (it cannot speak while a tool call is pending). Pending cards appear in each turn's message as `<approval-pending>`.
- When the user clicks, an approval runs the action (checking Plan and the worker file lock once more first; a refusal settles as "Not done: …"). The result goes to `takeSettledApprovals`; `onApprovalSettled` triggers an `approval` observation and the voice agent proactively speaks the result (`<approval-settled>`).
- `delete_file` still keeps its two-turn verbal confirmation; the card is raised only when the delete actually happens.

## Reminding the user to approve

- `approval` (the result of the voice agent's own card) has the highest priority in `FloorArbiter` and does not wait for a quiet gap.
- A worker request is announced even with `voiceAgent.narration` off when `WorkerStatus.fromVoice` is true (the worker's current instruction came from the voice agent, judged by `voiceOrigins` on the latest user message). `_describe` makes it remind the user to approve/deny in the chat or tell it verbally.
- Both only consider the current (voice-bound) tab.
