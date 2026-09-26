# 语音智能体 Handoff（2026-09-25，语音视图完成后）

设计见 [`voice-agent-design.md`](./voice-agent-design.md)，其中 §14.1 是逐步的实施记录。本文只记录交接时的状态：做了什么、怎么用、怎么验证、还缺什么、下一步。

## 1. 当前状态

**可以对着麦克风说话，由语音智能体指挥侧边栏里的 worker，并用语音回答。** 它会主动播报 worker 的进展，支持插嘴打断，多个 VS Code 窗口之间不会抢麦克风。开关和状态在会话输入框上方的机器人状态条，对话、引擎和 token 用量在底部面板的 “Bot” 标签里。

| 步骤 | 内容 | 状态（实测数据见设计文档 §14.1） |
|---|---|---|
| 1 | WorkerController：通过侧边栏的发送路径控制 worker（派活、插话、排队、叫停、回答弹窗） | 完成，VS Code 实测 13 项检查通过 |
| 2 | 语音 omp 进程 + 宿主工具分发（HostToolRouter）+ worker 工作日志 + 每个任务一份语音上下文（打字对话） | 完成，19 项通过 |
| 2.1 | 语音智能体自己用 read、grep、glob 查代码；只读任务派给 worker 时不需要确认 | 完成，7 项通过 |
| 2.2 | 后台调研（research）：一次性、只读的 `omp -p` | 完成，5 项通过 |
| 3a | 主动播报（FloorArbiter）：worker 等你回答、出错、做完，调研完成时主动开口 | 完成，16 项通过 |
| 3b | 音频环路：隐藏 Chrome 录音和播放（带回声消除）、Silero VAD、STT、插嘴确认、逐句 TTS | 完成，8 项通过；换成 chatterbox 后重跑 6 项通过 |
| 3b.1 | 多窗口：只有最后获得焦点的那个语音窗口在听、在说 | 完成，6 项通过 |
| 3c | 语音视图：单独的 `WebviewView`、对话记录（逐句朗读状态、被打断的部分）、卡片、打字、静音/闭嘴、历史；状态栏电平条和 ▴；会话里"From voice"标记 | 完成，VS Code 实测 15 项通过 |
| 3d | 控制挪进输入框（机器人状态条、麦克风两种状态、输入框默认发给语音智能体）；底部 Bot 视图（引擎、上下文占比、token 明细、每轮 Timing）；音频页面回报实际播放，新增“合成中”状态；删掉状态栏项 | 完成，VS Code 实测通过（设计 §14.1） |

- **端到端延迟**（从你停止说话到听到回答，脚本用假麦克风实测）：Kokoro 2.24 s（说完判定 1.20 s、STT 0.21 s、首字 0.73 s、首句合成 0.10 s）；chatterbox 2.78 s（首句合成 0.56 s）。
- **单元测试**：`src/test/unit/voiceAgent/` 11 个文件共 86 个，加上 `src/test/unit/voice/` 的 14 个，共 100 个，全部通过。`src/voiceAgent/` 没有 `tsc` 报错。
- **真人实测**：你已经对着麦克风试过（"还可以"）。脚本里的音频测试仍然用 Chrome 假麦克风和 `--mute-audio`。

## 2. 已定的设计决定

