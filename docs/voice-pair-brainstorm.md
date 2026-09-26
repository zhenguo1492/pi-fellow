# 语音结对搭档：可能性调研与头脑风暴（2026-09-25）

这份文档只做探索，不是设计定稿。依据三份调研：

- [`voice-pair-research-internal.md`](./voice-pair-research-internal.md)：现有代码里能复用什么、扩展点在哪、有哪些硬约束，每条都标了 file:line
- [`voice-pair-research-vscode-api.md`](./voice-pair-research-vscode-api.md)：stable VS Code API 能感知什么、能怎么"指给用户看"
- [`voice-pair-research-prior-art.md`](./voice-pair-research-prior-art.md)：语音编程和主动式 AI 助手的产品先例与 HCI 研究

## 1. 结论

- **可行，而且架构不用推倒。** 现在的语音智能体已经具备"脑子"（读代码、讨论）、"手"（worker）和"嘴"（TTS、主动播报、插嘴），缺的是"眼睛"和"手指"：
  - **眼睛**：看到用户在看什么、改什么、刚跑了什么。
  - **手指**：说到哪段代码，就在编辑器里指到哪段。
  这两样用 stable API 都能做，接入点也都已经有了：新宿主工具、新观察类型，以及每轮附带的上下文（`TurnInput`）。
- **难点在"什么时候开口"，不在能力本身。** 研究和产品的教训高度一致：主动发言太多，用户会讨厌，最后把功能关掉。
  - Chen et al.：高频版本的偏好率从 90% 降到 47%。
  - Cursor Tab：减少 21% 的建议，接受率反而提高 28%。
  - Copilot NES：专门训练"不跳"。
- **语音适合讨论意图，不适合逐行写代码。** Copilot Voice 在 2024 年停掉了。Serenade 和 Talon 只在无障碍等细分人群里活了下来。写代码继续交给 worker。
- **直接竞品**：VS Code 1.137 起的 Voice Mode（实验性，需要 Copilot）。它能感知 agent 会话，但文档没说它能读取光标或选区。**"知道你在看哪段代码的语音搭档"目前还是空白。**

## 2. 结对里的几种分工

人-人结对里，driver 写代码，navigator 看全局。我们这里有三方：你、语音智能体、worker，可以组合出四种模式：

| 模式 | 谁写代码 | 语音智能体做什么 | 最需要的能力 |
|---|---|---|---|
| **A. 你写，它看**（navigator） | 你 | 在子任务边界提醒错误，回答"这样写对吗"，说"接着我刚才的做" | 知道你刚改了什么、诊断、终端结果、克制的发言时机 |
| **B. worker 写，你看** | worker | 当讲解员和审阅者：边讲 diff 边指给你看，替你把关、提问 | `worker_diff`、多文件 diff 导览、高亮指点 |
| **C. 一起查** | 没人写 | 读代码、跳定义、查调用方、调试时看变量 | 编辑器快照、LSP 查询、peek、调试 API |
| **D. 橡皮鸭** | 你在想 | 基本不说话，你问"你怎么看"时才总结 | 识别出你在自言自语推演，这时不插话 |

现在只支持 B 的一半（能派活，但讲不了 diff）和 C 的一半（能读代码，但不知道"这段"指哪里）。

## 3. 点子清单

### 3.1 眼睛：感知

