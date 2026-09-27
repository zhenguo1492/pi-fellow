# 智能体光标：边讲边指代码（2026-09-25）

**实现状态**：

已实现：
- **看到你的编辑器**：每轮消息附带 `<editor>` 块。代码在 `editorSnapshot.ts`，编辑器跟踪复用 `utils/fileEditor.ts`。
- **代码锚点**：锚点从回复里取出，不显示也不朗读。代码在 `codeAnchors.ts`。
- **Pi 高亮**：行尾显示标签，不改你的选区和焦点。三种焦点三种颜色：讲解时是紫色 `Pi`，读文件时是蓝色 `Pi · reading`，写文件时是绿色 `Pi · writing`。代码在 `agentCursor.ts`。
- **和语音同步**：语音模式下，锚点在它后面那句话开始播放时才生效；打字对话时立即生效。
- **Pi 焦点**：除了讲解时的指向，还包括语音智能体自己读的文件（`onRead`）和 worker 读写的文件（`workerFocus.ts`）。worker 写文件的范围按写前、写后的内容比较得出，比较逻辑在 `piFocus.ts` 的 `changedLines`。worker 的焦点只在语音智能体开着时显示。
- **跟随 Pi**：状态栏显示 `$(eye) Pi: writing calc.js:18-22`，点击切换是否跟随；编辑器标题栏也有眼睛按钮。设置 `voiceAgent.followPi` 决定启动时是否跟随，默认跟随。跟随时，编辑器会在你的栏里用预览标签打开 Pi 的焦点，不抢键盘。不跟随时只记录、只在状态栏显示，已经显示在屏幕上的文件照样高亮。你一打字就自动停止跟随。
- **防乱跳**：讲解时的指向会保持 6 s，这段时间里读写活动只排队、不跳过去，之后只执行最新的那一个；读写活动之间也至少间隔 1.5 s。
- **`open_file` 宿主工具**：你说"打开某文件 / 跳到某处"时，即使没在跟随也会打开。
- **指向单个名字**：`⟦path:行#名字⟧` 只圈出那一行上的这个名字（变量、参数、字段），同一文件里它的其他用处用虚线框标出（`vscode.executeDocumentHighlights`，跟随作用域）。给的行上找不到时，向上下各找 3 行；再找不到就退回整行高亮。`⟦path#名字⟧` 解析到的符号如果是变量、常量、字段、属性或枚举成员，而且声明只占一行，也按名字圈出。`open_file` 同时给 `startLine` 和 `symbol` 时同理。状态栏显示成 `Pi: calc.js:6 · sum`。查找逻辑在 `piFocus.ts` 的 `findName`。
- **提示词规则**：已加入。

实测（真实 VS Code + omp，脚本 `/tmp/voice-smoke/suite-pair*.js`、`suite-follow.js`）：
- 能看到选区，不读文件就答对；
- 跨文件指向 `main.js` → `calc.js`；
- 语音模式下，4 次指向分别落在 4 个步骤开始播放的那一刻；
- 不跟随时 `open_file` 照样能打开文件，普通的指向不会动你的编辑器；
- 重新跟随时会跳到 Pi 的焦点；
- worker 写 `calc.js` 时，焦点依次是 `reading calc.js` → `writing calc.js` → `writing calc.js:18-22`，这个范围正好是新加的函数和导出行；
- 你一打字就停止跟随，而 worker 写盘引起的文件重载不会让它停止跟随。

与草案不同的地方：
- 颜色是固定的三种颜色，没有写进 `contributes.colors`；
- 标签在行尾，没有 `◀`；
- 文件在你当前编辑器所在的栏打开（`preview` + `preserveFocus`），开关只有跟随和不跟随两档，没做 `lead` / `side` / `hint`。

**未做**：
- §4 的在旁边一栏打开（`side`）；
- 聚焦历史，比如"上一个"、"回到我的代码"；
- §5 的 `<agent-focus>`，也就是"这里"指谁；
- 语音面板把锚点显示成小标签；
- worker 执行 bash 或跑测试时，状态栏没有显示。

