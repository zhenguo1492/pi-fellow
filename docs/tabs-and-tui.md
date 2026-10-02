# Tabs, startup, and TUI mode

## Multi-tab sessions

- `SidebarProvider` (`src/providers/sidebar.ts`) keeps `tabs: Map<string, TabState>` and `activeTabId`, per backend (`src/providers/sidebarBackends.ts`).
- Each tab has its own `PiChatSession` (its own omp/pi process). Switching tabs pushes that tab's full history and streaming state via `pushStateSync`, so tabs never interfere.

### No tabs

- Every tab can be closed, the last one too (`SidebarTabs._closeTab`; each tab, in the strip and in the overflow menu, has its ×). Then `activeTabId` is `''` and `activeTab` is undefined: host code takes no tab for granted.
- The chat gets a `stateSync` with no tabs (`tabs: []`, `activeTabId: ''`, the backend and voice status) and shows its empty state (`#app.no-tabs-mode`, `.no-tabs` in `src/webview/chat/layout.ts`, `styles/chat/welcome.css`): the Bot view's intro (`voiceIntro` in `src/webview/voicePanel.ts`: the voice agent's avatar, name, what it does, the speech-to-text and text-to-speech rows; see [voice-agent.md](./voice-agent.md)), its **Call** button while voice mode is off, then **Open worker** (`createTab`) and **Resume a session** (the resume panel). A call needs a tab: Call sends `callInNewTab`, and `SidebarBotView` opens a new tab, awaits `tabReady`, and starts voice mode as the phone button does, unless the user left that tab meanwhile (a worker that failed to start shows its error instead). The conversation, composer, model status, TUI toggle and mode switch are hidden; the header's New Agent, Resume and Settings stay.
- Webview messages: a handler that takes the tab (`MessageHandler`'s second parameter) runs only while a tab is open; one that takes none (tabs, resume panel, settings, TUI auth, voice) runs anyway (`SidebarProvider._handleMessage` dispatches by the handler's arity).
- The resume panel lists the workspace folder's sessions of the current backend, and a resumed session opens in a new tab. The New Chat command opens a new tab. Commands that act on the shown tab's session (select model, thinking level, reload, packages) do nothing; Settings works without a session, as for another backend's tab.
- Persisted open tabs are then none; the next window starts with one new tab, as when nothing was open. Switching the backend (Settings) to one with no tabs restores its open tabs or opens a new one.

### Composer drafts per tab

`src/webview/chat/stateSync.ts` calls `stashComposerDraft` before replacing the current tab's state and `restoreComposerDraft` after rebuilding the composer. `src/webview/chat/composer.ts` saves unsent text, selection, height, and any edit-and-resend context.

- Drafts live only in the current webview's memory; they do not survive a window reload.
- Once sent or manually cleared, a draft does not come back.
- On restore, only drafts of closed tabs of the *current* backend are pruned; switching backends does not delete the other backend's drafts.

### Opening a session from the resume panel

- Already open in some tab → switch to that tab.
- Otherwise open a new tab (`createEmptyTabState(backend, session cwd)`) and load it there, without overwriting the current tab. The current tab is reused only when it is a blank conversation (no messages, idle, not in Bot view, same backend and directory).
- Loading goes through `SidebarTabs.loadSessionIntoTab` (`src/providers/sidebarTabs.ts`), shared with startup restore: a history-loading placeholder is shown, `tabReady` blocks sending, and the title starts as the session name. On failure the new tab is closed and the original tab and backend are restored.
- If the current tab is in TUI mode, a new tab is opened and the TUI is started in it.

## Startup does not block the sidebar

- `activate` contains no `await`. The main session's `initialize()` runs in the background and the sidebar registers immediately. CLI check, native module preflight, and cleanup of extension-side API keys only report in the background.
- Previously open tabs are restored in parallel by `restorePersistedTabs` (one omp/pi process per tab, all started at once, not awaited).
- While a process is not ready, stateSync's `connectionStatus` is `connecting` (`tabConnectionStatus`) and "Starting omp…" shows above the composer. While a session is being restored, `restoringHistory` is true and the message area shows a "Loading conversation history…" placeholder instead of the welcome page.

