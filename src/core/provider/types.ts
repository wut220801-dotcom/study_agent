/**
 * Provider 抽象。
 *
 * 刻意不依赖官方 SDK：一是两个协议的流式格式都足够简单，手写一遍能看清
 * 「模型的一等公民是流式事件，不是一次性响应」这件事；二是 SDK 的版本变动
 * 会污染这个项目的依赖树，而这里的用法极其稳定。
 */

import type { JsonSchema, Message, StopReason, Usage } from "../types.js";

/**
 * 归一化的推理强度。
 *
 * 这是**跨协议的抽象**，不是任何一个厂商的字段名：各家的 wire 形态不同，
 * 由 provider 各自映射（见 anthropic.ts / openai.ts 里的说明）。
 * 用统一词表是为了让上层（设置页、按角色配置）不必关心底层差异。
 */
export type ReasoningEffort = "off" | "low" | "high" | "max";

/**
 * thinking 相关字段在 wire 上的形态。
 *
 * 必须显式区分的原因：DeepSeek 用 `thinking: {type: "disabled"}` 才能真正关掉思考，
 * 而 OpenAI 官方不认这个字段（会 400）；反过来 OpenAI 的 `reasoning_effort` 词表里
 * 没有 `max`。传错字段比不传更糟，所以这里让调用方明确表态。
 */
export type ThinkingFormat = "auto" | "deepseek" | "openai" | "none";

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface StreamRequest {
  model: string;
  /** 系统提示。按缓存友好的原则，这里放的是整个会话内稳定的内容。 */
  system: string;
  messages: Message[];
  tools: ToolDef[];
  maxTokens: number;
  temperature?: number;
  /** 本次请求的推理强度。不传表示用 provider 默认行为。 */
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  /**
   * 路由亲和键，通常传会话 id。
   *
   * OpenAI 系的前缀缓存是**按后端机器**生效的，多实例部署时同一个会话若被负载
   * 均衡打到不同机器就必然 miss。把它作为 prompt_cache_key 发下去，让同一会话
   * 粘在同一个后端上。不传的话表现为「命中率忽高忽低且无法复现」。
   */
  cacheKey?: string;
}

/**
 * 流式事件。provider 负责把「内容块增量」聚合成完整的 assistant 消息，
 * 在 done 事件里一次性交出——循环层因此不需要理解任何协议细节。
 */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "done"; message: Message; stopReason: StopReason; usage: Usage }
  | { type: "error"; message: string };

export interface Provider {
  readonly name: string;
  readonly model: string;
  stream(req: StreamRequest): AsyncGenerator<StreamEvent>;
}

/** 请求失败时抛出。带上状态码和响应体，便于定位是限流还是参数错。 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderConfig {
  /** anthropic | openai（含任意 OpenAI 兼容服务）| mock（演示模式，不联网） */
  kind: "anthropic" | "openai" | "mock";
  model: string;
  apiKey: string;
  /** OpenAI 兼容服务用；留空走官方地址 */
  baseUrl?: string;
  /** 是否发送 prompt cache 标记（Anthropic 及支持该扩展的兼容服务） */
  enableCaching?: boolean;
  /** thinking 字段的 wire 形态。auto 时按 baseUrl / 模型名推断。 */
  thinkingFormat?: ThinkingFormat;
}