目标：语音智能体有一个**自己的代码选择器**，与你的光标分开。它讲到哪段代码，就在编辑器里高亮哪段；讲到别的文件时，自动打开那个文件。讲解和高亮按句子同步。

验收场景：你问"讲讲一句话从麦克风到 worker 的完整路径"。它依次打开 `voiceMode.ts`、`conversation.ts`、`voiceAgent.ts`、`sidebar.ts`，每念一句，就高亮这句说的那几行。你的光标、选区和键盘焦点都不被动。

背景见 [`voice-pair-brainstorm.md`](./voice-pair-brainstorm.md)，本文对应其中的 F1。

## 1. 用户看到什么

| 元素 | 实现 | 说明 |
|---|---|---|
| 智能体高亮 | `TextEditorDecorationType`：独立的背景色、左侧竖条、gutter 图标、滚动条标记，行尾用 `after` 显示 `◀ Pi` | 颜色通过 `package.json` 的 `contributes.colors` 定义，跟随主题。**只是装饰，不改 `editor.selection`**，所以你的光标和选区不受影响 |
| 切换文件 | `showTextDocument(uri, { preview: true, preserveFocus: true, viewColumn })` | 用预览 tab，讲完一圈不会留下一排 tab；`preserveFocus` 保证键盘焦点还在原来的地方 |
| 滚动 | `revealRange(range, InCenterIfOutsideViewport)` | 目标已经在屏幕上就不滚动 |
| 状态栏 | `🔊 Pi › stt.ts › transcribe (2/5)` | 显示它现在指着哪里；点击跳过去 |
| 语音面板 | 句子里的锚点显示成可点击的 `stt.ts:139-141` 小标签 | 需要和正在做的语音面板约定好格式，见 §6 |

## 2. 它怎么"指"：在回复里嵌入锚点

模型在回复文本里写锚点，**放在它所指的那句话开头**：

```
入口在这里⟦src/voiceAgent/voiceMode.ts:560-575⟧，它把每句话送去合成。
然后状态机接手⟦src/voiceAgent/conversation.ts#reduce⟧，决定谁在说话。
```

支持四种形式：

- `⟦path:start-end⟧`：一段行
- `⟦path:line#name⟧`：那一行上的一个名字，比如变量或参数，只圈出名字本身和它在文件里的其他用处
- `⟦path:line⟧`：一行
- `⟦path#symbol⟧`：一个符号。用 `vscode.executeDocumentSymbolProvider` 解析成范围，模型不用读文件、不知道行号也能指

**为什么用内嵌锚点，不用宿主工具（`show_code`）**：

- 工具调用要多一次往返，设计文档实测一轮工具约 2.8 s；
- 工具调用发生在说话之前，没法和"念到哪一句"对齐；
- 锚点跟着文本流走，天然和句子绑定，不增加延迟。

模型知道行号，因为它自己的 `read` 工具输出带行号。

## 3. 数据流

```mermaid
flowchart LR
  LLM[语音模型流式文本] --> CUT[takeSentences<br/>锚点整体不切]
  CUT --> SPK[speak 效果<br/>句子保留锚点]
  SPK --> STRIP[送 TTS 前剥掉锚点]
  STRIP --> TTS[TTS 合成 / 播放]
  TTS -->|playing 事件| CUR[AgentCursor.focus]
  CUR --> ED[编辑器：打开文件 / 滚动 / 高亮]
  SPK --> PANEL[语音面板：锚点显示成小标签]
```

现有的挂载点：

