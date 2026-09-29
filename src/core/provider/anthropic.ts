/**
 * Anthropic Messages API provider。
 *
 * 关于 prompt cache 断点的布局（这是本文件里最需要想清楚的部分）：
 * 缓存命中要求「前缀逐字节相同」，所以断点必须打在稳定段的末尾。
 * 这里打三个（上限是 4 个，留一个余量）：
 *   1. 系统提示 —— 本项目的系统提示是纯静态的，会话内不变
 *   2. 最后一个工具定义 —— 工具表在会话内也不变
 *   3. 消息列表的最后一块 —— 对话是只追加的，下一轮的请求前缀就是这一轮的完整前缀
 * 第 3 个断点让长对话的每一轮都增量命中。
 *
 * 反过来说：任何「每轮都变」的内容都不能进系统提示，否则第 1 个断点永远失效。
 * 导师的笔记因此走 read_notes 工具按需读取，而不是常驻系统提示。
 */

import type { Message, StopReason, Usage } from "../types.js";
import { parseSSE } from "./sse.js";
import {
  type Provider,
  type ProviderConfig,
  type ReasoningEffort,
  type StreamEvent,
  type StreamRequest,
  type ThinkingFormat,
  type ToolDef,
} from "./types.js";

const API_VERSION = "2023-06-01";

/** 累积中的一个内容块。tool_use 的入参是分片到达的，需要一个 JSON 缓冲区。 */
type PartialBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; json: string };

export class AnthropicProvider implements Provider {
  constructor(private readonly cfg: ProviderConfig) {}

  get name(): string {
    return "anthropic";
  }

  get model(): string {
    return this.cfg.model;
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const caching = this.cfg.enableCaching !== false;
    const thinking = anthropicThinking(req.reasoningEffort, req.maxTokens, this.cfg.thinkingFormat);
    const body = {
      model: this.cfg.model,
      max_tokens: req.maxTokens,
      ...(thinking ? { thinking } : {}),
      system: caching
        ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
        : req.system,
      messages: toAnthropicMessages(req.messages, caching),
      ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools, caching) } : {}),
      stream: true,
      // 开启扩展思考时 Anthropic 要求 temperature 只能是 1，所以这时干脆不发这个字段
      ...(req.temperature !== undefined && !thinking ? { temperature: req.temperature } : {}),
    };

    const base = (this.cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      yield { type: "error", message: describeHttpError(response.status, text) };
      return;
    }

    /**
     * 有些兼容层会忽略 stream 参数，直接返回一个完整的 JSON 响应。
     * 不处理这种情况的话，SSE 解析器在非 SSE 的响应体里找不到 data: 行，
     * 会安静地什么都不产出——表现为「请求成功但没有任何返回」，非常难定位。
     */
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const body = await response.text().catch(() => "");
      const message = parseNonStreamingBody(body);
      if (!message) {
        yield {
          type: "error",
          message:
            `端点返回的不是 SSE 流（content-type: ${contentType || "未知"}），` +
            `也无法按普通 JSON 响应解析。响应开头：${body.slice(0, 300)}`,
        };
        return;
      }
      yield {
        type: "done",
        message,
        stopReason: message.content.some((b) => b.type === "tool_call") ? "tool_use" : "stop",
        usage: { input: 0, output: 0 },
      };
      return;
    }

    const blocks = new Map<number, PartialBlock>();
    let stopReason: StopReason = "stop";
    const usage: Usage = { input: 0, output: 0 };

    for await (const frame of parseSSE(response.body)) {
      if (frame.data === "[DONE]") break;

      let payload: any;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        continue; // 半截或非 JSON 的心跳，跳过
      }

      switch (payload.type) {
        case "message_start": {
          const u = payload.message?.usage ?? {};
          usage.input = u.input_tokens ?? 0;
          usage.output = u.output_tokens ?? 0;
          usage.cacheRead = u.cache_read_input_tokens ?? 0;
          usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const cb = payload.content_block;
          if (cb?.type === "text") blocks.set(payload.index, { kind: "text", text: "" });
          else if (cb?.type === "thinking")
            blocks.set(payload.index, { kind: "thinking", text: "" });
          else if (cb?.type === "tool_use")
            blocks.set(payload.index, { kind: "tool_use", id: cb.id, name: cb.name, json: "" });
          break;
        }
        case "content_block_delta": {
          let block = blocks.get(payload.index);
          const delta = payload.delta;

          /**
           * 兼容层可能不发 content_block_start、直接给 delta。原本这里遇到未知 index 就
           * `break`，于是正文被静默丢弃——正是「请求成功但没有任何返回」的成因之一。
           * 现在按 delta 类型补建块。
           *
           * input_json_delta 不补建：工具调用的 id 和 name 只在 start 事件里，
           * 缺了就配不上 tool_result，与其造一个坏调用不如跳过。
           */
          if (!block) {
            if (delta?.type === "text_delta") block = { kind: "text", text: "" };
            else if (delta?.type === "thinking_delta") block = { kind: "thinking", text: "" };
            else break;
            blocks.set(payload.index, block);
          }

          if (delta?.type === "text_delta" && block.kind === "text") {
            block.text += delta.text;
            yield { type: "text_delta", text: delta.text };
          } else if (delta?.type === "thinking_delta" && block.kind === "thinking") {
            block.text += delta.thinking;
            yield { type: "thinking_delta", text: delta.thinking };
          } else if (delta?.type === "input_json_delta" && block.kind === "tool_use") {
            block.json += delta.partial_json;
          }
          break;
        }
        case "message_delta": {
          if (payload.delta?.stop_reason) stopReason = mapStopReason(payload.delta.stop_reason);
          if (payload.usage?.output_tokens !== undefined) usage.output = payload.usage.output_tokens;
          break;
        }
        case "error": {
          yield { type: "error", message: payload.error?.message ?? "unknown stream error" };
          return;
        }
      }
    }

    yield {
      type: "done",
      message: assembleMessage(blocks),
      stopReason,
      usage,
    };
  }
}

