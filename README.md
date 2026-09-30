# PI Buddy

**A VS Code front end for the [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi) and pi coding agents, with a built-in voice AI pair programmer.**

- **One UI, two agents.** Chat with `omp` or `pi` in the sidebar. Everything runs through the CLI's own `--mode rpc`, so your models, logins, skills, extensions and sessions are the ones the CLI already uses.
- **A pair programmer you talk to.** Turn on voice mode and talk. Pi answers out loud and highlights the code it means. It can edit, run and debug in your editor, or plan a task with you and hand it to the chat agent, then tell you when the work is done.

> Unofficial community extension. It is not affiliated with the omp or pi projects.

**中文简介**：omp（Oh My Pi）与 pi 编码 Agent 的 VS Code 插件。侧边栏对话、差异审阅、检查点回滚、权限模式，并集成语音 AI 结对编程伙伴：可以直接和 Pi 说话，它会用语音回答并高亮所指代码，也能在编辑器里替你改代码、跑命令、调试，或者先和你确认方案再交给后台 Agent 执行。支持中英混合对话。

## Requirements

- VS Code 1.100 or newer (or VSCodium).
- **omp** or **pi** installed:
  - omp: `curl -fsSL https://omp.sh/install | sh` (or `bun install -g @oh-my-pi/pi-coding-agent`)
  - pi: `npm install -g @earendil-works/pi-coding-agent`

  With neither installed, the chat view shows these steps and a Reload Window button.
