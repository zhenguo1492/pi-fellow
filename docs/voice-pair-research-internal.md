# 语音结对编程：现有代码可复用资产、扩展点与硬约束（内部盘点）

范围：只根据仓库代码和文档。推断标了 [INFERENCE]。

## 1. 可复用资产

### 1.1 编辑器上下文
- `buildEditorContextFragment(filePath, selection?)`（src/shared/editorContext.ts:31-44）：生成 `<editor-context file lines>选区</editor-context>`。选区上限 `MAX_SELECTION_CHARS = 20_000`（:7, :38-41）。没有可见范围，也没有语言 ID。
- `EditorContextInfo`（editorContext.ts:13-19）：`filePath`、`displayPath`、`startLine`/`endLine`。`stripEditorContextBlocks`（:47-62）。
- 侧边栏的编辑器跟踪：订阅在 sidebar.ts:338-345（`onDidChangeActiveTextEditor`、`onDidChangeVisibleTextEditors`、`onDidChangeTextEditorSelection`）；`_trackActiveEditor`（:1892-1903）只保留 `file` scheme 的编辑器，焦点移到聊天视图后仍然保留；100 ms 防抖（:1905-1908）；`_editorContextTarget` 是私有字段（:300）。没订阅 visibleRanges（全仓库 grep 无匹配）。
- `selectedLineRange`（sidebar.ts:228）：模块私有函数，返回 1-based 闭区间行号。
- `_editorContextAttachments(evenIfExcluded)`（sidebar.ts:1923-1945）：发送那一刻抓取文件和选区。
- `tell_worker.includeEditorContext`（hostTools.ts:53-56, 171, 184）经 `WorkerController.send` 调用 `_editorContextAttachments(true)`（sidebar.ts:1029）：只有 worker 收到这段上下文，语音模型自己看不到。

### 1.2 diff 与 checkpoint
- `DiffManager`，每个 tab 一个（diff.ts:19；字段 sidebar.ts:109；创建于 :477-479）。监听 `tool_execution_start/end`（diff.ts:33-40），只处理 `edit`/`write`（:67）。开始时记下原文（:65-95），结束时用 `computeUnifiedDiff` 算 diff（:97-145）。
- `FileChangeInfo`（protocol.ts:161-170）：`filePath`、`toolCallId`、`toolName`、`isNew`、`diff`、`addedLines`、`removedLines`、`turnIndex`。
- `DiffManager` 的方法：`fileChanges`/`onFileChange`（diff.ts:43-57）；`pruneSettledChanges`（:185，在 `agent_end` 时调用，sidebar.ts:762）；`openDiff`（:148）；`undoFileChange`（:213）；`acceptAll`（:203）。
- `computeUnifiedDiff`（utils/diff.ts:11-49）：Myers 算法。
- `CheckpointManager`（checkpoint.ts:14）：`startTurn`（:24）、`recordFileState`（:34）、`restoreCheckpoint`（:44-110）、`redoCheckpoint`（:112-149）、`getCheckpointTurns`（:156）。
- `_startTurn`（sidebar.ts:1120-1130）同时给 checkpoint 和 diff 划分轮次。语音的 `send` 走 `_beginPrompt`（:1031-1033, :1103），和面板发送一样。回滚入口在 sidebar.ts:2439-2460。
- 缺口：`WorkerController` 接口（workerController.ts:9-39）没有暴露 `fileChanges`。

### 1.3 WorkerDigest
- `WorkerDigest`（workerDigest.ts:17-97）：每个 tab 一份，60 条（:15）。方法 `since`（:34）、`recent`（:38）、`lastSeq`/`runStartSeq`（:24-32）。
- 事件映射（:52-97）：指令和插话、`Worker said`、omp 的 `intent`（:104-121）、bash 退出码和最后一行输出（:123-135）、出错、叫停、用时。不记文件内容，也不记 diff（:3-6）。
- `formatDigest`（:100）、`clip`（:164）。
- 事件来源：`onTabEvent` 在侧边栏自己的簿记完成后触发（sidebar.ts:715-716），voiceAgent 在 voiceAgent.ts:130-134 订阅。