| # | 点子 | 实现方式（stable API / 现有资产） | 价值 | 成本 |
|---|---|---|---|---|
| E1 | **语义编辑器快照**：文件、可见行、选区（区分鼠标选中和键盘移动）、光标所在符号、是否有未保存改动、当前文件的错误数，只在你说话的那一轮附上，没变化时写"同上" | `activeTextEditor`、`onDidChangeTextEditorSelection`（带 `kind`）、`visibleRanges`、`executeDocumentSymbolProvider`；侧边栏已有编辑器跟踪（sidebar.ts:1892） | 极高："这段在干嘛""这里为什么报错"从此能听懂 | 低 |
| E2 | **你的编辑轨迹**：记录最近 N 次编辑（文件、行区间、所在符号、时间） | `onDidChangeTextDocument` 聚合成一段段连续输入 | 高：能做"接着我刚才的做"（Windsurf 最受欢迎的能力）和"我刚改的对吗" | 低 |
| E3 | **诊断**：`diagnostics` 工具，外加"保存后错误数增加且持续 2 s"这一观察 | `languages.getDiagnostics`、`onDidChangeDiagnostics` | 高：不读文件就知道哪里坏了，还能核对 worker 改完之后是否干净 | 低 |
| E4 | **你在终端跑的命令**：命令行、退出码、输出的最后几十行；失败时作为 error 级观察 | Shell Integration（1.93 起 stable）：`onDidEndTerminalShellExecution`、`read()` | 高：可以问"刚才那个报错什么意思"；你自己跑的测试挂了，它会知道 | 中（要剥 ANSI、限制缓冲） |
| E5 | **你未提交的改动**："帮我 review 一下我改的"；你和 worker 改了同一个文件时预警冲突 | `vscode.git` 的 `getAPI(1)`：`diffWithHEAD`、`workingTreeChanges` | 中高 | 低 |
| E6 | **调试上下文**：你停在哪一帧；因异常停下时主动说一句；"为什么是 null"就去读真实的变量值 | `debug.activeStackItem`、`customRequest('scopes'/'variables')`、`DebugAdapterTracker` | 高，但使用频率低 | 中 |
| E7 | **你在看哪种 tab**：diff、终端还是 webview | `window.tabGroups` | 中：在 diff 视图里问"这个改动"也能听懂 | 低 |
| E8 | **离开检测**：窗口长时间不活跃后回来，一次性用两三句简报 worker 的进展 | `window.state.active` | 中（JetBrains Recap：长时间离开后才有用，而且要短） | 低 |
| E9 | **用项目词汇提高识别率**：把可见范围的符号名、项目名、分支名作为 STT 的 `prompt` | `src/voice/stt.ts:139` 的 FormData 目前没带 `prompt`；OpenAI 兼容接口有这个字段，本地 8010 服务是否支持 [待验证] | 中高：标识符识别是语音编程公认的痛点 | 极低 |

### 3.2 手指：指给你看

| # | 点子 | 实现方式 | 价值 | 成本 |
|---|---|---|---|---|
| F1 | **高亮随朗读同步**：模型在回复里嵌入 `⟦ref:src/a.ts:40-52⟧` 这样的锚点，切句时剥掉，**播放到那一句时**高亮对应行，只在目标不在视口里时才滚动 | `createTextEditorDecorationType`、`revealRange`；`sentences.ts` 剥锚点；`voiceMode.ts` 已经在按句播放 | 极高：对应研究里的共享注视，"这里"才真正能用；可以不念路径 | 中 |
| F2 | **原地 peek**："这 3 个调用方"直接弹出内嵌窗口，不用切换文件 | `executeReferenceProvider` 加 `editor.action.peekLocations` | 高 | 低 |
| F3 | **diff 导览**：打开 worker 本轮的多文件 diff，逐处讲；你说"下一处"就跳到下一处 | `vscode.changes`；数据来自 `DiffManager.fileChanges`（要经由 `WorkerController` 暴露） | 高：让 B 模式真正成立 | 中 |
| F4 | **批注沉淀**：语音说完就没了，把 review 结论留成代码上的评论线程，你可以打字回复 | Comments API | 中：适合"我留了三处问题给你" | 中 |
| F5 | **跟随 worker**（参照 Zed）：worker 改到哪个文件，编辑器就跟到哪 | `showTextDocument`，设 `preserveFocus` 并在旁边打开 | 中，默认关闭 | 低 |
| F6 | **状态可见**：状态栏显示"🎙 正在看 stt.ts#transcribe"或"已转给 worker（排队中）" | 状态栏 | 中：研究发现，看得到 AI 在干什么，就不容易觉得被打扰 | 低 |

