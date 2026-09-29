/**
 * 脚本化的 provider，用于测试。
 *
 * 它做两件事：按预设脚本依次返回响应，以及**记录收到的每一个请求**。
 * 第二件事是关键——「规划师的上下文里没有笔记内容」这条隔离性质，只能通过
 * 检查实际发出的请求来验证，靠代码审查是查不出泄漏的。
 *
 * 有了它，循环、会话、压缩、注入这些机制都可以在不联网、不需要 API key 的情况下
 * 完整跑通并断言。
 */

import type { Message, StopReason, Usage } from "../types.js";
import type { Provider, StreamEvent, StreamRequest } from "./types.js";

export interface FauxTurn {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id?: string }>;
  stopReason?: StopReason;
}

export class FauxProvider implements Provider {
  readonly name = "faux";
  /** 收到的全部请求，按顺序。测试用它检查实际发出的 prompt。 */
  readonly requests: StreamRequest[] = [];
  private cursor = 0;

  constructor(
    readonly model: string,
    private readonly script: FauxTurn[],
    /** 脚本用尽后的固定回复。走正常路径发出，因此仍会产生 text_delta 事件。 */
    private readonly fallback = "（脚本已用尽）",
  ) {}

  get callCount(): number {
    return this.cursor;
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    this.requests.push(req);

    const turn = this.script[this.cursor++] ?? { text: this.fallback };

    const content: Message["content"] = [];
    if (turn.text) {
      content.push({ type: "text", text: turn.text });
      yield { type: "text_delta", text: turn.text };
    }
    (turn.toolCalls ?? []).forEach((call, index) => {
      content.push({
        type: "tool_call",
        id: call.id ?? `call_${this.cursor}_${index}`,
        name: call.name,
        args: call.args,
      });
    });

    const usage: Usage = { input: 100, output: 50 };
    yield {
      type: "done",
      message: { role: "assistant", content, timestamp: Date.now() },
      stopReason: turn.stopReason ?? (turn.toolCalls?.length ? "tool_use" : "stop"),
      usage,
    };
  }
}
