# AGENTS.md — Pi Fellow architecture and development guide

Pi Fellow (extension ID `GuoZheng.pi-fellow`, derived from the MIT-licensed [vscode-pi-agent](https://github.com/FChatin/vs-pi-agent)) puts the Pi coding agent (pi or omp) in the VS Code sidebar. This file is the entry point; details live in `docs/` (see [Topic docs](#topic-docs)).

## 1. What it is and how it works

- **No bundled SDK.** The extension does not bundle `@earendil-works/pi-coding-agent`. It spawns the local `pi` / `omp` CLI as `pi --mode rpc`.
- **Process RPC.** The extension host owns each `pi --mode rpc` child process and talks to it over stdin/stdout with NDJSON (JSON-RPC style requests, responses, and events).
- **Native webview.** The webview is plain TypeScript + DOM APIs + CSS variables — no React/Vue. Tool cards are native too (`src/webview/toolCards/`, ported from oh-my-pi `packages/collab-web/src/tool-render`).
- **One process per tab.** Every chat tab has its own `PiChatSession` and CLI process.

## 2. Directory structure

```
esbuild.js                  # Bundles extension + webviews into out/
package.json                # Manifest: commands, views, settings, keybindings
media/                      # Icons, VAD model (media/vad/silero_vad.onnx)
docs/                       # Topic docs (see below)
src/
├── extension.ts            # activate/deactivate; registers providers and commands
├── pi/                     # CLI processes and RPC
│   ├── piRpcBridge.ts      # Child process lifecycle, stdio RPC requests/responses/events
│   ├── rpcSession.ts       # PiChatSession: session state, prompt/abort/model/thinking
│   ├── rpcTypes.ts         # RPC message types
│   ├── rpcExtensionUi.ts   # RpcExtensionUiHandler: extension_ui_request dialogs/approvals
│   ├── permissionPolicy.ts # toolTier: read / write / exec classification
│   ├── permissionGate.ts   # PermissionGateFile: per-process mode file for the gate, and the edits file it reports to
│   ├── workerEdits.ts      # WorkerEditLocks: files the worker's running task changes (the voice agent's file lock)
│   ├── piAgentConfig.ts    # ~/.pi/agent/settings.json read/write/sync
│   ├── slashCommands.ts    # Slash commands (/help, /clear, /session, …)
│   ├── sessionActivity.ts  # SessionActivityWatcher: busy state from a session file (TUI)
│   ├── providerUsage.ts    # Subscription quota lookups for the model status bar
│   └── loggedInProviders.ts# Which providers are logged in (model list filter)
├── piExtension/            # Extensions loaded into the CLI (permissionGate.ts, hostTools.ts)
├── providers/              # VS Code views and panels
│   ├── sidebar.ts          # SidebarProvider: assembles sidebar*.ts, view lifecycle, stateSync, message handler table
│   ├── sidebarHost.ts      # SidebarHost interface shared by modules (post, tabs, active tab, stateSync)
│   ├── sidebarBackends.ts / sidebarTabs.ts / sidebarTabState.ts  # Per-backend tab workspaces + prewarm; tab lifecycle and persistence; TabState
│   ├── sidebarPromptQueue.ts / sidebarSessionPanel.ts / sidebarAttachments.ts / sidebarToolApproval.ts  # Send/queue/abort; resume panel and session tree; attachments and editor context; tool approval
│   ├── sidebarTuiMode.ts / sidebarTui.ts  # TUI mode per tab; TabTuis (PTY processes, busy state)
│   ├── sidebarBotView.ts / sidebarWorker.ts / sidebarVoiceSessions.ts  # Bot view and dictation; WorkerController for the voice agent; voice sessions
│   ├── sidebarMessageHandlers.ts / sidebarHtml.ts  # Handler table types and session handlers; sidebar HTML
│   ├── model-status.ts     # ModelStatusTracker: data for the model status bar
│   └── settings-panel.ts   # Settings WebviewPanel (models, providers, API keys, voice, …)
├── shared/                 # Code shared by host and webviews
│   ├── protocol.ts         # ClientMessage / ServerMessage: webview <-> host protocol
│   ├── board.ts            # Blackboards: blocks and ids, outline, board page protocol, show_me card rule
│   ├── planMessageFilter.ts# Plan-mode message filtering/parsing
│   ├── html.ts             # escapeHtml: the only HTML escaper (& < > " ')
│   └── voice*.ts, avatarPresets.ts, translationLanguages.ts  # Voice presets, view protocol, speakers
├── utils/                  # fileEditor.ts (FileEditorTracker), diff.ts
├── voice/                  # Dictation, STT client, VAD, voice settings, voiceprint gate; builtinEngine/ (local STT/TTS/speaker/denoise server)
├── voiceAgent/             # Voice agent: VoiceMode, VoiceLlm, HostToolRouter, FloorArbiter, replay, blackboard.ts (board tabs), …
└── webview/
    ├── main.ts             # Chat entry: mounts Bot view, message listener, message actions, render()
    ├── chat/               # Chat UI modules (one-way deps, no import cycles; tests in src/test/unit/webview/chat/)
    │   ├── state.ts        # ChatState synced from host; module-local UI state stays private
    │   ├── layout.ts       # render(): rebuilds #app skeleton, binds stable events; botHost
    │   ├── messageHandler.ts / stateSync.ts / agentEvents.ts  # ServerMessage dispatch, stateSync apply, agentEvent handling
    │   ├── transcript.ts / messageRender.ts / messageActions.ts  # History rebuild, single message render, message buttons
    │   ├── streaming.ts    # Streaming phase, deltas, #streaming-message, activity line
    │   ├── tools.ts / toolFormat.ts / toolApproval.ts / diffCard.ts / changedFiles.ts / thinking.ts  # Tool cards, diffs, changed files, thinking
    │   ├── composer.ts / composerInput.ts / composerChips.ts / slashMenu.ts / queuedBanner.ts  # Composer, keys, chips, slash menu, queued messages
    │   ├── permission.ts   # Modes menu (Manual / Edit automatically / Plan / Auto)
    │   └── helpers.ts / markdown.ts / messageContent.ts / scroll.ts / …  # Pure helpers
    ├── settings.ts + settings/  # Settings webview: state.ts (only mutable settingsState), api, tabs, render, edits.ts (unsaved edits) + saveBar.ts (one Save / Discard), per-tab modules
    ├── toolView.ts         # Tool card shell (status dot, name, summary, collapsible body, partial output)
    ├── board/              # Board page (blackboard): Markdown, Mermaid, highlight.js, web pages (web.ts: ```html in sandboxed frames; webElement.ts: the element an Alt + click in one picks), Pi's and the user's marks
    ├── toolCards/          # Per-tool renderers; registry.ts; parts.ts DOM blocks; util.ts pure helpers
    ├── modelPicker.ts / modelStatus.ts  # Favorite-model chip; model status bar
    ├── fileMentionMenu.ts / fileDropReaders.ts  # @ mentions; drag-and-drop files/images
    ├── voiceBar.ts / voicePanel.ts / voiceImages.ts / dictation.ts / sentence*.ts / selectionToolbar.ts / readAlong.ts / translatePopup.ts  # Voice UI (voiceImages.ts: Bot view image cards and viewer)
    ├── avatar.ts / avatarMotion.ts  # Avatar markup; the voice bar avatar talking (bot level) and thinking
    ├── vscodeApi.ts        # acquireVsCodeApi singleton
    ├── tsconfig.json       # Webview typecheck (DOM lib)
    └── styles/             # main.css / settings.css / board.css: entries esbuild bundles; tokens.css (shared theme tokens); chat/*.css modules (toolCards.css, voice.css = Bot view, …); board/*.css
```

## 3. Architecture and data flow

```
+--------------------------------------------------------------+
| 1. CLI child process (pi|omp --mode rpc)                      |
|    Model calls, reasoning, tool execution (bash, read, edit…) |
|    Pushes NDJSON events on stdout (message_update,            |
|    tool_execution_*, …)                                       |
+------------------------------+-------------------------------+
                               | NDJSON over stdin/stdout
                               v
+--------------------------------------------------------------+
| 2. Extension host (src/pi/, src/providers/)                   |
|    PiRpcBridge: stdio, JSON parsing, event/response dispatch  |
|    PiChatSession: per-session state, model switch, abort      |
|    SidebarProvider: tabs, forwards agentEvents, stateSync     |
+------------------------------+-------------------------------+
                               | postMessage / onDidReceiveMessage
                               v
+--------------------------------------------------------------+
| 3. Webview (src/webview/main.ts + src/webview/chat/)          |
|    ChatState for the active tab (messages, isStreaming, …)    |
|    #streaming-message: the in-progress step + live tool cards |
|    #messages: one .chat-turn per prompt, steps in time order  |
+--------------------------------------------------------------+
```

- Messages between host and webview are typed in `src/shared/protocol.ts`. `stateSync` carries a tab's full authoritative state; `agentEvent` carries incremental CLI events for live rendering.
- Each assistant message is one **step**: thinking streams, tool cards appear live on `tool_execution_start`, and on `message_end` the step is committed to history so the next step renders below it. See [docs/chat-rendering.md](docs/chat-rendering.md).
- Switching tabs pushes that tab's full state via `pushStateSync`; tabs never share state.

## 4. Invariants and gotchas

- **Always `await tabReady(tab)` before sending** (`src/providers/sidebarTabState.ts`). Sending, queueing, slash commands, the voice worker, and TUI startup must wait for process ready **and** `tab.restoring` to finish. Never gate on `session.isReady` / `waitUntilReady()` — a prompt could land in a tab still restoring.
- **`activate` has no `await`.** Session init, CLI checks, native module preflight, and tab restore (`restorePersistedTabs`, all tabs in parallel) run in the background so the sidebar registers immediately. Keep it that way.
- **Tool card rendering is synchronous.** Cards must have their final height when inserted so `updateMessages()` history rebuilds do not jump the scroll. Do not introduce async rendering in `toolView.ts` / `toolCards/`.
- **`escapeHtml` in `src/shared/html.ts` is the only HTML escaper** for host and webview. Do not add another.
- **Permission gate tiers** (`toolTier` in `src/pi/permissionPolicy.ts`, enforced by `src/piExtension/permissionGate.ts` in every worker): `read` always allowed; `write` (file-content edits) allowed in Edit automatically / Auto; `exec` (everything else, including edits that delete/move files) allowed only in Auto; Manual asks for both; Plan blocks both. The mode file is reread on every call. Details: [docs/permissions.md](docs/permissions.md).
- **Worker file lock.** Before a worker tool call that changes files runs (every call it does not block), the gate appends the absolute paths (`modifiedPaths`) to the edits file (`VSCODE_PI_EDITS_FILE`); `PermissionGateFile.edits()` reads it synchronously, `PiChatSession` clears it on `agent_end`. `HostToolRouter` refuses the voice agent's `edit_file` / `create_file` / `rename_file` / `delete_file` / `save_file` on overlapping paths via `WorkerController.lockedPaths`. Not reported: bash commands, and TUI tabs (no gate; there any running task blocks the voice agent's file changes). Details: [docs/voice-pair-agent-cursor.md](docs/voice-pair-agent-cursor.md) §11.
- **Webview modules have one-way dependencies.** `src/webview/chat/` has no import cycles; module-local UI state stays private behind functions, only `state.ts` is shared.
- **Stylesheets: import order is the cascade; colors come from tokens.** `styles/main.css` and `styles/settings.css` only `@import` modules (`tokens.css`, `chat/*.css`, xterm's CSS) that esbuild bundles into one file each; between rules of equal specificity the later module wins, so moving rules across modules can change the look. No `@layer`: VS Code before 1.104 injects its default webview styles unlayered, and they would beat every layered rule. Colors use `tokens.css` names (theme-derived) instead of literals so light and high-contrast themes work; `npm run lint:css` enforces it, `src/test/unit/webview/styles.test.ts` rejects undefined custom properties and classes no code renders.
- **Model/skill lists load in the background.** `get_available_models` waits for provider discovery; never block initialization on it (`_refreshModelsAndSkills`, `onDidChangeCatalog`).
- **TUI tabs own their session file.** The idle RPC worker behind a TUI tab is never used: `SidebarWorker` drives the TUI itself (prompts typed in, Escape to stop, the screen read through `ScreenReader` in `src/pi/terminalScreen.ts`). See [docs/tabs-and-tui.md](docs/tabs-and-tui.md#tui-tabs-and-the-voice-agent).
- **API keys never reach settings.json or the webview.** Voice keys live in SecretStorage; the user's own server never receives a key.
- **Settings are drafts until Save.** Every setting on the settings page is an edit (`src/webview/settings/edits.ts`; the voice services' forms are `voiceSetup.ts` drafts) shown over the saved settings (`currentSettings` = `savedSettings` + edits) until the page's one Save bar (`saveBar.ts`) sends them (`saveSettings`, `saveVoice`); an edit the host's settings already hold drops. Actions (log in, install a package, Test, Try, record a voiceprint) still act at once. A new setting control goes through `setSetting` / `setEdit`, never a direct write.

## 5. Key file index

| File | Key symbols | Responsibility |
|---|---|---|
| `src/pi/piRpcBridge.ts` | `PiRpcBridge` | Spawns `pi --mode rpc`, JSON-RPC requests, session event subscription |
| `src/pi/rpcSession.ts` | `PiChatSession` | High-level session API: prompt, abort, setThinkingLevel, cycleModel |
| `src/pi/rpcExtensionUi.ts` | `RpcExtensionUiHandler` | Answers `extension_ui_request` (dialogs, tool approvals) |
| `src/pi/permissionPolicy.ts` | `toolTier`, `modifiedPaths` | Classifies tool calls into read / write / exec; files a call changes |
| `src/pi/workerEdits.ts` | `WorkerEditLocks` | The worker's file lock for the voice agent |
| `src/providers/sidebar.ts` | `SidebarProvider` | Webview message routing, tab state machine, event broadcast |
| `src/providers/sidebarTabs.ts` | `SidebarTabs`, `loadSessionIntoTab` | Tab lifecycle, session loading (startup restore and resume panel) |
| `src/providers/sidebarTui.ts` | `TabTuis` | TUI PTY processes and busy state |
| `src/pi/tuiDialog.ts` + `src/providers/sidebarTuiDialogs.ts` | `parseTuiDialog`, `tuiAnswerPlan`, `TuiDialogs` | A TUI's own dialogs read off its screen, shown as the chat's dialog cards, answered with keys |
| `src/providers/model-status.ts` | `ModelStatusTracker` | Model name, context usage, quota for the status bar |
| `src/pi/providerUsage.ts` | `ProviderUsageTracker` | Provider subscription quota (omp CLI or direct OAuth APIs) |
| `src/pi/loggedInProviders.ts` | `readLoggedInProviders` | Limits the model list to logged-in providers |
| `src/shared/protocol.ts` | `ClientMessage`, `ServerMessage` | Typed webview <-> host protocol |
| `src/webview/chat/` | `render`, `updateMessages`, `renderStreamingContent`, `handleMessage` | Chat UI rendering, partial DOM updates, streaming pipeline |
| `src/webview/toolView.ts` + `toolCards/` | `createToolView`, registry | Tool card shell and per-tool renderers |
| `src/voice/` | `VoiceInput`, `DictationSession`, `SileroVad`, `SttClient` | Dictation and STT/TTS service configuration ([docs/voice.md](docs/voice.md)) |
| `src/voice/builtinEngine/` | `BuiltinVoiceEngine` | Zero-install local server (sherpa-onnx): STT, TTS, speaker embeddings, noise reduction; loads only the features asked for |
| `src/voice/voiceprint.ts` + `speakerGate.ts` | `speechGate`, `SpeakerGate` | Only your voice reaches voice input: enrollment storage (globalState), cosine check, noise reduction ([docs/voice.md](docs/voice.md#voiceprint-only-your-voice-srcvoicevoiceprintts-speakergatets)) |
| `src/voiceAgent/` | `VoiceAgent`, `VoiceMode`, `VoiceLlm`, `HostToolRouter`, `FloorArbiter` | Voice agent ([docs/voice-agent.md](docs/voice-agent.md)) |
| `src/voiceAgent/speakers.ts` | `resolveSpeakers` | Names and avatars in the Bot view |
| `src/voiceAgent/blackboard.ts` + `src/shared/board.ts` | `Blackboards`, `parseBoard`, `showMeIsCard` | Blackboards: `show_me` boards, markers, the user's mark, source edits ([docs/blackboard.md](docs/blackboard.md)) |

## 6. Build, typecheck, and dev

- **Build:** `npm run compile` (`node esbuild.js`, bundles `src/extension.ts`, the webviews and their stylesheets, the CLI extensions in `src/piExtension/`, and the voice engine into `out/`). Watch: `npm run watch` (CSS included).
- **CSS lint:** `npm run lint:css` (stylelint, `.stylelintrc.json`).
- **Typecheck:** esbuild does not typecheck. Run `npm run typecheck` (host `tsconfig.json` + `src/webview/tsconfig.json`) after changes.
- **Tests:** `npm run test:unit` (vitest, `src/test/unit/`); `npm run test:integration` builds `src/test/integration/` with `node esbuild.js --integration` (the voice model swapped for the scripted `fakes/voiceLlm.ts`) and runs it in a downloaded VS Code; run `npm run compile` first, the suites load `out/`.
- **Package:** `npm run package` builds one universal VSIX with `--no-dependencies`; esbuild copies the VAD WASM into `out/`. No native binaries ship: the built-in voice engine's sherpa-onnx runtime downloads on first use (`src/voice/builtinEngine/runtime.ts`); `npm run package:verify` fails if a VSIX contains any.
- **Runtime requirement:** an `omp` or `pi` CLI on PATH, or set `oh-my-pi-chater.cliPath`. `oh-my-pi-chater.backend` (`auto` / `omp` / `pi`) picks the family; `auto` prefers omp. State lives in `~/.omp/agent` or `~/.pi/agent`.
- **Thinking level:** `oh-my-pi-chater.thinkingLevel` (`off`, `minimal`, `low`, `medium`, `high`) is passed to the CLI; only reasoning models emit thinking.

## Topic docs

| Doc | Summary |
|---|---|
| [docs/chat-rendering.md](docs/chat-rendering.md) | How thinking, tool cards, and history render live and after archiving; tool card porting notes |
| [docs/tabs-and-tui.md](docs/tabs-and-tui.md) | Multi-tab sessions, drafts, resume panel, startup/restore, prewarm, per-tab TUI mode and busy detection |
| [docs/permissions.md](docs/permissions.md) | Manual / Edit automatically / Plan / Auto: selection, persistence, worker gate, pi plan mode, voice approvals |
| [docs/model-status.md](docs/model-status.md) | Model status bar, quota sources, favorite models, logged-in provider filter |
| [docs/voice.md](docs/voice.md) | Dictation, STT/TTS services, built-in engine, API keys, Voice settings tab, readiness, error messages |
| [docs/voice-agent.md](docs/voice-agent.md) | Voice agent implementation: Bot view, worker control, voice mode, text fallback, multi-window, pairing, names/avatars |
| [docs/sentence-replay.md](docs/sentence-replay.md) | Alt+click read-aloud and Alt+right-click translation of sentences (Alt+Shift: paragraphs) and of mouse selections (selection bar) in chat and Bot view; the picked text stays the region (click: pause/resume or read again, double-click: read from a word, right-click: translate); read-along sentence highlight |
| [docs/voice-agent-design.md](docs/voice-agent-design.md) | Voice agent design and rationale (§5.12 multi-session rules, §5.13 text fallback, §14.1 progress) |
| [docs/voice-pair-agent-cursor.md](docs/voice-pair-agent-cursor.md) | Pair design: agent cursor, Follow Pi, editing by hand (§11 worker file lock) |
| [docs/blackboard.md](docs/blackboard.md) | Blackboards: `show_me` writes Markdown, Mermaid and live ```html web pages (sandboxed srcdoc frames, frame nonce, laid out at a design size from a viewport meta tag or the column and scaled like a picture) on board tabs, the agent points with `⟦board:…⟧` markers (blocks, code lines, nodes, sequence messages and edges), the user marks back (`<board>`), placement and maximize, zoom (page, and per diagram and web page) and a diagram or web page expanded to fill the board (Escape, pan drags and zoom keys inside a frame forwarded through its port), links, source edits (`<board-edited>`), resume |