| 决定 | 内容 | 设计文档 |
|---|---|---|
| 语音绑定任务 | 语音附着在当前 tab 的任务上。每个 worker 会话一份语音上下文，切换 tab 就切换上下文；后台任务不发声 | §5.12 |
| 一个进程，多份上下文 | 只有一个语音 omp 进程，用 `switch_session` 切换各任务的语音会话（约 0.02 s） | §2.3 |
| 只做任务控制 | 派活、插话、排队、叫停、回答弹窗、查看进展；不管理会话 | §6 |
| 能看不能改（方案 C） | 语音智能体自己用 read、grep、glob 查代码；读很多文件的问题交给后台 `research`；改代码、跑命令只交给 worker | §7.4 |
| 一个派活工具 | `tell_worker(message, when, readOnly?)` 在执行那一刻按 worker 状态决定：空闲时作为新任务；忙且 `now` 时插话；忙且 `after` 时排队 | §6 |
| 确认只针对改文件的任务 | 只读任务直接派出。改文件的新任务先形成提案，你在之后的消息里同意，`confirm_task` 才生效 | §6 |
| 回答弹窗的时序规则 | 只接受请求出现之后你说的话；允许用语音批准工具审批 | §6 |
| 看 worker 的方式 | 看工作日志（把事件压成一行行动作），不看 worker 的完整上下文 | §5.8、§7.2 |
| 主动播报 | 优先级：`needs_input` > `error` > `done` > `research` > `progress`。`done` 要等 worker 空闲满 4 s 才算（omp 插话后会再自动开一轮）。主动轮次里只能调用 `worker_status`，不能派活或代答。不值得说时模型回复 `<silent/>`，整轮不出声。两次主动播报至少间隔 8 s，worker 等你回答或出错时不受这个限制 | §5.9 |
| 音频在隐藏 Chrome 里 | webview 打不开麦克风；Chrome 的回声消除（AEC3）只能消掉它自己播放的声音。所以录音和播放都放在同一个隐藏 Chrome 页面里，扩展通过本地 WebSocket 与它交换 PCM。页面连接要带随机 token | §5.1、§5.7 |
| 状态机驱动，每轮一个取消令牌 | `conversation.ts` 是纯函数状态机，做全部决策；`voiceMode.ts` 执行副作用。打断时中止本轮的令牌，生成、TTS 和播放一起停。状态机按**实际播放过**的句子写 `<interrupted>` 说明 | §4、§5.7 |
| 插嘴要经过 STT 确认 | 机器人说话时听到的声音，先转写再判断：和机器人刚说的话相似的当作回声，Whisper 在静音上的固定幻听当作噪声，都不算插嘴 | §5.2、原型文档 §4.3 |
| 多窗口 | 开着语音模式的窗口里，最后获得焦点的那个才在听和说，其他窗口待命。靠 `globalStorage/voice-windows/` 下每个窗口一个文件来协调，不用锁 | §13 R9 |
| TTS 按服务类型发语言字段 | `chatterbox`：每句发 `zh` 或 `en`。`kokoro`：按中文和非中文分段，中文段带 `lang_code: z`。`openai`：不发语言字段 | §5.6 |

## 3. 代码地图

### `src/voiceAgent/`（全部新增）

| 文件 | 职责 |
|---|---|
| `workerController.ts` | `WorkerController` 接口：`activeTask`、`send`、`abort`、`status`、`pendingRequests`、`answer`、`recentTurns`、`onActiveTaskChanged`、`onTabEvent`、`onRequestsChanged` |
| `voiceLlm.ts` | 语音 omp 进程（复用 `PiRpcBridge`），启动参数 `--tools read,grep,glob --approval-mode yolo --session-dir <临时目录>` |
| `hostTools.ts` | 宿主工具与 `HostToolRouter`：`tell_worker`、`confirm_task`、`stop_worker`、`answer_worker`、`worker_status`、`research`；提案、时序规则、主动轮次的工具限制 |
| `voicePrompt.ts` | 系统提示词；用户轮次和主动轮次（`<worker-update kind=…>`）的消息格式 |
| `voiceAgent.ts` | 编排：串行轮次（用户轮次优先于主动轮次）、按任务切换上下文、每秒询问一次仲裁器、`warmUp`、`floorReleased`、`<silent/>` 拦截 |
| `floorArbiter.ts` | 话语权仲裁：从当前状态推出该播报什么观察，并判断现在能不能说 |
| `workerDigest.ts` | 每个 tab 一份工作日志 |
| `research.ts` | 后台一次性 `omp -p`（只读，最长 5 分钟，同时最多 3 个） |
| `conversation.ts` | 语音模式的状态机：`listening`、`userSpeaking`、`transcribing`、`thinking`、`synthesizing`、`speaking`、`standby` 等阶段；`ttsActive` / `botSpeaking` 两个标志（设计 §5.7） |
| `voiceMode.ts` | 执行器：麦克风 → VAD → 分段或插嘴检查 → STT → 状态机 → `VoiceAgent.say(…, 'stt')` → 逐句 TTS → 播放；播放开始/结束以音频页面的回报为准，每轮结束时经 `onMetrics` 报各环节时间点 |
| `browserAudio.ts` | 本地 HTTP 和 `ws` 服务、音频页面（带 clip id 播放，回报 `started` / `ended`）、查找 Chrome 并启动隐藏窗口（临时 profile，退出后删除）；找不到 Chrome 时改用默认浏览器打开 |
| `tts.ts` | OpenAI 兼容的 `/audio/speech` 客户端，处理三种服务的语言字段差异 |
| `sentences.ts` | 把流式文字切成句子（首句尽早送出，代码块围栏内不切），并清理不适合朗读的内容 |
| `echoFilter.ts` | 判断插嘴是真的还是回声或幻听 |
| `activeWindow.ts` | 多窗口之间决定谁拥有语音 |
| `voiceAgentCommands.ts` | 命令、输出面板日志；经 `VoiceChatControls` 驱动会话里的机器人状态条和麦克风、接收它们的操作；接起 Bot 视图、对话记录和语音模式 |
| `transcriptStore.ts` | `VoiceTranscriptStore`：Bot 视图的对话记录，按任务分组，记下每句的朗读状态、每次 LLM 调用的 token 和每轮的 Timing，存进 `workspaceState` |
| `voicePanel.ts`、`voicePanelView.ts` | 底部面板的 Bot 视图：快照（引擎、上下文占比、token、卡片、对话）、卡片动作、历史 QuickPick |
| `workerControlCommands.ts` | 调试命令（直接控制 worker，不经过语音模型） |