## Tab ready gate

Sending, queueing, slash commands, the voice worker, and TUI startup all first `await tabReady(tab)` (process ready **and** `tab.restoring` finished). Do not use `session.isReady` / `waitUntilReady()` to decide whether a prompt can be sent — the prompt could land in a tab that has not finished restoring.

## Prewarm

While the window's first process starts and while tabs are being restored, `SidebarBackends.holdPrewarm()` pauses prewarming. The prewarm process starts 1.5 s after all holds are released.

## Model and skill lists

`get_available_models` waits for omp's provider discovery (local ports + network, from ~0.5 s). So `_refreshModelsAndSkills` runs in the background both at initialization and in `syncFromRpc`; when the list changes, `onDidChangeCatalog` tells tabs to resend the model bar and skills. The last result per backend + directory is cached in `catalogByWorkspace`, and new processes show it first.

## TUI mode (per tab)

- The title-bar TUI toggle only affects the current tab (`TabState.tuiMode`, sent to the webview as `TabInfo.tuiMode`). Other tabs keep their own chat/TUI view. Switching back to chat stops and reloads only that tab.
- Entering TUI is refused only when the current tab is streaming.
- TUI mode is persisted with open tabs (`PersistedOpenTabs.tuiSessionPaths`, keyed by session file). The context key `oh-my-pi-chater.tuiMode` reflects the current tab.
- Code: `src/providers/sidebarTuiMode.ts` (mode switching), `src/providers/sidebarTui.ts` (`TabTuis`, PTY processes), `src/pi/tuiTerminal.ts`, `src/webview/tuiView.ts`.

### TUI tabs and the voice agent

- A TUI tab can show the Bot view over its terminal: the tab icon and the voice bar's Bot view button toggle `botView` as in a chat tab (`SidebarBotView`), and the webview hides the terminal pane without disposing it (`syncTuiView(…, shown)`, `tabView` in `src/webview/chat/tabs.ts`), so the TUI keeps running and its screen is intact on the way back. Focus in the terminal moves to the composer, which in the Bot view talks to the voice agent; showing the terminal again focuses it. Entering TUI mode clears `botView` (the terminal shows first), and the voice agent never opens the Bot view over a TUI on its own (`showBotView` with `onlyIfWorkerUnused`).
- With the terminal shown, the composer area keeps only the voice status bar and approval cards. The voice agent can still be toggled, talked to, and use pair tools.
- The TUI owns the session file (design §5.12 rule 7), so the idle RPC worker is never used for a TUI tab. The voice agent drives the TUI itself, through the same omp-mode tools (`SidebarWorker`, `src/providers/sidebarWorker.ts`):
  - `tell_worker` pastes the message into the TUI's editor (bracketed paste) and submits it (`tuiPromptKeys`, `sidebarTui.ts`): Enter starts a turn, or steers a running one; `when=after` on a running TUI queues a follow-up (omp Ctrl+Q, pi Alt+Enter, or Ctrl+Q on Windows/WSL). A new task still goes through the proposal and go-ahead. It waits for `tabReady` and the TUI's input readiness (`typeWhenReady`).
  - `worker_status` returns the TUI's screen as text (`readTuiScreen`); `stop_worker` sends Escape (`TUI_INTERRUPT`); `answer_worker` types the user's answer (`value` and named `keys`, via `terminalKeys`) and returns the redrawn screen (`typeIntoTui`). The TUI's dialogs are not worker requests: the voice agent hears the question with the stop (below) or reads it off the screen, and presses keys per the user's words; the user can also answer the dialog's card.
  - `status()` reports `tui: true`, the phase from `tuiBusy`, no pending requests, and `fromVoice` from `TabState.tuiPromptFromVoice` (set when the voice agent submits a prompt, cleared when the user presses Enter in the TUI).

### Reading the screen

`TuiProcess` already parses all PTY output into a headless xterm mirror (`@xterm/headless`, bundled into `out/extension.js`). `ScreenReader` (`src/pi/terminalScreen.ts`) reads it for the voice agent:

