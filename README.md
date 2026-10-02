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
- **A shared blackboard:** what is easier to see than to hear goes on a board tab beside your code, in real time: short design docs, Mermaid diagrams (architecture, sequence, flow), tables, code snippets and diffs, and live HTML pages such as clickable UI prototypes and animated algorithm demos. As it talks, it points at the exact block, line, diagram node or arrow it is talking about. You can mark any part back (select text, or Alt+click an element in a demo) and ask "what about this?".
- **Explains as it goes:** ask how a flow works and it reads the code (or researches it in the background), then walks you through it one place at a time, highlighting each spot in your editor.
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

Open Settings → **Voice**. Speech-to-text and text-to-speech each offer three choices:

- **Built-in** (default): zero-install, runs locally; downloaded on first use. English only (Moonshine STT, Piper TTS).
- **Cloud**: a hosted service with your API key; for now OpenAI and Groq. Keys are kept in VS Code SecretStorage.
- **Self-hosted**: your own OpenAI-compatible server; no key is sent to it.

For Chinese or mixed-language speech, use Cloud or Self-hosted. Ready-made self-hosted services (Whisper STT, Kokoro and chatterbox TTS) are in [`docker/`](docker/README.md).

In the Voice tab, **Test** checks that a service answers, and **Dry run…** records or speaks one sentence so you can hear the result. Engine and settings details: [docs/voice.md](docs/voice.md).

Voice mode captures audio through a hidden headless Chrome/Edge/Chromium/Brave (echo cancellation). Dictation uses a
command-line recorder when there is one — `arecord` / `parecord` / SoX `rec` — and otherwise the same hidden browser, so
macOS, which ships no recorder, needs nothing installed beyond a Chromium-family browser.

## 🔒 Privacy

No telemetry. Prompts go to the model providers you configured in omp or pi; audio goes only to the STT/TTS endpoints you set (or stays local with the built-in engine).

## 📄 License

MIT. Derived from [vscode-pi-agent](https://github.com/FChatin/vs-pi-agent) by FChatin (MIT); original notice kept in LICENSE. Tool cards ported from [oh-my-pi](https://github.com/can1357/oh-my-pi) collab-web (MIT).
