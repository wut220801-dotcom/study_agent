/**
 * 演示模式 provider。
 *
 * 存在的理由：在配好 API key、愿意花钱之前，应该能先把整个界面和流程跑一遍，
 * 确认「建大纲 → 派发导师 → 记笔记 → 上报 → 注入」这条链路是通的。
 * 一个需要先付钱才能知道自己装对没有的工具，是很难验证的。
 *
 * 它按请求里出现的工具名判断当前是哪个 agent，返回对应的桩数据。
 * 所有输出都带「示例」标记，避免和真实模型输出混淆。
 */

import type { Message, StopReason, Usage } from "../types.js";
import type { Provider, StreamEvent, StreamRequest } from "./types.js";

export class MockProvider implements Provider {
  readonly name = "mock";

  /** 记录每个会话已经跑过几轮，用来让桩数据有递进感 */
  private readonly turns = new Map<string, number>();

  constructor(readonly model = "mock-demo") {}

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const key = req.cacheKey ?? "default";
    const turn = this.turns.get(key) ?? 0;
    this.turns.set(key, turn + 1);

    const toolNames = new Set(req.tools.map((t) => t.name));

    let text = "";
    let toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    if (req.tools.length === 0) {
      // 没有工具的调用 = 压缩摘要或一次性补全
      text = await this.compressionText(req);
    } else if (toolNames.has("add_knowledge_point")) {
      ({ text, toolCalls } = this.plannerTurn(req, turn));
    } else if (toolNames.has("save_note")) {
      ({ text, toolCalls } = this.tutorTurn(req, turn));
    } else {
      text = "【示例模式】当前没有匹配的桩数据。配置真实 API key 后可获得完整能力。";
    }

    const content: Message["content"] = [];
    if (text) {
      content.push({ type: "text", text });
      yield { type: "text_delta", text };
    }
    toolCalls.forEach((call, index) => {
      content.push({ type: "tool_call", id: `mock_${key}_${turn}_${index}`, name: call.name, args: call.args });
    });