- `sentences.ts` 的 `takeSentences` 目前会在 `:` 处切句（软断点），锚点里的 `:` 可能被切开。需要让 `⟦…⟧` 像代码围栏一样整体不切。
- `voiceMode.ts:308` 的 `speak` 效果把句子交给 `Speaker`；在 `voiceMode.ts:594` 调 `synthesize` 之前剥掉锚点。
- `voiceMode.ts:270` 已经会对每句话发出 `playing` 事件（`onAudio`）。智能体光标只要订阅它：**哪句开始播放，就聚焦那句的锚点**。
- 打字模式（语音模式没开）：从 `VoiceAgentListener.onText`（`voiceAgent.ts:52`）的增量里，锚点一完整就立即聚焦。
- 回声过滤：`recentReplies` 取自生成文本，比对前也要剥掉锚点，否则回声比对会失真。

## 4. 不打扰的规则

1. **永远不改你的光标、选区和键盘焦点。** 只用装饰和 `preserveFocus`。
2. **你在打字时不抢主编辑区。** 如果你最近 5 s 内在编辑，或者当前文件有未保存改动：
   - 在旁边一栏打开（`ViewColumn.Beside`）；
   - 或者只在状态栏提示"Pi 想给你看 stt.ts › transcribe"，由你决定要不要过去。

   由设置 `voiceAgent.cursor.follow` 控制：`lead`（直接带你看）/ `side`（在旁边一栏）/ `hint`（只提示）。
3. **高亮什么时候消失**：这轮说完后再保留 N 秒；你在那个范围里点击或编辑，也会立即清掉。
4. **打断**：你插嘴时停止切换，保留当前高亮，因为你多半就是想问这里。`<interrupted>` 说明里本来就记录了播到哪一句，模型能知道光标停在哪。
5. **可以回退**：维护一个聚焦历史栈。可以说"上一个""回到刚才"；也可以说"回到我的代码"，回到讲解开始前你所在的文件和位置。

## 5. "这里"指谁的光标

接入 EditorWatcher（brainstorm 里的 E1）以后，每轮消息里同时附上两个位置：

- `<editor …>`：你在看的地方
- `<agent-focus file="…" lines="…">`：它刚才指的地方

消解规则：

- 智能体聚焦之后，你动过自己的光标或选区：说"这里"指你的位置；
- 否则指它刚才高亮的位置。

这一点很关键。它正在带你看代码时，你问"这里为什么要 await"，"这里"指的是它的高亮，不是你的光标。

## 6. 校验与安全

- 锚点路径必须在工作区内，而且文件存在；行号超出文件范围就截到有效范围；符号解析失败就退回文件开头。无效锚点忽略，只记日志。
- 这个功能只读，不写任何文件。它不突破设计文档 §1.2 的非目标（"语音智能体不直接修改文件"）。
- 给语音面板的约定：句子文本里保留原始锚点 `⟦path:start-end⟧` / `⟦path#symbol⟧`，由面板渲染成小标签，点击时执行 `oh-my-pi-chater.voiceAgent.revealAnchor`。

## 7. 提示词要加的规则

系统提示词是静态的，加规则不影响缓存：

- 讲代码时，在每句话开头放它所指的锚点；每句最多一个。
- 优先用 `#symbol` 形式。行号只用你刚 `read` 过、确认过的。
- 不要把路径念出来，说"这里""这个函数"就行，用户看得到高亮。
- 跨文件讲解时按执行顺序走，每处一两句。

## 8. 实现切片

| # | 内容 | 文件 | 备注 |
|---|---|---|---|
| 1 | 锚点解析、剥离、切句时整体不切（纯函数，带单元测试） | 新增 `src/voiceAgent/codeAnchors.ts`；改 `sentences.ts` | 可以马上做，不和面板冲突 |
| 2 | `AgentCursor`：装饰、打开和滚动、跟随策略、历史栈、状态栏 | 新增 `src/voiceAgent/agentCursor.ts`；`package.json` 加 colors、设置、命令 | 可以马上做 |
| 3 | 接线：送 TTS 前剥锚点；`playing` 时聚焦；打字模式走 `onText`；回声比对剥锚点 | `voiceMode.ts`、`voiceAgentCommands.ts`、`conversation.ts` | **另一个会话正在改这几个文件**（面板），要等它合入 |
| 4 | 提示词规则 | `voicePrompt.ts` | |
| 5 | `<agent-focus>` 和 `<editor>` 快照，"这里"的消解 | `voicePrompt.ts`、`voiceAgent.ts`；需要先做 EditorWatcher | 第二阶段 |
| 6 | 语音面板把锚点渲染成小标签 | `voiceView.ts` | 和面板作者约定格式 |

