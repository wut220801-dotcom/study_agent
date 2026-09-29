/**
 * 工具定义与注册表。
 *
 * 关于「工具作用域」的设计取舍：
 * 常见做法是给每个工具打 scope 标记，运行时按当前 agent 过滤。本项目不这么做——
 * 每个 agent 直接拥有自己的注册表实例，规划师的注册表里**根本不存在** save_note
 * 这个工具。运行时过滤只要有一处忘记检查就会漏，而「对象不存在」是漏不掉的。
 * 这正是 Nanobot 隔离子 agent 的手法（它给子 agent 建全新注册表，而不是过滤）。
 */

import type { JsonSchema, ToolCallBlock, ToolResultBlock } from "../types.js";

/**
 * 工具的上下文由使用方定义。core 不认识它的结构，只做透传——
 * 学习层会给出 TutorToolContext / PlannerToolContext 两种具体形状。
 */
export interface Tool<TContext = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  execute(args: Record<string, unknown>, ctx: TContext): Promise<string>;
}

export class ToolRegistry<TContext = unknown> {
  private readonly tools = new Map<string, Tool<TContext>>();

  register(tool: Tool<TContext>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 交给模型的工具表。顺序稳定——顺序变化会让 prompt 前缀失效，缓存全废。 */
  definitions(): Array<{ name: string; description: string; parameters: JsonSchema }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * 执行一次工具调用。
   *
   * 刻意不抛异常：工具失败对模型来说是一条信息，不是程序的终止条件。找不到工具、
   * 参数缺失、用户代码抛错，全部转成 isError 的 tool_result 交回模型，让它自己决定
   * 是重试、换参数，还是承认此路不通。只有这样才能让 agent 具备纠错能力。
   */
  async execute(call: ToolCallBlock, ctx: TContext): Promise<ToolResultBlock> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        type: "tool_result",
        toolCallId: call.id,
        content: `未知工具 "${call.name}"。可用工具：${this.names().join(", ")}`,
        isError: true,
      };
    }

    try {
      const content = await tool.execute(call.args, ctx);
      return { type: "tool_result", toolCallId: call.id, content, isError: false };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        type: "tool_result",
        toolCallId: call.id,
        content: `工具 ${call.name} 执行失败：${detail}`,
        isError: true,
      };
    }
  }
}

/** 构造工具参数的辅助函数，省去到处手写 JSON Schema 的样板。 */
export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchema {
  return { type: "object", properties, required };
}

export function stringParam(description: string): { type: "string"; description: string } {
  return { type: "string", description };
}

export function arrayParam(
  description: string,
  items: unknown = { type: "string" },
): { type: "array"; description: string; items: unknown } {
  return { type: "array", description, items };
}