### 修改的已有文件

| 文件 | 改动 |
|---|---|
| `src/providers/sidebar.ts` | `SidebarProvider` 实现 `WorkerController` 和 `VoiceChatControls`；面板发送和语音共用 `_beginPrompt`；检测当前任务变化；转发 tab 事件和请求变化；`setVoiceStatus`（语音模式开着或启动中时停用听写，状态进 stateSync 的 `voice` 和 `voiceStatus` 消息）、`postVoiceLevel`、`onVoiceAction`；语音派发的用户消息标 `_fromVoice` |
| `src/providers/voiceOrigin.ts`（新增）、`src/pi/pendingAttachments.ts` | `VoiceOriginTracker`：按文本把语音发出的消息和随后到来的用户消息对上（新任务、插话、排队都算）；`QueuedPrompt.fromVoice` |
| `src/pi/rpcExtensionUi.ts` | `pendingRequests()`（带 `receivedAt`）；`respond()` 先到先得；语音回答或超时后关闭面板上的弹窗 |
| `src/pi/rpcSession.ts` | 调用方给出 `streamingBehavior` 时，worker 空闲也照样带上 |
| `src/pi/piRpcBridge.ts`、`src/pi/rpcTypes.ts` | 新增 `setHostTools`、`onExit`、`RpcHostToolDefinition` |
| `src/extension.ts` | 注册命令，把会话视图接给语音（`chat: sidebarProvider`） |
| `src/voice/voiceInput.ts`、`src/webview/dictation.ts`、`src/shared/protocol.ts` | 听写和语音模式互斥：`VoiceInput.setBlocked`；语音模式开着时输入框的麦克风显示语音智能体麦克风的电平、点击静音 |
| `src/voice/micLevel.ts`（新增）、`src/voice/dictation.ts` | 麦克风电平（dBFS → 0..1、峰值保持）抽成共用的 `MicLevelMeter`，听写和语音模式共用；每次上报还带这 64 ms 的真实波形（`wavePoints`：160 个带符号峰值，固定增益，机器人回复的波形也用它），输入框顶栏的示波器线（`src/webview/voiceWave.ts`）照原样绘制，报告之间只做短交叉淡入 |
| `src/shared/voiceViewProtocol.ts`（新增） | Bot 视图的消息和快照类型，以及会话用的 `VoiceStatus`、`VoiceAgentAction` |
| `src/webview/voiceBar.ts`（新增） | 输入框上方的机器人状态条，和输入框发给语音智能体还是 omp 的判断（“To worker” 勾选框） |
| `src/webview/voicePanel.ts`、`src/webview/styles/voice.css`（新增） | Bot 视图的前端：引擎、上下文、token 明细、卡片、对话流；`src/webview/voiceView.ts` 是入口（`out/webview/voiceView.js`，`esbuild.js`） |
| `src/webview/main.ts`、`src/webview/styles/main.css` | 会话里语音派发的消息显示"🎙 From voice"标记；机器人状态条、麦克风两种状态、输入框路由到语音智能体 |
| `package.json`、`package-lock.json` | 新增命令、设置项（`historySessions`、`debugTranscript`）；底部面板 `Bot` 视图（标题栏历史按钮）；Ctrl+Alt+M 语音模式下是静音、否则是听写；新依赖 `ws`（开发依赖 `@types/ws`） |
| `.vscode/launch.json` | F5 启动的开发窗口直接打开 `../voice-agent-playground` |
| `docs/voice-agent-design.md`、`AGENT.md` | 实测结论、设计更新、实施进度、文件索引 |
| `src/test/unit/voiceAgent/` | 新增单元测试 |