## 9. 待定

1. `follow` 默认用 `lead`、`side` 还是 `hint`？建议默认 `lead`，你在打字时自动降为 `side`。
2. 讲完一圈要不要自动回到原来的位置？建议不自动回去，但留一个"回到我的代码"。
3. 高亮颜色：用一个固定的"Pi 色"，和你自己的选区颜色明显区分开。

## 11. 两个模式：委派 / 结对（已实现，2026-09-25）

| | 委派模式（值 `omp`） | 结对模式（默认，值 `pair`） |
|---|---|---|
| 谁动手 | worker（`tell_worker` 等） | 语音智能体自己：`edit_file`、`run_in_terminal`，调试工具（§12） |
| worker 工具 | 可用 | 宿主拒绝（`tell_worker` / `confirm_task` / `stop_worker` / `answer_worker`） |
| 结对工具 | 宿主拒绝 | 可用 |

**切换规则**（`hostTools.ts` 的 `set_mode`）：
- 进入结对模式需要两步。第一次调用只记录请求，模型要请用户确认；之后用户的下一轮回复表示同意，才能真正切换。这个规则和 `confirm_task` 相同。
- 切回委派立即生效。用户要求时切；在结对模式里遇到重活（比如需要几个智能体并行），语音智能体也可以自己切，调用时带 `auto=true`，然后让 worker 去做，worker 可以自己开子智能体。
- 自己切走的例外：只有语音智能体自己从结对带 `auto=true` 切到委派后，它可以不经确认直接切回结对（活干完后）。标记 `_autoSwitchedFromPair` 在切回结对、或用户在界面上切换模式时清除；用户要求切到委派的（口头或界面），切回结对仍要两步确认。
- 界面上的切换（机器人工具条的模式按钮、命令 "Switch Delegate / Pair Mode"）本身就是明确的操作，不需要确认。
- 新启动的语音智能体总是在结对模式。用户交代任务时它先判断轻重：小改动自己做，重活自己带 `auto=true` 切到委派交给 worker，做完切回结对。
- 主动开口的轮次不能切换模式、不能改文件、不能跑命令。

**显示**：
- 输入框上方的机器人工具条有模式按钮：委派模式显示委派图标，结对模式显示握手图标，悬停提示 “Delegate mode” / “Pair mode”，点击切换；
- Bot 视图的 LLM 一行显示 “Delegate mode” 或 “Pair mode”；
- 切换时，对话里记一行 System（“Delegate mode: …” / “Pair mode: …”）。

**实现要点**：模式放在每一轮消息的 `<mode name="…"/>` 里，不写进系统提示词，这样切换模式后提示词缓存照样命中。

**`edit_file`**（`pairHands.ts`，定位逻辑在 `pairText.ts` 的 `locateEdit`）：
- 用 `oldText` 精确匹配要改的位置；匹配到多处时按 `nearLine` 选最近的一处。`oldText` 为空时只能填充空文件；文件不存在时报错，新建文件改用 `create_file`（§13）。
- 先删掉原文，再逐行敲入新代码，每行约 90 ms，整次最长 2 s。绿色的 `Pi · writing` 高亮跟着写到的行走，不管你是否在跟随都会显示。
- 删除和逐行输入合并成一个撤销步骤：第一次编辑设 `undoStopBefore`，只有最后一次设 `undoStopAfter`。所以一次 Ctrl+Z 就能撤销。
- 文件原本没有未保存的改动，就自动保存；如果你有未保存的改动，就不保存。
- 敲的过程中如果文件被别人改了（文档版本号跳变），就停下来并报告。
- worker 正在干活时拒绝修改。
- 只能改工作区内的文件，检查规则见 §13。
- 它自己的编辑不算"你在打字"，所以不会停止跟随。

