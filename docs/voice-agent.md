# Voice agent (`src/voiceAgent/`)

Implementation overview. The design and its rationale are in [voice-agent-design.md](./voice-agent-design.md) (§14.1 is implementation progress); pairing, the agent cursor, and the worker file lock are in [voice-pair-agent-cursor.md](./voice-pair-agent-cursor.md) (§11 is the file lock). Speech services and settings are in [voice.md](./voice.md); sentence read-aloud/translate is in [sentence-replay.md](./sentence-replay.md).

Main classes: `WorkerController`, `VoiceAgent`, `VoiceLlm`, `HostToolRouter`, `WorkerDigest`, `FloorArbiter`, `ResearchRunner`, `VoiceMode`, `conversation.reduce`, `TtsClient`, `VoiceTranscriptStore`, `VoicePanel`, `ReplayPlayer`, `SpeechCache`, `Translator`.

## UI

- **Toggle and status** live in the robot status bar above the session composer (`src/webview/voiceBar.ts`). In voice mode the composer's mic shows the level and acts as mute, and the composer sends to the voice agent by default (the "Send to omp" checkbox sends to omp instead). The host drives these through `VoiceChatControls` (implemented by `SidebarProvider`).
- **Bot view.** Conversation, engines (actual LLM / STT / TTS config), context usage, token breakdown, and per-turn Timing are shown in the session tab's Bot view. The icon left of the tab title (chat bubble ↔ robot) switches that tab's body between the transcript and the Bot view. The host `VoicePanel` sends/receives through `BotViewSurface` (implemented by `SidebarProvider`, `TabState.botView`); the frontend is `src/webview/voicePanel.ts`, mounted on `.bot-host` in `main.ts`, styled by `styles/voice.css`; message types in `src/shared/voiceViewProtocol.ts`. Tool cards in the Bot view: see [chat-rendering.md](./chat-rendering.md#tool-cards-in-the-bot-view).
- **Transcripts** are saved per task in workspaceState by `VoiceTranscriptStore` (`transcriptStore.ts`).
- "Speaking" is based on actual playback reported by the hidden audio page (after Pipecat's BotStarted/StoppedSpeaking); before the first sentence is heard the status shows "synthesizing".

## Division of labor

- The voice agent itself uses `read`, `grep`, `glob` to look at code.
- Questions that need many files go to `research` (a background one-shot `omp -p`, read-only; results are attached in later turns as `<research-result>`).
- Changing code and running commands: small jobs the voice agent does itself; heavy jobs (many files, big refactors, long test runs) it hands to the worker with `tell_worker` (see [Pairing](#pairing)).

## Components

- **`WorkerController`** (`workerController.ts`, implemented by `SidebarProvider`) is the only entry point for controlling the worker.
  - `send` routes by worker state at execution time: idle → new task; busy + now → `prompt` with `streamingBehavior:'steer'`; busy + after → the panel's queue.
  - `answer` answers `extension_ui_request` first-come-first-served with the webview (omp tool approvals are also selects).
  - `onTabEvent` / `onActiveTaskChanged` fire from `sendStateSync` and tab events; `onRequestsChanged` fires when pending requests change (`RpcExtensionUiHandler.onDidChangePending`).
  - A tab in TUI mode reports `status().tui`: the voice agent drives the CLI's TUI through the same tools, typing prompts and answers and reading its screen (`readTuiScreen`, `typeIntoTui`); see [tabs-and-tui.md](./tabs-and-tui.md#tui-tabs-and-the-voice-agent).
- **`VoiceLlm`** (`voiceLlm.ts`) is a hidden omp RPC process (`--tools read,grep,glob --approval-mode yolo`). Host tools are registered with `set_host_tools`. One voice session per worker session, switched with `switch_session`.
  - Built-in skills: `show-me` and `grilling` (`BUILTIN_VOICE_SKILLS`, `src/shared/builtinVoiceSkills.ts`) ship in `media/voiceAgent/skills/<name>/SKILL.md`, each with a `LICENSE` giving its source (humanlayer/skills and mattpocock/skills, MIT). Our `show-me` drops `disable-model-invocation` so the model can invoke it, and shows its views as files opened rendered (`list_viewers` + `open_with`, `markdown.showPreview`, never the source unless asked) instead of `Bash(open …)`. They are always loaded, whatever `voiceAgent.skills` says; `resolveVoiceSkills` (`builtinSkills.ts`) puts them first and drops a chosen skill of the same name, so the built-in copy is the one passed.
  - Skills picked in Settings → Voice → "Voice agent" → Skills (`voiceAgent.skills`, where the built-ins show as always-on chips) load on the next process start. omp: `--plugin-dir <extension>/media/voiceAgent` (the folder is laid out as an omp plugin; this adds it to discovery without replacing the user's skill directories) plus `--skills=<built-ins and chosen names>`; omp's own precedence applies, so a same-named skill in the user's `.omp` or `.claude` skills wins over the built-in, one in `.agents` loses. pi: `--no-skills` plus one `--skill <SKILL.md>` each, built-ins included (chosen skills' paths from `sourceInfo.path` of the chat tab's `get_commands`). `--no-skills` on omp only when the list is empty. Research runs without skills.
  - System prompt: `VOICE_SYSTEM_PROMPT` (`voicePrompt.ts`), plus the user's `voiceAgent.extraPrompt`, trimmed, under "Additional instructions from the user:" (`voiceSystemPrompt`); blank adds nothing. The default itself is not editable: it is tied to the host tools, and a stored copy would go stale on updates. A change to the setting calls `VoiceAgent.restartProcess`: between turns, the process stops and starts again with the new prompt, and each task's voice context resumes from its session file. Settings → Voice → "Voice agent" → Instructions edits it (View renders Markdown, Edit is a textarea saved on blur or View) and shows the default read-only under "View default prompt" (`src/webview/settings/voicePrompt.ts`; raw HTML such as `<editor>` shows as text via `renderMarkdownLiteralHtml`).
- **`HostToolRouter`** (`hostTools.ts`) executes `tell_worker` (a `readOnly` task is dispatched directly; a new file-changing task goes through two-step confirmation), `confirm_task`, `stop_worker`, `answer_worker`, `worker_status`, `research`. Proactive turns may only use `worker_status`. Permission tiers for the voice agent's own tools: [permissions.md](./permissions.md#voice-agent-tools). For a TUI tab (`<worker tui="true">`): `worker_status` returns the TUI's screen (`pagesBack` 0-20 reads further up), `answer_worker` takes `value` and `keys` (named keys, `terminalKeys`) instead of a request id and returns the redrawn screen, `stop_worker` presses Escape.
- **`WorkerDigest`** (`workerDigest.ts`) compresses worker events into activity log lines, attached to the voice model each turn.
- **`FloorArbiter`** (`floorArbiter.ts`) decides when to speak up proactively: the worker waits for an answer, a TUI tab's run stopped (`stopped`, from `tui_run_end`, carrying the screen's last lines; announced at once, as it may be an approval), an error, stable idle for 4 s after finishing, research completed; with `narration: all`, progress too. `VoiceAgent` asks it every second and whenever requests change. Proactive turns end with `<worker-update>`; a `<silent/>` reply is neither shown nor spoken.
- **`ToneDial`** (`tone.ts`) rolls each turn's `<tone mood time aside>` block, per `voiceAgent.humor` (`off` leaves it out). A model left alone jokes every reply or never and keeps one mood, so the host holds the dice: the mood drifts (30% per turn; late at night it may turn `tired`), an error makes it `sober` for two turns, finished work makes it `pleased` once. An `aside` (a kind of joke: pun, cold joke, mock gravity, …; a callback only after four turns) is invited at 30% (`occasional`) or 55% (`often`), never two turns running and never with a worker request, proposal, pending approval or deletion, failed card, interruption or error. The block goes in the user message, so `VOICE_SYSTEM_PROMPT` stays constant for the prompt cache; its "Tone" section says how to use it, and the user's Instructions set the flavour.
- **`ResearchRunner`** (`research.ts`) runs `research` tasks.

## Voice mode (`VoiceMode`, `voiceMode.ts`)

- A page in hidden Chrome (`--headless=new`, `browserAudio.ts`) does `getUserMedia` (AEC3) and playback, exchanging 16 kHz PCM with the extension over local `ws` (with a random token).
- Silero VAD + `SpeechSegmenter` segment speech. Human speech while the bot is talking counts as barge-in only after STT + `echoFilter` confirm it.
- `conversation.ts` is a pure state machine (`reduce(state, event) → effects`). Each reply has its own `AbortController`; the `prompt` effect calls `VoiceAgent.say(text, 'stt', listener, { signal, interrupted })`.
- `TtsClient` (`tts.ts`) calls OpenAI-compatible `/audio/speech` (the custom engine sends a Bearer key when it has one, see [voice.md](./voice.md#api-keys)).
  - Custom engine `tts.languageField` sets the language field: `none` (default) sends nothing; `perSentence` sends `language: zh/en` per sentence; `chineseLangCode` splits Chinese/non-Chinese segments and sends `lang_code: z` for Chinese.
  - Empty `tts.model` / `tts.voice` are omitted from requests (the server decides). The settings Test returns the server's `/models` list to pick from.
- **Legacy `tts.provider`** (kept in package.json as deprecated, only so it can be read and removed) is still read when `tts.engine` is unset: `builtin` / `custom` map directly; service-named `chatterbox` / `kokoro` / `openai` read as `custom` + `perSentence` / `chineseLangCode` / `none`, and old chatterbox / kokoro get their historic default model/voice when empty. `migrateTtsSettings` (on activation) writes these values plus `tts.engine` into the original config target and deletes `tts.provider` (targets that already have `tts.engine` only get the delete); workspace before user settings.

### When STT or TTS is unavailable

The voice agent comes online even when STT / TTS cannot be used (design §5.13):

- Before starting, services that failed are checked once more; ones still failing are not passed to `VoiceMode.start` (reason in `VoiceMode.unavailable`, sent to the webview as `VoiceStatus.unavailable`).
- No STT: VAD is not loaded and the audio page runs with `capture=0` (playback only, no mic); the user types.
- No TTS: `ConvState.voiced = false`; replies are text only, never entering synthesizing / speaking.
- Neither: no audio page is opened.
- The robot button stays clickable. Grey tags next to the status text, "Can't hear" / "No voice" (styled like "Muted"; hover shows the reason; click opens Settings → Voice), say what is missing. Mid-session failures only go to the log and a Bot view system message; the conversation continues.
- If the audio page cannot open the mic, `VoiceMode.unavailable.stt` shows why.
- Readiness tracking itself is described in [voice.md](./voice.md#readiness).
- **`VoiceServiceSync`** (`serviceSync.ts`) follows readiness and settings changes while voice mode is on: as soon as a missing service becomes ready it is resolved and attached (`VoiceMode.useTts` speaks from the next reply on — the state machine's `voiced` event applies after the current reply; `useStt` loads VAD and has the audio page open the mic with `{"type":"capture"}`, opening a new audio page if needed), `unavailable` is cleared, and status is resent. A service in use whose settings change is swapped for the new config; on failure it is not torn down and becomes usable once it recovers. No voice agent restart needed.

### Multiple windows

`ActiveVoiceWindow` (`activeWindow.ts`, `globalStorage/voice-windows/<id>.json`: pid + last focus time) decides which window owns voice. Only the window with voice mode on that was focused last listens and speaks; the others stand by (mic off, reply interrupted, status bar Standby).

## Entry points and commands

- VS Code status bar "Voice" (shows a level meter while on; ▴ next to it shows/hides the Voice view); commands "Voice Agent — Start Voice Mode" / "Stop".
- The Voice view's input box and "Type a Message" (typed conversation; in voice mode equivalent to speaking). Logs also go to the output channel "PI Buddy: Voice Agent". "Debug Worker Control".
- Internal commands for scripted tests: `oh-my-pi-chater.voiceAgent.say` / `.start` (accepts `chromeArgs`, e.g. a fake mic) / `.takeProactiveTurns` / `.takeOutput` / `.workerControl`, and `oh-my-pi-chater.voiceView.state` (view snapshot) / `.agentFocus` (Pi's current pointer highlight).

## Pairing

Full design: [voice-pair-agent-cursor.md](./voice-pair-agent-cursor.md).

- **Editor context.** Each turn carries `<editor>` (`editorSnapshot.ts`: the user's current file, cursor line, visible lines, selection, and selected code with line numbers; `<editor unchanged/>` when identical to the previous turn). Editor tracking is shared with the sidebar via `FileEditorTracker` in `src/utils/fileEditor.ts`.
- **Code anchors.** Anchors in replies, `⟦path:12-20⟧` / `⟦path#name⟧`, are extracted from the text stream by `AnchorStream` in `codeAnchors.ts` (neither shown nor spoken).
- **Agent cursor.** `AgentCursor` (`agentCursor.ts`) shows Pi's focus with end-of-line labels, without touching the user's cursor or focus: pointing while explaining (purple `Pi`), plus files the voice agent reads and files the worker reads/writes (`workerFocus.ts`; written line ranges come from `changedLines` in `piFocus.ts`, comparing content before and after; blue `Pi · reading` / green `Pi · writing`).
  - In voice mode a pointer takes effect when the sentence after the anchor starts playing (`onAnchors` in `voiceMode.ts`); in typed conversation, immediately. A pointer holds for 6 s; read/write activity queues meanwhile.
- **Follow Pi.** Toggled from the status bar `$(eye) Pi: …` or the eye button in the editor title bar (`followPi` / `unfollowPi` / `toggleFollowPi`; setting `voiceAgent.followPi` is the startup default). While following, the editor opens and scrolls to the focus; typing stops following. The host tool `open_file` opens files whether or not following.
- **Acting itself and directing the worker.** The voice agent always has both sets of tools.
  - It acts itself with `edit_file` (`pairHands.ts`: types line by line in the editor, Pi's write highlight follows, one Ctrl+Z undoes the whole edit) and `run_in_terminal` (runs in the "Pi" terminal via shell integration, reading output and exit code).
  - A command's output that moves the cursor or switches to the alternate screen (`drawsScreen`: omp, pi, vim, less, htop) is replayed into a headless xterm (`TerminalRun.screen()`, 200×60, since extensions cannot learn a terminal's size), and `run_in_terminal`'s early return, `terminal_send` and `terminal_read` return its screen as text through `ScreenReader` (`src/pi/terminalScreen.ts`): "no change" when it is what the voice agent last read; `terminal_read` `pagesBack` reads the scrollback, or pages a full-screen program up and back down with PageUp/PageDown. Line output stays cleaned lines, as before; a command that ended is reported from its lines.
  - It directs the worker (`tell_worker`, `confirm_task`, `stop_worker`, `answer_worker`, `worker_status`) for heavy jobs; the prompt's "Dividing the work" section (`VOICE_SYSTEM_PROMPT`) says when.
  - **Worker file lock.** Before each worker tool call it does not block, the permission gate (`src/piExtension/permissionGate.ts`) appends the files the call will change as an NDJSON line to the file named by `VSCODE_PI_EDITS_FILE`. `PermissionGateFile` reads them into `WorkerEditLocks` (`src/pi/workerEdits.ts`), cleared on `agent_end`; `SidebarWorker.lockedPaths` returns the ones overlapping a target, and `HostToolRouter._workerLock` refuses `edit_file`, `create_file`, `rename_file`, `delete_file`, `save_file` on them until the task ends. Other files stay editable.
  - Gaps: TUI tabs do not load the gate, so while a TUI tab runs a task all the voice agent's file changes are refused; `rm`/`mv`/`sed -i` via bash are not reported. Details: [voice-pair-agent-cursor.md §11](./voice-pair-agent-cursor.md#11-working-beside-the-worker-the-file-lock-2026-09-29).

## Names and avatars

Files: `src/voiceAgent/speakers.ts` (`resolveSpeakers`), `src/shared/voiceSpeakers.ts` (`speakerNames`, `parseAvatarSetting`), `src/shared/avatarPresets.ts` (`avatarPresetSrc`), `src/webview/avatar.ts` (`avatarMarkup`).

- Settings `voiceAgent.userName` / `userAvatar`, `botName` / `botAvatar` (defaults User / Bot and the original icons; empty name falls back to default; max 40 characters).
- An avatar is one of:
  - a pixel-art preset `preset:<id>` (`avatarPresets.ts`: uncle / boy / cat / otaku / woman / gentleman; each a 16×16 character pixel map + palette, merged per row into `<rect>`s and drawn as a 64px SVG with `shape-rendering: crispEdges`, transparent background so the frame color shows);
  - an emoji or up to two characters (split by grapheme);
  - an image path (contains a slash, starts with `~`, or has an image extension; `~` is home, relative paths start from the first workspace folder; ≤2 MB).
- The host reads images as data URIs; `VoicePanel` sends them in a separate `speakers` message to the webview (whether or not the Bot view is shown; on config change, view show, and webview `ready`; deduplicated by object reference). The webview crops them to a 64px square PNG with canvas and reuses one markup string for all turns. The voice agent's avatar also replaces the robot button (16px) in the status bar above the composer, and its name is that bar's label while the agent is offline (`setVoiceBarBot`). Unreadable images fall back to the default icon.
- Settings → Voice → "Voice agent" → "Names and avatars" shows previews, reasons, and clickable presets; "Choose picture…" opens a file dialog via `pickAvatar`.
- The voice bar's avatar moves (`src/webview/avatarMotion.ts`, CSS in `main.css`). Speaking: the bot's `voiceLevel` (one per 64 ms of audio) is remapped from 0.5..0.9 (TTS speech sits at level 0.67 and up, so syllables only show within that range) to how open the mouth is, smoothed into `--talk` on `.voice-bar-robot`; `.talking` is set while the reply has made sound within 600 ms. The robot's `.av-mouth` (hidden by default: `opacity="0"`) drops open with `--talk`; a pixel preset shows its closed, half or wide open frame (`mouth` rows in `avatarPresets.ts`: red inside, pink tongue; resolved as `VoiceAvatar.mouthSrcs`, carried space-separated in `data-mouth`, pre-decoded) at openness 0.2 and 0.6, each dropped 0.08 lower; every avatar bounces and its box glows with `--talk`. Thinking (`data-state="thinking"`): the avatar tilts side to side and the robot's `.av-antenna` blinks (off under `prefers-reduced-motion`).
- When either name is not the default, each turn carries `<names you="…" user="…"/>` and the voice agent answers to that name (the prompt tells it not to greet by name). Proactive (Update) turns are unchanged.
