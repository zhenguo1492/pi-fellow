# 语音 / AI 结对编程先例调研（Prior Art Survey）

调研日期：2026-09-25。目的：为 `src/voiceAgent/` 从“能听会说的派活助手”升级为“知道用户在看什么、在改什么的语音结对搭档”提供依据。对照本仓库设计文档：FloorArbiter（`docs/voice-agent-design.md:373-404`）、EditorWatcher（`:406-411`）、输入分层与每轮 prompt 格式（`:527-578`）。

约定：每条给出 **是什么 / 用了哪些信号 / 教训 / 来源**。只在一手来源（厂商文档、厂商博客、论文原文或摘要）里核实过的内容直接陈述；没核实到一手来源的标 **[UNVERIFIED]**。

---

## A. 语音编程工具

### A1. Serenade
- **是什么**：自然语言式语音编程工具，命令形如 `action + selector`：`add function hello`、`change parameter to number`、`copy lines five to ten`，可以连说（`save focus terminal`）。`add` 会按语法结构把光标移到合适位置，`insert` 在光标处插入。
- **信号**：语音 + 当前文件的语法结构（selector 是 `function`、`class`、`parameter` 等代码结构）+ 作用域内已有标识符。说 `insert foo bar`，如果作用域里有 `foo_bar`，会自动格式化成 `foo_bar`。
- **识别纠错**：拿不准时列出几个候选转写，默认用第一个；说数字（“two”）换成第二个并撤销第一个，说 `undo` 全部撤销。
- **现状**：GitHub 仓库 `serenadeai/serenade` 未归档，最后一次 push 是 2024-06-11（GitHub API 实测）。公司是否仍在运营 [UNVERIFIED]。
- **教训**：用**代码结构**当指代对象（“下一个函数”“第二个参数”）比用行号更适合语音；用**作用域内的符号**纠正转写，是解决标识符识别难题的有效手段；多候选加“说编号改选”的纠错方式成本很低。
- **来源**：https://serenade.ai/docs/ ；https://github.com/serenadeai/serenade

### A2. Talon Voice / Cursorless
- **是什么**：Talon 是通用免手输入平台，提供命令与听写两种模式、眼动控制鼠标（“Mouse by just looking”）、口腔噪音控制（“Pop to click, hiss to scroll”）和 `.talon` 自定义命令。Cursorless 是基于 Talon 的 VS Code 扩展，每条命令由 action 和 target 组成，例如 `"chuck bat"`：删除头上带 `b` 帽子标记的那个 token。
- **信号**：语音、眼动、噪音；Cursorless 还依赖编辑器里可见的帽子（hat）标记。
- **教训**：Cursorless 的 hat 是一种**可见的指代锚点**：系统先把可以指代的东西标出来，用户再用一个音节指过去。这是“看这里”问题在纯语音条件下最成熟的解法，但学习成本高，主要用户是重度或无障碍用户。
- **来源**：https://talonvoice.com/ ；https://www.cursorless.org/docs/

### A3. GitHub Copilot Voice（原 “Hey, GitHub!”）——已停止
- **是什么**：GitHub Next 的技术预览，功能包括用自然语言写/改代码（“不喜欢就用大白话要求修改”）、代码导航（`go to line 34`、`go to method X`、`go to next block`）、控制 IDE（“toggle zen mode”“run the program”）、代码解释（“explain lines 3-10”）。
- **信号**：语音 + 当前文件 + 行号 / 方法名。
- **结局**：官方原文：“We concluded the technical preview of GitHub Copilot Voice on April 3, 2024. We have transferred all the learning and feedback … to VS Code Speech extension.”
- **教训**：以“用语音替代键盘去写和导航代码”为卖点的产品没有独立存活下来，经验被并入通用的语音输入和语音对话能力。停止的具体原因官方没有说明 [UNVERIFIED]。可以推断 [INFERENCE]：对多数开发者来说，语音的价值在于表达意图和讨论，逐行操作代码并不划算；这一点和 C 节的研究一致。
- **来源**：https://githubnext.com/projects/copilot-voice/ （页面正文，2024 年存档与现页一致）