/** 按 index 顺序还原成内容块，丢掉空块。 */
function assembleMessage(blocks: Map<number, PartialBlock>): Message {
  const content: Message["content"] = [];

  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const block = blocks.get(index)!;
    if (block.kind === "text") {
      if (block.text) content.push({ type: "text", text: block.text });
    } else if (block.kind === "thinking") {
      if (block.text) content.push({ type: "thinking", text: block.text });
    } else {
      content.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        args: parseToolArgs(block.json),
      });
    }
  }

  return { role: "assistant", content, timestamp: Date.now() };
}

/**
 * 把「声称流式、实际返回完整 JSON」的响应体解析成消息。
 *
 * 这种兼容层不常见但确实存在，而且失败方式极其隐蔽：SSE 解析器在 JSON 里找不到
 * data: 行，什么也不产出，调用方看到的是「请求成功但没有任何返回」。
 */
function parseNonStreamingBody(body: string): Message | null {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  // 兼容层可能把错误也包在 200 里
  if (parsed?.type === "error" || parsed?.error) {
    const message = parsed.error?.message ?? parsed.message ?? "未知错误";
    throw new Error(`端点返回错误：${message}`);
  }

  const raw = Array.isArray(parsed?.content) ? parsed.content : null;
  if (!raw) return null;

  const content: Message["content"] = [];
  for (const block of raw) {
    if (block?.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block?.type === "thinking" && typeof block.thinking === "string") {
      content.push({ type: "thinking", text: block.thinking });
    } else if (block?.type === "tool_use") {
      content.push({
        type: "tool_call",
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        args: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }

  return { role: "assistant", content, timestamp: Date.now() };
}


/**
 * 模型偶尔会产出不合法或空的 JSON 入参。这里不抛异常，退化成空对象——
 * 工具层会因为缺少必填参数而返回可读的错误文本给模型，让它自己纠正。
 */
function parseToolArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 把归一化强度映射成 Anthropic 的扩展思考配置。
 *
 * Anthropic 没有「强度等级」这种概念，只有 `budget_tokens`（允许思考花多少 token）。
 * 所以要给每个档位一个具体预算。约束有两条：
 *   - budget_tokens 必须 < max_tokens，否则请求直接被拒
 *   - 必须 >= 1024
 * 这里对 max_tokens 做夹取，保证不会因为用户把输出上限调小而构造出非法请求。
 */
function anthropicThinking(
  effort: ReasoningEffort | undefined,
  maxTokens: number,
  format: ThinkingFormat | undefined,
): { type: "enabled"; budget_tokens: number } | undefined {
  // 显式声明该端点不认 thinking 字段时，一个都不发
  if (format === "none" || effort === undefined || effort === "off") return undefined;

  const desired = effort === "low" ? 2048 : effort === "high" ? 8192 : 16384;
  // 留 1024 给正文，且不低于 Anthropic 的下限
  const budget = Math.max(1024, Math.min(desired, maxTokens - 1024));
  return { type: "enabled", budget_tokens: budget };
}

function mapStopReason(raw: string): StopReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

function toAnthropicTools(tools: ToolDef[], caching: boolean): unknown[] {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    // 断点打在最后一个工具上，覆盖整张工具表
    ...(caching && index === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }));
}

/**
 * 转换消息格式，并做两件必要的事：
 *   - 丢掉内容为空的消息（Anthropic 会拒绝空 content 数组）
 *   - 合并相邻的同角色消息（工具结果和后续用户输入都是 user 角色）
 */
function toAnthropicMessages(messages: Message[], caching: boolean): unknown[] {
  const out: Array<{ role: string; content: any[] }> = [];

  for (const message of messages) {
    const content: any[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.text) content.push({ type: "text", text: block.text });
          break;
        case "thinking":
          // 历史里的思考块不回收给模型：Anthropic 要求 thinking 块与其签名配对，
          // 而我们不持久化签名，重放会被拒绝。思考的价值在于生成当时。
          break;
        case "tool_call":
          content.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.args,
          });
          break;
        case "tool_result":
          content.push({
            type: "tool_result",
            tool_use_id: block.toolCallId,
            content: block.content,
            ...(block.isError ? { is_error: true } : {}),
          });
          break;
      }
    }

    if (content.length === 0) continue;

    const previous = out[out.length - 1];
    if (previous && previous.role === message.role) {
      previous.content.push(...content);
    } else {
      out.push({ role: message.role, content });
    }
  }

  // 断点打在最后一条消息的最后一个块上，让下一轮请求的前缀命中
  if (caching && out.length > 0) {
    const last = out[out.length - 1]!;
    const lastBlock = last.content[last.content.length - 1];
    if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };
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
  return `Anthropic API ${status}: ${detail}`;
}