### 1.4 FloorArbiter
- 观察类型和优先级：`needs_input` > `error` > `done` > `research` > `progress`（floorArbiter.ts:10）；`Observation` 类型（:12-17）。
- `Narration` 有 `off`/`important`/`all` 三档（:20）。设置从 voiceAgentCommands.ts:142-149 读取，默认 `important`、8 s、30 s。
- `ArbiterView`（:31-40）由 `_view` 构造（voiceAgent.ts:326-336）。
- `ingest`（:67-100）只从事件里记下 `done` 和 `error`。
- `next`（:103-141）：`needs_input` 和 `error` 不受间隔限制；`done` 要空闲满 `DONE_SETTLE_MS = 4000`（:46, :125）；`progress` 只在 `narration = all` 时出现。
- `consume`（:144）、`userTurn`（:162）、`turnEnded`（:169）、`taskChanged`（:177）。
- 触发时机：每秒一次 tick（voiceAgent.ts:82, :147）；`onRequestsChanged`（:136）；调研完成（:467-486）；`floorReleased`（:170，由 voiceMode.ts:228-229 调用）。
- `_maybeProactive`（voiceAgent.ts:201-213）、`_proactiveTurn`（:256-296）、`_describe`（:309-324）。
- 语音模式里的话语权：`floorFree`（conversation.ts:129-131）、`floorBusy`（voiceMode.ts:162-164）、`proactiveTurn`（voiceMode.ts:167）。

### 1.5 `<silent/>`
- `SILENT_REPLY`（voicePrompt.ts:121）；`SilenceGate`（:124-153），在 voiceAgent.ts:352-360 使用、:392-396 做 `flush`。
- 主动轮次消息的结尾指令在 voicePrompt.ts:111-115。

### 1.6 宿主工具注册
- `RpcHostToolDefinition` 和 `loadMode`（rpcTypes.ts:50-59）；命令 `set_host_tools`（:48）。
- `PiRpcBridge.setHostTools` 整体替换工具集（piRpcBridge.ts:376-379）。
- 注册时机：`VoiceLlm.start` 里调用（voiceLlm.ts:103），传入的是 `tools: VOICE_HOST_TOOLS`（voiceAgent.ts:411）。
- 分发：`host_tool_call`（voiceLlm.ts:201-211）→ `HostToolRouter.execute`（voiceAgent.ts:364-373）→ `host_tool_result`（voiceLlm.ts:148-152）；取消在 :212-214。
- `HostToolRouter` 在 hostTools.ts:133-270；`ToolTurn` 在 :17-25。
- 内置读工具有旁路回调 `onBuiltinTool`（voiceLlm.ts:190-200；voiceAgent.ts:376-379）。

### 1.7 每个任务一份上下文、串行轮次
- 上下文的键 `taskKey`（voiceAgent.ts:85-87）；`_enterContext`（:434-464），切换上下文时 `clearProposals`（:448）。
- 首轮带 `<task-history>`（最近 3 轮）：voiceAgent.ts:239 和 :283；格式在 voicePrompt.ts:72-80。
- 串行队列 `_enqueue`（voiceAgent.ts:188-197）；`say` 打断当前轮（:151-159）；切换 tab 取消当前轮（:137-145，事件由 sidebar.ts:994-1003 触发）。

### 1.8 每轮消息
- `TurnInput`（voicePrompt.ts:53-65）；`buildTurnMessage`（:70-118）。块的顺序：`task-history`、`worker`、`worker-updates`（最多 20 行，:67）、`worker-request`、`proposal`、`research`、`interrupted`，最后是 `user` 或 `worker-update`。
- `workerLine`（:155-167）、`attr`（:169-171）。

### 1.9 句子切分与 TTS
- `takeSentences`（sentences.ts:31-70）：首句满 8 字就送出（:11），之后的片段 60 字（:13），代码围栏内不切（:34-44）。
- `cleanForSpeech` 删掉代码块（:16-22）；`flushSentence`（:72-75）。
- 打断说明 `interruptionNote`（conversation.ts:152-157），在 voiceAgent.ts:299-307 合并进下一轮消息。

### 1.10 其他
- `ResearchRunner`（research.ts:15, :17, :63-65）。
- 调试命令 `workerControl`（workerControlCommands.ts:6-13）。
- 多窗口 `ActiveVoiceWindow`（activeWindow.ts:11-16, 81-104）。
- 单元测试可参照：test/unit/voiceAgent/hostTools.test.ts、floorArbiter.test.ts、voicePrompt.test.ts、workerDigest.test.ts。

## 2. 扩展点