### A4. VS Code 内置语音（Voice Mode + 听写）与 VS Code Speech 扩展
- **是什么（2026 现状）**：
  - **Voice Mode**：与 agent 进行免手的语音对话，会朗读回复并继续听后续请求。请求发往当前 chat / agent 会话；也可以问正在运行的会话，或让它新开会话，并且会**播报它把请求转给了已有会话还是开了新会话**。
  - `agents.voice.handsFree`：agent 说完后自动重新开始听。agent 说话时，用户开口或按 `⇧⌘Space` 就能打断（barge-in）。
  - 可以只静音麦克风而不结束会话（`⇧⌘M`），可以显示转写（`agents.voice.showTranscript`），可以关闭朗读只看文字（`agents.voice.speakResponses`）。
  - **听写**：桌面端默认用本地模型（`nemotron-3.5-asr-streaming-0.6b`），可在 chat、编辑器、终端里听写；按住快捷键即 push-to-talk。终端听写会去掉普通标点、把读出的符号名转成符号；可选用 LLM 清理转写（`dictation.experimental.llmCleanup`），并支持 `~/.copilot/dictation.md` / `.github/dictation.md` 写术语说明。
  - **VS Code Speech 扩展**：给不支持内置听写的平台用，提供语音聊天、朗读和 “Hey Code” 唤醒词。
- **信号**：语音 + 当前 chat / agent 会话及其附加文件。文档**没有说** Voice Mode 会读取光标、选区等编辑器状态。
- **教训**：
  1. 语音层做成“路由器 + 会话观察者”，并**大声说出路由决定**，和我们“语音附着在任务上”的设计（§5.12）一致。
  2. 静音和结束会话是两件事。
  3. 纠错的重点放在术语词表上。
- **版本**：1.137 以 “Voice Mode (Experimental)” 首发（release notes：“Talk with an agent and interrupt or redirect it while it works on your code”；“aware of your active session and can answer questions about running sessions, the selected model, and attached files”）。1.138 加入 “Improved Voice Mode session awareness”：能查找近期会话、按 label 切换会话、报告各会话状态。同伴 `VsCodeApiSurvey` 的结论是：扩展 API 不开放 Voice Mode，只有 proposed 的 `speech` provider。本调研未独立核实这一点。
- **来源**：https://code.visualstudio.com/docs/configure/accessibility/voice ；https://code.visualstudio.com/updates/v1_137#_voice-mode-experimental ；https://code.visualstudio.com/updates/v1_138 ；https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-speech

### A5. Claude Code `/voice`（语音听写）
- **是什么**：只做听写，不朗读。转写实时进入 prompt 输入框，可以和键盘输入混用。
  - hold 模式（默认按住 `Space`）：松开后插入转写，等用户按 Enter；设 `autoSubmit` 后自动发送，前提是转写**不少于 3 个词**。
  - tap 模式：按一下开始，再按一下发送，同样要求至少 3 个词；静音 15 s 或录满 2 min 自动停止。
  - `Esc` / `Ctrl+C` 取消录音，丢弃转写，**把输入框恢复成录音前的样子**。
  - 也可以对 agent view 里的后台会话听写。
- **信号**：语音 + **识别提示词**：“your current project name and git branch name are added as recognition hints automatically”，并针对 `regex`、`OAuth`、`JSON` 等编程词汇做了优化。
- **教训**：
  1. 用项目上下文给 STT 做 biasing 成本低、见效快。
  2. “至少 3 个词才自动提交”是防误触的简单阈值。
  3. 取消必须能完整回滚。
  4. Anthropic 自家的 CLI 只做了输入侧，没有做双向语音对话。
- **来源**：https://code.claude.com/docs/en/voice-dictation

### A6. Cursor 2.0 Voice Mode
- **是什么**：changelog 原文：“Control Agent with your voice using built-in speech-to-text conversion. You can also define custom submit keywords in settings to trigger the agent to begin running.”
- **信号**：语音转文字，送进 Agent 输入框。
- **教训**：同样只做输入侧；“口令提交词”是免手场景下的轮次结束信号。第三方评价说它只作用于 Agent 输入框 [UNVERIFIED]。
- **来源**：https://cursor.com/changelog/2-0

### A7. Aider `/voice`
- **是什么**：在聊天里输入 `/voice` 开始录音，按 `ENTER` 结束，转写结果“as if you had typed them”，然后正常走 aider 的改代码流程。
- **信号**：语音 + 已加入 chat 的文件。
- **教训**：最朴素的做法（语音只是另一种键盘）本身就可用，但没有任何双工交互、打断和主动发言。
- **来源**：https://aider.chat/docs/usage/voice.html

