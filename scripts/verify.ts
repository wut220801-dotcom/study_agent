/**
 * 机制验证脚本。不联网、不需要 API key，用脚本化的 provider 断言四条关键性质。
 *
 * 运行：npx tsx scripts/verify.ts
 *
 * 为什么值得写这些断言：agent 的失败模式大多是**静默**的——上下文泄漏进无关内容、
 * 压缩把工具调用和结果拆散、撤销没真的撤销，这些都不会抛异常，只会让行为慢慢变怪。
 * 把它们变成断言，是让这些性质在后续修改中不被破坏的唯一办法。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FauxProvider } from "../src/core/provider/faux.js";
import { AnthropicProvider as AnthropicDirect } from "../src/core/provider/anthropic.js";
import { OpenAIProvider as OpenAIDirect } from "../src/core/provider/openai.js";
import { Session, COMPACTION_PREFIX } from "../src/core/session.js";
import { runAgentLoop } from "../src/core/loop.js";
import { findCutIndex, shouldCompact } from "../src/core/compaction.js";
import { ToolRegistry, objectSchema, stringParam } from "../src/core/tools/types.js";
import { assistantText, estimateMessagesTokens, toolResultMessage, userText, type Message } from "../src/core/types.js";

import { addNode, createCurriculum, updateNode } from "../src/learn/curriculum.js";
import { buildPlannerSystemPrompt, latestReportsByNode } from "../src/learn/planner.js";
import { appendCompactionToNotes, readNotes, writeNoteSection } from "../src/learn/notes.js";
import { generateEssence, applyInjection, revokeInjection, listInjections } from "../src/learn/inject.js";
import { LearningRuntime } from "../src/learn/runtime.js";
import { Workspace } from "../src/learn/workspace.js";
import { renderLearnEntry } from "../src/learn/entries.js";
import { exportToObsidian, inspectVault } from "../src/learn/obsidian.js";
import { tutorSessionId, type Report } from "../src/learn/types.js";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const root = mkdtempSync(join(tmpdir(), "learn-agent-verify-"));

try {
  // ---------------------------------------------------------------------
  section("1. agent 循环：工具调用被正确执行并回填");

  {
    const provider = new FauxProvider("faux-model", [
      { text: "我来记一笔。", toolCalls: [{ name: "echo", args: { value: "hello" } }] },
      { text: "记好了。" },
    ]);

    const registry = new ToolRegistry<{ tag: string }>().register({
      name: "echo",
      description: "回显",
      parameters: objectSchema({ value: stringParam("值") }, ["value"]),
      async execute(args, ctx) {
        return `${ctx.tag}:${String(args.value)}`;
      },
    });

    const events: string[] = [];
    const result = await runAgentLoop({
      provider,
      system: "sys",
      history: [userText("记一下 hello")],
      registry,
      toolContext: { tag: "T" },
      emit: (e) => {
        events.push(e.type);
      },
      onMessage: () => {},
    });

    check("循环正常结束", result.stopReason === "stop", `实际 ${result.stopReason}`);
    check("产生了两轮 assistant 消息 + 一条工具结果", result.messages.length === 3);

    const toolResult = result.messages[1]!;
    const block = toolResult.content[0];
    check(
      "工具拿到了上下文并正确执行",
      block?.type === "tool_result" && block.content === "T:hello",
      `实际 ${JSON.stringify(block)}`,
    );
    check("发出了工具开始/结束事件", events.includes("tool_start") && events.includes("tool_end"));
  }

  {
    // 未知工具不应该中断循环，而应该把错误作为信息交回模型
    const provider = new FauxProvider("faux-model", [
      { toolCalls: [{ name: "not_a_tool", args: {} }] },
      { text: "好的，我换个做法。" },
    ]);

    const result = await runAgentLoop({
      provider,
      system: "sys",
      history: [userText("试试")],
      registry: new ToolRegistry<null>(),
      toolContext: null,
      onMessage: () => {},
    });

    const block = result.messages[1]!.content[0];
    check(
      "未知工具返回可读错误而非抛异常",
      block?.type === "tool_result" && block.isError,
      `实际 ${JSON.stringify(block)}`,
    );
    check("循环在错误后继续跑完", result.stopReason === "stop");
  }

  {
    // 相同参数重复调用同一个工具，应该被提示
    const provider = new FauxProvider("faux-model", [
      { toolCalls: [{ name: "noop", args: { a: 1 } }] },
      { toolCalls: [{ name: "noop", args: { a: 1 } }] },
      { toolCalls: [{ name: "noop", args: { a: 1 } }] },
      { toolCalls: [{ name: "noop", args: { a: 1 } }] },
      { text: "停。" },
    ]);

    const registry = new ToolRegistry<null>().register({
      name: "noop",
      description: "什么都不做",
      parameters: objectSchema({ a: { type: "number" } }),
      async execute() {
        return "ok";
      },
    });

    const result = await runAgentLoop({
      provider,
      system: "sys",
      history: [userText("循环")],
      registry,
      toolContext: null,
      onMessage: () => {},
    });

    const lastResult = result.messages[result.messages.length - 2]!.content[0];
    check(
      "重复调用被检测并写入提示",
      lastResult?.type === "tool_result" && lastResult.content.includes("你已经用完全相同的参数调用"),
      `实际 ${lastResult?.type === "tool_result" ? lastResult.content : "?"}`,
    );
  }

  // ---------------------------------------------------------------------
  section("2. 会话树：追加、上下文构建、撤销");

  {
    const sessionPath = join(root, "tree.jsonl");
    const session = Session.load({ id: "t", filePath: sessionPath, renderCustom: renderLearnEntry });

    session.appendMessage(userText("第一个问题"));
    session.appendMessage(assistantText("第一个回答"));
    const anchor = session.currentLeafId;

    session.appendCustom("injected_knowledge", {
      sourceNodeTitle: "栈与堆",
      content: "栈是后进先出的内存区域。",
    }, true);
    session.appendMessage(userText("第二个问题"));

    check("注入后上下文包含注入内容", session.buildContext().length === 4);

    session.navigateTo(anchor);
    const afterUndo = session.buildContext();
    check("撤销后上下文回到注入前", afterUndo.length === 2, `实际 ${afterUndo.length}`);
    check(
      "撤销后不再包含被注入的内容",
      !JSON.stringify(afterUndo).includes("栈是后进先出的内存区域"),
    );

    // 从磁盘重新加载，验证 leaf 游标被持久化
    const reloaded = Session.load({ id: "t", filePath: sessionPath, renderCustom: renderLearnEntry });
    check("撤销状态在重载后保持", reloaded.buildContext().length === 2);
  }

  // ---------------------------------------------------------------------
  section("3. 压缩切割点：绝不把工具调用和它的结果拆到边界两侧");

  {
    // 构造一段历史：带工具调用的一轮夹在中间
    const messages: Message[] = [
      userText("问题一"),
      assistantText("回答一"),
      userText("问题二"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "我查一下" },
          { type: "tool_call", id: "c1", name: "search", args: { q: "x" } },
        ],
        timestamp: Date.now(),
      },
      toolResultMessage([{ type: "tool_result", toolCallId: "c1", content: "结果", isError: false }]),
      assistantText("根据结果，我认为……"),
      userText("问题三"),
      assistantText("回答三"),
    ];

    // 各种保留预算都试一遍，切割点在任何情况下都不能落在工具结果上
    let allValid = true;
    let invalidAt = -1;
    for (let keep = 1; keep <= 400; keep += 7) {
      const cut = findCutIndex(messages, keep);
      if (cut === null) continue;
      if (messages[cut]!.content.some((b) => b.type === "tool_result")) {
        allValid = false;
        invalidAt = keep;
        break;
      }
    }
    check("任意保留预算下切割点都合法", allValid, invalidAt > 0 ? `keepRecentTokens=${invalidAt} 时落在工具结果上` : "");

    const used = estimateMessagesTokens(messages);
    // 阈值 = contextWindow - reserveTokens。把窗口设到刚好只比用量大一点，
    // 使阈值落在用量之下，从而触发压缩。
    check(
      "小窗口触发压缩",
      shouldCompact(messages, { contextWindow: used + 10, reserveTokens: 20, keepRecentTokens: 100 }),
      `实际用量 ${used}`,
    );
    check(
      "大窗口不触发压缩",
      !shouldCompact(messages, { contextWindow: used + 10_000, reserveTokens: 200, keepRecentTokens: 100 }),
    );
    check("消息过少时不压缩", findCutIndex([userText("a"), assistantText("b")], 100) === null);
  }

  // ---------------------------------------------------------------------
  section("4. 上下文隔离：规划师拿不到任何教学细节");

  {
    const workspace = new Workspace(join(root, "iso"));
    const curriculum = createCurriculum("Rust 内存模型", "有 Python 基础，没写过系统编程");
    const kp1 = addNode(curriculum, {
      title: "栈与堆",
      objectives: ["能解释值类型与引用类型的存储位置差异"],
      methods: ["explain", "practice"],
    });
    const kp2 = addNode(curriculum, {
      title: "所有权转移",
      objectives: ["能预测一次赋值后原变量是否仍可用"],
      prerequisites: [kp1.id],
      methods: ["explain"],
    });

    // 导师写下一段有辨识度的笔记内容
    const SECRET = "栈上分配由编译器在编译期确定大小，堆上分配则通过 Box 在运行期申请";
    writeNoteSection(workspace, kp1.id, "核心概念", SECRET);
    writeNoteSection(workspace, kp1.id, "疑问与澄清", "学习者误以为 String 的内容一定在栈上");

    workspace.appendLine(workspace.reportPath(kp1.id), {
      nodeId: kp1.id,
      nodeTitle: kp1.title,
      status: "mastered",
      summary: "学习者能正确判断基本类型的存储位置。",
      ts: Date.now(),
    } satisfies Report);

    const latestReports = latestReportsByNode(curriculum, workspace);
    const plannerPrompt = buildPlannerSystemPrompt(curriculum, latestReports);

    check("规划师上下文里没有笔记正文", !plannerPrompt.includes(SECRET));
    check("规划师上下文里没有错题细节", !plannerPrompt.includes("学习者误以为 String 的内容一定在栈上"));
    check("规划师上下文里没有笔记文件内容的其他痕迹", !plannerPrompt.includes("Box 在运行期申请"));
    check("规划师上下文里确实有报告摘要", plannerPrompt.includes("学习者能正确判断基本类型的存储位置"));
    check("规划师能看到依赖关系", plannerPrompt.includes(`依赖：${kp1.id}`));

    // 反向验证：笔记本身是存在的，不是"因为没写进去"
    check("笔记文件确实写入了内容", readNotes(workspace, kp1.id).includes(SECRET));

    // 快照也不应该带笔记正文
    const snapshotNodes = curriculum.nodes.map((n) => ({ ...n, notePath: n.notePath }));
    check(
      "KnowledgePoint 结构本身不含笔记字段",
      !JSON.stringify(snapshotNodes).includes(SECRET),
    );
  }

  // ---------------------------------------------------------------------
  section("5. 注入：压缩、缓存、落地、撤销");

  {
    const workspace = new Workspace(join(root, "inject"));
    const curriculum = createCurriculum("Rust 内存模型", "");
    const kp1 = addNode(curriculum, { title: "栈与堆", objectives: ["判断值的存储位置"] });
    const kp2 = addNode(curriculum, {
      title: "所有权转移",
      objectives: ["预测赋值后的可用性"],
      prerequisites: [kp1.id],
    });

    writeNoteSection(
      workspace,
      kp1.id,
      "核心概念",
      "栈上分配大小编译期已知，堆上分配运行期决定。String 的指针在栈上，内容在堆上。",
    );

    const ESSENCE_TEXT = "## 栈与堆的关键区别\n\n栈：编译期确定大小。堆：运行期申请。String 的元数据在栈、数据在堆。";
    const ESSENCE_TEXT_2 = "## 栈与堆的关键区别（已更新）\n\n栈：编译期确定大小。堆：运行期申请。栈是后进先出。";
    const provider = new FauxProvider("faux-model", [{ text: ESSENCE_TEXT }, { text: ESSENCE_TEXT_2 }]);

    const targetSession = Session.load({
      id: tutorSessionId(kp2.id),
      filePath: workspace.sessionPath(tutorSessionId(kp2.id)),
      renderCustom: renderLearnEntry,
    });
    targetSession.appendMessage(userText("我想学所有权转移"));

    // 第一次：应当调用模型
    const first = await generateEssence({
      workspace,
      curriculum,
      sourceNode: kp1,
      targetNode: kp2,
      provider,
    });
    check("首次注入生成了精华", first.essence.content === ESSENCE_TEXT);
    check("首次注入调用了模型", provider.callCount === 1);

    // 第二次：笔记和提示语都没变，应当命中缓存
    const second = await generateEssence({
      workspace,
      curriculum,
      sourceNode: kp1,
      targetNode: kp2,
      provider,
    });
    check("相同条件下命中缓存", second.cached);
    check("命中缓存时没有再调用模型", provider.callCount === 1);

    // 笔记变了，缓存应当失效
    writeNoteSection(workspace, kp1.id, "关键要点", "栈是后进先出。", "append");
    const third = await generateEssence({
      workspace,
      curriculum,
      sourceNode: kp1,
      targetNode: kp2,
      provider,
    });
    check("笔记变化后缓存失效并重新生成", !third.cached && provider.callCount === 2);

    // 落地到目标会话
    const { record } = applyInjection(targetSession, third.essence, workspace);
    const injectedContext = targetSession.buildContext();
    check("注入后目标会话上下文增长", injectedContext.length === 2, `实际 ${injectedContext.length}`);
    check("注入内容进入目标上下文", JSON.stringify(injectedContext).includes("栈与堆的关键区别"));
    check(
      "注入内容带有防混淆的使用说明",
      JSON.stringify(injectedContext).includes("不要重新讲授"),
    );

    const history = listInjections(workspace);
    check("注入记录已落盘", history.length === 1 && history[0]!.id === record.id);

    // 撤销
    revokeInjection(targetSession, record, workspace);
    const afterRevoke = targetSession.buildContext();
    check("撤销后目标上下文回到注入前", afterRevoke.length === 1);
    check("撤销后不再包含注入内容", !JSON.stringify(afterRevoke).includes("栈与堆的关键区别"));

    const revoked = listInjections(workspace);
    check("撤销状态被记录", revoked[0]?.revokedAt !== undefined);
  }

  // ---------------------------------------------------------------------
  section("6. 压缩产物复用进笔记");

  {
    const workspace = new Workspace(join(root, "compact"));
    const curriculum = createCurriculum("测试", "");
    const node = addNode(curriculum, { title: "测试点", objectives: ["能通过"] });

    appendCompactionToNotes(workspace, node.id, "## 已讲内容\n\n讲了栈的基本概念。");
    const notes = readNotes(workspace, node.id);
    check("压缩摘要被写入回顾小节", notes.includes("讲了栈的基本概念"));
    check("回顾小节标题正确", notes.includes("## 回顾"));

    appendCompactionToNotes(workspace, node.id, "第二轮内容。");
    const twice = readNotes(workspace, node.id);
    check("二次归档追加而不是覆盖", twice.includes("讲了栈的基本概念") && twice.includes("第二轮内容"));
  }

  // ---------------------------------------------------------------------
  section("7. 压缩条目的自包含性");

  {
    const sessionPath = join(root, "compact-session.jsonl");
    const session = Session.load({ id: "c", filePath: sessionPath, renderCustom: renderLearnEntry });

    session.appendMessage(userText("很久以前的对话"));
    session.appendMessage(assistantText("很久以前的回答"));
    session.appendCompaction("摘要：讲了栈。", [userText("近期对话"), assistantText("近期回答")], 5000);

    const context = session.buildContext();
    check("压缩后上下文只剩摘要 + 保留尾部", context.length === 3, `实际 ${context.length}`);
    check("摘要带前缀说明", context[0]!.content[0]?.type === "text" && context[0]!.content[0].text.startsWith(COMPACTION_PREFIX));
    check("压缩边界之前的内容不再进入上下文", !JSON.stringify(context).includes("很久以前"));

    const tokens = estimateMessagesTokens(context);
    check("压缩确实减小了上下文", tokens < 5000, `实际估算 ${tokens}`);
  }

  // ---------------------------------------------------------------------
  section("8. 端到端：注入内容确实进入目标导师实际发出的请求");

  {
    const workspaceRoot = join(root, "runtime");
    const SECRET_NOTE = "栈上分配的大小在编译期就已知，堆上分配在运行期决定。";
    const ESSENCE = "## 栈与堆要点\n\n栈由编译器管理，堆由运行时管理。";

    // 三次模型调用的顺序：注入时的压缩 → 导师回应 → 规划师回应
    const provider = new FauxProvider("faux-model", [
      { text: ESSENCE },
      { text: "好，那我们接着讲所有权。" },
      { text: "大纲我看过了，下一步学所有权转移。" },
    ]);

    const runtime = new LearningRuntime(
      {
        provider: { kind: "mock", model: "faux-model", apiKey: "" },
        workspaceRoot,
        port: 0,
        maxIterations: 5,
        contextWindow: 200_000,
        maxOutputTokens: 32_768,
        reasoning: { planner: "high", tutor: "high" },
        thinkingFormat: "auto",
        obsidian: {},
      },
      provider,
    );

    const curriculum = runtime.getCurriculum();
    const stack = addNode(curriculum, {
      title: "栈与堆",
      objectives: ["能判断一个值存在栈上还是堆上"],
      methods: ["explain"],
    });
    const ownership = addNode(curriculum, {
      title: "所有权转移",
      objectives: ["能预测一次赋值后原变量是否仍可用"],
      prerequisites: [stack.id],
      methods: ["explain", "practice"],
    });
    runtime.saveCurriculum();

    writeNoteSection(runtime.workspace, stack.id, "核心概念", SECRET_NOTE);

    const { cached } = await runtime.inject(stack.id, ownership.id);
    check("runtime 层的注入未命中缓存", !cached);

    await runtime.runTutorTurn(ownership.id, "我准备好了，开始吧");
    await runtime.runPlannerTurn("接下来学什么？");

    const tutorRequest = provider.requests[1]!;
    const tutorPrompt = JSON.stringify(tutorRequest.messages) + tutorRequest.system;

    check(
      "注入内容出现在目标导师实际发出的请求里",
      tutorPrompt.includes("栈由编译器管理"),
      "导师的请求里找不到注入的精华",
    );
    check(
      "导师的请求里带有防混淆说明",
      tutorPrompt.includes("不要重新讲授"),
    );
    check(
      "导师的系统提示里含它负责的知识点",
      tutorRequest.system.includes("所有权转移"),
    );
    check(
      "导师的系统提示是静态的（不含会变的笔记内容）",
      !tutorRequest.system.includes(SECRET_NOTE),
      "笔记内容混进了系统提示——这会让 prompt 缓存每次记笔记都失效",
    );

    const plannerRequest = provider.requests[2]!;
    const plannerPrompt = JSON.stringify(plannerRequest.messages) + plannerRequest.system;

    check("规划师的请求里看不到笔记正文", !plannerPrompt.includes(SECRET_NOTE));
    check("规划师的请求里看不到注入的精华", !plannerPrompt.includes("栈由编译器管理"));
    check(
      "规划师的系统提示里能看到依赖关系",
      plannerRequest.system.includes(`依赖：${stack.id}`),
    );
    check(
      "规划师的系统提示里能看到可学的知识点",
      plannerRequest.system.includes("依赖已满足、可以开学的知识点"),
    );
  }

  // ---------------------------------------------------------------------
  section("9. 推理强度：按角色配置，并落到正确的 wire 字段");

  {
    // 拦截 fetch，直接检查真正发出去的请求体——这是唯一能查出「字段名写错」的办法
    const captured: Array<{ url: string; body: any }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      captured.push({ url: String(url), body: JSON.parse(init.body) });
      // 返回一个最小的合法 SSE 流，让 provider 正常走完
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const drain = async (stream: AsyncGenerator<any>) => {
        for await (const _ of stream) {
          /* 只关心请求体，事件内容不重要 */
        }
      };

      const base = {
        model: "deepseek-v4-flash",
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com",
      };

      // --- OpenAI 兼容 + DeepSeek 形态 ---
      const openai = new OpenAIDirect({ ...base, kind: "openai", thinkingFormat: "deepseek" });

      await drain(openai.stream({
        model: base.model, system: "s", messages: [], tools: [], maxTokens: 1000,
        reasoningEffort: "off",
      }));
      check(
        "DeepSeek 形态：off 发出 thinking.type=disabled",
        captured.at(-1)!.body.thinking?.type === "disabled",
        JSON.stringify(captured.at(-1)!.body.thinking),
      );
      check(
        "DeepSeek 形态：off 不携带 reasoning_effort",
        captured.at(-1)!.body.reasoning_effort === undefined,
      );

      await drain(openai.stream({
        model: base.model, system: "s", messages: [], tools: [], maxTokens: 1000,
        reasoningEffort: "max",
      }));
      check(
        "DeepSeek 形态：max 原样传递（它支持 max）",
        captured.at(-1)!.body.reasoning_effort === "max",
        String(captured.at(-1)!.body.reasoning_effort),
      );
      check(
        "DeepSeek 形态：max 同时声明 thinking 已启用",
        captured.at(-1)!.body.thinking?.type === "enabled",
      );

      // --- OpenAI 官方形态：不认 thinking 字段，且词表里没有 max ---
      const openaiOfficial = new OpenAIDirect({
        ...base, kind: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com/v1",
        thinkingFormat: "openai",
      });
      await drain(openaiOfficial.stream({
        model: "gpt-4o", system: "s", messages: [], tools: [], maxTokens: 1000,
        reasoningEffort: "max",
      }));
      check(
        "OpenAI 形态：不发 thinking 字段（发了会 400）",
        captured.at(-1)!.body.thinking === undefined,
        JSON.stringify(captured.at(-1)!.body.thinking),
      );
      check(
        "OpenAI 形态：max 降级为 high（词表里没有 max）",
        captured.at(-1)!.body.reasoning_effort === "high",
        String(captured.at(-1)!.body.reasoning_effort),
      );

      // --- Anthropic：没有强度等级，映射成 budget_tokens ---
      const anthropic = new AnthropicDirect({
        kind: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-test",
      });

      await drain(anthropic.stream({
        model: "claude-sonnet-4-5", system: "s", messages: [], tools: [], maxTokens: 100_000,
        reasoningEffort: "high", temperature: 0.5,
      }));
      check(
        "Anthropic：high 映射为 budget_tokens=8192",
        captured.at(-1)!.body.thinking?.budget_tokens === 8192,
        JSON.stringify(captured.at(-1)!.body.thinking),
      );
      check(
        "Anthropic：开启思考时不发 temperature（发了会被拒）",
        captured.at(-1)!.body.temperature === undefined,
      );

      await drain(anthropic.stream({
        model: "claude-sonnet-4-5", system: "s", messages: [], tools: [], maxTokens: 100_000,
        reasoningEffort: "off", temperature: 0.5,
      }));
      check(
        "Anthropic：off 完全不发 thinking（它是默认关闭的）",
        captured.at(-1)!.body.thinking === undefined,
      );
      check(
        "Anthropic：off 时 temperature 正常发送",
        captured.at(-1)!.body.temperature === 0.5,
      );

      // 输出预算很小时，预算要被夹取，不能构造出非法请求
      await drain(anthropic.stream({
        model: "claude-sonnet-4-5", system: "s", messages: [], tools: [], maxTokens: 2000,
        reasoningEffort: "max",
      }));
      check(
        "Anthropic：预算夹取到 max_tokens 之下，不会构造出非法请求",
        captured.at(-1)!.body.thinking.budget_tokens < 2000,
        String(captured.at(-1)!.body.thinking.budget_tokens),
      );

      // --- 声明 none 时一个字段都不发 ---
      const noThinking = new OpenAIDirect({
        ...base, kind: "openai", thinkingFormat: "none",
      });
      await drain(noThinking.stream({
        model: base.model, system: "s", messages: [], tools: [], maxTokens: 1000,
        reasoningEffort: "max",
      }));
      check(
        "thinkingFormat=none：不发任何 thinking 相关字段",
        captured.at(-1)!.body.thinking === undefined &&
          captured.at(-1)!.body.reasoning_effort === undefined,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ---------------------------------------------------------------------
  section("10. Obsidian 导出：双链、frontmatter、以及不覆盖用户笔记");

  {
    const vault = join(root, "vault");
    // 造一个最小的 Obsidian 库：有 .obsidian 目录才算
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    const folder = "学习Agent";
    mkdirSync(join(vault, folder), { recursive: true });

    const ws = new Workspace(join(root, "ob-ws"));
    const curriculum = createCurriculum("Rust 内存管理", "有 Python 基础");
    const stack = addNode(curriculum, {
      title: "栈与堆",
      objectives: ["能判断值的存储位置"],
      methods: ["explain"],
    });
    const own = addNode(curriculum, {
      title: "所有权转移",
      objectives: ["能预测赋值后的可用性"],
      prerequisites: [stack.id],
    });
    updateNode(curriculum, stack.id, { status: "mastered" });
    writeNoteSection(ws, stack.id, "核心概念", "栈上分配编译期确定。");

    // 预先放一个用户自己的同名文件，且不带生成标记
    const USER_NOTE = "学习Agent/kp-1 栈与堆.md";
    const USER_CONTENT = "# 我自己写的笔记，不能被覆盖\n";
    writeFileSync(join(vault, USER_NOTE), USER_CONTENT, "utf8");

    check(
      "非库目录被识别出来",
      !inspectVault(root).ok,
    );
    check("真库被识别出来", inspectVault(vault).ok);

    const first = exportToObsidian({
      workspace: ws, curriculum,
      settings: { vaultPath: vault, folder },
    });

    check("导出成功", first.ok, first.error ?? "");
    check("写了知识点文件", first.written.some((f) => f.includes("所有权转移")));
    check("写了索引文件", first.written.some((f) => f.includes("Rust 内存管理")));
    check(
      "同名用户笔记被跳过而不是覆盖",
      first.skipped.some((s) => s.path.includes("栈与堆") && s.reason.includes("你自己的笔记")),
      JSON.stringify(first.skipped),
    );
    check(
      "用户笔记内容完好",
      readFileSync(join(vault, USER_NOTE), "utf8") === USER_CONTENT,
    );

    const nodeFile = readFileSync(
      join(vault, folder, "kp-2 所有权转移.md"),
      "utf8",
    );
    check("带生成标记（用于后续安全覆盖）", nodeFile.includes("generated_by: learn-agent"));
    check("依赖渲染成双链（图谱视图能用）", nodeFile.includes("[[kp-1 栈与堆]]"));
    check("引用回索引文件", nodeFile.includes("[[Rust 内存管理]]"));
    check("frontmatter 里有状态，可供 Dataview 查询", nodeFile.includes("status: pending"));

    const indexFile = readFileSync(join(vault, folder, "Rust 内存管理.md"), "utf8");
    check("索引里有进度统计", indexFile.includes("1 / 2 个知识点已掌握"));
    check("索引表格用了双链", indexFile.includes("[[kp-2 所有权转移]]"));

    // 二次导出：自己生成的文件可以被覆盖（幂等），用户文件继续被跳过
    const second = exportToObsidian({
      workspace: ws, curriculum,
      settings: { vaultPath: vault, folder },
    });
    check("重复导出对自己生成的文件是幂等的", second.written.length === first.written.length);
    check(
      "重复导出仍然不碰用户笔记",
      readFileSync(join(vault, USER_NOTE), "utf8") === USER_CONTENT,
    );

    // 没配路径时给出明确错误而不是静默失败
    const noPath = exportToObsidian({ workspace: ws, curriculum, settings: {} });
    check("未配置路径时报错而不是静默无操作", !noPath.ok && Boolean(noPath.error));

    // 主题未设定时不该把占位文案写进文件名
    const unnamed = createCurriculum("（尚未设定）", "");
    addNode(unnamed, { title: "某个知识点", objectives: ["能做到某事"] });
    const unnamedExport = exportToObsidian({
      workspace: ws, curriculum: unnamed, settings: { vaultPath: vault, folder: "未命名测试" },
    });
    check(
      "主题未设定时索引用稳定文件名，不写占位文案",
      unnamedExport.written.some((f) => f.endsWith("学习大纲.md")),
      JSON.stringify(unnamedExport.written),
    );
  }

  // ---------------------------------------------------------------------
  console.log("");
  if (failures === 0) {
    console.log(`全部通过：${checks} 项断言`);
  } else {
    console.log(`${failures} / ${checks} 项断言失败`);
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