### (a) 新宿主工具
1. 在 `VOICE_HOST_TOOLS`（hostTools.ts:34-124）里追加定义，必须写 `loadMode: 'essential'`（rpcTypes.ts:57-58；design:486）。
2. 在 `_run` 的 switch（hostTools.ts:167-240）里加 case。返回字符串就是给模型的结果；抛错会变成 `isError`（:154-160）。
3. 主动轮次白名单在 hostTools.ts:164，只放行 `worker_status`；只读的新工具要在主动轮次里用，就改这一行。
4. 数据来源只能通过构造参数注入（hostTools.ts:137-143；构造在 voiceAgent.ts:120-125）。
   - worker 的 diff：给 `WorkerController` 加方法，由 `SidebarProvider` 用 `_workerTab(tabId).diffManager.fileChanges` 实现（sidebar.ts:1084-1091, :109）。
   - VS Code API（诊断、编辑器）：hostTools.ts 不导入 `vscode`。[INFERENCE] 应该通过 `VoiceAgentOptions`（voiceAgent.ts:10-26）注入函数，由 voiceAgentCommands.ts:134-156 在构造时传入。
5. 工具集在进程启动时注册一次（voiceLlm.ts:103）。[INFERENCE] 改清单后要重启语音模式；`setHostTools` 是整体替换，也可以在运行中换。
6. 在提示词 voicePrompt.ts:9 里说明用法；提示词必须保持不变以命中缓存。

### (b) 新主动观察
1. 在 `ObservationKind`（floorArbiter.ts:10）里按优先级加值，在 `Observation`（:12-17）里加分支。
2. 来源二选一：
   - 从状态推出：在 `ArbiterView`（:31-40）加字段，由 `_view`（voiceAgent.ts:326-336）填入；
   - 从事件记下：在 `TabWatch`（:48-55）加字段，在 `ingest`（:67-100）里设置。`ingest` 只接收 `WorkerEvent`；编辑器或诊断事件需要新的入口方法 [INFERENCE]。
3. 在 `next`（:103-141）里决定优先级、是否受间隔限制；在 `consume`（:144-159）和 `userTurn`（:162-167）里清掉。
4. 在 `_describe`（voiceAgent.ts:309-324）里写说明文字；TypeScript 的穷尽检查会逼你补上。
5. 要立刻播报就调用 `_maybeProactive()`（参照 :136），否则等每秒一次的 tick（:147）。
6. `Narration` 只有三档（:20），新类型要归到某一档，或者新增设置项（voiceAgentCommands.ts:142-149 和 package.json）。
7. 更新提示词里 "Speaking up" 一节列出的观察种类。

### (c) 每轮上下文
1. 在 `TurnInput`（voicePrompt.ts:53-65）加字段，在 `buildTurnMessage`（:70-118）里输出，放在 `<user>` 之前（:109-110）。设计给的格式：`<editor file visible selection lang>`，没变化时写 `<editor unchanged/>`（design:562-575）。
2. 在 `_userTurn`（voiceAgent.ts:234-244）和 `_proactiveTurn`（:279-288）两处填入。
3. "没变化"要和上次比较：把上次发过的快照存进 `VoiceContext`（voiceAgent.ts:72-79），因为每个 tab 各有一个 omp 会话 [INFERENCE]。
4. 快照来源：侧边栏的 `_editorContextTarget` 和 `selectedLineRange`（sidebar.ts:300, 228, 1892-1945），可以抽成服务，或者让 `WorkerController` 提供 `editorSnapshot()`。这样语音模型看到的，和 `includeEditorContext` 发给 worker 的是同一个来源 [INFERENCE]。
5. 用 `attr` 转义、`clip` 截断。

## 3. 硬约束

### 延迟
- 实测端到端（handoff:20）：Kokoro 2.24 s（说完判定 1.20 + STT 0.21 + 首字 0.73 + 首句合成 0.10）；chatterbox 2.78 s。
- `turnStopSecs` 默认 1.2 s（voiceAgentCommands.ts:209）。估算预算 2.5–3.5 s（design:764-772）。
- 一次工具轮次约 2.8 s（design:504）；自己读代码的一轮 4.2 s（design:260）；语音叫停约 3–4 s（design §6）。
- chatterbox 每句 0.5–1.2 s，没用流式（handoff:147, 161）。
- 播报节奏：`done` 至少 4 s；主动播报间隔 8 s；`progress` 间隔 30 s；仲裁器每秒问一次。