### A8. OpenAI Realtime API / GPT‑Live‑1（接 Codex）
- **是什么**：
  - Realtime API 的轮次检测有两种。`server_vad` 按静音切分。`semantic_vad` 根据用户说的内容判断话是否说完，`eagerness` 可设 `low` / `medium` / `high` / `auto`：`low` 让用户慢慢说，`high` 更积极地接话。`interrupt_response` 控制用户开口时是否打断正在进行的回复。
  - GPT‑Live‑1 是全双工模型（边听边说），能把推理和工具调用**委派给后端模型**，官方示例直接把对话上下文交给 `@openai/codex-sdk` 的 thread。官方称它能更好地处理静音和背景噪音，“without interrupting the conversation or narrating every step out loud”。
  - 客户 Speak 的评估：在用户**思考停顿**时，它的打断次数比之前的轮次式系统减少近 80%。
- **信号**：音频流（语义层面的结束判定、附和语 backchannel、背景人声）+ 后端 agent 的结果。
- **教训**：
  1. 架构上和我们的“语音层 + worker”同构（语音模型负责对话节奏，后端 coding agent 负责干活）。
  2. 判断用户是否说完要看语义，不能只数静音时长。编程讨论中停顿很多，应该偏向 low eagerness。
  3. 官方明确把“不要把每一步都念出来”当作卖点。
- **来源**：https://platform.openai.com/docs/guides/realtime-vad ；https://openai.com/index/introducing-gpt-live-1-in-the-api/

---

## B. 感知用户 IDE 活动的 AI 工具

| 产品 | 已核实的信号 | 呈现方式 | 关键教训 |
|---|---|---|---|
| Windsurf Cascade | “aware of your real-time actions”；手动改代码后说 “continue my work” 即可接续 | agent 面板 | 用户的近期操作可以替代 prompt 里的上下文说明 |
| Copilot NES（含 long-distance） | 近期编辑历史 + 光标上下文；单独的 location model 预测“去哪里改” | 光标附近的紧凑预览小窗 | 学会“何时不跳”和学会“跳到哪”同样重要 |
| Cursor Tab（online RL） | 接受 / 拒绝作为奖励信号 | 行内 | 少打扰、高命中：建议数 −21%，接受率 +28% |
| JetBrains NES / Recap / Insights | 近期编辑（NES）；近期活动（Recap） | 行内 / 独立工具窗 | 主动功能单独做成插件，由用户显式开启 |
| Zed Follow the Agent | agent 读写到哪个文件 | 编辑器跟着 agent 跳转 | 让用户看到 agent 在看哪里 |
| Continue | 光标前后文、LSP 定义、导入的符号、最近打开 / 编辑的文件 | 自动补全 | 以光标为中心，按需补充结构化上下文 |

### B1. Windsurf Cascade — “Real-time collaboration”
- **原文**：“A unique capability of Cascade is that it is aware of your real-time actions. You no longer necessarily need to prompt with context on your prior actions … Try making a manual change in the code editor, and then prompt Cascade to 'continue my work'!”
- **信号**：官方文档没有列出具体信号。第三方文章说包括终端输出、剪贴板（需开启）、打开的标签页等 [UNVERIFIED]。
- **现状**：文档现在托管在 Cognition（docs.devin.ai）下；JetBrains 版 Cascade 插件标注为 “being deprecated … maintenance mode”，推荐改用 Devin over ACP。
- **教训**：“接着我刚才的做”是用户感知最强的一类能力：模型需要知道**用户刚改了什么**（编辑 diff），而不只是用户在看什么。
- **来源**：https://docs.devin.ai/windsurf/plugins/cascade/cascade-overview

### B2. GitHub Copilot Next Edit Suggestions（NES）与 long-distance NES
- **信号**：近期编辑历史 + 光标上下文。long-distance NES 训练了**专门的 location model** 预测下一处编辑的位置。评测**同时考核 jump 和 no-jump 的准确率**：“A model that jumps too often can be just as disruptive as one that misses important transitions. Imagine getting a jump suggestion every time you're halfway through typing a variable name.”
- **实践中的问题**：内部试用发现模型 “too eager to jump”，根源是训练数据里 no-jump 样本太少；补足“停在原地”的样本（例如标识符只打了一半）后改善。A/B 测试中，经 NES 写出的代码增加 23%，但远处的建议被拒绝得更多。之后又用 RLVR 惩罚“不必要或时机不对的跳转”。
- **UI**：不渲染完整 diff，只在光标附近的空白处放一个紧凑小窗，里面是**一行摘录**，“just enough context to judge relevance”。不感兴趣就直接接着写。
- **教训**：主动性的首要目标是克制；预览要够用户在一眼之内做出判断；“这是个信任问题，不只是可发现性问题”。
- **来源**：https://code.visualstudio.com/blogs/2026/02/26/long-distance-nes

