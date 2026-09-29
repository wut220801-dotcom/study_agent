# 学习 Agent

一个针对学习场景设计的 agent 框架。核心想法是：**把「规划学什么」和「具体怎么教」拆成两种 agent，让它们的上下文严格隔离**。

```
                      ┌──────────────────┐
      学习者 ←───────→ │  规划师 agent     │  看到：大纲 DAG + 进度报告
                      │  (planner)       │  看不到：notes/**
                      └────────┬─────────┘
                               │ add_knowledge_point / dispatch_tutor
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        ┌───────────┐   ┌───────────┐   ┌───────────┐
        │ 导师 kp-1  │   │ 导师 kp-2  │   │ 导师 kp-3  │  各自独立会话
        └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
              │               │               │
      notes/kp-1.md   notes/kp-2.md   notes/kp-3.md   ← 学习细节停在这里
              │               ▲
              └── 压缩成精华 ──┘
                 手动注入（你指定 source → target）
```

## 快速开始

```bash
npm install
npm --prefix web install
npm --prefix web run build

cp .env.example .env        # 默认是 mock 演示模式，不需要 API key
npm run dev                 # 打开 http://127.0.0.1:8787
```

演示模式用桩数据，能让你在花任何钱之前确认整个流程是通的：建大纲 → 导师记笔记 → 上报进度 → 知识点之间注入。

配置真实模型：把 `.env` 里的 `LEARN_AGENT_PROVIDER` 改成 `anthropic` 或 `openai`，填上 key。前端开发时另开一个终端跑 `npm --prefix web run dev`（Vite 在 5173，自动代理 `/api` 到后端）。

验证机制是否正常：

```bash
npx tsx scripts/verify.ts   # 41 项断言，不联网、不需要 key
```

## 配置模型

**推荐在界面里配**：右上角「设置」→ 快速填充选一个预设 → 填 API key → 保存并生效。不用改文件、不用重启。

配置存在 `workspace/settings.json`，优先级高于 `.env`，所以重启也仍然有效。

### 开启 thinking 的模型要特别注意

DeepSeek V4 系列（以及 Claude 的扩展思考）**默认就会先思考再回答**，这会带来两个坑：

1. **输出预算给小了会「不说话」。** 思考内容会把 `max_tokens` 花光，正文一个字都不剩。请求是成功的（HTTP 200），所以你只会看到模型莫名其妙没反应。本项目的默认值因此设成了 32768，而不是常见的 8192：

   ```
   LEARN_AGENT_MAX_TOKENS=32768
   ```

2. **上下文窗口要填对。** 它决定压缩的触发时机。DeepSeek V4 是 **1,000,000**，不是 200,000。填小了会压缩过早（浪费），填大了会在请求超限时直接失败。

「设置」页里的快速填充已经带上了这些值，参数取自 deepseek-harness 自己的 DeepSeek 适配器配置。

### DeepSeek 的两条路线

| 路线 | 提供方选 | baseUrl | 说明 |
|---|---|---|---|
| 官方（推荐） | OpenAI 兼容 | `https://api.deepseek.com` | DeepSeek 原生支持的 chat-completions 协议 |
| Anthropic 兼容 | Anthropic | `https://api.deepseek.com/anthropic` | 走 Anthropic 格式，注意 thinking 默认也是开的 |

两条路线本项目都支持。「测试连接」按钮会真的发一次请求验证 key、模型名、baseUrl，比聊了一轮才发现配错要省事。

## 导出到 Obsidian

在「设置」页填上库路径（填**能看到 `.obsidian` 的那一层**）和子文件夹名，就能把学习内容写进你的 Obsidian 库。**不需要装任何插件**——Obsidian 的库就是本地一个 markdown 文件夹，所以这里直接写文件。

导出的内容：

| 文件 | 内容 |
|---|---|
| `{主题}.md` | 索引页。学习者画像、进度统计、带双链的知识点表格、导师报告 |
| `{id} {标题}.md` | 单个知识点。frontmatter 元数据 + 学习目标 + 先修知识 + 完整笔记 + 学习进展 |