    const usage: Usage = { input: 800, output: 200 };
    yield {
      type: "done",
      message: { role: "assistant", content, timestamp: Date.now() },
      stopReason: (toolCalls.length > 0 ? "tool_use" : "stop") as StopReason,
      usage,
    };
  }

  /** 规划师：第一轮拆出三个知识点，之后给文字建议。 */
  private plannerTurn(
    req: StreamRequest,
    turn: number,
  ): { text: string; toolCalls: Array<{ name: string; args: Record<string, unknown> }> } {
    if (turn > 0) {
      return {
        text: [
          "【示例模式】大纲已经有节点了。",
          "",
          "这是演示用的桩输出，用来验证界面和流程。配置真实 API key 后，我会真正读懂你的目标、"
            + "按依赖关系拆解知识点，并根据导师的进度报告调整计划。",
          "",
          "你可以先去左边点开一个知识点，和导师聊两句——那边会用桩数据模拟教学、记笔记和上报。",
        ].join("\n"),
        toolCalls: [],
      };
    }

    const topic = this.extractTopic(req) ?? "这个主题";

    return {
      text: [
        `【示例模式】我来为「${topic}」搭一个大纲框架。`,
        "",
        "演示模式会固定拆出三个知识点，主要为了让后面的环节有东西可跑。",
        "真实模式下我会先问清楚你的目的和现有水平再动手。",
      ].join("\n"),
      toolCalls: [
        {
          name: "set_learning_goal",
          args: {
            topic: `${topic}（示例大纲）`,
            learner_profile: "【示例】演示模式下的占位画像。真实模式会根据对话内容填写。",
          },
        },
        {
          name: "add_knowledge_point",
          args: {
            title: `${topic}·基础概念`,
            objectives: [`能用自己的话解释${topic}要解决的核心问题`, `能说出它最基本的两三个术语的含义`],
            methods: ["explain"],
            rationale: "先建立共同语言，后面的内容都要用到这些术语。",
          },
        },
        {
          name: "add_knowledge_point",
          args: {
            title: `${topic}·核心机制`,
            objectives: [`能说明它的工作原理`, `能预测改动某个部分会产生什么影响`],
            methods: ["explain", "practice"],
            rationale: "这是整个主题的主干，最需要动手练。",
          },
        },
        {
          name: "add_knowledge_point",
          args: {
            title: `${topic}·实际应用`,
            objectives: [`能在真实场景中判断什么时候该用它`, `能识别常见误用`],
            methods: ["practice", "discuss"],
            rationale: "把知识变成能用的判断力，这一步最容易跳过。",
          },
        },
      ],
    };
  }

  /** 导师：讲一段、记一笔；中途上报一次进度，然后自然收尾。 */
  private tutorTurn(
    req: StreamRequest,
    turn: number,
  ): { text: string; toolCalls: Array<{ name: string; args: Record<string, unknown> }> } {
    const title = this.extractTutorTitle(req) ?? "这个知识点";

    // 演示模式只在头几轮调用工具，之后停下来等学习者回应。
    // 真实模型也是这个节奏——如果每轮都无条件调工具，循环只能跑到轮次上限才结束。
    if (turn >= 4) {
      return {
        text: [
          "【示例模式】上面几轮已经演示了完整的机制：",
          "",
          "- **记笔记**：写进了右侧的「学习笔记」，那是属于你的资产；",
          "- **上报进度**：规划师收到了状态，但收不到我们具体聊了什么；",
          "- **知识点注入**：到顶栏的「注入」页，可以把这里的笔记压缩后投给别的知识点。",
          "",
          "现在换你说。配置真实 API key 后，这里会是真正的教学对话。",
        ].join("\n"),
        toolCalls: [],
      };
    }

    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [
      {
        name: "save_note",
        args: {
          section: "核心概念",
          content:
            `【示例笔记】第 ${turn + 1} 轮讲解的要点。\n\n` +
            "真实模式下这里会是导师针对你的理解程度整理的内容，包括定义、例子和你容易混淆的地方。",
        },
      },
    ];

    // 第三轮上报一次，让学习者能看见「报告」这条向上通道
    if (turn === 2) {
      toolCalls.push({
        name: "report_progress",
        args: {
          status: "learning",
          summary: `【示例报告】学习者对${title}的基础部分已经理顺，正在进入应用环节。`,
          suggested_next: [
            {
              title: `${title}的常见误用`,
              reason: "一线教学里发现这类错误最影响实际使用。",
            },
          ],
        },
      });
    }

    return {
      text: [
        `【示例模式】我们在学「${title}」。这是第 ${turn + 1} 轮。`,
        "",
        "演示模式下我只能给固定内容，但完整的机制都在跑——我把要点记进了右侧的**学习笔记**，"
          + "也向规划师**上报了进度**（只报状态，不报我们聊了什么）。",
        "",
        "你可以先在这里聊几轮，然后去「注入」页试试把内容投给别的知识点。",
      ].join("\n"),
      toolCalls,
    };
  }

  private async compressionText(req: StreamRequest): Promise<string> {
    const source = this.sliceBetween(req.messages, "<source_notes", "</source_notes>");
    const heading = source ? source.split("\n")[0]?.slice(0, 60) : "";

    return [
      "## 来自前置知识点的要点",
      "",
      "【示例压缩】真实模式下，这里会是按目标知识点重新组织过的前置知识，",
      "只保留理解新知识点必需的部分，而不会照搬源笔记。",
      "",
      heading ? `源笔记的开头是：${heading}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** 从用户消息里猜一个主题名，让演示输出看起来贴近实际输入。 */
  private extractTopic(req: StreamRequest): string | null {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const message = req.messages[i]!;
      if (message.role !== "user") continue;
      const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("")
        .trim();
      if (!text) continue;
      // 取第一句的前若干字作为主题
      const firstClause = text.split(/[，。！？\n,.]/)[0]?.trim() ?? "";
      return firstClause.slice(0, 24) || null;
    }
    return null;
  }

  private extractTutorTitle(req: StreamRequest): string | null {
    const match = /\*\*(.+?)\*\*（编号/.exec(req.system);
    return match?.[1] ?? null;
  }

  private sliceBetween(messages: Message[], start: string, end: string): string | null {
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type !== "text") continue;
        const from = block.text.indexOf(start);
        if (from === -1) continue;
        const to = block.text.indexOf(end, from);
        if (to === -1) continue;
        return block.text.slice(from + start.length, to).replace(/^[^>]*>/, "").trim();
      }
    }
    return null;
  }
}