### B3. Cursor Tab（online RL）
- **原文**：“If the accept rate is low, it means we're showing too many incorrect suggestions, which is distracting and disrupts the flow of coding.” 新模型 “makes 21% fewer suggestions … while having a 28% higher accept rate”。
- **教训**：用接受 / 忽略率来调主动频率。但 Mozannar 等人（C3）警告，单纯最大化接受率可能让建议质量下降。
- **来源**：https://cursor.com/blog/tab-rl

### B4. JetBrains AI：NES、Recap、Insights
- **NES**：“When you make a change, the model receives a prompt with your recent edits”；靠近光标的建议立即显示，并能结合 IDE 原生的 Rename 重构。
- **Recap / Insights（实验插件，2026-03）**：
  - Recap 是对近期活动的“previously on…”式摘要，放在独立工具窗里，“stays out of your way until you call it”。
  - Insights 只标注**确实晦涩**的代码（“selective by design”）。
  - 为什么单独做插件：“An incorrect instance of code completion costs you a keystroke. An unwanted feature in your editor depletes your focus and trust.” 所以要求用户**显式开启**。
  - 早期用户反馈：Recap 在**长时间离开、跨项目切换**时最有用，短暂中断时用处不大，并希望摘要更短。
- **教训**：主动功能要让用户选择开启；“回来后的简报”应在长时间离开后才触发，并且要短。
- **来源**：https://blog.jetbrains.com/ai/2025/08/introducing-next-edit-suggestions-in-jetbrains-ai-assistant/ ；https://blog.jetbrains.com/ai/2026/03/experimental-ai-features-for-jetbrains-ides-recap-and-insights/

### B5. Zed — Following the Agent
- **原文**：“Follow the agent as it reads and edits files … Your editor will jump to each file the agent touches.” 按住 `cmd` / `ctrl` 提交消息时自动开启跟随。
- **教训**：Zed 反向解决了指代问题：用户不用问 agent 在看哪里，直接跟着看。它是可选的，因为跟随会抢走用户的编辑器。
- **来源**：https://zed.dev/docs/ai/agent-panel

### B6. Continue（autocomplete 的上下文选择）
- **信号**：以光标为中心，加上 LSP 的 go-to-definition（写函数调用时带上它的定义）、光标附近符号对应的 import、“recently opened or edited files”中相关的片段。
- **教训**：编辑器快照不要只给“当前可见行”，还应该带光标所在符号的定义和最近编辑过的文件。这些都能通过 VS Code 的 LSP 命令拿到。
- **来源**：https://docs.continue.dev/ide-extensions/autocomplete/context-selection

---

## C. HCI 研究

### C1. Chen et al., “Need Help? Designing Proactive AI Assistants for Programming”, CHI 2025（arXiv:2410.04596）
- **作者**：Valerie Chen, Alan Zhu, Sebastian Zhao, Hussein Mozannar, David Sontag, Ameet Talwalkar。DOI 10.1145/3706598.3714002。
- **设计**：在 chat 里主动推送建议。输入是当前代码、聊天历史，可选终端输出。每条建议先只显示**一句摘要**（以类型开头，如 bug fix），可展开看实现，可以 preview 成 diff 再接受。
- **时机规则**：
  - 用户在打字、和建议交互、等回复时不请求建议；停止打字 **5 s** 后计时恢复。
  - 用户空闲时 5 s 后出建议，两次建议之间至少隔 **20 s**。
  - 如果建议还没显示出来用户就又开始写代码，这条建议作废。
  - **运行出错时立即给调试建议**。
- **结果**（N=65）：主动组完成的任务数多 12–18%。90% / 80% 的参与者更喜欢两种主动版本；但 **Persistent** 版本（等待从 20 s 缩到 5 s，每次 5 条建议）只有 47% 的人喜欢，评价是 “distracting”“annoying”，而且建议被复制的次数反而更少。
- **参与者提出的新设计考量**：让用户决定什么时候要主动帮助（开关、频率）。显式的接受 / 删除按钮“unnecessary / distracts me”，作者建议改为**从用户行为隐式获取反馈**。
- **来源**：https://arxiv.org/abs/2410.04596 （全文 https://arxiv.org/html/2410.04596v2 §4.3、§6.2、§7.1）