### 不属于这次改动的未提交文件

`src/pi/piCliPaths.ts`、`src/providers/settings-panel.ts`、`src/webview/main.ts`、`src/test/unit/settingsBackendSync.test.ts`、`src/test/unit/pi/windowBackend.test.ts` 在开始语音智能体工作之前就已有改动。**提交时分开。** 例外：`src/webview/main.ts` 里的语音改动要用 `git add -p` 挑出来：机器人状态条和麦克风（导入 `./voiceBar` 和 `applyVoiceMicStatus` / `applyVoiceLevel`、`voiceStatus` / `voiceLevel` 消息、stateSync 的 `voice`、`sendComposerToVoice` 和它在发送路径里的调用、占位文字），以及"From voice"标记（`FROM_VOICE_TAG` 和 `renderMessage` 里用到它的地方）。

## 4. 怎么用

### 前提

- 已安装 omp（语音进程和后台调研都必须用 omp；worker 可以是 omp 或 pi）。
- 本机有 Chrome、Edge、Chromium 或 Brave 之一。都找不到时，会在默认浏览器里打开音频页，需要保持这个标签页开着。
- STT 服务：`oh-my-pi-chater.voice.sttUrl`，你现在的设置是 `http://127.0.0.1:8010/v1`。
- TTS 服务：`oh-my-pi-chater.voiceAgent.tts.url`，你现在的设置是 `http://127.0.0.1:8881/v1`，`tts.provider` 是 `chatterbox`。
- 启动时会检查 STT 能否连通；STT 或 TTS 地址为空会直接报错。

### 操作

1. 按 **F5**，开发窗口会打开 `~/source/vscode/voice-agent-playground`。这是给 worker 随便改的测试项目，`git checkout . && git clean -fd` 可以还原。
2. 在侧边栏给 worker 一个任务，比如 `运行 npm test，告诉我结果`。
3. 开启语音模式：点会话输入框上方的**机器人**，或运行命令 **Voice Agent — Start Voice Mode**。机器人旁边显示状态：Listening / Hearing you / Transcribing（蓝）、Thinking（黄）、Synthesizing（橙，回答的第一句还在合成）、Speaking（绿）；另一个窗口占着麦克风时显示 `Standby`，静音时显示 `Muted`。
4. **直接说话**，停顿 1.2 s 算说完。它回答时你可以插嘴打断。输入框里的麦克风这时显示你的麦克风电平，点一下（或 Ctrl+Alt+M）静音 / 取消静音。状态条上的喇叭按钮停下正在念的回答，模式按钮切换模式（委派图标：交给 worker 做；握手图标：Pair，自己动手）。
5. 不方便说话时，直接在会话输入框里打字：默认发给语音智能体，效果和说话一样，也会打断正在进行的回复。要发给 omp，勾上页脚的 **To worker**；斜杠命令和带附件的消息总是发给 omp。
6. 底部面板的 **Bot** 标签：上面是 LLM / STT / TTS 实际用的模型、声音和语言，当前语音上下文占了多少上下文窗口，token 汇总（点开看每次调用的明细）；下面是对话，逐句显示朗读进度，被打断没念出的部分加删除线，每条回复有收起的 “Timing”。标题栏的 🕘 回看过去的会话。
7. 结束时再点机器人，或运行 **Voice Agent — Stop**。隐藏 Chrome 会退出，临时文件会删除；Bot 视图里的对话保留为只读记录。不开语音模式时，"Type a Message" 命令就是纯打字对话，回复只显示文字。
8. 想绕过语音模型、直接控制 worker：**Voice Agent — Debug Worker Control**。

