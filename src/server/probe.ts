/**
 * 模型连接探针。
 *
 * 作用:发一条最小请求,验证 key、模型名、baseUrl 三者是否可用。
 *
 * 两个从实践中得来的要点(参考 deepseek-harness 的 llm-deepseek 适配器):
 *
 * 1. **输出预算不能给得太小。** DeepSeek 这类模型的 thinking 默认是开着的,
 *    只给 8 个 token 的话思考就把预算吃尽,正文一个字都不会有。表现为「请求成功
 *    但没有任何返回」,极难定位。dsh 对生成会话标题这种小输出场景的做法是显式
 *    关掉 thinking;不改协议的话,给足预算(这里 512)是等效的保护。
 *
 * 2. **收到思考内容也算连接正常。** 探针的目的是验证连通性,不是验证模型肯不肯
 *    说「ok」。所以只要有合法的流式事件和用量,就应该判成功,并如实报告看到了什么。
 */

import type { Provider, ProviderConfig } from "../core/provider/types.js";
import { createProvider } from "../core/provider/index.js";

export interface ProbeResult {
  ok: boolean;
  message: string;
  /** 探测实际观测到的内容,失败时用于定位 */
  observed?: {
    textChars: number;
    thinkingChars: number;
    stopReason: string;
    usage: { input: number; output: number };
  };
}

/** 给够思考 + 正文的预算。太小会让开启 thinking 的模型一个字都吐不出来。 */
const PROBE_MAX_TOKENS = 512;

export async function probeProvider(cfg: ProviderConfig): Promise<ProbeResult> {
  let provider: Provider;
  try {
    provider = createProvider(cfg);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (cfg.kind === "mock") {
    return { ok: true, message: "演示模式，不需要联网。" };
  }

  try {
    const stream = provider.stream({
      model: cfg.model,
      system: "You are a connectivity probe. Reply with exactly: ok",
      messages: [
        { role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() },
      ],
      tools: [],
      maxTokens: PROBE_MAX_TOKENS,
      // 探针只关心连通性，关掉思考可以省掉一次真实费用，也让「有没有正文」这个
      // 判断信号更干净（参考 deepseek-harness 对会话标题的处理）
      reasoningEffort: "off",
    });

    let text = "";
    let thinking = "";
    let stopReason = "stop";
    let usage = { input: 0, output: 0 };
    let sawError: string | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          break;
        case "thinking_delta":
          thinking += event.text;
          break;
        case "done":
          stopReason = event.stopReason;
          usage = { input: event.usage.input, output: event.usage.output };
          break;
        case "error":
          sawError = event.message;
          break;
      }
    }

    const observed = {
      textChars: text.length,
      thinkingChars: thinking.length,
      stopReason,
      usage,
    };

    if (sawError) {
      return { ok: false, message: sawError, observed };
    }

    // 有三类证据说明连接是通的:正文、思考内容、或任何非零用量
    if (text.trim()) {
      return {
        ok: true,
        message: `连接正常。模型回复：${text.trim().slice(0, 60)}（用量 ${usage.input}/${usage.output} tokens）`,
        observed,
      };
    }

    if (thinking || usage.input > 0 || usage.output > 0) {
      return {
        ok: true,
        message:
          `连接正常（用量 ${usage.input}/${usage.output} tokens）。` +
          (thinking
            ? `模型只返回了思考内容${stopReason === "length" ? "，且输出预算已被思考用尽" : ""}——` +
              "这说明它的 thinking 是默认开启的，配置本身没问题。"
            : ""),
        observed,
      };
    }

    // 既没内容也没用量:这才是真的可疑
    return {
      ok: false,
      message:
        "请求到达了端点，但没有收到任何内容或用量。" +
        `检查模型名「${cfg.model}」是否在 ${cfg.baseUrl ?? "该服务"} 上存在。`,
      observed,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}