### C2. Pu et al., “Assistance or Disruption? … Proactive AI Programming Support”, CHI 2025（arXiv:2502.18658）
- **作者**：Kevin Pu, Daniel Lazaro, Ian Arawjo, Haijun Xia, Ziang Xiao, Tovi Grossman, Yan Chen。DOI 10.1145/3706598.3713357。
- **设计（Codellaborator）**：对比三种条件（PromptOnly / CodeGhost / Codellaborator）。时机依据中断管理理论：
  1. 在低心理负荷时介入：以“空闲”为代理信号，阈值 **30 s**，用户忽略一次就**加 30 s**。
  2. 在子任务边界介入：写完一个代码块（Python 反缩进）、运行代码、多行编辑 / 粘贴。
  3. 在用户给出隐式信号时介入：写注释、选中代码。
- **Presence**：AI 有自己的光标和 caret，显示 “Thinking…” 气泡；AI 写入的代码紫色高亮 5 s 后淡出（provenance）。还有锚定在具体代码行上的局部对话线程（breakouts）。
- **用户优先**：用户开始和 agent 对话时，取消 agent 所有待执行的动作和 API 请求。
- **结果**（N=18，1004 个交互片段，398 次主动介入）：
  - 53.3% 引起有效参与，12.1% 构成打扰，34.7% 被忽略。
  - **子任务边界是最有效的时机原则**（多行改动 73.1%、写注释 69.2%、运行程序 66.7% 引发参与）。
  - 但每写完一个代码块就介入，导致大量“确认式”的废话，约一半被忽略。
  - **注释和选区作为隐式信号误报多**：“I don't see [comments] necessarily as instructions”；很多人选中代码只是为了帮自己集中注意力。
  - 用户长时间不动时，往往是**在思考（负荷高）**，不一定是卡住了。
  - 没有 presence 的 CodeGhost 让人觉得“混乱”“突然”；加了 presence 和局部上下文后打扰更少，**感觉更像和伙伴协作，而不是在用工具**。
  - 代价是控制感、代码归属感和理解程度下降。
- **来源**：https://arxiv.org/abs/2502.18658 （全文 https://arxiv.org/html/2502.18658v4 §4.1、§6.1–6.2）

### C3. Mozannar et al.：CUPS（CHI 2024）与 “When to Show a Suggestion?”（CDHF）
- **CUPS**（arXiv:2210.14306）：21 名程序员给自己使用 Copilot 的录像打标签，得到 12 种状态的分类，揭示了验证建议的时间成本等低效之处。
- **CDHF**（arXiv:2306.04930）：用 535 名程序员的数据，按“被接受的概率”决定显示还是隐藏建议，能挡掉大量本会被拒的建议。三个关键发现：
  1. 程序员**不可观测的潜在状态**对显示决策很重要。
  2. 单纯以接受率为奖励会**降低建议质量**。
  3. 判断框架是效用理论：比较显示的收益和被打断的成本。
- **来源**：https://arxiv.org/abs/2210.14306 ；https://arxiv.org/abs/2306.04930

### C4. Barke, James, Polikarpova, “Grounded Copilot”（arXiv:2206.15000；OOPSLA 2023）
- **核心**：交互分两种模式。**acceleration**：知道要写什么，让工具帮着写得更快。**exploration**：不知道怎么做，用工具探索各种方案。
- **acceleration 下的发现**：长的多行建议会打断心流（“Oh God, no. Absolutely not”）。用户想要的建议**只覆盖当前这一个逻辑单元**。有人因为总被打扰而关掉了 Copilot。
- **exploration 下的发现**：用户愿意写注释当 prompt，愿意翻看多个候选。
- **建议**：工具应当感知当前模式并据此调整行为。
- **来源**：https://arxiv.org/abs/2206.15000

### C5. Ma, Wu, Koedinger, “Is AI the better programming partner? Human-Human Pair Programming vs. Human-AI pAIr Programming”（arXiv:2306.05153, 2023）
- **核心**：两种结对的效果在文献中都有好有坏。影响人-人结对成败的因素包括任务复杂度、**水平是否匹配**、沟通、**过度依赖与角色轮换**。
- **关于角色**：有人主张让 Copilot 当 driver、人当 navigator，但实际上人仍然需要频繁回到 driver 的位置。人-人结对中定期轮换角色，可以减轻 driver 的负荷并保证双方都投入。
- **来源**：https://arxiv.org/abs/2306.05153