**`run_in_terminal`**（`pairHands.ts`，输出清理在 `pairText.ts` 的 `cleanTerminalOutput`）：
- 在专用的 "Pi" 终端里运行，终端显示在底部，不抢键盘。
- 用 shell 集成的 `executeCommand` 执行，读取输出和退出码，把最后 60 行交给模型。
- 默认等 30 s，超时后返回已有的输出，命令继续运行。
- 上一条命令还在跑时，另开一个 "Pi (2)" 终端。
- 终端没有 shell 集成时，只把命令发过去，并说明看不到结果。

**提示词约束**：
- 只在用户明确要求时才提议进入结对模式；
- 结对模式下，只跑用户要求或刚答应的命令；
- 删除文件、`git push`、安装依赖之类的操作，先问用户。

**实测**（脚本 `/tmp/voice-smoke/suite-pairmode.js`、`suite-modechip.js`）：
- 请求结对 → 先问，再确认 → 进入结对模式，面板和状态栏都显示 Pair；
- 结对模式下加 `double` 函数：逐行写入，高亮从 15-16 走到 15-22，已保存，worker 空闲，一次 Ctrl+Z 恢复原文；
- 终端运行 `node -e …double(21)` → 退出码 0、输出 42；`process.exit(3)` → 退出码 3；
- 口头"切回 omp" → 立即切换；切换按钮两个方向都正常；
- 回到委派模式后说"直接删掉"：它没有自己动手，而是交给 worker 并提出方案。

**已知限制**：
- 结对模式的修改不进 checkpoint 和 diff 面板，回滚靠 Ctrl+Z 或 git；
- 状态栏的 Pi 焦点不显示终端命令；
- "只跑你要求的命令"只由提示词约束，宿主不做检查。

## 12. 读 VS Code 的输出、调试（已实现，2026-09-25）

| 工具 | 模式 | 做什么 |
|---|---|---|
| `read_output` | 两种模式都能用（只读） | 不带 `source`：列出能读的输出；带 `source`：返回它的最后若干行（默认 80，最多 400） |
| `list_viewers` | 两种模式都能用（不改文件） | 列出能显示这个文件的编辑器（所有已装扩展的 custom editor）和 VS Code 内置扩展的预览命令（如 Markdown 预览）；不写死任何扩展 |
| `open_with` | 两种模式都能用（不改文件） | 用 `list_viewers` 对同一个文件给出的某个 viewer 打开；`toSide` 在旁边的编辑组打开；最多等 8 s |
| `debug_start` | 结对 | 按名字启动 `.vscode/launch.json` 里的配置（`noDebug` 相当于 Ctrl+F5），等到暂停或结束（默认 15 s） |
| `debug_control` | 结对 | 按调试工具栏的按钮：continue、pause、stepOver、stepInto、stepOut、restart、stop，等到下一次暂停或结束（默认 10 s） |
| `set_breakpoint` | 结对 | 在某行加断点（可带条件），或 `remove` 删掉 |
| `debug_inspect` | 结对 | 当前停在哪：代码、调用栈、局部变量、断点列表；带 `expression` 时在栈顶帧求值 |

