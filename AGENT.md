# AGENT.md - 项目架构与开发指南

本文档汇总了 Oh My Pi Chater（扩展 ID `zhenguo.oh-my-pi-chater`，原型来自 MIT 许可的 [vscode-pi-agent](https://github.com/FChatin/vs-pi-agent)）的核心架构、目录结构、关键业务机制和开发注意事项，便于在后续对话中快速恢复上下文并进行高质量开发。

---

## 1. 项目定位与工作原理

Oh My Pi Chater 是一款将 **Pi 编码智能体（Pi Coding Agent）** 深度集成到 VS Code 侧边栏的扩展。

- **不打包 SDK**：本扩展不直接打包运行时体积庞大的 `@earendil-works/pi-coding-agent` SDK，而是启动本机环境的 `pi` 命令行（通过 `pi --mode rpc`）。
- **进程级通信**：VS Code 扩展宿主启动并管理 `pi --mode rpc` 子进程，通过标准输入输出（`stdin` / `stdout`）遵循 JSON-RPC / NDJSON 协议与 CLI 进行双向通信。
- **轻量原生前端**：Webview 层采用纯 TypeScript + 原生 DOM API + CSS Variables 实现，不依赖 React/Vue 等重型前端框架，启动极快，与 VS Code 原生设计系统高度契合。唯一例外是工具卡片：`media/omp-tool-views.js` 是从 oh-my-pi `packages/collab-web/src/tool-render` 打包的自包含 IIFE（内含 React 与 CSS），注册 `<omp-tool-view>` Web Component。

---

## 2. 目录结构与模块划分

```
vs-pi-agent/
├── esbuild.js                 # esbuild 打包脚本（构建 extension 与 webview）
├── package.json               # 扩展清单（命令、视图、配置项、快捷键）
├── src/
│   ├── extension.ts           # 扩展入口（activate/deactivate，注册 Providers 与 Commands）
│   │
│   ├── pi/                    # Pi CLI 进程管理与 RPC 客户端
│   │   ├── piRpcBridge.ts     # 管理 `pi --mode rpc` 子进程生命周期与 stdio RPC 请求/响应/事件
│   │   ├── rpcSession.ts      # 会话适配层（PiChatSession），维护状态、Tab 和命令逻辑
│   │   ├── rpcTypes.ts        # RPC 消息定义与类型声明
│   │   ├── piAgentConfig.ts   # ~/.pi/agent/settings.json 读写与同步
│   │   └── slashCommands.ts   # 斜杠命令处理（/help, /clear, /session 等）
│   │
│   ├── providers/             # VS Code 视图与面板提供者
│   │   ├── sidebar.ts         # 核心侧边栏 WebviewViewProvider（管理多 Tab、事件分发与消息中转）
│   │   └── settings-panel.ts  # 设置面板 WebviewPanel（管理模型、Provider、API Key 等配置）
│   │
│   ├── shared/                # 扩展宿主与 Webview 共享代码
│   │   ├── protocol.ts        # Webview <-> Extension 双向通信协议定义
│   │   └── planMessageFilter.ts # Plan 模式消息过滤与解析逻辑
│   │
│   └── webview/               # 前端 Webview 界面代码
│       ├── main.ts            # 主聊天界面（渲染消息历史、流式思考、工具卡片、Composer 输入框）
│       ├── settings.ts        # 设置页 Webview 前端逻辑
│       ├── fileMentionMenu.ts # @ 文件与路径引用自动补全菜单
│       ├── modelPicker.ts     # 输入框下方模型 chip：只列收藏模型（`oh-my-pi-chater.favoriteModels`）；收藏在状态栏模型 QuickPick 的 ☆ 按钮里切换
│       ├── fileDropReaders.ts # 拖拽文件/图片读取处理
│       ├── toolView.ts        # <omp-tool-view> 工具卡片封装（创建/流式更新/展开状态记忆/read 路径点击打开文件）
│       ├── vscodeApi.ts       # acquireVsCodeApi 单例封装
│       └── styles/            # 完整 CSS 样式（支持深浅色主题、呼吸动画、卡片排版）
│
└── media/                     # 图标与静态资源；omp-tool-views.js 为 vendored 工具卡片渲染器
```

---

## 3. 核心运行机制与数据流

### 3.1 三层架构与事件流向

```
+-------------------------------------------------------------------+
| 1. Pi CLI 子进程 (pi --mode rpc)                                   |
|    - 负责模型交互、推理、工具执行 (bash, read, edit, write 等)       |
|    - 通过 stdout 推送 NDJSON 事件 (message_update, tool_execution...) |
+---------------------------------+---------------------------------+
                                  │ (JSON-RPC over stdin/stdout)
                                  ▼
+-------------------------------------------------------------------+
| 2. VS Code Extension 宿主 (src/pi/ & src/providers/)               |
|    - PiRpcBridge: 维护子进程 stdio、解析 JSON、分发事件与响应       |
|    - PiChatSession: 会话级状态维护、模型切换、取消生成               |
|    - SidebarProvider: 多 Tab 管理、将 agentEvent 转发给 Webview      |
+---------------------------------+---------------------------------+
                                  │ (postMessage / onDidReceiveMessage)
                                  ▼
+-------------------------------------------------------------------+
| 3. Webview 前端 (src/webview/main.ts)                             |
|    - 维护当前 Tab 的 UI 状态 (state: messages, isStreaming, etc.)  |
|    - #streaming-message: 实时展示进行中的那一步（思考/回答）与尚未归档的工具卡片 |
|    - #messages: 按轮次 (chat-turn) 组织，轮内按时间顺序交错：思考→工具→思考→工具 |
+-------------------------------------------------------------------+
```

### 3.2 思考（Thinking）与工具（Tools）展示机制

1. **流式进行中（Live Streaming）**：
   - **按步（assistant message）组织**：每条 assistant 消息是一步。`message_start`（assistant）时清空实时思考/回答；宿主 `sidebar.ts` 也在 assistant `message_start`/`message_end` 时重置 `streamingText`/`streamingThinking`，二者都只代表当前这一步。
   - **思考过程**：`thinking_start` / `thinking_delta` 在 `#streaming-message` 末尾（位于上一步仍在运行的工具卡片之后）流式输出。用户手动折叠的意图在该步归档后仍保留。
   - **工具调用**：收到 `tool_execution_start` 时，所有工具均实时在 `#streaming-message` 中生成 `<omp-tool-view>` 卡片（每个工具有专属渲染器，未知工具走通用 JSON 渲染）；`tool_execution_update` 把输出尾部作为 `partial` 刷新，`tool_execution_end` 写入 `result` 并结束 running 状态。`edit`/`write` 若有 fileChange 仍使用插件自己的 diff 卡片。toolResult 进入历史后，对应实时卡片（`tool-<id>` / `diff-<id>`）被移除。
   - **归档**：assistant `message_end` 时 `commitStreamedAssistantMessage` 立即把该消息放进历史（随后的 `stateSync` 以权威副本替换），下一步的工具与思考因此排在它下方。
   - **底部状态栏**：`#stream-activity` 动态呈现精准状态（如 `Running bash: find .…`、`Thinking…`），拒绝笼统的 `Working…`。

2. **对话历史（Chat History）**：
   - 每个回合（User Prompt）对应一个 `.chat-turn`，内部包含 `.chat-turn-body`，按消息时间顺序渲染，不再把整轮思考/工具各自合并。
   - 每条 assistant 消息渲染自己的思考块 `details.thinking-block`（key `<msgIndex>:0`，默认展开，附带该步思考时长）与回答文本；只有思考、没有回答文本的中间步骤不显示操作按钮与 footer。
   - 两条 assistant 消息之间的 toolResult 合并为一个 `details.tools-block`（key `tools:<首个 toolResult 下标>`，默认展开，摘要如 `Used 2 tools (bash)`）；既无思考也无文本的纯工具调用步骤不会拆分工具块。
   - `shouldHideMessageInChat` 只隐藏纯 proposed-plan 回复；无文本（仅思考/工具调用）的 assistant 步骤保留。

### 3.3 多 Tab 会话管理

- `SidebarProvider` 维护 `tabs: Map<string, TabState>` 和 `activeTabId`。
- 每个 Tab 对应独立的 `PiChatSession`，切换 Tab 时通过 `pushStateSync` 同步对应 Tab 的完整历史与流式状态，互不干扰。

---

## 4. 关键文件索引与职责

| 文件路径 | 关键类 / 函数 | 职责说明 |
|---|---|---|
| `src/pi/piRpcBridge.ts` | `PiRpcBridge` | 管理 `pi --mode rpc` 子进程，封装 JSON-RPC 请求，订阅 session 事件 |
| `src/pi/rpcSession.ts` | `PiChatSession` | 高级会话接口，封装 prompt、abort、setThinkingLevel、cycleModel 等 |
| `src/providers/sidebar.ts` | `SidebarProvider` | 侧边栏 Provider，处理 Webview 消息中转、Tab 状态机、系统事件广播 |
| `src/providers/status-bar.ts` + `src/pi/providerUsage.ts` | `StatusBarManager` / `ProviderUsageTracker` | VS Code 状态栏：模型名 + 上下文占比 + 当前 provider 订阅额度（5h / 周）。omp 走 `omp usage --json --provider <id>`；pi 读 `auth.json` 的 OAuth token 直连 Anthropic `/api/oauth/usage`、ChatGPT `wham/usage` 和 Antigravity `retrieveUserQuotaSummary`（区分 Gemini 与 Claude/GPT 额度池，不刷新 token，过期则提示）。模型切换立即拉取，`agent_end` 节流 30s，空闲每 5 分钟轮询 |
| `src/pi/loggedInProviders.ts` | `readLoggedInProviders` | 模型列表只保留已 `/login` 的 provider：pi 读 `auth.json` 键；omp 用 `node:sqlite` 读 `agent.db` 的 `auth_credentials`（无 `node:sqlite` 时退回 RPC `get_login_providers`）。`oh-my-pi-chater.showAllModels` 关闭过滤 |
| `src/webview/main.ts` | `renderStreamingContent` / `updateMessages` / `renderToolStart` | Webview 核心，驱动所有界面渲染、DOM 局部更新、实时流式管道 |
| `src/voice/` | `VoiceInput` / `DictationSession` / `SileroVad` / `SpeechSegmenter` / `SttClient` / `MicLevelMeter` | 语音输入：Webview 拿不到麦克风，扩展宿主用 `arecord` / `parecord` / sox `rec` 采 16k 单声道 PCM；Silero VAD（`media/vad/silero_vad.onnx`，取自 pipecat，onnxruntime-web WASM 单线程，运行时文件由 esbuild 拷到 `out/vad/`）按停顿切句（状态机同 pipecat `VADAnalyzer`）；每句立即 POST 到 `oh-my-pi-chater.voice.sttUrl` 的 OpenAI 兼容 `/audio/transcriptions`，按说话顺序把文字插入输入框光标处。`webview/dictation.ts` 是麦克风按钮，命令 `oh-my-pi-chater.toggleDictation`（Ctrl+Alt+M） |
| `src/voiceAgent/` | `WorkerController` / `VoiceAgent` / `VoiceLlm` / `HostToolRouter` / `WorkerDigest` / `FloorArbiter` / `ResearchRunner` / `VoiceMode` / `conversation.reduce` / `TtsClient` / `VoiceTranscriptStore` / `VoicePanel` / `VoicePanelView` | 语音智能体（设计见 `docs/voice-agent-design.md`，§14.1 是实施进度）。开关和状态在会话输入框上方的机器人状态条（`src/webview/voiceBar.ts`），语音模式下输入框的麦克风显示电平并静音，输入框默认发给语音智能体（“Send to omp” 勾选框改发 omp）；宿主经 `VoiceChatControls`（`SidebarProvider` 实现）驱动它们。对话、引擎（LLM / STT / TTS 实际配置）、上下文占比、token 明细和每轮 Timing 显示在底部面板的 “Bot” 视图（宿主 `VoicePanel` + `VoicePanelView`，前端 `src/webview/voiceView.ts` + `voicePanel.ts`、`styles/voice.css`，消息类型 `src/shared/voiceViewProtocol.ts`），记录由 `VoiceTranscriptStore` 按任务保存在 workspaceState。“正在说”以隐藏音频页回报的实际播放为准（参照 Pipecat 的 BotStarted/StoppedSpeaking），首句出声前显示“合成中”。分工：语音智能体自己用 read、grep、glob 查代码；读很多文件的问题交给 `research`（后台一次性 `omp -p`，只读，结果在后续轮次里以 `<research-result>` 附上）；改代码、跑命令只交给 worker。`WorkerController` 是控制 worker 的唯一入口，由 `SidebarProvider` 实现：`send` 在执行时按 worker 状态路由（空闲→新任务，忙+now→`prompt`+`streamingBehavior:'steer'`，忙+after→面板排队队列）；`answer` 与 webview 先到先得地回答 `extension_ui_request`（omp 工具审批也是 select）；`onTabEvent`/`onActiveTaskChanged` 在 `sendStateSync` 与 tab 事件处发出，`onRequestsChanged` 在待回答请求增减时发出（`RpcExtensionUiHandler.onDidChangePending`）。`VoiceLlm` 是隐藏的 omp RPC 进程（`--tools read,grep,glob --approval-mode yolo`，宿主工具经 `set_host_tools` 注册，每个 worker 会话一个语音会话，`switch_session` 切换）；`HostToolRouter` 执行 `tell_worker`（`readOnly` 任务直接派出，改文件的新任务走两阶段确认）/`confirm_task`/`stop_worker`/`answer_worker`/`worker_status`/`research`，主动轮次里只允许 `worker_status`；`WorkerDigest` 把 worker 事件压成一行行活动日志，按轮附给语音模型；`FloorArbiter` 决定何时主动开口（worker 等回答、出错、做完后稳定空闲 4 s、调研完成；`narration: all` 时加进展），`VoiceAgent` 每秒和请求变化时询问它，主动轮次以 `<worker-update>` 结尾，回复 `<silent/>` 不显示也不朗读。语音模式（`VoiceMode`）：隐藏 Chrome（`--headless=new`）里的页面负责 `getUserMedia`（AEC3）和播放，经本地 `ws`（带随机 token）与扩展交换 16 kHz PCM；Silero VAD + `SpeechSegmenter` 分段，机器人说话时的人声先经 STT + `echoFilter` 确认才算插嘴；`conversation.ts` 是纯状态机（`reduce(state, event) → effects`），每个回复一个 `AbortController`，`prompt` 效果调用 `VoiceAgent.say(text, 'stt', listener, { signal, interrupted })`；`TtsClient` 调 OpenAI 兼容 `/audio/speech`，`tts.provider` 决定语言字段：`chatterbox`（本机 :8881，在用）每句发 `language: zh/en`，`kokoro` 按中文/非中文分段、中文段带 `lang_code: z`，`openai` 不发。多窗口：`ActiveVoiceWindow`（`globalStorage/voice-windows/<id>.json`，pid + 最后获得焦点时间）决定哪个窗口有语音，只有开着语音模式、最后获得焦点的窗口在听在说，其余窗口待命（麦克风关、回复打断、状态栏 Standby）。入口：状态栏 "Voice"（开着时显示电平条，旁边 ▴ 显示/隐藏 Voice 视图）、命令 "Voice Agent — Start Voice Mode" / "Stop"；Voice 视图里的输入框和 "Type a Message"（打字对话，语音模式下等同说话），日志另记在输出面板 "Oh My Pi Chater: Voice Agent"；"Debug Worker Control"。内部命令 `oh-my-pi-chater.voiceAgent.say` / `.start`（可传 `chromeArgs`，测试用假麦克风）/ `.takeProactiveTurns` / `.takeOutput` / `.workerControl`、`oh-my-pi-chater.voiceView.state`（视图快照）/ `.agentFocus`（Pi 高亮当前指向）供脚本测试。结对：每轮消息附 `<editor>`（`editorSnapshot.ts`：用户当前文件、光标行、可见行、选区及带行号的选中代码；和上一轮相同时只写 `<editor unchanged/>`），编辑器跟踪与侧边栏共用 `src/utils/fileEditor.ts` 的 `FileEditorTracker`；回复里的代码锚点 `⟦path:12-20⟧` / `⟦path#name⟧` 由 `codeAnchors.ts` 的 `AnchorStream` 从文本流里取出（不显示、不朗读），`agentCursor.ts` 的 `AgentCursor` 显示 Pi 的焦点：讲解时的指向（紫色 `Pi`），语音智能体自己读的文件和 worker 读写的文件（`workerFocus.ts`，写入的行范围用 `piFocus.ts` 的 `changedLines` 比较写前写后的内容得出；蓝色 `Pi · reading` / 绿色 `Pi · writing`），都用行尾标签标出，不动用户的光标和焦点。语音模式下，指向在锚点后那句开始播放时才生效（`voiceMode.ts` 的 `onAnchors`），打字对话时立即生效；指向会保持 6 s，这期间读写活动排队等待。跟随 Pi：状态栏 `$(eye) Pi: …` 或编辑器标题栏的眼睛按钮切换（`followPi` / `unfollowPi` / `toggleFollowPi`，设置 `voiceAgent.followPi` 是启动时的默认值），跟随时编辑器打开并滚动到焦点，用户一打字就停止跟随。宿主工具 `open_file` 不管是否在跟随都会打开文件。两个模式（`hostTools.ts` 的 `AgentMode`）：omp 模式是默认，语音智能体指挥 worker；结对模式下，它用 `edit_file`（`pairHands.ts`：在编辑器里逐行敲入，Pi 的写入高亮跟着走，一次 Ctrl+Z 撤销整次修改）和 `run_in_terminal`（在 "Pi" 终端里用 shell 集成执行，读取输出和退出码）自己动手，worker 的控制工具被宿主拒绝。进入结对模式要先用 `set_mode` 提出请求，用户在下一轮同意后才切换；切回 omp 立即生效。界面上切换用语音面板底栏的模式小标签，或命令 `toggleMode`；结对模式下状态栏显示 `Voice Pair`。当前模式每轮以 `<mode>` 附在消息里，不写进系统提示词。设计见 `docs/voice-pair-agent-cursor.md`（§11 是模式） |
| `src/shared/protocol.ts` | `ClientMessage` / `ServerMessage` | 前后端通信的 TypeScript 消息协议强类型定义 |

---

## 5. 开发与构建注意事项

1. **构建方式**：
   - 编译命令：`npm run compile`（通过 `node esbuild.js` 执行，同时打包 `src/extension.ts` 和 `src/webview/*.ts` 到 `out/`）。
   - 监听模式：`npm run watch`。
2. **TypeScript 检查**：
   - `esbuild` 不执行类型校验，修改代码后可执行 `npx tsc --noEmit` 进行类型安全检查。
   - 注意：`src/test/setup.ts` 和历史遗留 SDK 依赖文件可能包含对老包的引用，主功能开发以 `src/pi/`（基于 RPC）和 `src/webview/` 为准。
3. **运行时依赖**：
   - 宿主系统必须安装 `pi` 命令行（`which pi` 正常输出，或在扩展设置中配置 `oh-my-pi-chater.piPath`）。
4. **思考等级设置**：
   - `package.json` 中的 `oh-my-pi-chater.thinkingLevel` 控制传递给 Pi 的思考深度（`off`, `minimal`, `low`, `medium`, `high`）。需使用具备 reasoning 能力的模型才会有思维链输出。
5. **工具卡片渲染器（vendored）**：
   - `media/omp-tool-views.js` 来自 https://github.com/can1357/oh-my-pi （MIT），文件头记录了来源 commit。
   - 更新方式：在 oh-my-pi 的 `packages/collab-web` 执行 `bun run gen:tool-views`，把生成的 `packages/coding-agent/src/export/html/tool-views.generated.js` 复制为 `media/omp-tool-views.js`，并更新文件头的 commit。
   - **本地补丁（每次更新后必须重新打）**：自定义元素 `#n()` 里的 `this.#t.render(...)` 改为 `Us().flushSync(()=>this.#t.render(...))`（`Us` 是 bundle 内的 react-dom 模块，变量名随构建可能变化）。否则 React 在后续任务里才提交，新插入的卡片先以 0 高度绘制一帧，`updateMessages()` 每次重建历史时整条对话会塌缩再撑开，表现为滚动跳动/抖动；工具越多跳得越远。
   - 主题：`main.css` 中 `omp-tool-view { --accent/--ok/--err/... }` 把渲染器的配色映射到 VS Code 主题变量。
