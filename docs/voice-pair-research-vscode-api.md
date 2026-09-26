# VS Code 扩展 API 调研：语音结对编程可用的感知信号与执行手段

> 范围：只看 **stable** 扩展 API（本扩展 `engines.vscode: ^1.100.0`，见 `package.json:10`），proposed API 只做标注：它们"只在 Insiders 可用、不应在已发布扩展中使用"（[Using Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)），Marketplace 版本不能依赖。
> 证据来源：`vscode.d.ts`（main 分支，2026-09）、[API 参考](https://code.visualstudio.com/api/references/vscode-api)、[内置命令表](https://code.visualstudio.com/api/references/commands)、release notes、VS Code 源码。下文 `API#x` 统一指 `https://code.visualstudio.com/api/references/vscode-api#x`，所有锚点都已核对存在。
> 标注约定：**[INFERENCE]** = 根据 API 形态推断、没有文档明说；**[UNVERIFIED]** = 未查证。

---

## 1. 感知：用户在看什么、在做什么

| API | 提供什么 | 稳定性 | 事件粒度 / 成本 | 结对用途 | 来源 |
|---|---|---|---|---|---|
| `window.activeTextEditor` / `onDidChangeActiveTextEditor` | 当前编辑器（document、selections、visibleRanges、viewColumn）。文档说明：有焦点的编辑器；没有编辑器有焦点时，取最近一次切换过输入的那个 | stable | 切换文件时触发，低频 | EditorWatcher 快照的根：当前文件、语言、是否 dirty | [API#window.activeTextEditor](https://code.visualstudio.com/api/references/vscode-api#window.activeTextEditor) |
| `TextEditor.selections` + `window.onDidChangeTextEditorSelection` | 多光标选区；事件带 `kind: Keyboard \| Mouse \| Command \| undefined` | stable | **高频**：每次光标移动、每个按键都触发。需要 250–500 ms 去抖 [INFERENCE] | 指代消解（"这段""这里"）；`kind=Mouse` 的选中通常是有意指给你看，`Keyboard` 多半只是在打字 [INFERENCE] | [API#window.onDidChangeTextEditorSelection](https://code.visualstudio.com/api/references/vscode-api#window.onDidChangeTextEditorSelection)、[API#TextEditorSelectionChangeKind](https://code.visualstudio.com/api/references/vscode-api#TextEditorSelectionChangeKind) |
| `TextEditor.visibleRanges` + `onDidChangeTextEditorVisibleRanges` | 视口内可见的行区间（折叠时是多段） | stable | **高频**：滚动时连续触发，需要去抖 | 回答"屏幕上这个函数"；判断 agent 要指的位置是否已在视口内，决定要不要 reveal | [API#window.onDidChangeTextEditorVisibleRanges](https://code.visualstudio.com/api/references/vscode-api#window.onDidChangeTextEditorVisibleRanges) |
| `window.visibleTextEditors` / `onDidChangeVisibleTextEditors` | 分屏时所有可见的文本编辑器 | stable | 低频 | "左边那个文件"；分屏对照时同时给出两个上下文 | [API#window.onDidChangeVisibleTextEditors](https://code.visualstudio.com/api/references/vscode-api#window.onDidChangeVisibleTextEditors) |
| `workspace.onDidChangeTextDocument` | `contentChanges[]`（range、rangeOffset、rangeLength、text）和 `reason`（只有 `Undo`/`Redo`，其余为 `undefined`）。文档说明：dirty 状态变化时也会触发 | stable | **高频**：每次编辑事务一次（通常每个按键），载荷是增量，很小 | ① 检测"用户正在打字"，FloorArbiter 暂缓主动播报；② 累计成"最近编辑摘要"；③ 区分用户编辑和 worker 落盘：worker 写盘后 VS Code 重载文档，文档保持非 dirty；用户键入会让文档变 dirty，并伴随 `Keyboard` 选区事件 [INFERENCE] | [API#workspace.onDidChangeTextDocument](https://code.visualstudio.com/api/references/vscode-api#workspace.onDidChangeTextDocument)、[API#TextDocumentChangeEvent](https://code.visualstudio.com/api/references/vscode-api#TextDocumentChangeEvent)、[API#TextDocumentChangeReason](https://code.visualstudio.com/api/references/vscode-api#TextDocumentChangeReason) |
| `workspace.onDidSaveTextDocument` | 保存事件 | stable | 低频 | 自然的"检查点"：保存后等诊断稳定，再决定是否主动提示错误或提议 review | [API#workspace.onDidSaveTextDocument](https://code.visualstudio.com/api/references/vscode-api#workspace.onDidSaveTextDocument) |
| `window.tabGroups`（`all`、`activeTabGroup.activeTab`、`onDidChangeTabs`、`onDidChangeTabGroups`） | 所有编辑器组和 tab；`Tab.input` 区分 `TabInputText`、`TabInputTextDiff`、`TabInputNotebook`、`TabInputTerminal`、`TabInputWebview` 等；还有 `isDirty`、`isPreview`、`isActive` | stable（1.67 定稿只读部分，[v1_67](https://code.visualstudio.com/updates/v1_67#_tab-api)） | 中低频 | 知道用户在看 diff（`TabInputTextDiff` 的 original/modified）、终端 tab 还是 webview，这些情况下 `activeTextEditor` 描述不了；"我打开的那几个文件" | [API#window.tabGroups](https://code.visualstudio.com/api/references/vscode-api#window.tabGroups)、[API#TabInputTextDiff](https://code.visualstudio.com/api/references/vscode-api#TabInputTextDiff) |
| `window.state` / `onDidChangeWindowState`（`focused`、`active`） | 窗口是否有焦点；`active` 表示"最近有交互"，有活动时立刻变化，闲置一小段时间后翻转 | stable（`active` 于 1.89 定稿，[v1_89](https://code.visualstudio.com/updates/v1_89#_finalized-window-activity-api)） | 低频 | 已用于多窗口抢麦（`voiceAgentCommands.ts:239`）。`active=false` 说明用户可能离开或在看别处，可以把 progress 类播报攒着，回来后再做一次汇总 | [API#window.state](https://code.visualstudio.com/api/references/vscode-api#window.state)、[API#WindowState](https://code.visualstudio.com/api/references/vscode-api#WindowState) |
| `languages.getDiagnostics(uri?)` + `onDidChangeDiagnostics` | 所有诊断：severity、message、range、source、code、relatedInformation；事件只带 `uris` | stable | 中频（语言服务每次重算都会发布）；事件轻，查询也便宜 | 主动提示"刚保存的文件有 2 个类型错误"；验证 worker 改完后诊断是否清零；把错误行号换成符号名来念。TS 等语言服务主要只算已打开的文件 [INFERENCE] | [API#languages.getDiagnostics](https://code.visualstudio.com/api/references/vscode-api#languages.getDiagnostics)、[API#languages.onDidChangeDiagnostics](https://code.visualstudio.com/api/references/vscode-api#languages.onDidChangeDiagnostics) |
| `vscode.executeDocumentSymbolProvider` | 文件的符号树（`DocumentSymbol[]`，带 range 和 selectionRange） | stable（内置命令） | 按需调用；延迟取决于语言服务，一般几十毫秒到几百毫秒 [INFERENCE] | 光标 → 所在函数/类名。语音里说"`parseConfig` 里"比说"第 132 行"自然得多 | [commands#executeDocumentSymbolProvider](https://code.visualstudio.com/api/references/commands) |
| `vscode.executeSelectionRangeProvider` | 某位置的语义扩展选区链（表达式 → 语句 → 块 → 函数） | stable（内置命令） | 按需，便宜 | 把"这个 if""这一块"映射成精确范围，再高亮确认 | [commands](https://code.visualstudio.com/api/references/commands) |
| `vscode.executeDefinitionProvider` / `executeTypeDefinitionProvider` / `executeImplementationProvider` / `executeReferenceProvider` | 语义跳转结果（`Location[]` / `LocationLink[]`） | stable（内置命令） | 按需；在大工作区里查 references 可能要几秒 [INFERENCE] | "这个函数谁在调""定义在哪"：用语言服务回答，比 grep 准；结果可以直接交给 peek 展示（§6） | [commands](https://code.visualstudio.com/api/references/commands) |
| `vscode.executeHoverProvider` | 某位置的 hover 内容（类型签名、文档注释） | stable（内置命令） | 按需 | 念出推断出来的类型或 JSDoc，不必读整个文件 | [commands](https://code.visualstudio.com/api/references/commands) |
| `vscode.prepareCallHierarchy` → `vscode.provideIncomingCalls` / `provideOutgoingCalls` | 调用层级（`CallHierarchyItem` + `fromRanges`） | stable（内置命令） | 按需，每层一次往返 | "改这个函数会影响谁"：影响面分析，也是派 worker 之前的范围评估 | [commands](https://code.visualstudio.com/api/references/commands)、[API#CallHierarchyItem](https://code.visualstudio.com/api/references/vscode-api#CallHierarchyItem) |
| `vscode.executeWorkspaceSymbolProvider` / `executeCodeActionProvider` / `executeInlayHintProvider` / `executeSignatureHelpProvider` | 全局符号搜索 / 该范围可用的 quick fix / inlay hints / 签名 | stable（内置命令） | 按需 | 用户用语音说出符号名 → 定位；"有没有自动修复"→ 列出 quick fix 让用户口头选 | [commands](https://code.visualstudio.com/api/references/commands) |
| `window.onDidChangeNotebookEditorSelection`、`NotebookCell.executionSummary.success`、`cell.outputs` | Notebook 的选中 cell、执行结果和输出 | stable | 低频 | notebook 场景下"这个 cell 为什么报错" | [API#window.onDidChangeNotebookEditorSelection](https://code.visualstudio.com/api/references/vscode-api#window.onDidChangeNotebookEditorSelection)、[API#NotebookEditor](https://code.visualstudio.com/api/references/vscode-api#NotebookEditor) |
| `env.clipboard.readText()` | 剪贴板文本 | stable | 按需 | "我刚复制的那段报错"。只在用户明确提到时读，涉及隐私 | [API#env.clipboard](https://code.visualstudio.com/api/references/vscode-api#env.clipboard) |

**缺口（stable 里没有）**
- 鼠标悬停位置、眼动或"注视"信号：没有 API。hover 只能作为 provider 被动响应。[INFERENCE：`vscode.d.ts` 里没有相关事件]
- 编辑器的 dirty diff（quick diff 行级增删）：`TextEditor.diffInformation` 是 proposed（`textEditorDiffInformation`，见 §8）。stable 的替代是 git API 的 `diffWithHEAD(path)`（§5）。
- 区分"AI 或 inline completion 写入"和"用户手打"：`TextDocumentChangeEvent.detailedReason` 是 proposed（`textDocumentChangeReason`，source 取值如 `'inline-completion'`、`'chat-edit'`）。
- 读取其他扩展的 Output channel 内容：没有 stable API [INFERENCE]。

---

## 2. 终端：Shell Integration API

**稳定版本**：1.88 作为 proposed 引入（[v1_88](https://code.visualstudio.com/updates/v1_88#_terminal-shell-integration-api)），**1.93 定稿**（[v1_93](https://code.visualstudio.com/updates/v1_93#_terminal-shell-integration-api)："enables an extension to listen to commands run in terminals, read their raw output, exit code, and command lines"）。本扩展要求 ≥1.100，可以直接用。

| API | 提供什么 | 稳定性 | 事件粒度 / 成本 | 结对用途 | 来源 |
|---|---|---|---|---|---|
| `window.onDidStartTerminalShellExecution` | 命令开始：`terminal`、`shellIntegration`、`execution` | stable 1.93 | 每条命令一次 | 听到用户自己跑了 `npm test`，开始收集输出 | [API#window.onDidStartTerminalShellExecution](https://code.visualstudio.com/api/references/vscode-api#window.onDidStartTerminalShellExecution) |
| `TerminalShellExecution.read(): AsyncIterable<string>` | 命令的原始输出流，**含转义序列**。文档说明：只包含首次调用 `read` 之后写入的数据，所以必须在 start 事件里立即调用 | stable 1.93 | 流式；要自己剥离 ANSI，并限制缓冲大小 | 测试失败时抽出失败用例和栈，主动说"3 个测试挂了，第一个是……" | [API#TerminalShellExecution](https://code.visualstudio.com/api/references/vscode-api#TerminalShellExecution) |
| `TerminalShellExecution.commandLine`（`value`、`confidence: Low/Medium/High`、`isTrusted`）、`cwd` | 命令行文本和可信度 | stable 1.93 | 取值即可 | 只对 High confidence 的命令做语义判断（例如识别 test/build 命令） | [API#TerminalShellExecutionCommandLine](https://code.visualstudio.com/api/references/vscode-api#TerminalShellExecutionCommandLine) |
| `window.onDidEndTerminalShellExecution` → `exitCode` | 退出码。`undefined` 可能表示：shell 没上报、子 shell、Ctrl+C、空回车；文档建议视情况按失败处理 | stable 1.93 | 每条命令一次 | "构建失败了（exit 2）"作为 error 级观察进入 FloorArbiter | [API#window.onDidEndTerminalShellExecution](https://code.visualstudio.com/api/references/vscode-api#window.onDidEndTerminalShellExecution)、[API#TerminalShellExecutionEndEvent](https://code.visualstudio.com/api/references/vscode-api#TerminalShellExecutionEndEvent) |
| `Terminal.shellIntegration.executeCommand(cmd)` / `window.onDidChangeTerminalShellIntegration` | 在用户终端里执行命令并拿到 execution 句柄（会等 prompt 就绪，必要时先发 ^C）；shell integration 激活后才可用 | stable 1.93 | 按需 | 执行器：语音里"帮我跑一下测试"，命令跑在用户看得见的终端里，结果可读。比 worker 在后台跑更透明 | [API#TerminalShellIntegration](https://code.visualstudio.com/api/references/vscode-api#TerminalShellIntegration)、[API#window.onDidChangeTerminalShellIntegration](https://code.visualstudio.com/api/references/vscode-api#window.onDidChangeTerminalShellIntegration) |
| `window.activeTerminal` / `onDidChangeActiveTerminal` / `onDidChangeTerminalState`（`TerminalState.isInteractedWith`、`shell`） | 当前终端；是否被交互过；shell 类型（1.99 定稿，[v1_99](https://code.visualstudio.com/updates/v1_99#_terminal-shell-type)） | stable | 低频 | "在终端里"的指代；按 shell 类型生成命令 | [API#window.onDidChangeTerminalState](https://code.visualstudio.com/api/references/vscode-api#window.onDidChangeTerminalState)、[API#TerminalState](https://code.visualstudio.com/api/references/vscode-api#TerminalState) |
| `tasks.onDidStartTask` / `onDidEndTask` / `onDidEndTaskProcess`（`exitCode`） | 任务生命周期和退出码；problem matcher 的结果进入 diagnostics | stable | 每个任务一次 | 用户用 task 跑构建或测试时，拿到成败结果；错误细节通过 `getDiagnostics` 取 | [API#tasks.onDidEndTaskProcess](https://code.visualstudio.com/api/references/vscode-api#tasks.onDidEndTaskProcess)、[API#TaskProcessEndEvent](https://code.visualstudio.com/api/references/vscode-api#TaskProcessEndEvent) |

注意事项：
- 前提是 shell integration 已激活：bash、zsh、fish、pwsh、Git Bash 等会自动注入；子 shell、普通 ssh 和复杂配置需要手动安装（[shell integration 文档](https://code.visualstudio.com/docs/terminal/shell-integration)）。
- 官方示例：[shell-integration-sample](https://github.com/microsoft/vscode-extension-samples/tree/main/shell-integration-sample)。
- 终端里的选中文本（`Terminal.selection`）是 proposed（`terminalSelection`）。任意终端原始数据流 `onDidWriteTerminalData`（`terminalDataWriteEvent`）也是 proposed，d.ts 注释写明"不打算推到 stable（性能问题）"（[源码](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.terminalDataWriteEvent.d.ts)）。旧的 `onDidExecuteTerminalCommand` 是 proposed，并且已标记 deprecated。

---

## 3. 调试

| API | 提供什么 | 稳定性 | 事件粒度 / 成本 | 结对用途 | 来源 |
|---|---|---|---|---|---|
| `debug.activeDebugSession` / `onDidChangeActiveDebugSession` / `onDidStartDebugSession` / `onDidTerminateDebugSession` | 当前调试会话和生命周期 | stable | 低频 | 进入调试时切换到"调试结对"模式（换提示词和工具集） | [API#debug.activeDebugSession](https://code.visualstudio.com/api/references/vscode-api#debug.activeDebugSession) |
| `debug.activeStackItem` / `onDidChangeActiveStackItem` | 用户在 Debug 视图里聚焦的 `DebugThread` 或 `DebugStackFrame`（含 `session`、`threadId`、`frameId`） | stable（1.90，[v1_90 Debug Stack Focus API](https://code.visualstudio.com/updates/v1_90#_debug-stack-focus-api)） | 断点停下或用户点栈帧时触发 | "这一帧"的指代；拿到 frameId 之后查变量 | [API#debug.activeStackItem](https://code.visualstudio.com/api/references/vscode-api#debug.activeStackItem)、[API#debug.onDidChangeActiveStackItem](https://code.visualstudio.com/api/references/vscode-api#debug.onDidChangeActiveStackItem) |
| `DebugSession.customRequest(command, args)` | 直接发 DAP 请求：`stackTrace`、`scopes`、`variables`、`evaluate`、`threads` 等 | stable | 每次都是一个 adapter 往返；`variables` 要逐层展开，必须限制深度和数量 | "为什么 `user` 是 null"：`scopes(frameId)` → `variables(ref)` → 把关键局部变量念给用户；`evaluate` 算表达式（有副作用风险，只读用 `context:'hover'`） | [API#DebugSession](https://code.visualstudio.com/api/references/vscode-api#DebugSession)、DAP：[stackTrace](https://microsoft.github.io/debug-adapter-protocol/specification#leftwards_arrow_with_hook-stacktrace-request)、[scopes](https://microsoft.github.io/debug-adapter-protocol/specification#leftwards_arrow_with_hook-scopes-request)、[variables](https://microsoft.github.io/debug-adapter-protocol/specification#leftwards_arrow_with_hook-variables-request)、[evaluate](https://microsoft.github.io/debug-adapter-protocol/specification#leftwards_arrow_with_hook-evaluate-request) |
| `debug.registerDebugAdapterTrackerFactory(type, factory)` → `DebugAdapterTracker.onDidSendMessage` / `onWillReceiveMessage` / `onError` / `onExit` | 旁听所有 DAP 消息，`'*'` 可以匹配所有调试类型 | stable | **高频**（每条 DAP 消息都会经过，output 事件可能很多），回调里只做过滤 | 监听 `stopped` 事件（reason 为 exception 或 breakpoint），主动说"停在异常上了：TypeError……"；监听 `output` 事件捕获被调试程序的 stderr | [API#debug.registerDebugAdapterTrackerFactory](https://code.visualstudio.com/api/references/vscode-api#debug.registerDebugAdapterTrackerFactory)、[API#DebugAdapterTracker](https://code.visualstudio.com/api/references/vscode-api#DebugAdapterTracker)、DAP [stopped](https://microsoft.github.io/debug-adapter-protocol/specification#arrow_left-stopped-event) / [output](https://microsoft.github.io/debug-adapter-protocol/specification#arrow_left-output-event) |
| `debug.breakpoints` / `onDidChangeBreakpoints` / `addBreakpoints` / `removeBreakpoints`（`SourceBreakpoint` 支持 condition、hitCondition、logMessage） | 读写断点 | stable | 低频 | 执行器：口述"在 132 行 `count > 10` 时停"，或"加一个 logpoint 打印 id"（logpoint 不打断程序，适合结对） | [API#debug.addBreakpoints](https://code.visualstudio.com/api/references/vscode-api#debug.addBreakpoints)、[API#SourceBreakpoint](https://code.visualstudio.com/api/references/vscode-api#SourceBreakpoint) |
| `debug.startDebugging` | 启动 launch 配置 | stable | 按需 | "用调试模式再跑一次这个测试" | [API#debug.startDebugging](https://code.visualstudio.com/api/references/vscode-api#debug.startDebugging) |
| `languages.registerInlineValuesProvider` / `vscode.executeInlineValueProvider` | 调试时在行尾内联显示变量值 | stable | 断点停下时被拉取 | 执行器：把 agent 认为关键的变量值直接显示在代码旁 | [API#languages.registerInlineValuesProvider](https://code.visualstudio.com/api/references/vscode-api#languages.registerInlineValuesProvider) |

---

## 4. 测试：能不能观察其他扩展的测试结果？——**不能（stable）**

已核实：stable 的 `vscode.d.ts` 里，`tests` 命名空间**只有** `createTestController(id, label)`（[API#tests.createTestController](https://code.visualstudio.com/api/references/vscode-api#tests.createTestController)）。`tests.testResults`、`tests.onDidChangeTestResults`、`tests.createTestObserver`、`tests.runTests`、`TestRunResult` 和 `TestResultSnapshot` 全部在 **proposed** 的 `vscode.proposed.testObserver.d.ts`（issue #107467，[源码](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.testObserver.d.ts)）。Marketplace 构建不可用。

| API | 提供什么 | 稳定性 | 结对用途 | 来源 |
|---|---|---|---|---|
| `tests.createTestController` + `TestRun` | 自己提供测试（发现、运行、上报结果） | stable | 只能看到自己跑的结果。可以做一个"voice 测试控制器"，但会和用户已有的测试扩展重复 | [Testing guide](https://code.visualstudio.com/api/extension-guides/testing) |
| `tests.testResults` / `onDidChangeTestResults` / `createTestObserver` | 观察所有 controller 的测试结果 | **proposed**（`testObserver`） | 正是需要的能力，但不能用 | [源码](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.testObserver.d.ts) |
| 命令 `testing.runAll` / `testing.reRunFailTests` / `testing.runAtCursor` / `testing.runCurrentFile` / `testing.reRunLastRun` / `testing.showMostRecentOutput` | 触发 Test Explorer 运行 | 命令 ID 存在（源码 `TestCommandId`），不在公开命令文档里；返回值 [UNVERIFIED]，应当当作 fire-and-forget | 执行器："把失败的测试再跑一遍"，结果只能靠用户看 UI 或下面的替代方案 | [constants.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/testing/common/constants.ts) |

**stable 下的替代路径**：
① 用 `shellIntegration.executeCommand('npm test')` 跑测试，读 `read()` 输出和 `exitCode`（§2）；
② 用 tasks API 拿退出码，配合 problem matcher 进入 diagnostics；
③ 让测试框架输出 JUnit/JSON 报告，再用 `createFileSystemWatcher` 监听报告文件（§7）；
④ 交给 omp worker 跑（现有路径）。

---

## 5. SCM / Git：内置 `vscode.git` 扩展 API

用法：`vscode.extensions.getExtension<GitExtension>('vscode.git').exports.getAPI(1)`。git 扩展 README 写明"exposes an API, reachable by any other extension"，要求把 `src/api/git.d.ts` 复制进自己的项目（[README](https://github.com/microsoft/vscode/blob/main/extensions/git/README.md)）。这是扩展级 API，不属于 `vscode.d.ts`，版本号一直是 `1`，但会逐步增加方法。

| API | 提供什么 | 可用性 | 事件粒度 / 成本 | 结对用途 | 来源 |
|---|---|---|---|---|---|
| `GitExtension.enabled` / `onDidChangeEnablement` / `getAPI(1)` | 入口；git 被禁用时 `getAPI` 会抛错 | 1.100 已有 | — | — | [git.d.ts L447-462](https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts#L447-L462) |
| `API.repositories` / `getRepository(uri)` / `onDidOpenRepository` | 仓库列表 | 1.100 已有 | 低频 | 多根工作区里定位当前文件属于哪个仓库 | [git.d.ts L415-426](https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts#L415-L426) |
| `Repository.state`：`HEAD`、`workingTreeChanges`、`indexChanges`、`untrackedChanges`、`mergeChanges`、`onDidChange` | 当前分支和变更文件列表（`Change.status`） | 1.100 已有 | `onDidChange` 在 git status 刷新后触发（git 扩展内部做了节流）[INFERENCE] | "你现在改了 4 个文件，还没提交"；发现用户在 worker 工作期间也改了同一个文件（冲突预警） | [git.d.ts L131-145](https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts#L131-L145) |
| `Repository.diff(cached?)`、`diffWithHEAD(path)`、`diffIndexWithHEAD(path)`、`diffWith(ref, path)`、`diffBetween(ref1, ref2)` | unified diff 文本或变更列表 | 1.100 已有（`diffBetweenWithStats` 等是更新版本才有，1.100 的 d.ts 里没有，[1.100.0 版 git.d.ts](https://github.com/microsoft/vscode/blob/1.100.0/extensions/git/src/api/git.d.ts)） | 每次调用起一个 git 子进程，结果可能很大，要截断 | review 用户自己未提交的改动；也是 `worker_diff` 的另一个数据源（覆盖 worker 之外的改动） | [git.d.ts L236-316](https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts#L236-L316) |
| `Repository.blame(path)`、`log(options)`、`show(ref, path)`、`getCommit(ref)` | blame、历史和旧版本内容 | 1.100 已有 | git 子进程 | "这行谁在什么时候改的""上一版是怎么写的" | 同上 |
| `Repository.onDidCommit` / `onDidCheckout`、`inputBox.value` | 提交和切分支事件；提交信息输入框 | 1.100 已有 | 低频 | 提交后总结"本次提交包含……"；执行器：口述提交信息后写进 `inputBox` | 同上 |

相关的 proposed：`scmHistoryProvider`、`quickDiffProvider`、`textEditorDiffInformation`（§8）。

---

## 6. 执行手段："指给用户看"

| API | 提供什么 | 稳定性 | 成本 / 侵入性 | 结对用途 | 来源 |
|---|---|---|---|---|---|
| `window.createTextEditorDecorationType(options)` + `TextEditor.setDecorations(type, ranges \| DecorationOptions[])` | 背景色、边框、`isWholeLine`、`gutterIconPath`、`overviewRulerColor`（滚动条标记）、`before`/`after` 附加文本（`contentText`，也就是行尾"幽灵批注"）、`hoverMessage`（Markdown） | stable | **最便宜、最灵活**：不需要注册 provider，也不抢焦点；同一个 type 再次调用 `setDecorations` 会整体替换 | 边说边高亮："看第 40 到 52 行这段"。高亮会随 TTS 的句子移动；行尾 `after` 写 `← 这里可能 NPE`；滚动条标出所有提到的位置 | [API#window.createTextEditorDecorationType](https://code.visualstudio.com/api/references/vscode-api#window.createTextEditorDecorationType)、[API#DecorationRenderOptions](https://code.visualstudio.com/api/references/vscode-api#DecorationRenderOptions)、[API#ThemableDecorationAttachmentRenderOptions](https://code.visualstudio.com/api/references/vscode-api#ThemableDecorationAttachmentRenderOptions)、[API#DecorationOptions](https://code.visualstudio.com/api/references/vscode-api#DecorationOptions)、[decorator-sample](https://github.com/microsoft/vscode-extension-samples/tree/main/decorator-sample) |
| `TextEditor.revealRange(range, TextEditorRevealType.InCenterIfOutsideViewport)` | 滚动到指定范围 | stable | 会移动用户视口，属于中度侵入 | 先查 visibleRanges，不在视口里才 reveal。原则：不打断用户正在看的内容 | [API#TextEditor](https://code.visualstudio.com/api/references/vscode-api#TextEditor)、[API#TextEditorRevealType](https://code.visualstudio.com/api/references/vscode-api#TextEditorRevealType) |
| `window.showTextDocument(uri, { selection, preserveFocus, preview, viewColumn })` | 打开文件并选中范围 | stable | 切换编辑器属于高侵入；`preserveFocus: true` 不抢键盘焦点，`viewColumn: Beside` 在旁边打开，不打断当前文件 | "我把 `auth.ts` 的 `login` 开在右边给你看" | [API#window.showTextDocument](https://code.visualstudio.com/api/references/vscode-api#window.showTextDocument)、[API#TextDocumentShowOptions](https://code.visualstudio.com/api/references/vscode-api#TextDocumentShowOptions) |
| 命令 `editor.action.peekLocations(uri, position, locations, 'peek'\|'gotoAndPeek'\|'goto')`（`editor.action.showReferences` 是它的别名） | 在当前位置弹出内嵌 peek 窗，列出多个位置 | 内置命令（peekLocations 在公开命令表里；showReferences 别名见源码） | 不切换文件，Esc 关闭；侵入性低 | "这 3 个调用方"：配合 `executeReferenceProvider` 的结果一次性展示 | [commands](https://code.visualstudio.com/api/references/commands)、[goToCommands.ts L812-826, L859](https://github.com/microsoft/vscode/blob/main/src/vs/editor/contrib/gotoSymbol/browser/goToCommands.ts#L812-L826) |
| 命令 `vscode.diff(left, right, title)` / `vscode.changes(title, [[uri, orig, modified]...])` | 单文件 diff 编辑器 / 多文件 changes 编辑器 | 内置命令 | 打开新 tab | "worker 改了这些"：一键打开多文件 diff 边看边讲 | [commands](https://code.visualstudio.com/api/references/commands) |
| 命令 `editor.action.showHover` | 在光标处显示 hover | 内置命令（源码 ID） | 侵入性低 | 配合自己注册的 `HoverProvider`，把 agent 的解释显示成 hover | [hoverActionIds.ts L7](https://github.com/microsoft/vscode/blob/main/src/vs/editor/contrib/hover/browser/hoverActionIds.ts#L7) |
| `comments.createCommentController(id, label)` → `createCommentThread(uri, range, comments)`（`canReply`、`state: Unresolved/Resolved`、`contextValue`、`collapsibleState`、`label`） | 锚定在代码范围上的评论线程，用户可以回复 | stable | 持久可见；线程多了会显得杂乱 | 结对 review："我在 3 处留了批注"；语音会话结束后批注仍在；用户打字回复 → 回调给 voice agent 或 worker（回复按钮通过 `comments/commentThread/context` 菜单命令实现，见 sample） | [API#comments.createCommentController](https://code.visualstudio.com/api/references/vscode-api#comments.createCommentController)、[API#CommentController](https://code.visualstudio.com/api/references/vscode-api#CommentController)、[API#CommentThread](https://code.visualstudio.com/api/references/vscode-api#CommentThread)、[comment-sample](https://github.com/microsoft/vscode-extension-samples/tree/main/comment-sample) |
| `languages.registerCodeLensProvider`（`onDidChangeCodeLenses` 用来刷新） | 在函数上方显示可点击的操作行 | stable | 由 VS Code 拉取；数量多了会挤占垂直空间 | 在用户正在讨论的函数上显示 `🔊 解释`、`让 worker 修这里`，点击后把"指代 + 意图"交给 voice agent | [API#languages.registerCodeLensProvider](https://code.visualstudio.com/api/references/vscode-api#languages.registerCodeLensProvider)、[codelens-sample](https://github.com/microsoft/vscode-extension-samples/tree/main/codelens-sample) |
| `languages.registerInlayHintsProvider`（`InlayHintLabelPart` 可以带 `command` 和 tooltip） | 行内短标签，占排版位置 | stable（1.65 定稿，[v1_65](https://code.visualstudio.com/updates/v1_65#_inlay-hints)） | 拉取式；用户可能关掉了 inlay hints | 行内标注"← worker 刚改""← 你问的变量"。一般 decoration 的 `after` 就够用，需要可点击时才用它 | [API#languages.registerInlayHintsProvider](https://code.visualstudio.com/api/references/vscode-api#languages.registerInlayHintsProvider) |
| `languages.createDiagnosticCollection('voice')` | 以诊断的形式放置波浪线，同时进入 Problems 面板 | stable | 会污染 Problems，还可能被其他 AI 自动修复功能读到 | 只适合"agent 发现的真实问题"，用 `Information`/`Hint` 级别；review 批注优先用 Comments | [API#languages.createDiagnosticCollection](https://code.visualstudio.com/api/references/vscode-api#languages.createDiagnosticCollection) |
| `languages.registerCodeActionsProvider` | 在灯泡菜单里提供 quick fix | stable | 用户主动触发 | 把 agent 口头建议的改动变成可一键应用的 `WorkspaceEdit` | [API#languages.registerCodeActionsProvider](https://code.visualstudio.com/api/references/vscode-api#languages.registerCodeActionsProvider) |
| `languages.registerInlineCompletionItemProvider` + 命令 `editor.action.inlineSuggest.trigger` | 光标处的幽灵文本，Tab 接受 | stable（1.68 定稿，[v1_68](https://code.visualstudio.com/updates/v1_68#_inline-completions-finalization)） | **拉取式**：用户停止打字或显式触发时，VS Code 才并行询问所有 provider 并合并结果（Copilot 会同时参与）；`range` 必须在同一行开始和结束 | **可行但受限**：用户口述"这里加个空值检查"→ agent 生成代码 → 缓存 → 执行 `editor.action.inlineSuggest.trigger`（可以带 `providerId`，[源码](https://github.com/microsoft/vscode/blob/main/src/vs/editor/contrib/inlineCompletions/browser/controller/commands.ts#L86-L101)）→ 在光标处显示幽灵文本等用户按 Tab。只能出现在光标位置。任意位置的"下一处编辑"（NES 式 `isInlineEdit`、`displayLocation`、`jumpToPosition`）都是 proposed `inlineCompletionsAdditions` | [API#languages.registerInlineCompletionItemProvider](https://code.visualstudio.com/api/references/vscode-api#languages.registerInlineCompletionItemProvider)、[API#InlineCompletionItemProvider](https://code.visualstudio.com/api/references/vscode-api#InlineCompletionItemProvider)、[inline-completions sample](https://github.com/microsoft/vscode-extension-samples/tree/main/inline-completions) |
| 命令 `vscode.editorChat.start({ initialRange, initialSelection, message, autoSend, position, attachments })` | 程序化打开 inline chat，可以预填并自动发送 | 公开命令表里有，但参数只写了"Run arguments"，具体字段来自源码 `InlineChatRunOptions` | **依赖 Copilot Chat**，而且请求走 Copilot，不经过我们的 omp worker；参数属于内部形态，比较脆弱 | 只作为"用户有 Copilot 时的可选交接"，不建议作为主路径 | [commands](https://code.visualstudio.com/api/references/commands)、[inlineChatController.ts L57-65](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/inlineChat/browser/inlineChatController.ts#L57-L65) |
| `window.createStatusBarItem` / `setStatusBarMessage` / `withProgress` | 常驻状态、临时消息、进度 | stable | 低侵入 | 已经用于 Voice 状态。可以扩展为显示"🎙 听 · 正在看 `foo.ts#parse`"，让用户知道 agent 当前的上下文 | [API#window.createStatusBarItem](https://code.visualstudio.com/api/references/vscode-api#window.createStatusBarItem)、[UX: status bar](https://code.visualstudio.com/api/ux-guidelines/status-bar) |
| `window.showInformationMessage`（modal / 非 modal） | 通知 | stable | 高侵入。UX 指南："only sending notifications when absolutely necessary"；非用户发起的操作不要用 modal | 语音场景下几乎不需要，TTS 本身就是通知通道。只用来兜底（静音或语音不可用时） | [API#window.showInformationMessage](https://code.visualstudio.com/api/references/vscode-api#window.showInformationMessage)、[UX: notifications](https://code.visualstudio.com/api/ux-guidelines/notifications) |
| Notebook：`NotebookEditor.revealRange` / `selections` | 在 notebook 里定位 cell | stable | 同文本编辑器 | notebook 场景下"看第 3 个 cell" | [API#NotebookEditor](https://code.visualstudio.com/api/references/vscode-api#NotebookEditor) |

**不可用的 proposed**：`editorInsets`（在编辑器行间嵌入 webview，本来适合做富卡片）、`commentReveal`（`CommentThread.reveal()`，程序化展开或聚焦线程）、`activeComment`（当前聚焦的评论线程）。

---

## 7. 其他相关能力

| API | 提供什么 | 稳定性 | 成本 | 结对用途 | 来源 |
|---|---|---|---|---|---|
| `workspace.createFileSystemWatcher(glob)` / `workspace.fs` | 监听磁盘上的文件增删改（包括没打开的文件）；读写文件 | stable | 文档：递归 watcher "quite resource intense"，应尽量少用；递归事件受 `files.watcherExclude` 过滤，建议用简单模式或 `RelativePattern` | 监听测试报告文件（§4 替代方案 ③）；察觉 worker 以外的工具写了文件。worker 自己的改动已经可以从 RPC 事件拿到，不需要 watcher | [API#workspace.createFileSystemWatcher](https://code.visualstudio.com/api/references/vscode-api#workspace.createFileSystemWatcher)、[API#FileSystemWatcher](https://code.visualstudio.com/api/references/vscode-api#FileSystemWatcher)、[API#workspace.fs](https://code.visualstudio.com/api/references/vscode-api#workspace.fs) |
| `workspace.onDidCreateFiles` / `onDidDeleteFiles` / `onDidRenameFiles` | 通过 VS Code UI 或 WorkspaceEdit 做的文件操作 | stable | 低频 | "你刚把 X 重命名了"，同步 agent 的记忆 | [API#workspace.onDidRenameFiles](https://code.visualstudio.com/api/references/vscode-api#workspace.onDidRenameFiles) |
| Speech：`speech.registerSpeechProvider`（STT、TTS、关键词唤醒） | 让扩展**提供**语音引擎给 VS Code（`ms-vscode.vscode-speech` 用的就是它） | **proposed**（`speech`） | — | 不能用；它是 provider 侧 API，也没有"订阅转写"的消费侧 API。我们自带的音频链路仍然必要 | [vscode.proposed.speech.d.ts](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.speech.d.ts) |
| VS Code 内置 dictation（1.131 起，本地 Nemotron 模型）和 **Voice Mode**（1.137 起，Experimental，需要个人 Copilot 计划，`agents.voice.enabled`） | 官方的"和 agent 语音对话 + 插话打断 + 会话感知"（1.138 支持按标签切换 session） | 产品功能，**没有扩展 API** | — | ① 竞品参照；② 麦克风争用或双重 TTS 风险：用户同时开了 Voice Mode、dictation 或 `accessibility.voice.autoSynthesize` 时，我们的语音模式应当检测并提示 [INFERENCE] | [v1_131](https://code.visualstudio.com/updates/v1_131#_built-in-dictation-across-vs-code-experimental)、[v1_137](https://code.visualstudio.com/updates/v1_137#_voice-mode-experimental)、[v1_138](https://code.visualstudio.com/updates/v1_138)、[Voice docs](https://code.visualstudio.com/docs/configure/accessibility/voice) |
| Live Share `vsls` 包：`getApi()` → `session.role (Host/Guest)`、`peers`、`onDidChangePeers`、`onDidChangeSession`、`shareService` / `getSharedService`（主机和访客之间的 RPC）、`onActivity` | 多人会话的感知和扩展间 RPC | 第三方扩展 API（npm `vsls@1.0.4753`，最后发布于 2022-05-23） | — | 多人结对：voice agent 跑在 host 上，通过 `shareService` 让访客端的扩展实例转发指令。**没有**对端光标或选区的 API（`vscode.ts` 里搜不到 cursor/selection），没法知道访客在看哪里。包已经多年未更新，优先级低 | [npm vsls](https://www.npmjs.com/package/vsls)、[vscode.ts 源码](https://unpkg.com/vsls@1.0.4753/vscode.ts) |
| `lm.registerTool` / `lm.invokeTool` / `lm.tools` | 把工具注册给 Copilot 等 LM 调用方；调用其他扩展注册的工具 | stable（1.95，[v1_95](https://code.visualstudio.com/updates/v1_95#_tools-for-language-models)） | — | 可以把 `editor_context` 或 `speak` 暴露给 Copilot agent（让 Copilot 也能"念给用户听"）；对本扩展的主路径不重要 | [API#lm.registerTool](https://code.visualstudio.com/api/references/vscode-api#lm.registerTool)、[Tools guide](https://code.visualstudio.com/api/extension-guides/ai/tools) |
| `chat.createChatParticipant` / `lm.selectChatModels` | `@participant` 聊天参与者；调用 Copilot 模型 | stable（1.90 定稿，1.91 进 Stable，[v1_91](https://code.visualstudio.com/updates/v1_91#_chat-and-language-model-api)） | — | 低优先：我们自有 VoiceLlm 和 worker | [API#chat.createChatParticipant](https://code.visualstudio.com/api/references/vscode-api#chat.createChatParticipant)、[Chat guide](https://code.visualstudio.com/api/extension-guides/ai/chat) |
| `window.registerFileDecorationProvider` | Explorer 和 tab 上的文件徽标、颜色 | stable | 低 | 标出"agent 正在讨论或 worker 正在改"的文件 | [API#window.registerFileDecorationProvider](https://code.visualstudio.com/api/references/vscode-api#window.registerFileDecorationProvider) |

---

## 8. 只作标注：proposed API（Marketplace 构建不可用）

依据：[Using Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)（"only available in Insiders distribution and should not be used in published extensions"；需要 `enabledApiProposals` 和 `--enable-proposed-api`）。所有文件都在 [src/vscode-dts](https://github.com/microsoft/vscode/tree/main/src/vscode-dts)。

| Proposal | 能力 | 对语音结对的价值 |
|---|---|---|
| `testObserver` | `tests.testResults`、`onDidChangeTestResults`、`createTestObserver`、`runTests` | 高（观察所有测试结果），但不可用 |
| `speech` | 注册 STT/TTS/唤醒词 provider | 低（我们自带音频链路） |
| `terminalDataWriteEvent` | `window.onDidWriteTerminalData` 原始终端流 | 中；d.ts 注明不会推到 stable |
| `terminalSelection` | `Terminal.selection` | 中（"终端里我选中的这段"） |
| `terminalExecuteCommandEvent` | `onDidExecuteTerminalCommand`（已 deprecated，由 1.93 的 stable API 取代） | 无 |
| `textEditorDiffInformation` | `TextEditor.diffInformation`、`onDidChangeTextEditorDiffInformation`（quick diff 行级增删） | 中（stable 用 git `diffWithHEAD` 替代） |
| `textDocumentChangeReason` | `TextDocumentChangeEvent.detailedReason.source`（如 `inline-completion`、`chat-edit`） | 中（区分 AI 写入和用户手打） |
| `editorInsets` | `createWebviewTextEditorInset`：行间嵌入 webview | 中（富"指点"卡片） |
| `activeComment` / `commentReveal` | 当前评论线程；`CommentThread.reveal()`/`hide()` | 中 |
| `agentEditorComments` | VS Code Agents 窗口的"agent 可读写评论"存储（1.126 起，评论存在 agent host 上供 agent 用 `listComments`/`resolveComments` 读取，[v1_126](https://code.visualstudio.com/updates/v1_126#_agentic-code-feedback-with-agent-host-harnesses)） | 参照价值：官方也在做"评论作为 agent 反馈通道" |
| `inlineCompletionsAdditions` | NES 式 `isInlineEdit`、`displayLocation`、`jumpToPosition`、`showRange` | 中（在任意位置显示幽灵编辑） |
| `timeline`、`scmHistoryProvider`、`chatContextProvider`、`chatParticipantAdditions` 等 | 时间线和历史、聊天上下文扩展 | 低 |

---

## 9. 对 EditorWatcher（§5.10）的直接启示

1. **快照要升级为"语义快照"**：在 `文件 + 可见行 + 选区` 之外，加上 `enclosingSymbol`（由 `executeDocumentSymbolProvider` 算出，按文件版本缓存）、选区的 `kind`（Mouse/Keyboard）、`isDirty`、当前 tab 类型（diff、终端还是 webview，来自 `tabGroups`），以及当前文件的诊断摘要（错误和警告数量，加上最近的 1 条）。
2. **事件分层去抖**：selection 和 visibleRanges 用 300–500 ms 去抖；textDocument 变更聚合成"打字 burst"，停顿约 1.5 s 算结束，同时作为 FloorArbiter 的"用户忙"信号；save 和 diagnostics 是低频触发点。数值都是建议值 [INFERENCE]。
3. **新增的主动观察来源**（进入 §5.9 的仲裁队列）：终端命令失败（`onDidEndTerminalShellExecution` 且 exitCode≠0）、调试停在异常（DebugAdapterTracker 收到 `stopped`，reason=exception）、保存后错误数增加。它们都是 `error` 级。
4. **执行手段优先级**（按侵入性从低到高）：decoration 高亮和 `after` 批注 → peek → CodeLens/Comments → `showTextDocument(preserveFocus, Beside)` → `revealRange` → 通知。默认不抢焦点、不移动视口，除非用户明确说"带我去"。

---

## Top 10 highest-leverage APIs for voice pairing

| # | API | 理由 |
|---|---|---|
| 1 | `window.activeTextEditor` + `onDidChangeTextEditorSelection`（含 `kind`）+ `onDidChangeTextEditorVisibleRanges` | 语音结对的核心难题是指代消解（"这个""这里""屏幕上那段"）。这三者都是 stable、便宜，已经是 §5.10 的基础。`kind=Mouse` 的选区能可靠地区分"指给你看"和"在打字" |
| 2 | `vscode.executeDocumentSymbolProvider` + `executeSelectionRangeProvider` | 把行号翻译成符号名、把"这个 if/函数"翻译成精确范围。语音输出和理解都依赖符号级粒度，而这只需要一次按需调用 |
| 3 | `languages.getDiagnostics` + `onDidChangeDiagnostics` | 不读文件就能知道哪里错了。可以在保存后主动提示，也可以验证 worker 改完是否干净，还能作为 FloorArbiter 的 error 级观察。成本几乎为零 |
| 4 | Shell Integration：`onDidStart/EndTerminalShellExecution` + `read()` + `exitCode` + `shellIntegration.executeCommand`（1.93 stable） | 补上"用户自己在终端跑了什么、结果如何"这个盲区，也是 stable 下观察测试结果的最佳替代（testObserver 是 proposed）。还能让 agent 在用户可见的终端里执行命令 |
| 5 | `createTextEditorDecorationType` / `setDecorations`（背景、`after` 批注、overview ruler） | 最便宜、侵入性最低的"指点"手段：边说边高亮、行尾批注、滚动条标记。不需要 provider，也不抢焦点，可以和 TTS 的句子同步 |
| 6 | `vscode.executeDefinitionProvider` / `executeReferenceProvider` / `executeHoverProvider` / `prepareCallHierarchy` + `editor.action.peekLocations` | 回答"谁调用了它""这是什么类型"时，用语言服务比 grep 准，而且结果能直接用 peek 在原地展示。"查"和"指"形成闭环 |
| 7 | `workspace.onDidChangeTextDocument` + `onDidSaveTextDocument` | 知道用户正在打字（此时不插话）、刚改了什么（上下文），以及 save 这个自然的检查点。配合 isDirty 还能大致区分用户编辑和 worker 落盘 |
| 8 | `vscode.git` API：`state.workingTreeChanges` / `onDidChange` / `diffWithHEAD(path)` / `blame` | 支持"我改了什么""帮我 review 未提交的改动""这行谁改的"。能覆盖 worker 之外、用户自己的改动，并提供冲突预警 |
| 9 | `comments.createCommentController` / `CommentThread` | 语音转瞬即逝，评论可以持久保存并锚定在代码上。适合 review 结论、待办和"留给你的问题"，用户可以打字回复，形成异步通道。官方 Agents 窗口也在朝这个方向走（proposed `agentEditorComments`） |
| 10 | `debug.activeStackItem` + `DebugSession.customRequest('scopes'/'variables'/'evaluate')` + `DebugAdapterTracker` | 把结对扩展到调试：知道用户停在哪一帧，读取真实变量值来回答"为什么是 null"；异常停下时主动提示。activeStackItem 是 1.90 stable |

候补：`window.tabGroups`（识别 diff 或终端 tab）、`window.state.active`（离开时攒播报）、`editor.action.inlineSuggest.trigger` + InlineCompletionItemProvider（口述代码 → 幽灵文本 → Tab 接受；可行，但只能出现在光标处，还要和 Copilot 竞争）、`vscode.changes`（多文件 diff 讲解）、tasks API 的 exitCode。