### C6. Kuttal, Ong, Kwasny, Robe（CHI 2021）与 Robe & Kuttal “Designing PairBuddy”（TOCHI 2022）
- **CHI 2021**（DOI 10.1145/3411764.3445659）：18 人人-人结对对比 14 人 Wizard-of-Oz 人-agent 结对，**生产率、代码质量、自我效能没有显著差异**。agent 能促进知识传递，但 “agents were unable to provide logical explanations or discussions”。人类伙伴 “trusted and showed humility towards agents”。
- **PairBuddy**（DOI 10.1145/3498326）：
  - 作为 navigator 时发挥软技能（adaptability、motivation、social presence），提升了用户的信心和信任。
  - 作为 driver 时发挥技术能力（代码贡献、just-in-time feedback、创造力支持），帮助用户实现**他们自己的**方案。
  - 目标是 “an Alexa-like programming partner”。
- **教训**：语音结对伙伴的价值一半在社交层面（在场、鼓励、跟上节奏）。用户容易过度信任 agent，所以 agent 必须能讲出理由。
- **来源**：https://doi.org/10.1145/3411764.3445659 ；https://doi.org/10.1145/3498326 （摘要经 OpenAlex 核对）

### C7. 中断与可打断性
- **Iqbal & Bailey, CHI 2006**（DOI 10.1145/1124772.1124882）：以恢复延迟（resumption lag）衡量，**任务结构（在不在子任务边界）**能较准确地预测中断成本。
- **Züger et al., FlowLight, CHI 2017**（DOI 10.1145/3025453.3025662）：只根据键盘和鼠标的交互数据自动估计可打断性，在 449 人、12 国的现场部署中把被打断次数降低了 46%。
- **Parnin & Rugaber 2010/2011**（Software Quality Journal, DOI 10.1007/s11219-010-9104-9）：被打断后重建上下文要付出恢复延迟。这里据 C2 的引用转述；原文具体数字未核实 [UNVERIFIED]。
- **Horvitz, CHI 1999**（DOI 10.1145/302979.303030）：mixed-initiative 原则，包括按不确定性决定是否行动、用对话消解不确定性、考虑用户注意力和时机等。
- **Amershi et al., CHI 2019**（DOI 10.1145/3290605.3300233）：18 条 human-AI 交互指南，其中包括 time services based on context、support efficient dismissal、scope services when in doubt、learn from user behavior、provide global controls。条目名称凭记忆列出，未逐条核对原文 [UNVERIFIED]。
- **教训**：可打断性可以从编辑器事件里低成本地估计；**子任务边界**是最便宜也最有效的时机。

### C8. 共享注视与指代：D'Angelo & Begel, CHI 2017
- **是什么**：远程结对时显示对方在看哪段代码，双方看同一处时变色。
- **结果**：共同注视的时间比例更高；**隐式指代（“这里”）相对显式描述的比例上升**，回应指代也更快、更准。
- **教训**：只要双方知道彼此的焦点，“这里 / 这个”就能工作。我们的 EditorWatcher 相当于给 agent 装上了“注视”；**反方向也要做**：agent 说到某段代码时要在编辑器里显示出来。
- **来源**：https://www.microsoft.com/en-us/research/publication/improving-communication-pair-programmers-using-shared-gaze-awareness/ （DOI 10.1145/3025453.3025573）

### C9. 语音编程与无障碍研究
- **Rosenblatt et al., W4A 2018 — VocalIDE**（DOI 10.1145/3192714.3192821）：先做 Wizard-of-Oz 形成性研究，再做原型，提供 Context Color Editing 等功能。8 名上肢运动障碍参与者在**导航编辑和选中文本**上明显改善。
- **Paudyal et al., DIS 2020 — Voiceye**（DOI 10.1145/3357236.3395553）：语音 + 注视 + 机械开关的多模态写代码，29 名非残障参与者和 5 名残障参与者都能完成任务。
- **Nowrin & Vertanen, CUI 2023**（DOI 10.1145/3571884.3597130）：专家念代码更接近自然语言，新手更按语法逐字念。商用识别器在口述代码上错误率高，用口述代码语料适配语言模型后，错误率相对降低 27%。
- **Creed & Sarcar 2024**（DOI 10.1108/jet-02-2024-0021）：资深语音编程者需要多模态方式、单音节命令、命令串联、直观导航和自定义命令。
- **教训**：语音适合表达意图，不适合逐字输入语法；识别需要代码领域的偏置；要让语音和键盘、眼睛协同工作，不要试图取代它们。

### C10. 出声思考 / 橡皮鸭
- **Parreira, Gillet, Leite, “Robot Duck Debugging”（arXiv:2301.06511, 2023）**：101 人的被试间实验。机器人的两种倾听行为（规则式、深度学习式）在任务表现和主观感受上，都**没有比一只不会动的橡皮鸭更好**。
- **教训**：出声思考的收益主要来自说的人自己。用户在自言自语地推演时，语音伙伴应该**保持安静**，不要抢话；附和也不一定有帮助。
- **来源**：https://arxiv.org/abs/2301.06511