可以试的话：`clamp 是干嘛的`、`调研一下测试还缺什么`、`让 worker 跑测试`、`把 average 修好` → `好`、worker 干活时问 `它在干嘛`、`停下`。worker 弹出工具审批时，语音智能体会主动问你，你说"批准"即可。

### 设置项（`oh-my-pi-chater.voiceAgent.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `model` / `thinking` | 空 / `off` | 语音模型；为空时跟随当前 tab 的模型。修改后要 Stop 一次才生效 |
| `confirmBeforeDispatch` | `true` | 改文件的新任务先确认 |
| `narration` | `important` | 主动播报范围：`off` 从不；`important` 等你回答、出错、完成、调研结果；`all` 再加上进展 |
| `minProactiveGapSecs` / `narrationIntervalSecs` | 8 / 30 | 防连播间隔 / 进展播报间隔 |
| `turnStopSecs` | 1.2 | 停顿多久算你说完 |
| `tts.provider` / `tts.url` / `tts.model` / `tts.voice` / `tts.speed` | `openai` / 空 / 空 / 空 / 1 | TTS 服务；model 和 voice 为空时用各服务的默认值 |
| `historySessions` | 20 | 每个工作区保留的语音会话数（每个任务、每次语音模式各算一个） |
| `debugTranscript` | `false` | 视图里显示每轮发给语音模型的内容和不出声的主动轮次，排查用 |

STT 沿用 `oh-my-pi-chater.voice.sttUrl` / `sttModel` / `language` / `vadConfidence`。

## 5. 怎么重跑验证

- 单元测试：`npx vitest run src/test/unit/voiceAgent src/test/unit/voice`（100 个）。全量 `npx vitest run` 里有几个原本就失败的旧 SDK 测试（`src/test/unit/pi/`），和语音无关。
- 类型检查：`npx tsc --noEmit -p .`。仓库里原本就有一批报错（旧 SDK 依赖、`piRpcBridge.ts` 第 250 行附近、`rpcExtensionUi.ts` 的 `timeout` / `placeholder`、`sidebar.ts` 两处）；`src/voiceAgent/` 没有报错。`src/webview/` 不在 tsconfig 里，靠 `node esbuild.js` 构建检查。
- 冒烟测试（在真实 VS Code 里用真实 omp 跑脚本）：都在 `/tmp/voice-smoke/`，**没有纳入版本库，重启后可能就没了**。需要长期回归的话，应该挪进仓库。
  - 运行：`SUITE=<脚本> env -u ELECTRON_RUN_AS_NODE node /tmp/voice-smoke/run.js`。这个终端环境设置了 `ELECTRON_RUN_AS_NODE`，必须用 `env -u` 去掉。
  - 可选环境变量：`APPROVAL=1` 在测试工作区打开 worker 的工具审批；`NO_CONFIRM=1` 关闭派活确认；`SETTINGS='{…}'` 追加 VS Code 设置。
  - **音频相关的脚本必须用 `SETTINGS` 传入 STT 和 TTS**，因为测试用的是全新的用户目录，没有你的设置：
    `SETTINGS='{"oh-my-pi-chater.voice.sttUrl":"http://127.0.0.1:8010/v1","oh-my-pi-chater.voiceAgent.tts.provider":"chatterbox","oh-my-pi-chater.voiceAgent.tts.url":"http://127.0.0.1:8881/v1"}'`
  - 脚本和步骤的对应关系：

    | 脚本 | 步骤 | 附加条件 |
    |---|---|---|
    | `suite.js`、`suite4.js` | 1 | `suite4.js` 需要 `APPROVAL=1` |
    | `suite-voice-a.js`、`suite-voice-b.js` | 2 | `-b` 需要 `APPROVAL=1 NO_CONFIRM=1` |
    | `suite-voice-c.js`、`suite-voice-d.js` | 2.1、2.2 | `PLAYGROUND_CALC` / `PLAYGROUND_TEST` 指向 `calc.js` 和 `test.js`（`/tmp/voice-smoke/` 里有副本） |
    | `suite-voice-e.js`、`suite-voice-f.js` | 3a | `-e` 需要 `APPROVAL=1` |
    | `suite-voice-audio.js`、`-audio-b.js` | 3b | `SETTINGS`；假麦克风文件 `user-mic.wav`（可以用 `MIC_WAV` 换成别的） |
    | `suite-voice-audio-c.js` | 3b.1 | `SETTINGS` |
    | `suite-voice-view.js`、`suite-voice-view-b.js` | 3c | `-view` 需要 `SETTINGS`；两个脚本都读 `oh-my-pi-chater.voiceView.state` 快照，并用 `gnome-screenshot` 截全屏到 `/tmp/voice-smoke/*.png` |

  - 运行时会弹出一个独立的 VS Code 窗口，跑完自动关闭，**不要手动关**。
  - 跑完删掉测试会话：`rm -rf ~/.omp/agent/sessions/-tmp-voice-smoke-*`。