- A read is the visible screen as text: soft-wrapped rows joined, trailing spaces and bottom blank rows dropped. The same screen as the previous read returns `NO_CHANGE` instead.
- `pagesBack` n reads n screens above it from the mirror's scrollback, which does not move the user's view. On the alternate screen (a full-screen program keeps no scrollback) it sends PageUp n times, waits for the redraw to go quiet, reads, then sends PageDown n times.
- `type(keys)` sends keys, waits for the redraw, and reads. `tail(n)` gives the last lines without counting as a read.

The voice agent's Pi terminals use the same reader (see [voice-agent.md](./voice-agent.md)).

### TUI busy state

A TUI run does not go through the RPC worker, so busy state is inferred:

1. After the TUI starts, `TabTuis` creates a `SessionActivityWatcher` (`src/pi/sessionActivity.ts`) on its session file: `fs.watchFile` polling every 500 ms, reading only complete appended lines, rescanning from the start if the file shrinks. user / toolResult / assistant with `stopReason: toolUse` mean working; any other assistant end (stop, aborted, error) means idle (`sessionEntryBusy`).
2. `TabTuis` combines this with what the TUI draws: busy only when the file says running **and** the screen's text keeps changing (`onScreenChange` from `TuiProcess`, via `watchScreenText` on the headless mirror: omp / pi spinners and elapsed timers change it several times a second while working). 3 s without new text (`TUI_QUIET_MS`) ends the busy state, covering interrupts the file never records and a TUI waiting on the user: omp's approval dialog ("Allow tool: bash") leaves the file at an assistant `toolUse` entry and keeps sending ~6 KB/s that only recolor its status line, so counting bytes kept it busy until the task ended (captured 2026-09-29). New text while the file still says running makes it busy again.
3. The result goes through `busyChanged` into `TabState.tuiBusy`; `getTabInfos` merges it into `TabInfo.isStreaming`, and the tab icon shows a colored spinning terminal icon. A background tab that finishes gets `hasNotification`.
4. `SidebarTuiMode` also turns each change into a worker event for the voice agent: `tui_run_start`, and on busy → idle `tui_run_end` with the screen's last 15 lines once output has gone quiet, plus `question` (method, title, message, options) when the TUI waits on a dialog a card can answer. The voice agent's arbiter turns the end into a `stopped` proactive turn right away (it may be an approval that should not wait), whose update states the question and choices (`tuiQuestionLine`); none is sent when the TUI was stopped or exited with the run on.

Watchers are removed and busy state ends when the TUI stops or exits. Only the session file present at TUI start is followed: after `/new` or `/resume` inside the TUI, its state is no longer reflected. Unit tests: `src/test/unit/pi/sessionActivity.test.ts`, `src/test/unit/providers/sidebarTui.test.ts`.

### Dialog cards for a TUI's own dialogs