三个设计上值得一提的地方：

**依赖关系渲染成双链。** 大纲本来是一张有向图，而 Obsidian 的图谱视图正好是看这张图的地方。导出后打开图谱，你的学习路径就是一张可视化的网络。

**frontmatter 承载元数据。** `status`、`methods`、`id`、`prerequisites` 都在里面，Obsidian 的属性面板和 Dataview 可以直接查询，不用在正文里写给人看的表格。

**绝不覆盖你自己的笔记。** 这是往你的库里写文件，而库里全是你的东西。每个生成的文件都带 `generated_by: learn-agent` 标记，覆盖前先读一遍——同名文件没有这个标记就跳过并在界面上报告，不会静默覆盖。

勾上「每轮学习结束后自动导出」（默认关）可以让 Obsidian 那边始终保持最新，代价只是本地写几个文件。

## 三个核心设计

### 1. 上下文隔离是结构保证，不是提示词约定

「学习细节不要上传给规划师」如果只写在提示词里说「请不要汇报细节」，迟早会漏。所以规划师的上下文构造函数签名是这样的：

```ts
function buildPlannerSystemPrompt(
  curriculum: Curriculum,
  latestReports: Map<string, Report>,
): string
```

它的入参类型里**没有任何字段能装下笔记内容**——`KnowledgePoint` 只有 `notePath: string` 这样的引用。规划师想读到教学细节都无路可走。

工具层面同理：规划师和导师各自持有独立的工具注册表，规划师的注册表里**根本不存在** `save_note`。运行时过滤只要漏一处检查就会失效，「对象不存在」则漏不掉。

### 2. 三层产物，去向严格分离

| 产物 | 谁写 | 存哪 | 谁读 |
|---|---|---|---|
| `notes` | 导师（`save_note` 工具） | `notes/kp-1.md` | 你（界面）、注入压缩器 |
| `essence` | **系统**（注入时按目标生成） | `essences/kp-1.json` | 注入目标的导师 |
| `report` | 导师（`report_progress` 工具） | `reports/kp-1.jsonl` | **只有规划师** |

关键在 `essence` 不由导师写，而是注入时由系统按**目标知识点**临时压缩。「总结栈与堆」和「提取学习借用检查所需的栈与堆知识」是两种不同的抽取，后者必须知道接收方是谁。所以精华按 `(源, 目标, 提示语, 笔记哈希)` 缓存，笔记一改就失效。

### 3. 注入可以撤销

会话是 append-only 的条目树，槽位由 `leafId` 游标标记。撤销一次注入 = 把游标移回注入前的位置。注错了前置知识会持续误导导师，必须能干净地撤掉——这也是为什么会话用树而不是数组。

## 目录结构

```
src/
  core/                    通用 agent runtime（与学习无关，可复用）
    types.ts               内容块模型、token 估算
    provider/
      anthropic.ts         Anthropic Messages API + prompt cache 断点
      openai.ts            OpenAI 兼容（含路由亲和键）
      sse.ts               SSE 分帧
      mock.ts              演示模式桩数据
    loop.ts                agent 循环：工具调用、死循环检测、结果截断
    session.ts             append-only 条目树 + JSONL 持久化
    compaction.ts          长对话压缩（切割点算法 + 学习场景摘要提示词）
    complete.ts            一次性补全（摘要/压缩共用）
    tools/types.ts         工具定义与注册表
  learn/                   学习语义层
    types.ts               KnowledgePoint / Curriculum / Report / Essence
    curriculum.ts          DAG 操作 + 给规划师的渲染（隔离落点）
    notes.ts               笔记分节读写
    inject.ts              压缩、缓存、落地、撤销
    entries.ts             自定义会话条目种类与渲染
    tutor.ts               导师：4 个工具 + 系统提示
    obsidian.ts            导出到 Obsidian（双链、frontmatter、防覆盖）
    planner.ts             规划师：5 个工具 + 系统提示（隔离落点）
    runtime.ts             装配层：把上面这些串起来
    prompts/*.md           提示词（独立文件，方便反复打磨措辞）
  server/                  Hono API + SSE + 静态托管
web/                       Vite + React 前端
scripts/verify.ts          机制验证（41 项断言）
workspace/                 运行时数据（不进版本库）
```