### 3.3 发言时机

| # | 点子 | 依据 |
|---|---|---|
| T1 | FloorArbiter 增加 `userTyping` 状态：连续输入时只允许 `needs_input` 和 `error` 插话，停手约 5 s 后才考虑别的 | Chen：停止打字 5 s；FlowLight：用键鼠活动估计可打断性 |
| T2 | **只在子任务边界开口**：保存、命令或测试结束（尤其失败）、worker 完成或出错、多行粘贴 | Codellaborator：子任务边界是效果最好的时机 |
| T3 | **不拿选区和注释当触发器**，你长时间不动也不算"卡住了" | Codellaborator：这些信号误报多；空闲时多半是在思考 |
| T4 | **被忽略就退避**：每被忽略一次，间隔翻倍，你主动开口后重置 | Codellaborator 的"忽略一次加 30 s"；Amershi 等人的指南 |
| T5 | **主动发言只说一句标题**："测试挂了两个，都在 stt 那边，要细说吗？" | Chen 的一句话摘要；NES 的一行预览 |
| T6 | **主动程度开关**：`off` / `errors-only` / `normal`，外加语音命令"安静会儿""可以说了" | Chen 的参与者要求可调；JetBrains 让用户显式开启 |
| T7 | **识别橡皮鸭模式**：长段独白、没有问句时不接话；判断你说完没有要看语义（比如结尾是"嗯……然后"就继续等） | Robot Duck 实验：机器人的倾听动作并不比一只静止的橡皮鸭有用；OpenAI `semantic_vad` 的 low eagerness 设置 |
| T8 | **判断你在"冲"还是在"探索"**：编辑集中在一个函数里时只报错；在文件间跳来跳去、问"怎么做比较好"时才给方案 | Grounded Copilot 的 acceleration / exploration 两种模式 |

### 3.4 手：动作（都要先决定是否放宽"语音不直接动手"这条非目标）

| # | 点子 | 性质 | 备注 |
|---|---|---|---|
| H1 | 在**你看得见的终端**里跑只读命令，比如测试，并读取结果 | 执行，不改文件 | `shellIntegration.executeCommand`；比 worker 在后台跑更透明 |
| H2 | 口述断点或 logpoint："count 大于 10 时停" | 改调试状态，不改文件 | `debug.addBreakpoints` |
| H3 | **幽灵文本**：你口述"这里加个空值检查"，代码以幽灵文本出现在光标处，按 Tab 才落地 | 你按 Tab 才算写入，控制权在你 | InlineCompletionItemProvider；只能出现在光标处，还要和 Copilot 一起被合并显示 |
| H4 | 口述选择 quick fix："用第二个修复" | 你确认后才应用 | `executeCodeActionProvider` |
| H5 | 口述提交信息，写进 SCM 输入框 | 只填输入框，不自动提交 | git API 的 `inputBox.value` |

### 3.5 不建议做

- **口述逐行写代码**（"第 12 行插入……"）：Copilot Voice 已经停了，交给 worker 更好。
- **用户空闲就主动帮忙**、**用户一选中代码就开口**：研究里误报率最高。
- **观察其他扩展的测试结果**：`testObserver` 是 proposed API，Marketplace 版本用不了。用 E4（终端）替代。
- **Live Share 多人结对**：`vsls` 包从 2022 年起就没更新，也没有获取对端光标的 API。

## 4. 场景剧本（设想中的效果）

**C. 一起查**
> 你用鼠标选中 `transcribe` 里的几行，问："这段为什么要自己编码 wav？"
> 它（快照里有选区和所在符号）："因为 STT 接口只收文件上传，⟦ref:src/voice/stt.ts:139-141⟧ 这里把 PCM 包成 wav 再塞进表单。"（朗读到这句时，139–141 行高亮）