When a TUI waits on the user (a tool approval, or an extension's select, confirm, input or editor), the tab shows the same dialog card a chat tab shows for an RPC `extension_ui_request` (`src/webview/extensionUi.ts`), above the composer and under the terminal (`#app.tui-mode` keeps `.extension-ui-host`). One card UI, two answer paths behind `ExtensionUiAnswerer` (`src/shared/extensionUi.ts`): `RpcExtensionUiHandler` sends the answer back over RPC; `TuiDialogs` (`src/providers/sidebarTuiDialogs.ts`) types it into the TUI. `extensionUiResponse` picks the path by card id (`TuiDialogs.owns`: `tui-<tabId>-<n>`).

- **When it looks.** `TabTuis` asks for a check (`screenChanged`) once after the screen's text stops changing and at most every 500 ms while it keeps changing (`DIALOG_CHECK_MS`), when the TUI sets its terminal title, and at once when it stops or exits. `TuiDialogs.check` reads the whole screen (`ScreenReader.peek`, not a read, so the voice agent's "no change" is unaffected) and shows, keeps, replaces or drops the card. A card goes as soon as its dialog is off the screen, however it was answered (in the TUI, by the voice agent, by a timeout); a moved cursor keeps it.
- **What it reads.** `parseTuiDialog` (`src/pi/tuiDialog.ts`, pure) finds the dialog by its hint line, then reads the rows above it. omp: a box whose top border is the title (`╭─ Allow tool: bash ─╮`, countdown `(12s)` dropped); select hint `up/down navigate  enter select  esc cancel`, options `  ❯ x` (cursor) and `    x`, one-space rows the message (`Command: …`, `Reason: …`), `(k/N)` a scrolled list; input `enter submit  esc cancel`; editor `… submit  esc cancel  ctrl+g external editor` (both styles submit with Ctrl+Q). pi: between full-width rules; select hint `↑↓ navigate  enter select  … cancel`, options ` → x` and `   x`, title and message the one-space rows above; input `enter submit  … cancel`; editor `enter submit  … newline  … cancel  … external editor` (Enter submits, the text between its own rules). A select with exactly Yes / No is a confirm. Nothing is taken from omp's dialog wording beyond these hints.
- **Fallback.** A dialog no card can answer shows as a screen card: its text as is, and a Show the terminal button (`showTui`: clears `botView`, switching to the tab; the webview also focuses the terminal at once when it already shows, `focusTui`, else the sync that shows it does, so keys go to the TUI without clicking into it). That covers omp's multi-select (`enter toggle`), a multi-select question of the ask panel (`Space toggle`), an ask question whose options scroll, an ask panel whose active tab cannot be seen or whose tabs wrap, a list longer than the screen, a text field that already holds text, a layout not recognized, and an omp screen with no dialog found while its terminal title is `π ! …` (omp's attention state, set for approvals and `ask`; pi has no such signal). The user can also answer by voice.
- **Answering.** `tuiAnswerPlan`: select and confirm move the cursor from the row it is on with ↑/↓ (`terminalKeys`), then Enter, but only after the screen shows the cursor on that option; input is typed as one line of plain characters, then Enter; editor text is pasted (bracketed, so newlines stay) and submitted with Ctrl+Q (omp) or Enter (pi); cancel is Escape. After the submit the screen is read again: a dialog still open, or a cursor that did not land, replaces the card with the screen card. Checks wait while an answer is being typed.
- **omp's ask panel** (AskDialogComponent, the model's `ask` tool with several questions) is answered like omp's own RPC fallback: one select card per question, in tab order, then Submit. `parseTuiDialog` reads it as `kind: 'ask'`: the box titled `Ask`, the tab bar (question ids, then `Submit`), the question, the options (`❯` cursor, `○` / `◉` unchosen / chosen, `Other (type your own)` last), and the footer (`Enter select · n note · …`; `Enter submit · …` on the Submit tab, where the review lines show). The active tab is marked only by its background, so the cards read the screen with `ScreenReader.peek()`, which returns `screenSnapshot`: the text plus a `highlight` of what is drawn on a background color, line for line. A question's card is a select with `Question k of N` and what is already chosen; the Submit tab's card is a select of `Submit` with the review as its message. Picking an option moves the cursor there (checked), presses Enter, and checks that the panel moved to the next tab (`tuiAnswerLanded`); the next check shows that question's card. Other opens omp's own editor (`Custom answer: …`), shown as the usual editor card. When the answers reach the Submit tab, Enter submits the panel; a single question has no tabs and submits on Enter. Cancelling any card of the panel sends Escape, twice from Other's editor (the first only closes the editor), which cancels the whole panel. Before each step the dialog is read afresh: another tab than the card's, a cursor that did not land, or a tab that did not move on shows the panel's box as the screen card instead. `TuiDialogs.question` (and so the voice agent's `stopped` update) gives the current question and its options.
- The card's keyboard shortcuts (digits, Escape) do not apply while focus is in the terminal, and a new card does not take focus from it: keys typed into the TUI stay the TUI's.
- Screens captured from omp 18.2.11 and pi 0.87.1 for each kind are the tests' fixtures (`src/test/unit/pi/fixtures/tuiDialogs/`): `.txt` the text, `.ans` the ask panel's screens serialized with their colors, replayed by `src/test/unit/pi/tuiScreens.ts`. pi 0.99.1 was checked against them (2026-09-30): its select, confirm, input, editor, long-list and approval-like dialogs draw the same rows and hint lines (its screens differ only in startup notices above the dialog, so no fixtures were added), and the answer keys above (↓/↑ then Enter, typed text then Enter, bracketed paste then Enter, Escape) answer them.