**`read_output`**（`vscodeOutput.ts`，名字匹配在 `pairText.ts` 的 `pickName`：先精确匹配，不区分大小写；否则取唯一包含它的）：
- **Output 面板**：VS Code 没有读别的扩展输出通道的 API，但每个通道都写成当前窗口日志目录里的文件，就在本扩展 `context.logUri` 旁边。读的是：`exthost/output_logging_<最新>/<n>-<名字>.log`（扩展的普通通道）、`exthost/<扩展 id>/<名字>.log`（日志通道，如 Git）、`exthost/exthost.log`（Extension Host）、`window<N>/output_<最新>/tasks.log`（Tasks）、窗口和会话级的 `*.log`（Window、Main、Shared 等）。只读文件末尾 256 KB。这个目录结构没有写进文档，VS Code 改了就要跟着改。
- **Debug Console**：`DebugDriver` 用 `registerDebugAdapterTrackerFactory('*')` 收集所有调试会话的 `output` 事件（去掉 telemetry），按一次运行（顶层会话加 js-debug 的子会话）分开，保留最近 5 次。最新一次叫 `Debug Console`。
- **终端**：用 `onDidStartTerminalShellExecution` 记录所有终端里跑的命令（包括用户自己的终端），每个终端保留最近 5 条命令和它们的输出、退出码。只有扩展启动之后、有 shell 集成的终端里跑的命令才有；没有 shell 集成的终端在列表里注明读不到。

**`list_viewers` / `open_with`**（发现和匹配在纯函数模块 `viewers.ts`，执行在 `pairHands.ts`）：

只留实测可靠的部分（2026-09-26）：custom editor 都用 `vscode.openWith` 打开，谁贡献的都一样可靠（draw.io 正常打开）；内置 Markdown 预览正常（bierner.markdown-mermaid 在里面画 Mermaid）。第三方扩展的预览命令各自要不同的参数和状态，不可靠：MermaidChart 的 `mermaidChart.preview` 对 `.mmd` 文件要么什么也没显示，要么 8 s 超时。所以第三方预览命令默认不列、`open_with` 也不接受，要用得打开设置 `oh-my-pi-chater.voiceAgent.discoverPreviewCommands`（默认 `false`，每次调用时读取）。

提示词让模型：`.drawio` 这类图表文件用它的 custom editor 打开；Mermaid 放在 `.md` 文件的 mermaid 代码块里，用 `markdown.showPreviewToSide` 在旁边预览，一边改一边看；单独的 `.mmd` 文件可以提议搬进 Markdown。

- **编辑器**：扫 `vscode.extensions.all` 的 `contributes.customEditors`，`selector.filenamePattern` 按 VS Code 的规则匹配（有 `/` 时匹配整条路径，否则只匹配文件名，不区分大小写），比如 draw.io 的 `*.drawio`、`*.dio`、`*.drawio.svg`。顺序：扩展的 `default`、内置的 `builtin`、`option`，最后是内置文本编辑器 `default`。不受上面的设置影响。
- **内置还是第三方**：运行时扩展描述里的 `isBuiltin`（不在 API 类型里），或者扩展装在 `vscode.env.appRoot/extensions` 下，就算内置。
- **预览命令**（内置扩展的总是找；设置打开时也找第三方的）：`contributes.commands` 里名字（id 最后一段，按驼峰拆词）或标题里有以 preview 开头的词的（`appReview` 不算），并且扩展是给这个文件的：
  - 同一个扩展的 `menus` 里有 `when` 说明是给这个文件的：`resourceLangId`/`editorLangId`/`resourceExtname`/`resourceFilename`/`resourcePath` 的 `==` 或 `=~` 成立，且对文件的条件没有不成立的；其他上下文键（焦点、视图等）当作未知；
  - 或者命令没有被 `commandPalette` 的 `when` 限制（命令面板里对所有文件都显示），而扩展贡献了这个文件的语言或能打开它的编辑器（设置打开时，MermaidChart 的 `mermaidChart.preview` 就是这样找到的）。
  - 排序：编辑器标题栏 0，命令面板 1，只在右键菜单等处 2；命令面板隐藏的（`when: false`）或 id 里带 ContextMenu 的再加 2。标题相同的只留排最前的一个。最多 8 个。Markdown 的 `markdown.showPreview`、`markdown.showPreviewToSide` 从内置扩展里找到，设置开不开都有。