**A. 你写，它看**
> 你改了半天 `echoFilter.ts`，保存。2 秒后诊断里多了一个错误。
> 它（error 级观察，一句话）："保存后多了一个类型错误，在 isEcho 里，要看吗？"
> 你："不用，我知道。" → 同类提醒的间隔加倍（退避）。

**B. worker 写，你看**
> worker 做完了。它："改了三个文件，我带你过一遍？" → 你："好。"
> 它打开多文件 diff，按顺序高亮，每处一两句。你说"下一处"就跳过去。说到有疑问的地方，它留一条评论线程。

**D. 调试**
> 断点停在一个异常上。它："停在 TypeError 上了，`session` 是 undefined，是上面 `switchSession` 没等它返回。"（变量值是通过 DAP 读出来的真实值）

## 5. 和现有架构怎么接

| 点子类型 | 接入点（详见 internal 调研 §2） |
|---|---|
| 每轮附带的上下文（E1、E2、E7） | 在 `TurnInput` 里加一个 `editor` 字段（voicePrompt.ts:53），在 `_userTurn` 里填入；每个 `VoiceContext` 记住上次发过的快照，没变化就写 `<editor unchanged/>` |
| 查询类工具（E3、E5、E6、F2、F3） | 在 `VOICE_HOST_TOOLS` 里加定义，`_run` 里加 case；用到 VS Code API 的，由 `VoiceAgentOptions` 注入函数（hostTools.ts 不导入 `vscode`） |
| 主动观察（E3、E4、E6、E8） | 给 `ObservationKind` 加类型，数据放进 `ArbiterView` 或 `TabWatch`；`ingest` 目前只收 worker 事件，需要一个新的入口方法 |
| 指点（F1） | 这是一种新的机制：`sentences.ts` 剥锚点 → 句子带上 ref 元数据 → `voiceMode.ts` 在播放那一句时回调 Highlighter。播放进度目前是估算的（handoff §7），高亮可能早或晚一句 |
| 发言时机（T1–T8） | 给 FloorArbiter 的 `next()` 增加输入：`userTyping`、`lastSubtaskBoundary`、`ignoredStreak` |

**要守住的约束**
- 每轮附件预算小于 1k token。编辑器片段不能照搬现在的 20k 字上限，快照控制在约 300 token 以内。
- 系统提示词要保持不变，这样才能命中缓存。
- 主动轮次里目前只能调用 `worker_status`。只读的新工具（`diagnostics`、`show_code`）应该加进白名单。
- 端到端延迟现在是 2.2–2.8 s。LSP 查询只花几十毫秒，快照不会明显拖慢。

## 6. 建议的第一刀

价值最高、成本最低、也最能验证"结对"感觉的组合是：**E1 快照 + F1 同步高亮 + E3 诊断 + E9 STT 词汇提示 + T1 打字时不插话。**

做完就能验收 C 模式："选中代码问'这段在干嘛'，它听得懂，并且边说边指给你看。"这一步不涉及任何越权动作，也不增加主动打扰。

第二刀：F3 diff 导览（补上 B 模式）+ E2 编辑轨迹 + E4 终端观察 + T2/T4/T5 发言时机。
第三刀：E6 调试、F4 批注、H 系列动作（需要先定下 §7 的问题）。

## 7. 需要你拍板的问题

1. **主场景是哪个？** 你自己写、它在旁边看（A）；还是主要让 worker 写、它给你讲（B）？这决定第二刀先做什么。
2. **要不要放宽"语音不直接动手"？** H1（在可见终端跑测试）、H2（断点）、H3（幽灵文本）都不绕过你的控制，但都突破了设计文档 §1.2 的非目标。
3. **主动程度默认值**：建议默认 `errors-only`，也就是只在出错或 worker 需要你回答时开口。
4. **实际使用环境**：戴耳机还是外放？外放时插嘴误判的风险更大（handoff §8 第 1 项还没做真人测试），会影响要不要加"说话时按住键"这种兜底。
5. **高亮会不会打扰？** 同步高亮默认不移动视口，只在目标不在屏幕上时滚动。你能接受它帮你滚动或打开文件吗？还是只在你说"带我去"时才动？