### C11. 可用性总体：Vaithilingam et al. CHI EA 2022；Liang, Yang, Myers ICSE 2024
- **Vaithilingam et al. 2022**：Copilot 不一定缩短完成时间，但用户喜欢它提供的起点。问题在于**理解、编辑、调试生成代码很难**。
- **Liang et al. 2024**（410 名开发者）：不用这类工具的主因是输出不满足需求、**难以控制**。作者建议设计认知成本极低的交互，减少分心。
- **来源**：https://doi.org/10.1145/3491101.3519665 ；https://doi.org/10.1145/3597503.3608128

---

## D. 我们的语音结对搭档：设计要点

以下每条都对应到上面的来源，以及本仓库设计文档里要改的位置。

1. **默认沉默，宁可少说也不说错。** 主动发言首先追求命中率，其次才是覆盖面。FloorArbiter 的 `<silent/>` 出口（`docs/voice-agent-design.md:384-391`）保持为默认选项，并且统计每次主动发言之后用户是接话、忽略还是打断，据此调频率。依据：Cursor Tab 建议数 −21%、接受率 +28%（B3）；NES 专门训练 no-jump（B2）；Chen 的 Persistent 版本偏好率从 90% 降到 47%（C1）。但不要只优化接话率（CDHF 的陷阱，C3）。

2. **在子任务边界发言，不在用户打字时发言。** 可以触发主动轮次的时机：保存、运行或测试结束（尤其是失败）、worker `done` / `error`、多行粘贴、光标离开刚改完的函数。用户正在连续编辑时（`onDidChangeTextDocument` 的频率高）只允许 `needs_input` / `error` 插话；停止打字后至少等约 5 s。给 FloorArbiter 增加 `userTyping` 状态，数据来自 EditorWatcher。依据：Codellaborator 发现子任务边界最有效（C2）；Chen 的规则“打字停止后 5 s，出错立即”（C1）；Iqbal & Bailey 关于任务结构的结论、FlowLight 用键鼠活动估计可打断性（C7）。

3. **用户长时间不动 ≠ 需要帮助；被忽略就退避。** 空闲触发阈值从 30 s 起步，每被忽略一次就加长；进展播报每被忽略一次，也把 `minProactiveGapSecs` 加倍，直到用户再次主动说话才重置。依据：Codellaborator 发现空闲多半是在思考，采用 30 s 起步、忽略一次加 30 s（C2）；Chen DC4 与 Amershi 的 learn from user behavior（C1、C7）。

4. **先说一句话的标题，细节等用户要。** 主动发言限制为一句：“测试挂了两个，都在 stt 那边，要我细说吗？”。详情留到用户追问，或者在面板里显示。依据：Chen 的“一句摘要 + 可展开”（C1）；NES 只放一行摘录（B2）；GPT‑Live 强调不把每一步都念出来（A8）。

5. **按 acceleration / exploration 两种模式调整行为。** 用编辑器信号估计当前模式：编辑集中在同一个符号内、输入连续，判为 acceleration，此时只报错误和阻塞；在文件间跳转、在同一段代码上长时间停留、语音里出现“要不要 / 怎么做比较好”，判为 exploration，此时可以提方案、给两三个选项。依据：Barke 的双模式和“长建议打断心流”（C4）；Chen 的时机规则就是按这两种模式设计的（C1）。

6. **“这里”解析：选区 > 光标所在符号 > 可见范围 > 最近编辑；选区和注释只作上下文，不作触发器。** EditorWatcher（`:406-411`）的快照里补充三样东西：光标所在的 `DocumentSymbol`（函数名和范围），最近 N 次编辑的环形缓冲（文件、行区间、时间），以及当前诊断。只有用户开口时才把这些附进轮次（`:559-578`）。选区和注释变化**不触发**主动轮次。指代有歧义时追问一次，不要猜。依据：Continue 以光标为中心加 LSP 定义和最近编辑（B6）；Windsurf 的 “continue my work” 依赖最近编辑（B1）；Codellaborator 发现注释和选区误报多（C2）；Horvitz 主张用对话消解不确定性（C7）。

