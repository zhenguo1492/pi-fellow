<h1><div align="center">
 <img alt="Pi Fellow" width="400" src="docs/images/banner.png">
</div></h1>

[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.100-007ACC)](https://code.visualstudio.com/)
[![Agents](https://img.shields.io/badge/agents-omp%20%7C%20pi-6e40c9)](https://github.com/can1357/oh-my-pi)
[![Voice](https://img.shields.io/badge/voice-pair%20programmer-c0283f)](docs/voice-agent.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

# 🎩 Pi Fellow: omp & pi in VS Code, with a Voice Pair Programmer

**Pi Fellow** puts the [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi) and pi coding agents in the VS Code sidebar, as a chat view or as the CLI's full TUI, and adds a voice agent you talk to like a pair-programming partner: it discusses the design with you, writes code in your editor, and hands bigger tasks to an omp/pi worker.

> Want to dive right in? Install `omp` or `pi`, open the **Pi Fellow** view and type `/login`. See [Install](#-install).

> Unofficial community extension. It is not affiliated with the omp or pi projects.

## 🚀 Features

### 🧑‍💻 Drive omp or pi from VS Code

Runs your local `omp` / `pi` CLI (`--mode rpc`), so models, logins, skills, extensions and sessions are the CLI's own.

- **Webview chat:** streaming replies, collapsible thinking, tool cards (bash, edit, grep, LSP, task, todo, …).
- **TUI mode:** switch any tab to the CLI's own terminal UI, with every TUI feature, on the same session.
- **Tabs:** one agent process per tab; search, resume, fork and tree-browse sessions.
- **Permission modes:** Manual, Edit automatically, Plan (read-only), Auto; approve/reject cards.
- **Review and undo:** changed files open in the diff editor; undo/redo a turn; checkpoints restore files and conversation.
- **Context:** active file and selection, `@` file mentions, drag-and-drop files, pasted images.
- **Prompt queue:** queue, edit, steer into the running turn, or interrupt.
- **Slash commands:** CLI built-ins, extension/skill/prompt commands, `!cmd` shell.
- **Model status:** model, context fill, subscription quota; starred models for quick switching.
- **Settings panel:** backend, login, models, packages, skills, MCP servers, voice.
- **Dictation:** mic button in the chat input.

### 🎙️ Voice pair programmer

A second omp/pi session you talk to, like a pair-programming partner. Start it with the phone button above the chat input; the avatar button opens its conversation (Bot view), where you can also type.

- **Talk it through:** discuss design and trade-offs out loud; interrupt any time; mixed Chinese and English.
- **Code together:** it highlights the code it means, types edits in your editor (one Ctrl+Z each), runs commands in a visible terminal, debugs with breakpoints.
- **Delegate to the worker:** agree on a plan, it hands the task to the chat tab's omp/pi agent, steers or answers it while it runs, and tells you when it needs you or finishes. It stays off files the worker is changing.
- **Blackboards:** it draws Markdown, Mermaid diagrams and live web pages on a board and points at parts while explaining; you can mark them back.
- **Only your voice:** optional voiceprint and noise reduction.

Details: [docs/voice-agent.md](docs/voice-agent.md), [docs/blackboard.md](docs/blackboard.md).

## 📦 Install

1. VS Code 1.100+ (or VSCodium).
2. Install omp or pi:
   - omp: `curl -fsSL https://omp.sh/install | sh`
   - pi: `npm install -g @earendil-works/pi-coding-agent`
3. Open the **Pi Fellow** view in the Activity Bar and sign in with `/login` (or Settings → **Configure provider**).

`oh-my-pi-chater.backend` (`auto` / `omp` / `pi`) picks the CLI; `auto` prefers omp. `oh-my-pi-chater.cliPath` overrides the path.

## 🔊 Voice setup

Open Settings → **Voice**. Speech-to-text and text-to-speech each have two engines:

- **Built-in** (default): zero-install, runs locally; downloaded on first use. English only (Moonshine STT, Piper TTS).
- **Custom**: any OpenAI-compatible server, e.g. a self-hosted one or OpenAI / Groq (API keys are kept in VS Code SecretStorage).

For Chinese or mixed-language speech, run the self-hosted services in [`docker/`](docker/README.md) (`docker/up.sh`) and point Pi Fellow at them:

| Service | URL | Settings |
|---|---|---|
| Whisper STT (speaches) | `http://127.0.0.1:8010/v1` | `voice.sttUrl` |
| Kokoro TTS | `http://127.0.0.1:8880/v1` | `voiceAgent.tts.url`, `tts.model` `kokoro`, `tts.voice` e.g. `af_heart`, `tts.languageField` `chineseLangCode` |
| chatterbox TTS (GPU, voice cloning) | `http://127.0.0.1:8881/v1` | `voiceAgent.tts.url`, `tts.model` `chatterbox-multilingual`, `tts.voice` e.g. `Justin.mp3`, `tts.languageField` `perSentence` |

All settings are prefixed `oh-my-pi-chater.`. **Test** checks each endpoint; **Dry run…** records or speaks one sentence. Hardware needs, voices, language restriction and curl tests: [docker/README.md](docker/README.md). Engine and settings details: [docs/voice.md](docs/voice.md).

Voice mode captures audio through a hidden headless Chrome/Edge/Chromium/Brave (echo cancellation); dictation uses `arecord` / `parecord` on Linux or SoX `rec` on macOS.

## 🔒 Privacy

No telemetry. Prompts go to the model providers you configured in omp or pi; audio goes only to the STT/TTS endpoints you set (or stays local with the built-in engine).

## 📄 License

MIT. Derived from [vscode-pi-agent](https://github.com/FChatin/vs-pi-agent) by FChatin (MIT); original notice kept in LICENSE. Tool cards ported from [oh-my-pi](https://github.com/can1357/oh-my-pi) collab-web (MIT).