### token
- 分层预算：L1 ≤ 1.5k、L2 ≤ 2k、L3 通常 < 1k（design:534-536）。L1 和引导轮次都没实现 [INFERENCE]，现在只在首轮带 `<task-history>`（voiceAgent.ts:239）。
- 截断：日志 20 行；日志每行 160–240 字；`task-history` 300/400 字；`done` 600 字；`worker_status` 15 条日志、指令 300 / 回复 500 字；调研 250 词。
- 编辑器片段上限 20k 字（editorContext.ts:7）。直接用到语音的每轮附件会超预算 [INFERENCE]。
- 系统提示词必须不变（voicePrompt.ts:8；design:578）。不给语音模型 worker 的完整上下文（design:541-557），不附文件全文（design:411），不做向量索引（design:582）。
- `maxReadSteps` 没实现（design:587）：一轮里可以无限次读文件。

### 工具
- 语音进程只有 `read,grep,glob`（voiceLlm.ts:34, 89），`--approval-mode yolo`（:92；design:262），必须是 omp（:98-100）。
- 不给它 edit/write/bash：会和 worker 同时写工作区，改动不进 checkpoint 和 diff（design:586, 33）。
- `research` 最多 3 个、最长 5 分钟。

### 串行
- 同一时刻只有一轮（voiceAgent.ts:188-197；voiceLlm.ts:121-123）。
- 用户说话就打断当前轮（:151-159）。被打断轮里的工具调用不撤销（:382-383），会写进 `<interrupted>`（:398-400）。
- 轮次进行中到达的观察不会 steer 进模型（design §7.7）。

### 主动轮次
- 宿主工具只能调 `worker_status`（hostTools.ts:164-166）；内置 read/grep/glob 不经过路由器，不受限制。
- 一轮只带一个观察（voiceAgent.ts:275-278）。用户在排队或 `floorBusy` 就放弃（:259, 265-267, 203）。语音进程启动前不会有主动轮次（:202-203）。

### 多窗口 / 多 tab
- 只有最后获得焦点的语音窗口在听和说（activeWindow.ts；design:788）。
- 语音只绑定当前 tab，工具没有 tab 参数，不能用语音切换 tab（design:453-480）。
- `onTabEvent` 只覆盖当前后端的工作区（workerController.ts:17）。
- 会话目录是 `voice-sessions/<uuid>`（voiceAgentCommands.ts:137），在 `stop` 时删除。

### TTS
- 代码块整段删掉（sentences.ts:18）；提示词禁止 Markdown、代码块、URL，不要念代码（voicePrompt.ts:9；design:654）；默认一到三句（design:655）。
- Kokoro 读夹在英文里的单个汉字会出错；chatterbox 要按句发语言字段（handoff:147-148）。
- 播放进度是估算的（handoff:162）。

### 非目标 / 范围
- worker 不发声；语音智能体不直接修改文件；不做远程通话（design:30-35）。
- 工具只做任务控制，不管理会话（design:484）；`send` 拒绝 `/` 和 `!`（sidebar.ts:1025-1027）。
- 改文件的新任务默认两阶段确认（hostTools.ts:174-182, 193-195）；`answer_worker` 有时序规则（:214-216）。

## 4. handoff §7 中与结对相关的缺口
- EditorWatcher 没做（handoff:164）：语音模型不知道用户在看什么；`TurnInput` 里没有编辑器字段。
- `worker_diff` 没做（handoff:164；design:498）：数据在 `diffManager.fileChanges` 里，但接口没暴露。
- `worker_transcript` 没做（design:497）：只能看到最近 2 轮（hostTools.ts:262）。
- `maxReadSteps` 没做（design:587、R10 :789）：[INFERENCE] 可以在 `onBuiltinTool`（voiceAgent.ts:376-379）里计数，超了就 steer。
- `diagnostics` 没做（design:499, P2 :801；handoff:177）：仓库里没有 `getDiagnostics` 调用。
- 没有思考提示音 `fillerAfterSecs`（handoff:160；design:615, 700）。
- 语音面板没做（handoff:157）：看不到派出的指令原文和读过的文件；`onLookup`/`onToolCall` 监听器已经有了（voiceAgent.ts:44-53）。
- 语音派发的消息没有"来自语音"标记（handoff:165）：看不出侧边栏里的指令是谁发的。
