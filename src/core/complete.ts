/**
 * 一次性补全调用。
 *
 * 摘要压缩和知识注入的压缩都需要「给模型一段材料，要一段文本回来」，不需要工具、
 * 不需要多轮。单独抽出来是因为这类调用的失败语义和多轮循环不同：它要么拿到结果，
 * 要么明确失败，绝不能悄悄降级成空字符串——那样压缩会把历史清空而留下一句空摘要。
 */

import type { Provider, ReasoningEffort } from "./provider/types.js";
import type { Message, StopReason, Usage } from "./types.js";

export interface CompleteOnceOptions {
  provider: Provider;
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

export interface CompleteOnceResult {
  text: string;
  usage: Usage;
  stopReason: StopReason;
}

export async function completeOnce(
  options: CompleteOnceOptions,
): Promise<CompleteOnceResult> {
  const { provider, system, prompt, signal } = options;
  const usage: Usage = { input: 0, output: 0 };

  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  let text = "";
  let stopReason: StopReason = "stop";
  let error: string | undefined;

  const stream = provider.stream({
    model: provider.model,
    system,
    messages: [userMessage],
    tools: [],
    maxTokens: options.maxTokens ?? 4096,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.reasoningEffort !== undefined
      ? { reasoningEffort: options.reasoningEffort }
      : {}),
    ...(signal ? { signal } : {}),
  });

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "thinking_delta":
        break; // 一次性调用不关心思考过程
      case "done":
        stopReason = event.stopReason;
        usage.input += event.usage.input;
        usage.output += event.usage.output;
        break;
      case "error":
        error = event.message;
        break;
    }
  }

  if (error) throw new Error(error);
  return { text: text.trim(), usage, stopReason };
}