- **语言**：文件已打开就用它的 `languageId`，否则按各扩展 `contributes.languages` 的 `filenames`、`filenamePatterns`、最长的 `extensions` 推断。
- **文件在不在**：已经在 `workspace.textDocuments` 里打开的直接算在（`create_file` 刚建的文件可能还 stat 不到）；否则 `fs.stat` 最多试 5 次，间隔 200 ms。
- **安全**：路径和其他工具一样必须在工作区里；`open_with` 先重新算一遍 `list_viewers`，id 不在里面就拒绝，所以不能用它执行任意命令。
- **执行**：编辑器用 `vscode.openWith`。预览命令先把文件显示成活动编辑器（很多预览命令不看参数，只看活动编辑器），再带着 uri 执行；如果抛错，或 1.5 s 内没有出现新的标签页，就不带参数再执行一次。打开文件、每次执行命令都最多等 8 s，超时就返回"已经开始、还没结束"，不再等，也不再执行第二次，避免扩展的命令一直不返回时工具卡住。

**调试**（`debugDriver.ts`）：
- 控制用 VS Code 自己的命令（`workbench.action.debug.stepOver` 等），作用于你在界面上看到的那个会话和线程，调试工具栏、变量视图照常更新。
- 暂停、继续靠调试适配器消息判断：`stopped` 事件记为暂停；`continued` 事件，或者发给适配器的 `continue` / `next` / `stepIn` / `stepOut` 等请求，记为继续运行。所以你自己按 F10 也跟得上。
- 等待在动作之前开始监听，快速命中的断点不会漏掉。restart 可能换一个新的顶层会话，所以只等暂停，不把旧会话结束当成"跑完了"。
- 暂停时返回：原因、函数和位置、前后各 2 行代码（当前行标 `→`）、最多 5 帧调用栈、第一个非 expensive 作用域里最多 25 个变量。暂停的那一行成为 Pi 的焦点，不跟随时也会打开并高亮。
- 设断点后也会把那一行作为 Pi 的焦点打开。
- 启动、重启程序算"跑命令"，提示词要求用户要求或同意后才做；一起调试时的单步和查看不用再问。

**实测**（脚本 `/tmp/voice-smoke/suite-debug.js`，真实 VS Code + omp + 内置 js-debug）：
- "average 里的 sum 是干什么的，指给我看" → 焦点 `name: "sum"`，声明处实线框，另外两处用到的地方虚线框，行尾 `Pi` 标签；
- "Smoke Build 报了什么错" → `read_output` 读到测试写入输出通道的 `error E1234`；
- "user shell 终端里刚跑的命令输出了什么" → 读到命令、stdout、stderr 和 `exit code 2`；
- "calc.js 第 11 行打断点，用 Run main 启动调试" → `set_breakpoint` + `debug_start`，返回 `Paused (breakpoint) in global.average at calc.js:11`，局部变量 `sum = 0; values = (0) []`，Pi 焦点在 `calc.js:11`；
- `debug_inspect` 求值 `[sum, values.length]` → `[0, 0]`；stepOut → `main.js:3`；continue → 跑完，Debug Console 里是 `average of scores: NaN`；之后 `read_output` 读 `Debug Console` 得到同样内容。

**已知限制**：
- 退出码只有适配器发 `exited` 事件时才有，js-debug 实测没有发；
- 求值只在栈顶帧，不看你在调用栈视图里选的帧；
- 终端输出只从扩展启动后开始记。

## 13. 结对模式的文件操作（已实现，2026-09-26）

代码在 `fileHands.ts`，路由和删除确认在 `hostTools.ts`。这些工具都只在结对模式可用；主动开口的轮次不能用。`create_file`、`rename_file`、`delete_file` 和 `edit_file` 一样，worker 正在干活时拒绝执行。