## 8. 竞品盘点（2026-09-25 核对）

结论：**目前没有产品同时做到这五点**：知道你在编辑器里看哪、全双工语音、在合适的时机主动开口、指挥另一个 coding agent 干活、把代码指回给你看。下面每一家都只覆盖其中一两点。

| 产品 | 做到了什么 | 缺什么 | 来源 |
|---|---|---|---|
| **ChatGPT macOS "Work with Apps" + Advanced Voice** | 最接近"一起查"。通过 VS Code 扩展读取当前窗格的最后 200 行，以及你的选区；支持语音对话 | 只能在 macOS 上用；语音模式下不能改代码；只在你发消息时抓一次快照，不会主动开口；不能把代码指给你看；没有 worker | [OpenAI Help](https://help.openai.com/en/articles/10119604-work-with-apps-on-macos) |
| **VS Code Voice Mode**（1.137 起，实验性） | 全双工，能插嘴；能把请求转给 Copilot 的 agent 会话，并说出转给了谁 | 需要个人版 Copilot 计划；文档只说它会使用"会话已选的模型和附加的文件"，没提光标或选区；不会主动评论你的编辑；没有扩展 API | [Voice docs](https://code.visualstudio.com/docs/configure/accessibility/voice) |
| **PlagueHO/agent-voice**（开源，11 星） | 架构和我们相同：语音"经理 agent"（Azure GPT-Realtime）指挥 Copilot agent | 定位是做规划、写规格、建 issue，不做编辑器感知和结对；依赖 Azure 和 Copilot | [GitHub](https://github.com/PlagueHO/agent-voice) |
| **VOQR**（Marketplace，161 次安装） | 给 VS Code 里任何支持 LM API 的聊天加上本地 Whisper + Kokoro 语音环路，逐句朗读 | 只是语音输入输出层，不感知编辑器，不主动开口，不指挥 agent | [Marketplace](https://marketplace.visualstudio.com/items?itemName=intergen.voqr)、[GitHub](https://github.com/InterGenJLU/voqr-public) |
| **Vocode**（Marketplace，10 次安装） | 口述改代码，用 AST 结构化编辑，并用 LSP 符号定位 | 属于"用语音写代码"这一路，不做对话式结对 | [GitHub](https://github.com/Spencer1O1/vocode) |
| **Gemini Live / AI Studio 屏幕共享** | 看得到屏幕像素，能语音讨论 | 不接入 IDE，不知道文件、行号和符号，不能指回代码，也不能驱动 agent | [INFERENCE，未读一手文档] |
| 只做听写：Cline Dictation、Claude Code `/voice`、Cursor Voice、Aider `/voice`、Wispr Flow、Superwhisper | 把语音转成文字塞进输入框 | 不朗读，不对话 | 见 prior-art 调研 A5–A7 |
| 命令式语音编程：Serenade、Talon/Cursorless | 用语音精确操作代码 | 学习成本高，主要是无障碍用户在用；Copilot Voice 走这条路，已经停了 | 见 prior-art 调研 A1–A3 |

**我们的差异点**：
1. 感知编辑器状态，而且覆盖选区、诊断、终端等多种信号，不只是发消息时抓一次快照；
2. 高亮随朗读同步，把代码指给你看；
3. 有克制的主动发言；
4. 语音层和 worker 分离，而且 worker 的后端可以换（pi 或 omp），不绑定 Copilot；
5. STT 和 TTS 全部在本地。

**风险**：微软把 Voice Mode 加上编辑器感知的门槛很低，因为它本来就在 VS Code 内部。我们的护城河在第 2、3、4 点，第 1 点不算。
