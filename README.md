# Oh My Pi Chater

omp (Oh My Pi) / Pi coding agent in VS Code — sidebar chat, diffs, checkpoints, plan mode, and Pi CLI sync.

Extension ID: `zhenguo.oh-my-pi-chater`. Install from a locally built VSIX (`npm run package`).

## Requirements

- **omp (Oh My Pi)** or **Pi CLI** must be installed — omp: `curl -fsSL https://omp.sh/install | sh` (or `bun install -g @oh-my-pi/pi-coding-agent`); pi: `npm install -g @earendil-works/pi-coding-agent`. With neither installed, the chat view shows these install steps and a Reload Window button instead of the chat.
- VS Code or VSCodium

The extension talks to the agent via `<cli> --mode rpc`. It does not bundle the SDK — everything runs through the CLI. With `oh-my-pi-chater.backend: auto` (default) it runs `omp` when found on PATH (or `~/.local/bin`, `~/.bun/bin`), otherwise `pi`. omp is spawned directly; pi runs as `node cli.js` under your Node.

The Settings panel's backend picker lists only the CLIs installed on this machine. If this workspace's picked backend is uninstalled later, the window falls back to `oh-my-pi-chater.backend`.

## Features

**Chat & agents** — send messages, receive streaming responses, view thinking steps  
**Diff & undo** — see unified diffs for every file change; undo or redo changes per turn  
**Checkpoints** — roll back to any previous turn; redo after rollback  
**Plan mode** — Pi drafts a plan in a VS Code document; apply complete sections with one click  
**Attachments** — drag files or paste images directly into chat  
**Editor context** — the active file and selected lines go with each message automatically; click the chip above the input to exclude them  
**Slash commands** — `/login`, `/logout`, `/model`, `/new`, `/settings`, `/reload`, `/compact`, `/resume`, `/session`  
**MCP config import** — bring MCP server configs from Cursor, Zed, or VS Code  
**Settings panel** — configure auth, thinking level, workspace scope, sync mode  
**Model status line** — at the top of the conversation (styled like the Bot view's header): model, context fill, and the subscription limits that gate the current model (e.g. Claude `5h 11% · 7d 3%`, plus `Fable 7d` on Fable; Codex 5h + weekly; Antigravity Gemini vs Claude/GPT buckets); click it for context, session tokens, per-window bars and reset times. omp backend uses `omp usage --json` (all providers omp supports); pi backend reads OAuth credentials from `auth.json` and queries Anthropic, OpenAI Codex, or Antigravity quota directly (without refreshing tokens)
**Model picker** — the switch button at the right of the model status line (or `/model`) opens the full list; the ☆ on each row stars a model into `oh-my-pi-chater.favoriteModels`. The chip under the chat input switches between starred models only. Lists only providers you signed in to with `/login` (pi `auth.json`, omp credential store); set `oh-my-pi-chater.showAllModels` to include env-var / `models.json` / `models.yml` providers  
**Session catalog** — list, resume, or switch between sessions  
**Checkpoint + Todo merge** — Pi-managed plan todos merged into VS Code with task markers  
**TUI mode** — header toggle turns the current tab into an embedded terminal running the CLI's own TUI (`omp --resume <tab session>`); other tabs keep their own view. Switching back reloads that conversation into the chat view. `/tree` and the command palette still open the session tree
**Voice input** — the mic button in the chat input (or `Ctrl+Alt+M` / `Cmd+Alt+M`) records until clicked again. Silero VAD (the model pipecat uses, run locally on onnxruntime-web WASM) splits speech at pauses; each utterance goes to an OpenAI-compatible `/audio/transcriptions` endpoint (speaches / faster-whisper-server, OpenAI, Groq…) and its text is inserted at the caret while you keep talking. Set the endpoint under Settings → Voice: edits there are drafts until the **Test** button beside the section's URL saves them (even if the check fails) and marks it with a green check or a red cross, and **Dry run…** tries the typed values — STT records one sentence and shows the transcript, TTS synthesizes a text into a playable clip. The mic is red, with the reason in its tooltip, until the STT server answers `GET /models` with HTTP 200. Audio is captured with `arecord`, `parecord`, or SoX `rec` (VS Code webviews cannot open the microphone)

## Configuration

| Setting | Default | Description |
|---|---|---|
| `oh-my-pi-chater.authProvider` | `pi-cli` | Authentication provider (`pi-cli`) |
| `oh-my-pi-chater.backend` | `auto` | Agent CLI: `auto` (omp, else pi), `omp`, or `pi` |
| `oh-my-pi-chater.syncWithPiCli` | `true` | Use the CLI agent dir (`~/.omp/agent` or `~/.pi/agent`) for config, sessions, skills |
| `oh-my-pi-chater.cliPath` | auto | Force a specific `omp` / `pi` binary path |
| `oh-my-pi-chater.nodePath` | auto | pi only: Node binary used to run `cli.js` |
| `oh-my-pi-chater.thinkingLevel` | `off` | Thinking level (`off`, `fast`, `deep`) |
| `oh-my-pi-chater.workspaceScope` | `current` | Session scope (`current` or `all`) |
| `oh-my-pi-chater.tools` | built-in | Enabled tool groups |
| `oh-my-pi-chater.modelProvider` | auto | Preferred model provider |
| `oh-my-pi-chater.modelId` | auto | Preferred model |
| `oh-my-pi-chater.favoriteModels` | `[]` | Starred models (`provider/id`) offered by the chat input's model chip |
| `oh-my-pi-chater.maxTokens` | auto | Max tokens per response |
| `oh-my-pi-chater.autoApproveTools` | `ask` | Tool auto-approval (`ask`, `all`, `none`) |
| `oh-my-pi-chater.promptTemplates` | `[]` | Custom prompt prefixes |
| `oh-my-pi-chater.mcpConfigImportPaths` | `[]` | Paths to import MCP configs from |
| `oh-my-pi-chater.voice.sttUrl` | empty | Voice input STT base URL, e.g. `http://127.0.0.1:8010/v1` (a bare host gets `/v1`); `/audio/transcriptions` is appended |
| `oh-my-pi-chater.voice.sttModel` | first listed | Transcription model id; empty uses the first model at `/models` |
| `oh-my-pi-chater.voice.language` | auto | ISO-639-1 language hint (`zh`, `en`, …) |
| `oh-my-pi-chater.voice.vadConfidence` | `0.5` | Silero VAD speech threshold (Silero's own default); lower = more sensitive |
| `oh-my-pi-chater.voice.vadStopSecs` | `0.8` | Pause that ends an utterance and sends it to STT |

## Architecture

```
VS Code extension
    │
    └─── starts ──────────>  pi --mode rpc  (Pi CLI subprocess)
                               │
                               ├──  /login  →  Pi CLI handles auth
                               ├──  /model  →  Pi CLI manages providers
                               ├──  thinking →  streaming events over JSON-RPC
                               └──  tools  →  executed by Pi CLI
```

Extension writes to `~/.pi/agent/settings.json` (same as CLI). Sessions, skills, and packages live under `~/.pi/agent`.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open sidebar | `Ctrl+Shift+P` → "Oh My Pi Chater: Focus Chat" |
| New session | `Ctrl+Shift+P` → "Oh My Pi Chater: New Chat" |
| Resume session | `/resume` in chat |
| Apply plan section | `Ctrl+Shift+A` |
| Reject plan section | `Ctrl+Shift+R` |

## Quick start

1. Install Pi CLI: `npm install -g oh-my-pi-chater`
2. Install extension: **Install from VSIX** in VS Code Extensions
3. Set provider: `/login` or Settings → **Configure provider**
4. Start chatting

## License & attribution

MIT. Oh My Pi Chater is derived from [vscode-pi-agent](https://github.com/FChatin/vs-pi-agent) by FChatin (MIT); the original copyright and permission notice are kept in [LICENSE](LICENSE). The tool cards (`src/webview/toolCards/`) are ported from the `tool-render` renderers of [oh-my-pi](https://github.com/can1357/oh-my-pi) collab-web (MIT).