7. **反向指代：agent 提到代码时，在编辑器里指给用户看，不要念路径。** 说到某段代码时调用 `revealRange` 并加一个淡出的高亮（参照 Codellaborator 的 5 s 紫色高亮），用户只听到“就是我高亮的这段”。另外提供可选的“跟随 worker”，编辑器随 worker 改到哪个文件就跳到哪里，默认关闭。依据：共享注视让隐式指代更多也更快（C8）；Zed 的 Follow the Agent（B5）；Codellaborator 的 presence 和 provenance 高亮减少了打扰（C2）；Cursorless 用可见锚点指代（A2）。

8. **让 agent 的状态可见：它在听、在想、在看哪、把话转给了谁。** 语音面板上常驻状态行，例如“正在读 stt.ts 120–180”“已把指令转给 worker（排队中）”。路由决定要说出来，参照 VS Code Voice Mode 播报“交给已有会话还是新开会话”。依据：没有 presence 的 CodeGhost 让人觉得混乱（C2）；VS Code Voice Mode（A4）。

9. **用户永远优先；判断用户是否说完要看语义，并容忍思考停顿。** 保持 §5.9 规则 1：用户一开口就 `cancelTurn`，同时取消所有待发的主动轮次。`turnStopSecs` 之外再加语义层面的完成判断，例如句末是“嗯…然后”这类未完成的语气时继续等。用户在出声推演（长段独白、没有问句）时不插话、不附和。依据：Realtime `semantic_vad` 的 `eagerness=low` 与 Speak 在思考停顿中打断减少约 80%（A8）；Codellaborator 在用户发起时取消 agent 的待执行动作（C2）；Robot Duck 的结果（C10）。

10. **明确 driver / navigator 分工，并允许用语音切换。** 默认分工：用户或 worker 当 driver；语音 agent 当 navigator，负责审阅、提醒、把关 worker 的产出。用户说“你来写”时，把活交给 worker，用户转为审阅者；说“我自己来”时，agent 退回只提醒错误的模式。切换时口头确认一次。依据：Ma et al. 的角色轮换与过度依赖（C5）；PairBuddy 中 navigator 的软技能和 driver 的技术能力（C6）；Codellaborator 允许 AI 与用户交换 driver / observer 角色（C2）。

11. **提供理由和验证手段，校准用户的信任。** 用户倾向于信任 agent，而 agent 往往讲不清理由。所以结论要带一句依据，例如“因为 stt.ts 第 140 行没 await”；对 worker 的改动，主动提出“要我让它跑一下测试吗”，而不是直接说“好了”；有破坏性的操作一定要确认。依据：Kuttal 发现用户 trusted and showed humility、agent 无法给出逻辑解释（C6）；Vaithilingam、CUPS 指出验证成本高（C11、C3）；Windsurf 的自动执行分级（B1）。

12. **主动程度由用户掌控，有全局开关和语音开关。** 提供 `voiceAgent.proactivity` 三档：`off` / `errors-only` / `normal`。支持语音命令“安静一会儿 / 可以说了”；静音麦克风和结束语音模式分开。依据：Chen 参与者要求能开关和调频率（C1 DC6）；JetBrains 要求显式开启（B4）；Amershi 的 provide global controls（C7）；VS Code 的 mute 与结束会话分离（A4）。

13. **识别要偏向本项目的词汇，取消要能完整回滚。** 把可见范围和打开文件里的符号名、项目名、git 分支，作为 STT 的 prompt 或热词。`source="stt"` 的转写里，标识符按作用域内的符号做模糊匹配纠正（参照 Serenade 的 `foo bar → foo_bar`）。用户说“不对 / 取消”时，撤回上一条尚未执行的指令。依据：Claude Code 把项目名和分支加入识别提示（A5）；Serenade 按作用域格式化标识符、候选可改选（A1）；Nowrin & Vertanen 语言模型适配后错误率相对降 27%（C9）；Claude Code 的 Esc 完整回滚（A5）。

14. **语音用来讨论意图，不用来逐行写代码；长时间离开后回来再做一次简报。** 不做“口述第 N 行插入 X”这类功能（Copilot Voice 已停，Serenade 和 Talon 只在细分人群中存活），写代码一律交给 worker。用户离开超过约 10 分钟（无编辑、无语音），或切换到别的 tab 后回来，**一次性**播报 worker 在此期间的进展，限两三句；短暂停顿不播报。依据：Copilot Voice 停止（A3）；Creed & Sarcar、Voiceye 指出语音需要与其他模态配合（C9）；JetBrains Recap 在长时间离开时最有价值、用户要求更短（B4）；Parnin & Rugaber 的恢复延迟（C7）。
