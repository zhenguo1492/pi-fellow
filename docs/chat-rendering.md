# Chat rendering: thinking, tools, and history

## Live streaming

- **Organized by step (assistant message).** Each assistant message is one step. On assistant `message_start` the webview clears the live thinking/answer; the host (`src/providers/sidebar.ts`) also resets `streamingText` / `streamingThinking` on assistant `message_start` / `message_end`, so both only ever represent the current step.
- **Thinking.** `thinking_start` / `thinking_delta` stream at the end of `#streaming-message` (after any still-running tool cards from the previous step). If the user collapsed it manually, that stays collapsed after the step is archived.
- **Tools.** On `tool_execution_start` every tool gets a live card in `#streaming-message` (`createToolView`; each tool has a dedicated renderer, unknown tools use the generic JSON renderer). `tool_execution_update` refreshes the output tail as `partial`; `tool_execution_end` writes `result` and ends the running state. `edit` / `write` with a fileChange still use the extension's own diff card. Once the toolResult is in history, the live card (`tool-<id>` / `diff-<id>`) is removed.
- **Archiving.** On assistant `message_end`, `commitStreamedAssistantMessage` puts the message into history immediately (the following `stateSync` replaces it with the authoritative copy), so the next step's tools and thinking render below it.
- **Activity line.** `#stream-activity` shows a precise state (e.g. `Running bash: find .…`, `Thinking…`), never a generic `Working…`.

Code: `src/webview/chat/streaming.ts`, `agentEvents.ts`, `tools.ts`, `thinking.ts`, `diffCard.ts`.

## History

- Each user prompt is one `.chat-turn` with a `.chat-turn-body`, rendered in message time order; thinking and tools are not merged per turn.
- Each assistant message renders its own thinking block `details.thinking-block` (key `<msgIndex>:0`, expanded by default, with that step's thinking duration) and its answer text. Intermediate steps with thinking but no answer text show no action buttons or footer.
- toolResults between two assistant messages are merged into one `details.tools-block` (key `tools:<index of first toolResult>`, expanded by default, summary like `Used 2 tools (bash)`). Pure tool-call steps with neither thinking nor text do not split a tools block.
- `shouldHideMessageInChat` hides only pure proposed-plan replies; assistant steps without text (thinking/tool calls only) are kept.

Code: `src/webview/chat/transcript.ts`, `messageRender.ts`, `messageActions.ts`.

## Tool cards

`src/webview/toolView.ts` (card shell) + `src/webview/toolCards/` (renderers).

- Ported from https://github.com/can1357/oh-my-pi (MIT) @ a1b3b83, `packages/collab-web/src/tool-render`. One renderer per tool (`summary` returns the header line, `body` returns the expanded block), registered in `toolCards/registry.ts`.
- **All rendering is synchronous** (native DOM): a card has its final height when inserted, so rebuilding history in `updateMessages()` does not cause scroll jumps. Do not introduce async rendering.
- Styles are in `src/webview/styles/chat/toolCards.css` (`tv-*` classes). The `--tv-*` variables on `.tv-card` map to the theme tokens in `styles/tokens.css`.

### Tool cards in the Bot view

`renderTools` in `src/webview/voicePanel.ts` renders each reply's tool calls with the same cards, in call order:

- The voice agent's own `read` / `grep` / `glob` / `web_search` use the worker renderers from the registry. `VoiceLlm` reports them on `tool_execution_start` / `_end`; `VoiceTranscriptStore` stores arguments and results, truncating results over 8000 characters because transcripts live in workspaceState.
- Host tools (`src/voiceAgent/hostTools.ts`) use the renderers in `toolCards/voice.ts` via `ToolViewPayload.renderer`.
- The look keeps the Bot view's small tags: `ToolViewPayload.label` shows a plain-language name (Sent to worker, Proposed, Research…, with the tool name as tooltip), `data-kind` sets the color, and `.vp-tools .tv-*` in `styles/chat/voice.css` turns the card into an outlined strip with ▶, ✓/✗ at the end, and an inset block with a colored left border when expanded.
- `show_text` is text shown instead of spoken (code, SQL, commands): its card (`showTextRenderer`) is open from the start (`ToolViewPayload.defaultOpen`), shows `title` (else `language`, else the first line) in the header and the text itself, highlighted when it has a `language`, with a copy button (`.tv-copy`) under it.
- A `research` call only starts a task: the card spins while it runs and, when it ends (`VoiceAgentOptions.onResearchSettled` → `store.researchSettled`), shows all findings, collapsed by default. Tasks still running when the window closed show as stopped after reload.
