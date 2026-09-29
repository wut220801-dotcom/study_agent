/**
 * OpenAI Chat Completions provider，同时兼容任何遵循该协议的第三方服务
 * （DeepSeek / Moonshot / Qwen / vLLM 等）——它们和官方接口的差别主要在
 * 模型名和 baseUrl，协议本身一致。
 *
 * 与 Anthropic 的两个关键差异：
 *   - 工具结果走独立的 "tool" role，而不是塞在 user 消息里
 *   - 缓存标记不用手打：前缀缓存是自动的，但需要 prompt_cache_key 做路由亲和
 */

import type { Message, StopReason, Usage } from "../types.js";
import { parseSSE } from "./sse.js";
import type {
  Provider,
  ProviderConfig,
  ReasoningEffort,
  StreamEvent,
  StreamRequest,
  ThinkingFormat,
  ToolDef,
} from "./types.js";

/** 累积中的工具调用。arguments 是分片到达的 JSON 字符串。 */
interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

export class OpenAIProvider implements Provider {
  constructor(private readonly cfg: ProviderConfig) {}

  get name(): string {
    return "openai";
  }

  get model(): string {
    return this.cfg.model;
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const body = {
      model: this.cfg.model,
      messages: toOpenAIMessages(req.system, req.messages),
      ...(req.tools.length > 0 ? { tools: toOpenAITools(req.tools) } : {}),
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
      ...thinkingFields(req.reasoningEffort, resolveThinkingFormat(this.cfg)),
    };

    const base = (this.cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      yield { type: "error", message: describeHttpError(response.status, text) };
      return;
    }

    let text = "";
    let thinking = "";
    const toolCalls = new Map<number, PartialToolCall>();
    let stopReason: StopReason = "stop";
    const usage: Usage = { input: 0, output: 0 };

    for await (const frame of parseSSE(response.body)) {
      if (frame.data === "[DONE]") break;

      let payload: any;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        continue;
      }

      if (payload.error) {
        yield { type: "error", message: payload.error.message ?? "unknown stream error" };
        return;
      }

      // include_usage 会让最后一个 chunk 只带 usage、choices 为空
      if (payload.usage) {
        usage.input = payload.usage.prompt_tokens ?? 0;
        usage.output = payload.usage.completion_tokens ?? 0;
        const cached = payload.usage.prompt_tokens_details?.cached_tokens;
        if (cached) usage.cacheRead = cached;
      }

      const choice = payload.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);

      const delta = choice.delta;
      if (!delta) continue;

      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        yield { type: "text_delta", text: delta.content };
      }

      // 部分兼容服务用 reasoning_content 承载思考内容
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        thinking += reasoning;
        yield { type: "thinking_delta", text: reasoning };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = call.index ?? 0;
          const existing = toolCalls.get(index) ?? { id: "", name: "", args: "" };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name += call.function.name;
          if (call.function?.arguments) existing.args += call.function.arguments;
          toolCalls.set(index, existing);
        }
      }
    }

    const content: Message["content"] = [];
    if (thinking) content.push({ type: "thinking", text: thinking });
    if (text) content.push({ type: "text", text });
    for (const index of [...toolCalls.keys()].sort((a, b) => a - b)) {
      const call = toolCalls.get(index)!;
      if (!call.name) continue;
      content.push({
        type: "tool_call",
        // 少数兼容服务不回 id，自己补一个稳定值保证 tool_result 能配对
        id: call.id || `call_${index}`,
        name: call.name,
        args: parseToolArgs(call.args),
      });
    }

    yield {
      type: "done",
      message: { role: "assistant", content, timestamp: Date.now() },
      stopReason,
      usage,
    };
  }
}

/**
 * 推断 thinking 字段该用哪种形态。
 *
 * 这个区分不是洁癖：DeepSeek 只有收到 `thinking: {type: "disabled"}` 才真正停止思考，
 * 而 OpenAI 官方收到这个字段会直接 400。传错比不传更糟，所以宁可显式判断。
 */
function resolveThinkingFormat(cfg: ProviderConfig): Exclude<ThinkingFormat, "auto"> {
  if (cfg.thinkingFormat && cfg.thinkingFormat !== "auto") return cfg.thinkingFormat;
  // DeepSeek 的地址或模型名都含有 deepseek，任一处命中即可
  const haystack = `${cfg.baseUrl ?? ""} ${cfg.model}`.toLowerCase();
  return haystack.includes("deepseek") ? "deepseek" : "openai";
}

/**
 * 把归一化强度翻译成具体厂商的 wire 字段。
 *
 * 词表差异要注意：OpenAI 的 reasoning_effort 只有 minimal|low|medium|high，
 * 没有 max，所以 max 降级为 high；DeepSeek 有 low|high|max，可以原样传。
 */
function thinkingFields(
  effort: ReasoningEffort | undefined,
  format: Exclude<ThinkingFormat, "auto">,
): Record<string, unknown> {
  if (!effort || format === "none") return {};

  if (format === "deepseek") {
    // off 必须走 thinking.type：仅仅不发 reasoning_effort 的话，服务端默认仍是开启
    if (effort === "off") return { thinking: { type: "disabled" } };
    return { thinking: { type: "enabled" }, reasoning_effort: effort };
  }

  // openai：off 就是不表态（该服务不提供显式关闭字段）
  if (effort === "off") return {};
  return { reasoning_effort: effort === "max" ? "high" : effort };
}

/** 与 Anthropic 侧同策略：不抛异常，退化成空对象让工具层报可读错误。 */
function parseToolArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapFinishReason(raw: string): StopReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "length";
    default:
      return "stop";
  }
}

function toOpenAITools(tools: ToolDef[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function toOpenAIMessages(system: string, messages: Message[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];

  for (const message of messages) {
    const texts: string[] = [];
    const calls: unknown[] = [];
    // 思考通道的内容单独收集：它在「带工具调用的轮次」里必须回传，见下方说明
    let reasoning = "";

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          texts.push(block.text);
          break;
        case "thinking":
          reasoning += block.text;
          break;
        case "tool_call":
          calls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.args) },
          });
          break;
        case "tool_result":
          // 工具结果在 OpenAI 协议里是独立的一条 tool 消息，必须紧跟 assistant
          out.push({
            role: "tool",
            tool_call_id: block.toolCallId,
            content: block.content,
          });
          break;
      }
    }

    // tool 消息已单独入队；这里只处理这条消息自身携带的文本/调用
    if (calls.length > 0) {
      out.push({
        role: "assistant",
        // 空文本必须是 ""，不能是 null——部分网关会直接拒绝 null
        content: texts.join("") || "",
        // 思考模式的官方回传规则（deepseek guides/thinking_mode）：
        // 带工具调用的 assistant 轮次必须把 reasoning_content 原样传回，否则请求会被拒。
        // 不带工具调用的轮次它会被忽略，所以那时丢掉以省 token。
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        tool_calls: calls,
      });
    } else if (texts.length > 0) {
      out.push({ role: message.role, content: texts.join("") });
    }
  }

  return out;
}

function describeHttpError(status: number, body: string): string {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? detail;
  } catch {
    /* 保持原始文本 */
  }
  return `OpenAI API ${status}: ${detail}`;
}