## 6. 实测得到的外部行为（已写进设计文档）

- **pi / omp**（§2.4）：两者都支持 `prompt` + `streamingBehavior`，空闲时按普通 prompt 执行。omp 的插话会截断正在执行的命令，约 3 s 后再自动开一轮。omp 的工具审批就是普通的 `select`（Approve / Deny）。语音进程必须用 `--approval-mode yolo` 启动，否则宿主工具会被 `always-ask` 配置拦住。
- **chatterbox**（§5.6）：必须按句子发 `language`，不发的话英文会读坏；只接受它加载的那个模型名。每句合成 0.5–1.2 s。它支持流式输出（首字节约 0.46 s），但还没用上。
- **Kokoro**（§5.6）：英文音色直接读中文会不停念 "Chinese letter"；整句带 `lang_code: z` 又会把英文单词读坏，所以按中英文分段合成。已知弱点：夹在英文词之间的单个汉字会读错。
- **回声和幻听**（`echoFilter.ts`）：误判的插嘴转写出来是机器人自己那句话的片段；Whisper 在静音上会编出"点赞 订阅""Thank you."之类的话。
- 这台机器上 pi 的默认模型（Anthropic OAuth）会被拒绝，提示"Third-party apps now draw from your extra usage"。

## 7. 已知缺口

| 缺口 | 影响 | 建议 |
|---|---|---|
| 设置页没有 TTS 区块（连通性测试、试听） | 只能在 settings.json 里手改 | 单独做 |
| 没有思考提示音（`fillerAfterSecs`，§7.7） | 语音智能体调工具或查代码时会沉默几秒 | 小改动 |
| 没用 chatterbox 的流式输出 | 首句多等约 0.1–0.7 s | 延迟优化 |
| 播放进度靠估算（写出时刻加 80 ms），没有页面回报的实际播放时间 | `<interrupted>` 里"听到了哪些"可能差一句 | P3 |
| 没做 Smart Turn；"按住说话"（半双工兜底）暂不做，需要时做成快捷键 | 嘈杂环境或说话停顿长时可能被抢话 | P3 |
| `worker_transcript`、`worker_diff`、`maxReadSteps`、EditorWatcher 没做 | 查细节只能靠 `worker_status`；不知道你正在看哪段代码 | P1 余项 / P2 |
| worker 进程意外退出没有事件，不会播报 | 你不知道 worker 挂了 | 给 `WorkerController` 加事件 |
| 没在扩展里验证：pi 当 worker 的完整流程；webview 新开 tab 再切回的流程；语音回答后面板弹窗确实关闭 | 可能有未发现的问题 | 手动测一次 |
| 会话里的"From voice"标记只记在内存里 | 重启 VS Code 后从磁盘打开的会话没有标记 | 需要时把标记存进 workspaceState |
| 语音视图和会话视图的界面文字是英文，设计稿是中文 | 和扩展其他界面一致 | 想要中文再加本地化 |
| VS Code 崩溃时，`globalStorage/voice-sessions/` 下的临时目录不会被清理（`voice-windows/` 里的死条目会自动清掉） | 残留少量文件 | 启动时清理 |
| `omp say` 这个 TTS 后端没做 | 只影响零配置试用 | 暂不做 |

## 8. 下一步

1. **提交**：只提交第 3 节列出的语音相关文件，不要混进那几个无关文件。`package-lock.json` 里新增了 `ws`，要一起提交。
2. **补小缺口**：思考提示音；启动时清理残留的 `voice-sessions` 目录。（听写和语音模式互斥已完成。）
3. 设置页的 TTS 区块（连通性测试、试听）。
4. 之后：chatterbox 流式输出、Smart Turn（P3）；EditorWatcher 和 diagnostics（P2）。