- **Voice features only.** You need an OpenAI-compatible speech-to-text server, for example [speaches](https://github.com/speaches-ai/speaches) (faster-whisper), OpenAI or Groq. Voice mode also needs an OpenAI-compatible text-to-speech server, for example chatterbox-tts, Kokoro-FastAPI or OpenAI. See [Voice setup](#voice-setup).

## Getting started

1. Install omp or pi (above).
2. Open the **PI Buddy** view in the Activity Bar.
3. Sign in to a model provider: type `/login` in the chat, or open Settings → **Configure provider**.
4. Start chatting. To use voice, fill in Settings → **Voice**, then click the phone button above the chat input.

## Features

### Chat with omp or pi

- **Backend choice.** `auto` runs `omp` when it is found and `pi` otherwise. You can pick a backend per workspace in the Settings panel.
- **Streaming chat.** Replies stream in, thinking steps collapse, and tool cards render bash, read, edit, write, grep, glob, AST, LSP, fetch, web search, task and todo calls.
- **Multiple chat tabs.** Each tab has its own agent process, change tracking and checkpoints.
- **Permission modes.** Pick Manual, Edit automatically, Plan (read-only) or Auto from the menu next to the model chip. Tool calls that need approval show Approve/Reject cards in the chat.
- **Review and undo.** The changed-files bar opens each edit in VS Code's diff editor. Undo reverts the last turn's edits, and Redo brings them back.
- **Checkpoints.** Restore files and the conversation to any earlier message, and redo until you send something new.
- **Plan mode.** On pi, the plan opens in an editor, the agent's todo list appears as live progress, and **Implement** runs it. On omp, Plan mode blocks all writes.
- **Context.**
  - The active file and selected lines go with each prompt. Click the chip to leave them out.
  - `@` mentions workspace files.
  - Drag files in, paste images, or use Explorer → **Add to Chat**.
- **Prompt queue.** While the agent works, queue a message. You can then edit it, remove it, steer it into the running turn, or interrupt and send it now.
- **Edit and regenerate.** Resend an edited message or regenerate a reply, in the same session or in a fork.
- **Slash commands.** The chat supports:
  - The CLI's built-ins, plus every command from your extensions, skills and prompt templates.
  - VS Code panels for `/model`, `/resume`, `/tree`, `/fork`, `/mcp`, `/packages` and `/settings`.
  - `!cmd`, which runs a shell command (`!!cmd` keeps its output out of the context).
- **Sessions.**
  - Search, rename, delete or resume this folder's sessions.
  - The session branch tree (`/tree`) lets you fork and summarize.
- **Model status line.** Shows the model, context fill and the subscription limits that apply to it (for example Claude `5h 11% · 7d 3%`). Click it for per-window bars and reset times.
- **Model picker.** Star models (☆) to put them in the quick-switch chip under the input. A picked model also becomes the CLI default.
- **TUI mode.** A header toggle turns a tab into the CLI's own terminal UI on the same session. Switch back to reload that session into the chat view.
- **Settings panel.** Covers the backend, login, default model and thinking, permissions, packages (with a catalog browser), skills, commands, MCP servers (toggles and connection tests) and voice services.
- **Dictation.** The mic button in the chat input records until you click it again. The recording is then transcribed and the text goes in at the caret.

### Voice AI pair programmer

Start voice mode with the phone button above the chat input (click it again to hang up), or run **Voice Agent — Start Voice Mode**. The avatar button next to it shows the voice agent's conversation (Bot view), where you can also type to it with voice mode off, as a text chat. The voice agent is a second omp/pi session, separate from the chat agent. It reads your code, listens to what you say, and answers out loud.

- **Talk naturally.**
  - Interrupt it at any time. Saying "stop", "wait", 停 or 等等 also works, and so does typing.
  - **Hush** stops the current reply, and **Mute** pauses the mic.
  - It answers in the language you last used, and reads mixed Chinese and English.
- **Pi points at the code.** Pi's focus is highlighted in the editor, in purple while it talks about code, blue while it reads and green while it writes. With **Follow** on, the editor scrolls to that code without moving your cursor. Typing in the editor stops following.
- **Pi works in your editor.**
  - It types edits line by line at its highlight, and a single Ctrl+Z undoes each edit.
  - It creates, renames, deletes (after asking you), saves and closes files.
  - It runs commands in a visible **Pi** terminal.
  - It starts debug sessions, sets breakpoints, steps, and inspects where the program paused.
  - It reads the Output panel, the Debug Console and terminal output.
  - It opens files in the right viewer, such as the Markdown preview or draw.io.

  Your chat permission mode still applies to everything it does.
- **Pi hands heavy jobs to the chat agent.** Small changes it makes itself; a job that spans many files or needs a long run goes to the chat agent.
  - It works out a task with you, and once you agree, sends it to the chat agent.
  - While the agent works, it can steer or queue follow-ups, answer the agent's questions, or stop it.
  - It speaks up when the agent needs you, fails or finishes. Set how often under `voiceAgent.narration`.
  - It keeps off the files the chat agent is changing until the agent's task ends.
- **Background research.** Pi can start up to three read-only research jobs and tells you what they found.
- **Bot view.** Toggle a chat tab to the Bot view. It shows the voice conversation, plan and approval cards, and the speech engines and token use. Past voice conversations are kept per workspace and auto-titled.
- **No microphone?** Run **Voice Agent — Type a Message** to talk to it by text.

### Voice setup

Open Settings → **Voice**.

1. **Speech-to-text.** Set `voice.sttUrl` to an OpenAI-compatible base URL, for example `http://127.0.0.1:8010/v1`. `/audio/transcriptions` is appended to it.
2. **Text-to-speech** (voice mode only):
   - Set `voiceAgent.tts.url`, for example `http://127.0.0.1:8881/v1`.
   - Set `voiceAgent.tts.provider` to `chatterbox`, `kokoro` or `openai`, so each sentence is sent with the right language.
3. **Test** checks each endpoint. **Dry run…** records one sentence, or synthesizes a text, using the values you typed.

Speech detection (Silero VAD) runs locally in WebAssembly.

Audio is captured in two ways:

- **Voice mode** captures audio through a hidden headless Chrome, Edge, Chromium or Brave, which provides echo cancellation. If none is found, the audio page opens in your default browser, and that page must stay open.
- **Dictation** records with `arecord` or `parecord` on Linux, or with SoX `rec` (for example `brew install sox` on macOS).

## Settings

| Setting | Default | Description |
|---|---|---|
| `oh-my-pi-chater.backend` | `auto` | `auto` (omp, else pi), `omp` or `pi` |
| `oh-my-pi-chater.cliPath` | auto | Path to the `omp` / `pi` binary |
| `oh-my-pi-chater.nodePath` | auto | pi only: Node binary used to run pi |
| `oh-my-pi-chater.thinkingLevel` | `off` | `off`, `minimal`, `low`, `medium`, `high` |
| `oh-my-pi-chater.defaultPermissionLevel` | `ask` | Permission mode of new tabs: `ask` (Manual), `edit`, `plan`, `auto` |
| `oh-my-pi-chater.allowedTools` | `[]` | Tools that run without asking in Manual / Edit automatically |
| `oh-my-pi-chater.showAllModels` | `false` | Also list providers configured only via env vars or models files |
| `oh-my-pi-chater.favoriteModels` | `[]` | Starred models (`provider/id`) for the quick-switch chip |
| `oh-my-pi-chater.contextUsageWarningThreshold` | `80` | Warn above this % of the context window |
| `oh-my-pi-chater.promptRecommendedPackages` | `true` | Offer to install recommended pi packages |
| `oh-my-pi-chater.autoInstallRecommendedPackages` | `false` | Install them on startup without asking |
| `oh-my-pi-chater.voice.sttUrl` | empty | OpenAI-compatible STT base URL; empty disables voice |
| `oh-my-pi-chater.voice.sttModel` | first listed | Transcription model id |
| `oh-my-pi-chater.voice.language` | auto | ISO-639-1 hint (`zh`, `en`, …) |
| `oh-my-pi-chater.voice.vadConfidence` | `0.5` | Speech threshold; lower = more sensitive |
| `oh-my-pi-chater.voice.vadStopSecs` | `0.8` | Pause that ends a dictation utterance |
| `oh-my-pi-chater.voiceAgent.model` | chat tab's | Voice agent model (`provider/id`) |
| `oh-my-pi-chater.voiceAgent.thinking` | `off` | Voice agent thinking level |
| `oh-my-pi-chater.voiceAgent.confirmBeforeDispatch` | `true` | Agree to a plan before it is sent to the chat agent |
| `oh-my-pi-chater.voiceAgent.followPi` | `true` | Editor follows Pi's focus |
| `oh-my-pi-chater.voiceAgent.narration` | `important` | When Pi speaks up on its own: `off`, `important`, `all` |
| `oh-my-pi-chater.voiceAgent.minProactiveGapSecs` | `8` | Quiet seconds before unprompted announcements |
| `oh-my-pi-chater.voiceAgent.narrationIntervalSecs` | `30` | Progress update interval with narration `all` |
| `oh-my-pi-chater.voiceAgent.humor` | `occasional` | Mood and jokes: `off`, `occasional`, `often`; the dice are rolled per turn |
| `oh-my-pi-chater.voiceAgent.turnStopSecs` | `1.2` | Silence that ends your turn |
| `oh-my-pi-chater.voiceAgent.tts.provider` | `openai` | `chatterbox`, `kokoro` or `openai` |
| `oh-my-pi-chater.voiceAgent.tts.url` | empty | OpenAI-compatible TTS base URL |
| `oh-my-pi-chater.voiceAgent.tts.model` / `.voice` / `.speed` | provider default / `1` | TTS model, voice and speed |
| `oh-my-pi-chater.voiceAgent.discoverPreviewCommands` | `false` | Also offer other extensions' preview commands as viewers |
| `oh-my-pi-chater.voiceAgent.historySessions` | `20` | Past voice conversations kept per workspace |
| `oh-my-pi-chater.voiceAgent.debugTranscript` | `false` | Show raw voice prompts and silent turns |

## How it works

```
VS Code extension
 ├─ chat tabs ──> omp|pi --mode rpc   (one process per tab; tools run in the CLI)
 └─ voice agent ─> omp|pi --mode rpc   (read-only tools + VS Code host tools)
       mic ─> Silero VAD ─> STT server ─> voice model ─> TTS server ─> speaker
```

The extension uses the CLI's own agent directory, `~/.omp/agent` or `~/.pi/agent`, for config, sessions, skills and packages.

## Privacy

The extension has no telemetry. Prompts go to the model providers you configured in omp or pi. Voice audio goes only to the STT and TTS endpoints you set. On the pi backend, the model status line reads your subscription usage from Anthropic, OpenAI Codex or Antigravity with your existing OAuth token. The package catalog searches the npm registry.

## License & attribution

MIT. PI Buddy is derived from [vscode-pi-agent](https://github.com/FChatin/vs-pi-agent) by FChatin (MIT). The original copyright and permission notice are kept in the bundled LICENSE file. The tool cards are ported from the `tool-render` renderers of [oh-my-pi](https://github.com/can1357/oh-my-pi) collab-web (MIT).