## 一些设计取舍

**为什么导师不常驻自己的笔记。** 笔记每写一次就变一次，而系统提示是 prompt 缓存的第一个断点——笔记常驻系统提示的话，导师每记一笔笔记就会让整个会话的缓存失效，长对话的账单会成倍上涨。所以笔记走 `read_notes` 按需读取，代价是多一次工具调用。

**为什么依赖只做推荐顺序、不强制阻塞。** 真实学习里经常需要跳着学：可能想先看看后面长什么样再回头补基础，也可能已经有相关经验。强行阻塞只会让人绕过这个工具。缺前置时由导师在对话里指出来，比系统拒绝提供服务好。

**为什么压缩的切割点要特殊处理。** 工具调用和它的结果必须落在压缩边界的同一侧，否则 provider 会拒绝请求（结果找不到对应调用）。所以 `findCutIndex` 里有一条硬规则：带 `tool_result` 的消息永远不能作为切割点。`scripts/verify.ts` 里对这条做了穷举验证。

**为什么摘要复用进笔记。** 会话被压缩时那个摘要本身就是「刚才讲了什么」的良好概括，直接沉淀进笔记的「回顾」小节，不需要再花一次模型调用。

## 怎么改

**加一个导师工具**：在 `tutor.ts` 里实现 `Tool<TutorToolContext>` 并 `register`。它自动只对导师可见。

**加一个会话条目类型**：在 `entries.ts` 里加常量 + 渲染分支，`inContext` 决定它是否进模型上下文。如果只给你自己看（像题目参考答案），传 `false`。

**改提示词**：直接编辑 `src/learn/prompts/*.md`，改完重启即可，不碰代码。

**换模型**：改 `.env` 的 `LEARN_AGENT_MODEL`。用第三方模型时记得同时设 `LEARN_AGENT_CONTEXT_WINDOW`，压缩阈值由它推导。

## 当前的限制

- **单用户、本地运行**。没有认证，会话状态在内存里缓存。
- **导师不能互相派发**。学习场景里你就是跟一个具体导师对话，套娃没有意义。
- **注入纯手动**。依赖关系只用于推荐顺序和界面提示，不会自动往导师上下文里塞东西。
- **代码块没有语法高亮**。markdown 渲染用的是等宽样式；要高亮可以接 shiki，但会给构建加不少体积。
- **报告不做自动折叠**。规划师的上下文里每个节点只展示最新一条报告，所以暂时没有增长问题；如果节点数很多、报告很长，可以再加 `reportDigest` 的自动折叠。

## 和参考实现的对照

这个项目的机制大多能在工作目录里的三个框架中找到原型，想深入某一块时可以对照着读：

| 本项目的 | 参考文件 | 借鉴了什么 |
|---|---|---|
| `core/loop.ts` | `pi/packages/agent/src/agent-loop.ts` | 内外双循环结构 |
| `core/session.ts` | `pi/packages/coding-agent/src/core/session-manager.ts` | append-only + parentId 树、上下文重建 |
| `core/compaction.ts` | `pi/packages/coding-agent/src/core/compaction/` | 合法切割点算法、对话拍平后摘要 |
| `learn/tutor.ts` 的隔离手法 | `Nanobot/nanobot/agent/subagent.py` | fresh 工具注册表 + fresh 系统提示 |
| `learn/curriculum.ts` 的工具作用域 | `Nanobot/nanobot/agent/tools/loader.py` | 按 agent 分注册表而非运行时过滤 |
| `learn/entries.ts` 的注入包装 | `pi/packages/agent/src/harness/messages.ts` | 标签包裹后投影成普通消息 |
| `core/provider/anthropic.ts` 的缓存断点 | `Nanobot/nanobot/providers/anthropic_provider.py` | cache_control 布局（并修正了它的断点位置问题） |