| 工具 | 实现 | 说明 |
|---|---|---|
| `create_file` `{path, content?}` | `WorkspaceEdit.createFile(…, { contents })` | 文件已存在就报错。缺的上级文件夹会自动建。建好后在你的编辑器栏打开，并显示 `Pi · writing` 高亮 |
| `create_folder` `{path}` | `workspace.fs.createDirectory` | 已存在就直接报告 |
| `rename_file` `{from, to}` | `WorkspaceEdit.renameFile(…, { overwrite: false })` | 能改名或移动文件、文件夹。目标已存在就报错，从不覆盖。不能改工作区根目录 |
| `delete_file` `{path, recursive?}` | 见下文 | 要先确认 |
| `save_file` `{path?}` | `TextDocument.save()` | 不给 path 时保存所有有未保存改动的工作区文件。会连你自己的改动一起存盘，提示词要求只在你开口时才用 |
| `close_editor` `{path}` | `window.tabGroups.close` | 关闭这个文件在所有编辑器组里的标签；有未保存改动时拒绝 |

`edit_file` 不再新建文件，新建统一用 `create_file`。

**路径检查**（`FileHands.resolve`，所有文件工具和 `edit_file` 都经过它）：
- 路径按第一个工作区文件夹解析，结果必须落在某个 `file:` 工作区文件夹里。判断用 `pairText.ts` 的 `insideFolder`，所以 `..cache` 这样的名字算在工作区内，`../x` 和 `/ws2` 不算。
- 路径中已经存在的最深一级，用 `fs.realpath` 解开符号链接后，仍然必须在工作区内。指向工作区外面的链接会被拒绝。

**删除**：
- **两步确认，由宿主强制执行**：
  - 第一次调用只做检查，然后记下待删除项；返回的文字说明要删什么，文件夹会写明里面有几个文件。
  - 之后用户的某一轮里，再用同样的 path 和 recursive 调用，才会真正删除。
  - 换一个路径、换一个 recursive、切换模式、切换语音上下文，都会重新开始。
  - 待删除项每一轮都以 `<pending-delete path="…"/>` 出现在消息里。
- **拒绝删除**：工作区根目录；`.git` 目录及其中的内容；自己或里面的文件有未保存改动的；文件夹没给 `recursive: true` 的。
- **优先放回收站**：`workspace.fs.delete(uri, { recursive, useTrash: true })`。
- **回收站失败时先备份**：把原文件或文件夹用 `fs.cp` 复制到 `<系统临时目录>/oh-my-pi-chater-deleted/<时间戳>/<工作区相对路径>`，符号链接照原样复制成链接；备份成功后，才用 `useTrash: false` 永久删除。备份失败就不删。工具结果里写明备份位置。
- **删除后**：关掉被删内容的编辑器标签，它们没有未保存的改动。

**实测**（脚本 `/tmp/voice-smoke/suite-files.js`，真实 VS Code + omp；用 `XDG_DATA_HOME` 把回收站指到测试目录）：
- 新建 `src/util.js`，带内容，`src` 文件夹自动建好 → 在编辑器里打开，显示 `Pi · writing`；
- 新建文件夹 `lib`；把 `src/util.js` 移到 `lib/math.js`；
- 让它删 `lib/math.js` → 第一轮只询问，文件还在；确认后删除，文件出现在回收站的 `files/math.js`，标签被关闭；
- 删 `lib` 文件夹 → 询问时说明"里面有 2 个文件"，确认后整个文件夹进回收站；
- 在指向工作区外的链接 `escape/` 下新建文件 → 被宿主拒绝；
- 删工作区外的文件 → 模型自己拒绝了，没有调用工具，文件还在；
- 回收站不可用（让 `$XDG_DATA_HOME/Trash` 是一个普通文件）→ 回收站报 `Failed to move item to trash`；文件先备份到 `/tmp/oh-my-pi-chater-deleted/<时间戳>/notes/todo.txt`，内容一致，然后删除；回复里告诉了用户备份在哪。

**已知限制**：
- 备份在系统临时目录里，重启后可能被清空。
- 只支持本地的 `file:` 工作区，远程工作区的文件夹会被当作工作区外。
- 删除的确认不在语音面板上显示卡片，只靠语音或文字确认。
