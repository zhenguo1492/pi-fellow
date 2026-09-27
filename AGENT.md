# AGENT.md - 项目架构与开发指南

本文档汇总了 Oh My Pi Chater（扩展 ID `zhenguo.oh-my-pi-chater`，原型来自 MIT 许可的 [vscode-pi-agent](https://github.com/FChatin/vs-pi-agent)）的核心架构、目录结构、关键业务机制和开发注意事项，便于在后续对话中快速恢复上下文并进行高质量开发。

---

## 1. 项目定位与工作原理

Oh My Pi Chater 是一款将 **Pi 编码智能体（Pi Coding Agent）** 深度集成到 VS Code 侧边栏的扩展。

- **不打包 SDK**：本扩展不直接打包运行时体积庞大的 `@earendil-works/pi-coding-agent` SDK，而是启动本机环境的 `pi` 命令行（通过 `pi --mode rpc`）。
- **进程级通信**：VS Code 扩展宿主启动并管理 `pi --mode rpc` 子进程，通过标准输入输出（`stdin` / `stdout`）遵循 JSON-RPC / NDJSON 协议与 CLI 进行双向通信。
- **轻量原生前端**：Webview 层采用纯 TypeScript + 原生 DOM API + CSS Variables 实现，不依赖 React/Vue 等重型前端框架，启动极快，与 VS Code 原生设计系统高度契合。工具卡片也是原生实现（`src/webview/toolCards/`，移植自 oh-my-pi `packages/collab-web/src/tool-render`）。

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
│   │   ├── sidebar.ts         # 核心侧边栏 WebviewViewProvider：组装下列 sidebar*.ts 模块、视图生命周期、stateSync、按消息类型分发的 handler 表
│   │   ├── sidebarHost.ts     # 各模块依赖的 SidebarHost 接口（post、当前后端的 tabs/活动 tab、stateSync）
│   │   ├── sidebarBackends.ts / sidebarTabs.ts / sidebarTabState.ts # 每个后端的 Tab 工作区与预热会话；Tab 生命周期、订阅、打开 Tab 的持久化；TabState
│   │   ├── sidebarPromptQueue.ts / sidebarSessionPanel.ts / sidebarAttachments.ts / sidebarToolApproval.ts # 发送/排队/中止；恢复面板与会话树；附件与编辑器上下文；工具审批（各自导出 webview 消息 handler）
│   │   ├── sidebarTuiMode.ts / sidebarTui.ts / sidebarBotView.ts / sidebarWorker.ts / sidebarVoiceSessions.ts # TUI 模式；Bot 视图与听写；语音 agent 的 WorkerController；语音会话
│   │   ├── sidebarMessageHandlers.ts / sidebarHtml.ts # handler 表类型与会话类 handler；侧边栏 HTML
│   │   └── settings-panel.ts  # 设置面板 WebviewPanel（管理模型、Provider、API Key 等配置）
│   │
│   ├── shared/                # 扩展宿主与 Webview 共享代码
│   │   ├── protocol.ts        # Webview <-> Extension 双向通信协议定义
│   │   ├── planMessageFilter.ts # Plan 模式消息过滤与解析逻辑
│   │   └── html.ts            # escapeHtml：宿主与 Webview 唯一的 HTML 转义（& < > " '）
│   │
│   └── webview/               # 前端 Webview 界面代码
│       ├── main.ts            # 聊天界面入口：挂 Bot 视图、注册 message 监听、注入消息操作回调、调用 render()
│       ├── chat/              # 主聊天界面模块（依赖单向，无循环导入）
│       │   ├── state.ts       # 与宿主同步的 `state` 对象（ChatState）；各模块的 UI 局部状态私有，经函数访问
│       │   ├── layout.ts      # render()：重建 #app 骨架并绑定稳定事件；botHost
│       │   ├── messageHandler.ts / stateSync.ts / agentEvents.ts # ServerMessage 分发、stateSync 应用、agentEvent 处理
│       │   ├── transcript.ts / messageRender.ts / messageActions.ts # 消息历史重建、单条消息渲染、消息按钮（编辑/重发经 installMessageActions 注入）
│       │   ├── streaming.ts   # 流式阶段、增量、#streaming-message 渲染与活动条
│       │   ├── tools.ts / toolFormat.ts / toolApproval.ts / diffCard.ts / changedFiles.ts / thinking.ts # 工具卡片、diff、改动文件栏、思考块
│       │   ├── composer.ts / composerInput.ts / composerChips.ts / slashMenu.ts / queuedBanner.ts # 输入框（发送/插队/中止/编辑重发）、键盘绑定、附件与编辑器上下文 chip、斜杠菜单、排队消息
│       │   └── helpers.ts / markdown.ts / messageContent.ts / scroll.ts / … # 纯函数与共用小工具（测试在 src/test/unit/webview/chat/）
│       ├── tsconfig.json      # Webview 类型检查（DOM lib）：`npm run typecheck`
│       ├── settings.ts        # 设置页 Webview 入口（注册 message 监听并请求初始数据）
│       ├── settings/          # 设置页模块：state.ts（唯一可变状态 settingsState）、api.ts、tabs.ts、render.ts、messages.ts、events.ts、dom.ts 与各标签页（general/auth/voice/packages/skills/mcp/commands）
│       ├── fileMentionMenu.ts # @ 文件与路径引用自动补全菜单
│       ├── modelPicker.ts     # 输入框下方模型 chip：只列收藏模型（`oh-my-pi-chater.favoriteModels`）；收藏在模型 QuickPick（命令 `selectModel`，会话顶部模型状态条右侧的切换按钮）的 ☆ 按钮里切换
│       ├── modelStatus.ts     # 会话顶部的模型状态条（样式仿 Bot 视图头部）：模型 · ctx · 5h/7d 额度，点击展开上下文、会话 token 与各额度窗口的重置时间
│       ├── fileDropReaders.ts # 拖拽文件/图片读取处理
│       ├── toolView.ts        # 工具卡片外壳（状态点/名称/单行摘要/折叠正文、流式 partial、展开状态记忆、read 路径点击打开文件）
│       ├── toolCards/         # 各工具渲染器（bash/read/edit/write/grep/glob/ast/lsp/fetch/web_search/task/todo，其余走 registry.ts 通用卡片）、parts.ts DOM 积木、util.ts 纯函数
│       ├── vscodeApi.ts       # acquireVsCodeApi 单例封装
│       └── styles/            # 完整 CSS 样式（支持深浅色主题、呼吸动画、卡片排版）
│
└── media/                     # 图标与静态资源
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
| 3. Webview 前端 (src/webview/main.ts + src/webview/chat/)         |
|    - 维护当前 Tab 的 UI 状态 (state: messages, isStreaming, etc.)  |
|    - #streaming-message: 实时展示进行中的那一步（思考/回答）与尚未归档的工具卡片 |
|    - #messages: 按轮次 (chat-turn) 组织，轮内按时间顺序交错：思考→工具→思考→工具 |
+-------------------------------------------------------------------+
```

### 3.2 思考（Thinking）与工具（Tools）展示机制

1. **流式进行中（Live Streaming）**：
   - **按步（assistant message）组织**：每条 assistant 消息是一步。`message_start`（assistant）时清空实时思考/回答；宿主 `sidebar.ts` 也在 assistant `message_start`/`message_end` 时重置 `streamingText`/`streamingThinking`，二者都只代表当前这一步。
   - **思考过程**：`thinking_start` / `thinking_delta` 在 `#streaming-message` 末尾（位于上一步仍在运行的工具卡片之后）流式输出。用户手动折叠的意图在该步归档后仍保留。
   - **工具调用**：收到 `tool_execution_start` 时，所有工具均实时在 `#streaming-message` 中生成工具卡片（`createToolView`；每个工具有专属渲染器，未知工具走通用 JSON 渲染）；`tool_execution_update` 把输出尾部作为 `partial` 刷新，`tool_execution_end` 写入 `result` 并结束 running 状态。`edit`/`write` 若有 fileChange 仍使用插件自己的 diff 卡片。toolResult 进入历史后，对应实时卡片（`tool-<id>` / `diff-<id>`）被移除。
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
- **输入草稿按 Tab 保留**：`stateSync.ts` 在替换当前 Tab 状态前调用 `stashComposerDraft`，重建输入框后调用 `restoreComposerDraft`；`composer.ts` 保存未发送文字、选区、高度及历史消息编辑上下文。草稿只保存在当前 Webview 内存中，不跨窗口重载持久化；发送或手动清空后不会复活。恢复时只清理当前后端已关闭 Tab 的草稿，切换后端不会误删另一个后端的草稿。
- **从恢复面板打开会话**：已在某个 Tab 打开 → 切到那个 Tab；否则新开 Tab（`createEmptyTabState(backend, 会话 cwd)`）加载，不覆盖当前 Tab。只有当前 Tab 是空白对话（无消息、空闲、非 Bot 视图、同后端同目录）时才直接复用它。加载走 `SidebarTabs.loadSessionIntoTab`（与启动恢复共用：加载中显示历史加载占位、`tabReady` 挡住发送、标题先用会话名），失败时关闭新 Tab 并回到原 Tab 和原后端。当前 Tab 在 TUI 模式时同样新开 Tab 并在其中启动 TUI。
- **TUI 模式按 Tab**：标题栏的 TUI 切换只作用于当前 Tab（`TabState.tuiMode`，经 `TabInfo.tuiMode` 发给 webview），其他 Tab 保持各自的聊天/TUI 视图；切回聊天只停止并重新加载这一个 Tab。只拦截当前 Tab 正在流式输出时切入 TUI。TUI 模式随打开的 Tab 持久化（`PersistedOpenTabs.tuiSessionPaths`，按会话文件）；context key `oh-my-pi-chater.tuiMode` 反映当前 Tab。
- **TUI Tab 与语音 agent**：TUI Tab 没有 Bot 视图——切入时清掉 `botView`，Tab 图标显示终端图标，点击只切到该 Tab（`toggleBotView`/`showBotView` 对 TUI Tab 不改 `botView`）。输入框在 TUI 下只保留语音状态条（隐藏 Bot 视图按钮）和审批卡，语音 agent 仍可开关、对话、用 pair 工具；但 TUI 占着会话文件，`SidebarWorker.send`/`abort` 对 TUI Tab 直接报错（design §5.12 规则 7），语音不能派活或叫停。
- **TUI Tab 的运行状态**：TUI 的运行不经过 RPC worker。`TabTuis` 在 TUI 启动后对它的会话文件建 `SessionActivityWatcher`（`src/pi/sessionActivity.ts`，`fs.watchFile` 每 500ms 轮询，只读追加的完整行，文件变短则从头重扫）：user / toolResult / `stopReason: toolUse` 的 assistant 记为工作中，其他 assistant 结束（stop、aborted、error）记为空闲（`sessionEntryBusy`）。`TabTuis` 再和 PTY 输出合并：文件说在跑且 TUI 在重绘（omp / pi 工作时 spinner 每秒上万字节，空闲时 0）才算工作中；静默 3s（`TUI_QUIET_MS`）即结束，兜住中断后文件没记下结束的情况，之后再有输出而文件仍在跑又恢复工作中。结果经 `busyChanged` 写入 `TabState.tuiBusy`，`getTabInfos` 把它并进 `TabInfo.isStreaming`，Tab 图标显示彩色旋转的终端图标；后台 Tab 跑完标 `hasNotification`。TUI 停止或退出时撤掉监听并结束运行状态。只跟随启动时的会话文件：在 TUI 里 `/new` 或 `/resume` 换了会话后不再反映状态。
- **启动不阻塞侧边栏**：`activate` 内没有 `await`——主会话 `initialize()` 在后台跑，侧边栏立即注册；CLI 检查、native 模块预检、清理扩展侧 API key 都只在后台报告。上次打开的 Tab 由 `restorePersistedTabs` 并行恢复（每个 Tab 一个 omp/pi 进程同时启动，不 `await`）。进程未就绪时 stateSync 的 `connectionStatus` 为 `connecting`（`tabConnectionStatus`），输入框上方显示 “Starting omp…”；会话恢复中 `restoringHistory` 为 true，消息区用 “Loading conversation history…” 占位代替欢迎页。
- **Tab 就绪门**：发送、排队、斜杠命令、语音 worker、TUI 启动都先 `await tabReady(tab)`（进程就绪 + `tab.restoring` 完成），不要直接用 `session.isReady` / `waitUntilReady()` 判断能否发送，否则提示词会落进尚未恢复的 Tab。
- **预热**：窗口首个进程启动期间和恢复 Tab 期间 `SidebarBackends.holdPrewarm()` 暂停预热，全部释放后 1.5s 才启动预热进程。
- **模型/技能列表**：`get_available_models` 要等 omp 的 provider 发现（本地端口 + 网络，约 0.5s 起），所以 `_refreshModelsAndSkills` 在初始化和 `syncFromRpc` 中都在后台执行，列表变化时通过 `onDidChangeCatalog` 通知 Tab 重发模型栏和技能；同一后端 + 目录的上次结果缓存在 `catalogByWorkspace`，新进程先用它显示。

### 3.4 权限模式（Manual / Edit automatically / Plan / Auto）

- 名称照 Claude 的模式；内部值依次是 `ask` / `edit` / `plan` / `auto`（`PermissionLevel`）。输入框下方模型选择同一行右侧的按钮打开 “Modes” 菜单（`src/webview/chat/permission.ts`，消息 `setPermissionLevel`），按 Tab 设置；新 Tab 取本工作区上次在菜单里选的模式（`workspaceState` 的 `oh-my-pi-chater.lastPermissionLevel`，`newTabPermissionLevel`），从没选过时取 `oh-my-pi-chater.defaultPermissionLevel`（未设置时沿用旧的 `autoApproveTools`：true → Auto，否则 Manual）；改这个设置会清掉上次的选择。每个会话的模式按会话文件（canonical 路径）记在 `oh-my-pi-chater.sessionPermissions`（最多 500 条，最旧的先丢），`_persistOpenTabs` 与关闭 Tab 时写入，`loadSessionIntoTab`（启动恢复与恢复面板共用）加载前应用，所以关掉再打开的会话仍是它自己的模式。
- **worker 的统一闸门**：每个聊天 worker（omp 与 pi）都用 `--extension out/pi-extension/permissionGate.js` 加载 `src/piExtension/permissionGate.ts`，在 `tool_call` 事件里判定。规则在 `src/pi/permissionPolicy.ts` 的 `toolTier`：`read`（只读白名单、写 `local://`/`memory://`/`xd://`）任何模式都放行；`write`（edit、write、ast_edit、lsp rename/应用 code action）只改文件内容；`exec` 是其余一切（bash、eval、task、browser、MCP、未知工具），以及删除或移动文件的 edit（hashline `REM`/`MV`、apply_patch `*** Delete File:`/`*** Move to:`、patch 形式的 `op: 'delete'`/`rename`）。Manual 对 write 和 exec 都询问；Edit automatically 放行 write、询问 exec；Plan 返回 `{ block, reason }` 告诉模型处于只读计划模式；Auto 全放行。询问是 `select`「`Allow tool: <name>` / Approve·Deny」（与 omp 自带审批同格式，走 `RpcExtensionUiHandler` 的对话框，语音 agent 也能 `answer_worker`）；`oh-my-pi-chater.allowedTools` 里的工具在 Manual / Edit automatically 下免审批。模式写在每个进程一个的临时文件（`PermissionGateFile`，env `VSCODE_PI_PERMISSION_FILE`），闸门每次调用都重读，切换无需重启。Auto 下宿主还会自动批准 omp 自身的 `Allow tool:` 审批（`RpcExtensionUiHandler.autoApproveTools`）。
- **pi 的 Plan** 就是 pi 自己的计划模式（pi-plan-mode）：选 Plan 时 `TabState.readOnlyPlan` 先让闸门只读，`setAgentMode('plan')` 确认开启后交还给 pi（`releasePlanToPi`），闸门在 pi 计划模式开着时放行（由 pi-plan-mode 自己的 `tool_call` 拦截），pi 退出计划模式（Implement 或它自己的菜单）后回到 Tab 的 `permissionBase`（Manual / Edit automatically / Auto）。标题栏只剩 Implement 按钮，没有第二个 Plan 开关。
- **语音 agent**：`HostToolRouter` 的 `PERMISSION_TIER` 把 pair 工具分成 write（edit_file、create_file、create_folder、save_file）和 exec（run_in_terminal、debug_start、delete_file、rename_file），规则同 worker：Plan 拒绝；Manual 两类都要审批，Edit automatically 只有 exec 要审批。需要审批时 `_holdForApproval` 通过 `WorkerController.requestToolApproval` 挂出输入框上方的审批卡（`#tool-approval-host`，随 stateSync 的 `pendingToolApprovals` 重建，Bot 视图下也可见），工具调用**立即返回**“等待批准”，让语音 agent 能马上开口提醒用户去点（工具调用没返回时它说不了话）；等待中的卡片每轮以 `<approval-pending>` 出现在消息里。用户点了之后，批准则执行动作（执行前再查一次 Plan 与 worker 是否在写文件），结果进 `takeSettledApprovals`，`onApprovalSettled` 触发 `approval` 观察，语音 agent 主动说出结果（`<approval-settled>`）。delete_file 仍保留两轮口头确认，卡片在真正删除时才挂出。
- **提醒用户审批**：`FloorArbiter` 的 `approval`（自己审批卡的结果）优先级最高、不等安静间隔；worker 的请求在 `WorkerStatus.fromVoice`（worker 当前指令是语音 agent 发的，按 `voiceOrigins` 判断最新一条 user 消息）时即使 `voiceAgent.narration` 为 off 也会播报，`_describe` 让它提醒用户去聊天里批准/拒绝或口头告诉它。二者都只看当前（语音绑定的）Tab。

---

## 4. 关键文件索引与职责

| 文件路径 | 关键类 / 函数 | 职责说明 |
|---|---|---|
| `src/pi/piRpcBridge.ts` | `PiRpcBridge` | 管理 `pi --mode rpc` 子进程，封装 JSON-RPC 请求，订阅 session 事件 |
| `src/pi/rpcSession.ts` | `PiChatSession` | 高级会话接口，封装 prompt、abort、setThinkingLevel、cycleModel 等 |
| `src/providers/sidebar.ts` | `SidebarProvider` | 侧边栏 Provider，处理 Webview 消息中转、Tab 状态机、系统事件广播 |
| `src/providers/model-status.ts` + `src/pi/providerUsage.ts` | `ModelStatusTracker` / `ProviderUsageTracker` | 会话顶部模型状态条的数据（`ServerMessage` `modelStatus` → `src/webview/modelStatus.ts`，Bot 视图下隐藏）：模型名 + 上下文占比 + 当前 provider 订阅额度（5h / 周，≥90% 警告色，100% 错误色）。omp 走 `omp usage --json --provider <id>`；pi 读 `auth.json` 的 OAuth token 直连 Anthropic `/api/oauth/usage`、ChatGPT `wham/usage` 和 Antigravity `retrieveUserQuotaSummary`（区分 Gemini 与 Claude/GPT 额度池，不刷新 token，过期则提示）。模型切换立即拉取，`agent_end` 节流 30s，空闲每 5 分钟轮询 |
| `src/pi/loggedInProviders.ts` | `readLoggedInProviders` | 模型列表只保留已 `/login` 的 provider：pi 读 `auth.json` 键；omp 用 `node:sqlite` 读 `agent.db` 的 `auth_credentials`（无 `node:sqlite` 时退回 RPC `get_login_providers`）。`oh-my-pi-chater.showAllModels` 关闭过滤 |
| `src/webview/chat/` | `render` / `updateMessages` / `renderStreamingContent` / `handleMessage` | Webview 核心，驱动所有界面渲染、DOM 局部更新、实时流式管道（入口 `src/webview/main.ts`） |
| `src/voice/` | `VoiceInput` / `DictationSession` / `SileroVad` / `SpeechSegmenter` / `SttClient` / `MicLevelMeter` | 语音输入：Webview 拿不到麦克风，扩展宿主用 `arecord` / `parecord` / sox `rec` 采 16k 单声道 PCM；Silero VAD（`media/vad/silero_vad.onnx`，取自 pipecat，onnxruntime-web WASM 单线程，运行时文件由 esbuild 拷到 `out/vad/`）按停顿切句（状态机同 pipecat `VADAnalyzer`）；每句立即 POST 到 `oh-my-pi-chater.voice.sttUrl` 的 OpenAI 兼容 `/audio/transcriptions`，按说话顺序把文字插入输入框光标处。`webview/dictation.ts` 是麦克风按钮，命令 `oh-my-pi-chater.toggleDictation`（Ctrl+Alt+M） |
| `src/voiceAgent/` | `WorkerController` / `VoiceAgent` / `VoiceLlm` / `HostToolRouter` / `WorkerDigest` / `FloorArbiter` / `ResearchRunner` / `VoiceMode` / `conversation.reduce` / `TtsClient` / `VoiceTranscriptStore` / `VoicePanel` | 语音智能体（设计见 `docs/voice-agent-design.md`，§14.1 是实施进度）。开关和状态在会话输入框上方的机器人状态条（`src/webview/voiceBar.ts`），语音模式下输入框的麦克风显示电平并静音，输入框默认发给语音智能体（“Send to omp” 勾选框改发 omp）；宿主经 `VoiceChatControls`（`SidebarProvider` 实现）驱动它们。对话、引擎（LLM / STT / TTS 实际配置）、上下文占比、token 明细和每轮 Timing 显示在会话 tab 的 “Bot” 视图：点 tab 标题左边的图标（聊天气泡 ↔ 机器人）把该 tab 的正文在会话记录和 Bot 视图之间切换（宿主 `VoicePanel` 经 `BotViewSurface`（`SidebarProvider` 实现，`TabState.botView`）收发，前端 `src/webview/voicePanel.ts` 挂在 `main.ts` 的 `.bot-host`、`styles/voice.css`，消息类型 `src/shared/voiceViewProtocol.ts`），记录由 `VoiceTranscriptStore` 按任务保存在 workspaceState。“正在说”以隐藏音频页回报的实际播放为准（参照 Pipecat 的 BotStarted/StoppedSpeaking），首句出声前显示“合成中”。分工：语音智能体自己用 read、grep、glob 查代码；读很多文件的问题交给 `research`（后台一次性 `omp -p`，只读，结果在后续轮次里以 `<research-result>` 附上）；改代码、跑命令只交给 worker。`WorkerController` 是控制 worker 的唯一入口，由 `SidebarProvider` 实现：`send` 在执行时按 worker 状态路由（空闲→新任务，忙+now→`prompt`+`streamingBehavior:'steer'`，忙+after→面板排队队列）；`answer` 与 webview 先到先得地回答 `extension_ui_request`（omp 工具审批也是 select）；`onTabEvent`/`onActiveTaskChanged` 在 `sendStateSync` 与 tab 事件处发出，`onRequestsChanged` 在待回答请求增减时发出（`RpcExtensionUiHandler.onDidChangePending`）。`VoiceLlm` 是隐藏的 omp RPC 进程（`--tools read,grep,glob --approval-mode yolo`，宿主工具经 `set_host_tools` 注册，每个 worker 会话一个语音会话，`switch_session` 切换）；`HostToolRouter` 执行 `tell_worker`（`readOnly` 任务直接派出，改文件的新任务走两阶段确认）/`confirm_task`/`stop_worker`/`answer_worker`/`worker_status`/`research`，主动轮次里只允许 `worker_status`；`WorkerDigest` 把 worker 事件压成一行行活动日志，按轮附给语音模型；`FloorArbiter` 决定何时主动开口（worker 等回答、出错、做完后稳定空闲 4 s、调研完成；`narration: all` 时加进展），`VoiceAgent` 每秒和请求变化时询问它，主动轮次以 `<worker-update>` 结尾，回复 `<silent/>` 不显示也不朗读。语音模式（`VoiceMode`）：隐藏 Chrome（`--headless=new`）里的页面负责 `getUserMedia`（AEC3）和播放，经本地 `ws`（带随机 token）与扩展交换 16 kHz PCM；Silero VAD + `SpeechSegmenter` 分段，机器人说话时的人声先经 STT + `echoFilter` 确认才算插嘴；`conversation.ts` 是纯状态机（`reduce(state, event) → effects`），每个回复一个 `AbortController`，`prompt` 效果调用 `VoiceAgent.say(text, 'stt', listener, { signal, interrupted })`；`TtsClient` 调 OpenAI 兼容 `/audio/speech`，`tts.provider` 决定语言字段：`chatterbox`（本机 :8881，在用）每句发 `language: zh/en`，`kokoro` 按中文/非中文分段、中文段带 `lang_code: z`，`openai` 不发。多窗口：`ActiveVoiceWindow`（`globalStorage/voice-windows/<id>.json`，pid + 最后获得焦点时间）决定哪个窗口有语音，只有开着语音模式、最后获得焦点的窗口在听在说，其余窗口待命（麦克风关、回复打断、状态栏 Standby）。入口：状态栏 "Voice"（开着时显示电平条，旁边 ▴ 显示/隐藏 Voice 视图）、命令 "Voice Agent — Start Voice Mode" / "Stop"；Voice 视图里的输入框和 "Type a Message"（打字对话，语音模式下等同说话），日志另记在输出面板 "Oh My Pi Chater: Voice Agent"；"Debug Worker Control"。内部命令 `oh-my-pi-chater.voiceAgent.say` / `.start`（可传 `chromeArgs`，测试用假麦克风）/ `.takeProactiveTurns` / `.takeOutput` / `.workerControl`、`oh-my-pi-chater.voiceView.state`（视图快照）/ `.agentFocus`（Pi 高亮当前指向）供脚本测试。结对：每轮消息附 `<editor>`（`editorSnapshot.ts`：用户当前文件、光标行、可见行、选区及带行号的选中代码；和上一轮相同时只写 `<editor unchanged/>`），编辑器跟踪与侧边栏共用 `src/utils/fileEditor.ts` 的 `FileEditorTracker`；回复里的代码锚点 `⟦path:12-20⟧` / `⟦path#name⟧` 由 `codeAnchors.ts` 的 `AnchorStream` 从文本流里取出（不显示、不朗读），`agentCursor.ts` 的 `AgentCursor` 显示 Pi 的焦点：讲解时的指向（紫色 `Pi`），语音智能体自己读的文件和 worker 读写的文件（`workerFocus.ts`，写入的行范围用 `piFocus.ts` 的 `changedLines` 比较写前写后的内容得出；蓝色 `Pi · reading` / 绿色 `Pi · writing`），都用行尾标签标出，不动用户的光标和焦点。语音模式下，指向在锚点后那句开始播放时才生效（`voiceMode.ts` 的 `onAnchors`），打字对话时立即生效；指向会保持 6 s，这期间读写活动排队等待。跟随 Pi：状态栏 `$(eye) Pi: …` 或编辑器标题栏的眼睛按钮切换（`followPi` / `unfollowPi` / `toggleFollowPi`，设置 `voiceAgent.followPi` 是启动时的默认值），跟随时编辑器打开并滚动到焦点，用户一打字就停止跟随。宿主工具 `open_file` 不管是否在跟随都会打开文件。两个模式（`hostTools.ts` 的 `AgentMode`）：omp 模式是默认，语音智能体指挥 worker；结对模式下，它用 `edit_file`（`pairHands.ts`：在编辑器里逐行敲入，Pi 的写入高亮跟着走，一次 Ctrl+Z 撤销整次修改）和 `run_in_terminal`（在 "Pi" 终端里用 shell 集成执行，读取输出和退出码）自己动手，worker 的控制工具被宿主拒绝。进入结对模式要先用 `set_mode` 提出请求，用户在下一轮同意后才切换；切回 omp 立即生效。界面上切换用语音面板底栏的模式小标签，或命令 `toggleMode`；结对模式下状态栏显示 `Voice Pair`。当前模式每轮以 `<mode>` 附在消息里，不写进系统提示词。设计见 `docs/voice-pair-agent-cursor.md`（§11 是模式） |
| `src/shared/protocol.ts` | `ClientMessage` / `ServerMessage` | 前后端通信的 TypeScript 消息协议强类型定义 |

---

## 5. 开发与构建注意事项

1. **构建方式**：
   - 编译命令：`npm run compile`（通过 `node esbuild.js` 执行，同时打包 `src/extension.ts` 和 `src/webview/*.ts` 到 `out/`）。
   - 监听模式：`npm run watch`。
2. **TypeScript 检查**：
   - `esbuild` 不执行类型校验，修改代码后执行 `npm run typecheck`（扩展宿主 `tsconfig.json` + Webview `src/webview/tsconfig.json`）进行类型安全检查。
   - 注意：`src/test/setup.ts` 和历史遗留 SDK 依赖文件可能包含对老包的引用，主功能开发以 `src/pi/`（基于 RPC）和 `src/webview/` 为准。
3. **运行时依赖**：
   - 宿主系统必须安装 `pi` 命令行（`which pi` 正常输出，或在扩展设置中配置 `oh-my-pi-chater.piPath`）。
4. **思考等级设置**：
   - `package.json` 中的 `oh-my-pi-chater.thinkingLevel` 控制传递给 Pi 的思考深度（`off`, `minimal`, `low`, `medium`, `high`）。需使用具备 reasoning 能力的模型才会有思维链输出。
5. **工具卡片（`src/webview/toolView.ts` + `src/webview/toolCards/`）**：
   - 移植自 https://github.com/can1357/oh-my-pi （MIT）@ a1b3b83 的 `packages/collab-web/src/tool-render`，每个工具一个渲染器（`summary` 返回头部单行内容，`body` 返回展开后的块），在 `toolCards/registry.ts` 注册。
   - 渲染全部同步完成（原生 DOM），卡片插入时即为最终高度；`updateMessages()` 重建历史不会导致滚动跳动。不要引入异步渲染。
   - 样式在 `styles/toolCards.css`（`tv-*` 类），`.tv-card` 上的 `--tv-*` 变量映射到 `main.css` `:root` 的 VS Code 主题变量。
