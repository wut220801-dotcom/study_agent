"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../src/core/provider/sse.ts
async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame) yield frame;
      boundary = buffer.indexOf("\n\n");
    }
  }
  const tail = parseFrame(buffer);
  if (tail) yield tail;
}
function parseFrame(raw) {
  let event;
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
var init_sse = __esm({
  "../src/core/provider/sse.ts"() {
    "use strict";
  }
});

// ../src/core/provider/types.ts
var init_types = __esm({
  "../src/core/provider/types.ts"() {
    "use strict";
  }
});

// ../src/core/provider/anthropic.ts
function assembleMessage(blocks) {
  const content = [];
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const block = blocks.get(index);
    if (block.kind === "text") {
      if (block.text) content.push({ type: "text", text: block.text });
    } else if (block.kind === "thinking") {
      if (block.text) content.push({ type: "thinking", text: block.text });
    } else {
      content.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        args: parseToolArgs(block.json)
      });
    }
  }
  return { role: "assistant", content, timestamp: Date.now() };
}
function parseNonStreamingBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed?.type === "error" || parsed?.error) {
    const message = parsed.error?.message ?? parsed.message ?? "未知错误";
    throw new Error(`端点返回错误：${message}`);
  }
  const raw = Array.isArray(parsed?.content) ? parsed.content : null;
  if (!raw) return null;
  const content = [];
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
        args: block.input ?? {}
      });
    }
  }
  return { role: "assistant", content, timestamp: Date.now() };
}
function parseToolArgs(json) {
  if (!json.trim()) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function anthropicThinking(effort, maxTokens, format) {
  if (format === "none" || effort === void 0 || effort === "off") return void 0;
  const desired = effort === "low" ? 2048 : effort === "high" ? 8192 : 16384;
  const budget = Math.max(1024, Math.min(desired, maxTokens - 1024));
  return { type: "enabled", budget_tokens: budget };
}
function mapStopReason(raw) {
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
function toAnthropicTools(tools, caching) {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    // 断点打在最后一个工具上，覆盖整张工具表
    ...caching && index === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}
  }));
}
function toAnthropicMessages(messages, caching) {
  const out = [];
  for (const message of messages) {
    const content = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.text) content.push({ type: "text", text: block.text });
          break;
        case "thinking":
          break;
        case "tool_call":
          content.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.args
          });
          break;
        case "tool_result":
          content.push({
            type: "tool_result",
            tool_use_id: block.toolCallId,
            content: block.content,
            ...block.isError ? { is_error: true } : {}
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
  if (caching && out.length > 0) {
    const last = out[out.length - 1];
    const lastBlock = last.content[last.content.length - 1];
    if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };
  }
  return out;
}
function describeHttpError(status, body) {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? detail;
  } catch {
  }
  return `Anthropic API ${status}: ${detail}`;
}
var API_VERSION, AnthropicProvider;
var init_anthropic = __esm({
  "../src/core/provider/anthropic.ts"() {
    "use strict";
    init_sse();
    init_types();
    API_VERSION = "2023-06-01";
    AnthropicProvider = class {
      constructor(cfg) {
        this.cfg = cfg;
      }
      get name() {
        return "anthropic";
      }
      get model() {
        return this.cfg.model;
      }
      async *stream(req) {
        const caching = this.cfg.enableCaching !== false;
        const thinking = anthropicThinking(req.reasoningEffort, req.maxTokens, this.cfg.thinkingFormat);
        const body = {
          model: this.cfg.model,
          max_tokens: req.maxTokens,
          ...thinking ? { thinking } : {},
          system: caching ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] : req.system,
          messages: toAnthropicMessages(req.messages, caching),
          ...req.tools.length > 0 ? { tools: toAnthropicTools(req.tools, caching) } : {},
          stream: true,
          // 开启扩展思考时 Anthropic 要求 temperature 只能是 1，所以这时干脆不发这个字段
          ...req.temperature !== void 0 && !thinking ? { temperature: req.temperature } : {}
        };
        const base = (this.cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
        const response = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.cfg.apiKey,
            "anthropic-version": API_VERSION
          },
          body: JSON.stringify(body),
          ...req.signal ? { signal: req.signal } : {}
        });
        if (!response.ok || !response.body) {
          const text = await response.text().catch(() => "");
          yield { type: "error", message: describeHttpError(response.status, text) };
          return;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const body2 = await response.text().catch(() => "");
          const message = parseNonStreamingBody(body2);
          if (!message) {
            yield {
              type: "error",
              message: `端点返回的不是 SSE 流（content-type: ${contentType || "未知"}），也无法按普通 JSON 响应解析。响应开头：${body2.slice(0, 300)}`
            };
            return;
          }
          yield {
            type: "done",
            message,
            stopReason: message.content.some((b) => b.type === "tool_call") ? "tool_use" : "stop",
            usage: { input: 0, output: 0 }
          };
          return;
        }
        const blocks = /* @__PURE__ */ new Map();
        let stopReason = "stop";
        const usage = { input: 0, output: 0 };
        for await (const frame of parseSSE(response.body)) {
          if (frame.data === "[DONE]") break;
          let payload;
          try {
            payload = JSON.parse(frame.data);
          } catch {
            continue;
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
              if (payload.usage?.output_tokens !== void 0) usage.output = payload.usage.output_tokens;
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
          usage
        };
      }
    };
  }
});

// ../src/core/provider/openai.ts
function resolveThinkingFormat(cfg) {
  if (cfg.thinkingFormat && cfg.thinkingFormat !== "auto") return cfg.thinkingFormat;
  const haystack = `${cfg.baseUrl ?? ""} ${cfg.model}`.toLowerCase();
  return haystack.includes("deepseek") ? "deepseek" : "openai";
}
function thinkingFields(effort, format) {
  if (!effort || format === "none") return {};
  if (format === "deepseek") {
    if (effort === "off") return { thinking: { type: "disabled" } };
    return { thinking: { type: "enabled" }, reasoning_effort: effort };
  }
  if (effort === "off") return {};
  return { reasoning_effort: effort === "max" ? "high" : effort };
}
function parseToolArgs2(json) {
  if (!json.trim()) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function mapFinishReason(raw) {
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
function toOpenAITools(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}
function toOpenAIMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const message of messages) {
    const texts = [];
    const calls = [];
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
            function: { name: block.name, arguments: JSON.stringify(block.args) }
          });
          break;
        case "tool_result":
          out.push({
            role: "tool",
            tool_call_id: block.toolCallId,
            content: block.content
          });
          break;
      }
    }
    if (calls.length > 0) {
      out.push({
        role: "assistant",
        // 空文本必须是 ""，不能是 null——部分网关会直接拒绝 null
        content: texts.join("") || "",
        // 思考模式的官方回传规则（deepseek guides/thinking_mode）：
        // 带工具调用的 assistant 轮次必须把 reasoning_content 原样传回，否则请求会被拒。
        // 不带工具调用的轮次它会被忽略，所以那时丢掉以省 token。
        ...reasoning ? { reasoning_content: reasoning } : {},
        tool_calls: calls
      });
    } else if (texts.length > 0) {
      out.push({ role: message.role, content: texts.join("") });
    }
  }
  return out;
}
function describeHttpError2(status, body) {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? detail;
  } catch {
  }
  return `OpenAI API ${status}: ${detail}`;
}
var OpenAIProvider;
var init_openai = __esm({
  "../src/core/provider/openai.ts"() {
    "use strict";
    init_sse();
    OpenAIProvider = class {
      constructor(cfg) {
        this.cfg = cfg;
      }
      get name() {
        return "openai";
      }
      get model() {
        return this.cfg.model;
      }
      async *stream(req) {
        const body = {
          model: this.cfg.model,
          messages: toOpenAIMessages(req.system, req.messages),
          ...req.tools.length > 0 ? { tools: toOpenAITools(req.tools) } : {},
          max_tokens: req.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...req.temperature !== void 0 ? { temperature: req.temperature } : {},
          ...req.cacheKey ? { prompt_cache_key: req.cacheKey } : {},
          ...thinkingFields(req.reasoningEffort, resolveThinkingFormat(this.cfg))
        };
        const base = (this.cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
        const response = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.cfg.apiKey}`
          },
          body: JSON.stringify(body),
          ...req.signal ? { signal: req.signal } : {}
        });
        if (!response.ok || !response.body) {
          const text2 = await response.text().catch(() => "");
          yield { type: "error", message: describeHttpError2(response.status, text2) };
          return;
        }
        let text = "";
        let thinking = "";
        const toolCalls = /* @__PURE__ */ new Map();
        let stopReason = "stop";
        const usage = { input: 0, output: 0 };
        for await (const frame of parseSSE(response.body)) {
          if (frame.data === "[DONE]") break;
          let payload;
          try {
            payload = JSON.parse(frame.data);
          } catch {
            continue;
          }
          if (payload.error) {
            yield { type: "error", message: payload.error.message ?? "unknown stream error" };
            return;
          }
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
        const content = [];
        if (thinking) content.push({ type: "thinking", text: thinking });
        if (text) content.push({ type: "text", text });
        for (const index of [...toolCalls.keys()].sort((a, b) => a - b)) {
          const call = toolCalls.get(index);
          if (!call.name) continue;
          content.push({
            type: "tool_call",
            // 少数兼容服务不回 id，自己补一个稳定值保证 tool_result 能配对
            id: call.id || `call_${index}`,
            name: call.name,
            args: parseToolArgs2(call.args)
          });
        }
        yield {
          type: "done",
          message: { role: "assistant", content, timestamp: Date.now() },
          stopReason,
          usage
        };
      }
    };
  }
});

// ../src/core/provider/mock.ts
var MockProvider;
var init_mock = __esm({
  "../src/core/provider/mock.ts"() {
    "use strict";
    MockProvider = class {
      constructor(model = "mock-demo") {
        this.model = model;
      }
      name = "mock";
      /** 记录每个会话已经跑过几轮，用来让桩数据有递进感 */
      turns = /* @__PURE__ */ new Map();
      async *stream(req) {
        const key = req.cacheKey ?? "default";
        const turn = this.turns.get(key) ?? 0;
        this.turns.set(key, turn + 1);
        const toolNames = new Set(req.tools.map((t) => t.name));
        let text = "";
        let toolCalls = [];
        if (req.tools.length === 0) {
          text = await this.compressionText(req);
        } else if (toolNames.has("add_knowledge_point")) {
          ({ text, toolCalls } = this.plannerTurn(req, turn));
        } else if (toolNames.has("save_note")) {
          ({ text, toolCalls } = this.tutorTurn(req, turn));
        } else {
          text = "【示例模式】当前没有匹配的桩数据。配置真实 API key 后可获得完整能力。";
        }
        const content = [];
        if (text) {
          content.push({ type: "text", text });
          yield { type: "text_delta", text };
        }
        toolCalls.forEach((call, index) => {
          content.push({ type: "tool_call", id: `mock_${key}_${turn}_${index}`, name: call.name, args: call.args });
        });
        const usage = { input: 800, output: 200 };
        yield {
          type: "done",
          message: { role: "assistant", content, timestamp: Date.now() },
          stopReason: toolCalls.length > 0 ? "tool_use" : "stop",
          usage
        };
      }
      /** 规划师：第一轮拆出三个知识点，之后给文字建议。 */
      plannerTurn(req, turn) {
        if (turn > 0) {
          return {
            text: [
              "【示例模式】大纲已经有节点了。",
              "",
              "这是演示用的桩输出，用来验证界面和流程。配置真实 API key 后，我会真正读懂你的目标、按依赖关系拆解知识点，并根据导师的进度报告调整计划。",
              "",
              "你可以先去左边点开一个知识点，和导师聊两句——那边会用桩数据模拟教学、记笔记和上报。"
            ].join("\n"),
            toolCalls: []
          };
        }
        const topic = this.extractTopic(req) ?? "这个主题";
        return {
          text: [
            `【示例模式】我来为「${topic}」搭一个大纲框架。`,
            "",
            "演示模式会固定拆出三个知识点，主要为了让后面的环节有东西可跑。",
            "真实模式下我会先问清楚你的目的和现有水平再动手。"
          ].join("\n"),
          toolCalls: [
            {
              name: "set_learning_goal",
              args: {
                topic: `${topic}（示例大纲）`,
                learner_profile: "【示例】演示模式下的占位画像。真实模式会根据对话内容填写。"
              }
            },
            {
              name: "add_knowledge_point",
              args: {
                title: `${topic}·基础概念`,
                objectives: [`能用自己的话解释${topic}要解决的核心问题`, `能说出它最基本的两三个术语的含义`],
                methods: ["explain"],
                rationale: "先建立共同语言，后面的内容都要用到这些术语。"
              }
            },
            {
              name: "add_knowledge_point",
              args: {
                title: `${topic}·核心机制`,
                objectives: [`能说明它的工作原理`, `能预测改动某个部分会产生什么影响`],
                methods: ["explain", "practice"],
                rationale: "这是整个主题的主干，最需要动手练。"
              }
            },
            {
              name: "add_knowledge_point",
              args: {
                title: `${topic}·实际应用`,
                objectives: [`能在真实场景中判断什么时候该用它`, `能识别常见误用`],
                methods: ["practice", "discuss"],
                rationale: "把知识变成能用的判断力，这一步最容易跳过。"
              }
            }
          ]
        };
      }
      /** 导师：讲一段、记一笔；中途上报一次进度，然后自然收尾。 */
      tutorTurn(req, turn) {
        const title = this.extractTutorTitle(req) ?? "这个知识点";
        if (turn >= 4) {
          return {
            text: [
              "【示例模式】上面几轮已经演示了完整的机制：",
              "",
              "- **记笔记**：写进了右侧的「学习笔记」，那是属于你的资产；",
              "- **上报进度**：规划师收到了状态，但收不到我们具体聊了什么；",
              "- **知识点注入**：到顶栏的「注入」页，可以把这里的笔记压缩后投给别的知识点。",
              "",
              "现在换你说。配置真实 API key 后，这里会是真正的教学对话。"
            ].join("\n"),
            toolCalls: []
          };
        }
        const toolCalls = [
          {
            name: "save_note",
            args: {
              section: "核心概念",
              content: `【示例笔记】第 ${turn + 1} 轮讲解的要点。

真实模式下这里会是导师针对你的理解程度整理的内容，包括定义、例子和你容易混淆的地方。`
            }
          }
        ];
        if (turn === 2) {
          toolCalls.push({
            name: "report_progress",
            args: {
              status: "learning",
              summary: `【示例报告】学习者对${title}的基础部分已经理顺，正在进入应用环节。`,
              suggested_next: [
                {
                  title: `${title}的常见误用`,
                  reason: "一线教学里发现这类错误最影响实际使用。"
                }
              ]
            }
          });
        }
        return {
          text: [
            `【示例模式】我们在学「${title}」。这是第 ${turn + 1} 轮。`,
            "",
            "演示模式下我只能给固定内容，但完整的机制都在跑——我把要点记进了右侧的**学习笔记**，也向规划师**上报了进度**（只报状态，不报我们聊了什么）。",
            "",
            "你可以先在这里聊几轮，然后去「注入」页试试把内容投给别的知识点。"
          ].join("\n"),
          toolCalls
        };
      }
      async compressionText(req) {
        const source = this.sliceBetween(req.messages, "<source_notes", "</source_notes>");
        const heading = source ? source.split("\n")[0]?.slice(0, 60) : "";
        return [
          "## 来自前置知识点的要点",
          "",
          "【示例压缩】真实模式下，这里会是按目标知识点重新组织过的前置知识，",
          "只保留理解新知识点必需的部分，而不会照搬源笔记。",
          "",
          heading ? `源笔记的开头是：${heading}` : ""
        ].filter(Boolean).join("\n");
      }
      /** 从用户消息里猜一个主题名，让演示输出看起来贴近实际输入。 */
      extractTopic(req) {
        for (let i = req.messages.length - 1; i >= 0; i--) {
          const message = req.messages[i];
          if (message.role !== "user") continue;
          const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
          if (!text) continue;
          const firstClause = text.split(/[，。！？\n,.]/)[0]?.trim() ?? "";
          return firstClause.slice(0, 24) || null;
        }
        return null;
      }
      extractTutorTitle(req) {
        const match = /\*\*(.+?)\*\*（编号/.exec(req.system);
        return match?.[1] ?? null;
      }
      sliceBetween(messages, start, end) {
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
    };
  }
});

// ../src/core/provider/index.ts
function anthropicProvider(config) {
  return new AnthropicProvider(config);
}
function openaiProvider(config) {
  return new OpenAIProvider(config);
}
function createProvider(config) {
  switch (config.kind) {
    case "anthropic":
      return anthropicProvider(config);
    case "openai":
      return openaiProvider(config);
    case "mock":
      return new MockProvider(config.model);
  }
}
var init_provider = __esm({
  "../src/core/provider/index.ts"() {
    "use strict";
    init_anthropic();
    init_openai();
    init_mock();
  }
});

// ../src/server/probe.ts
var probe_exports = {};
__export(probe_exports, {
  probeProvider: () => probeProvider
});
async function probeProvider(cfg) {
  let provider;
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
        { role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() }
      ],
      tools: [],
      maxTokens: PROBE_MAX_TOKENS,
      // 探针只关心连通性，关掉思考可以省掉一次真实费用，也让「有没有正文」这个
      // 判断信号更干净（参考 deepseek-harness 对会话标题的处理）
      reasoningEffort: "off"
    });
    let text = "";
    let thinking = "";
    let stopReason = "stop";
    let usage = { input: 0, output: 0 };
    let sawError;
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
      usage
    };
    if (sawError) {
      return { ok: false, message: sawError, observed };
    }
    if (text.trim()) {
      return {
        ok: true,
        message: `连接正常。模型回复：${text.trim().slice(0, 60)}（用量 ${usage.input}/${usage.output} tokens）`,
        observed
      };
    }
    if (thinking || usage.input > 0 || usage.output > 0) {
      return {
        ok: true,
        message: `连接正常（用量 ${usage.input}/${usage.output} tokens）。` + (thinking ? `模型只返回了思考内容${stopReason === "length" ? "，且输出预算已被思考用尽" : ""}——这说明它的 thinking 是默认开启的，配置本身没问题。` : ""),
        observed
      };
    }
    return {
      ok: false,
      message: `请求到达了端点，但没有收到任何内容或用量。检查模型名「${cfg.model}」是否在 ${cfg.baseUrl ?? "该服务"} 上存在。`,
      observed
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
var PROBE_MAX_TOKENS;
var init_probe = __esm({
  "../src/server/probe.ts"() {
    "use strict";
    init_provider();
    PROBE_MAX_TOKENS = 512;
  }
});

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => LearnAgentPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian8 = require("obsidian");

// ../src/learn/obsidian.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// ../src/learn/types.ts
var METHOD_LABELS = {
  explain: "讲解",
  practice: "练习",
  discuss: "讨论",
  review: "复盘"
};
var STATUS_LABELS = {
  pending: "未开始",
  learning: "学习中",
  mastered: "已掌握",
  review: "待复习"
};
function tutorSessionId(nodeId) {
  return `tutor-${nodeId}`;
}
var PLANNER_SESSION_ID = "planner";

// ../src/learn/notes.ts
var import_node_crypto = require("node:crypto");
var NOTE_SECTIONS = [
  "核心概念",
  "关键要点",
  "例题与练习",
  "疑问与澄清",
  "回顾"
];
function readNotes(workspace, nodeId) {
  return workspace.readText(workspace.notePath(nodeId)).trim();
}
function hasNotes(workspace, nodeId) {
  return readNotes(workspace, nodeId).length > 0;
}
function writeNoteSection(workspace, nodeId, section, content, mode = "append") {
  const body = content.trim();
  if (!body) return;
  const existing = readNotes(workspace, nodeId);
  const sections = parseSections(existing);
  const index = sections.findIndex((s) => s.title === section);
  if (index === -1) {
    sections.push({ title: section, body });
  } else {
    const current = sections[index];
    sections[index] = {
      title: current.title,
      body: mode === "append" && current.body ? `${current.body}

${body}` : body
    };
  }
  workspace.writeText(workspace.notePath(nodeId), renderSections(sections));
}
function appendCompactionToNotes(workspace, nodeId, summary) {
  const stamp = (/* @__PURE__ */ new Date()).toLocaleString("zh-CN");
  writeNoteSection(workspace, nodeId, "回顾", `_（${stamp} 自动归档）_

${summary}`, "append");
}
function notesHash(content) {
  return (0, import_node_crypto.createHash)("sha256").update(content).digest("hex").slice(0, 16);
}
function parseSections(markdown) {
  const sections = [];
  let current = null;
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1], body: "" };
      sections.push(current);
      continue;
    }
    if (current) {
      current.body = current.body ? `${current.body}
${line}` : line;
    }
  }
  for (const section of sections) section.body = section.body.trim();
  return sections;
}
function renderSections(sections) {
  return `${sections.filter((s) => s.body).map((s) => `## ${s.title}

${s.body}`).join("\n\n")}
`;
}

// ../src/learn/obsidian.ts
var GENERATED_BY = "learn-agent";
var MARKER_KEY = "generated_by";
function isGeneratedFile(content) {
  return content.includes(`${MARKER_KEY}: ${GENERATED_BY}`);
}
var DEFAULT_OBSIDIAN_FOLDER = "学习Agent";
function inspectVault(vaultPath) {
  if (!vaultPath.trim()) return { ok: false, error: "没有填写库路径" };
  if (!(0, import_node_fs.existsSync)(vaultPath)) return { ok: false, error: `路径不存在：${vaultPath}` };
  if (!(0, import_node_fs.existsSync)((0, import_node_path.join)(vaultPath, ".obsidian"))) {
    return {
      ok: false,
      error: `这个目录里没有 .obsidian 文件夹，看起来不是 Obsidian 库。请填库的根目录（就是能看到 .obsidian 的那一层）。`
    };
  }
  return { ok: true };
}
function exportToObsidian(options) {
  const { workspace, curriculum, settings } = options;
  const vaultPath = settings.vaultPath?.trim();
  if (!vaultPath) {
    return { ok: false, written: [], skipped: [], error: "没有配置 Obsidian 库路径", exportedAt: Date.now() };
  }
  const probe = inspectVault(vaultPath);
  if (!probe.ok) {
    return { ok: false, written: [], skipped: [], error: probe.error, exportedAt: Date.now() };
  }
  const folder = settings.folder?.trim() || DEFAULT_OBSIDIAN_FOLDER;
  const files = renderVaultFiles(curriculum, workspace, folder);
  const written = [];
  const skipped = [];
  try {
    (0, import_node_fs.mkdirSync)(targetDirFor(vaultPath, files), { recursive: true });
    for (const [relative, content] of files) {
      if (writeGuarded((0, import_node_path.join)(vaultPath, relative), content, relative, skipped)) {
        written.push(relative);
      }
    }
    return { ok: true, written, skipped, exportedAt: Date.now() };
  } catch (error) {
    return {
      ok: false,
      written,
      skipped,
      error: error instanceof Error ? error.message : String(error),
      exportedAt: Date.now()
    };
  }
}
function renderVaultFiles(curriculum, workspace, folder) {
  const safeFolder = sanitizeSegment(folder.trim() || DEFAULT_OBSIDIAN_FOLDER);
  const files = /* @__PURE__ */ new Map();
  for (const node of curriculum.nodes) {
    const filename = `${sanitizeSegment(node.id)} ${sanitizeSegment(node.title)}.md`;
    files.set(`${safeFolder}/${filename}`, renderNodeFile(node, curriculum, workspace));
  }
  const indexName = `${sanitizeSegment(indexTitle(curriculum))}.md`;
  files.set(`${safeFolder}/${indexName}`, renderIndexFile(curriculum, workspace));
  return files;
}
function targetDirFor(vaultPath, files) {
  const first = files.keys().next().value;
  if (!first) return vaultPath;
  const parts = first.split("/");
  parts.pop();
  return (0, import_node_path.join)(vaultPath, ...parts);
}
function writeGuarded(absolutePath, content, relativeForReport, skipped) {
  if ((0, import_node_fs.existsSync)(absolutePath)) {
    let existing = "";
    try {
      existing = (0, import_node_fs.readFileSync)(absolutePath, "utf8");
    } catch {
    }
    if (!isGeneratedFile(existing)) {
      skipped.push({
        path: relativeForReport,
        reason: "同名文件已存在且不是本工具生成的，已跳过以免覆盖你自己的笔记"
      });
      return false;
    }
  }
  (0, import_node_fs.writeFileSync)(absolutePath, content, "utf8");
  return true;
}
function renderNodeFile(node, curriculum, workspace) {
  const notes = readNotes(workspace, node.id);
  const reports = workspace.readLines(workspace.reportPath(node.id));
  const front = [
    "---",
    `${MARKER_KEY}: ${GENERATED_BY}`,
    `id: ${node.id}`,
    `title: ${yamlString(node.title)}`,
    `status: ${node.status}`,
    `methods: [${node.methods.map((m) => METHOD_LABELS[m]).join(", ")}]`,
    `objectives: ${node.objectives.length}`,
    `curriculum: ${yamlString(indexTitle(curriculum))}`,
    `updated: ${(/* @__PURE__ */ new Date()).toISOString()}`
  ];
  if (node.prerequisites.length > 0) {
    front.push(
      `prerequisites: [${node.prerequisites.map((p) => yamlString(linkFor(curriculum, p))).join(", ")}]`
    );
  }
  front.push("---");
  const parts = [front.join("\n"), "", `# ${node.title}`, ""];
  parts.push(`> 所属大纲：[[${sanitizeSegment(indexTitle(curriculum))}]]`);
  parts.push("");
  if (node.objectives.length > 0) {
    parts.push("## 学习目标", "");
    for (const objective of node.objectives) parts.push(`- ${objective}`);
    parts.push("");
  }
  if (node.prerequisites.length > 0) {
    parts.push("## 先修知识", "");
    for (const prerequisite of node.prerequisites) {
      parts.push(`- [[${linkFor(curriculum, prerequisite)}]]`);
    }
    parts.push("");
  }
  parts.push(`## 学习方法`, "", node.methods.map((m) => METHOD_LABELS[m]).join("、"), "");
  parts.push("## 学习笔记", "");
  parts.push(notes || "_（导师还没有写笔记）_");
  parts.push("");
  if (reports.length > 0) {
    parts.push("## 学习进展", "");
    for (const report of [...reports].reverse()) {
      const when = new Date(report.ts).toLocaleDateString("zh-CN");
      parts.push(`- **${when}**（${STATUS_LABELS[report.status]}）${report.summary}`);
    }
    parts.push("");
  }
  return `${parts.join("\n").trimEnd()}
`;
}
function renderIndexFile(curriculum, workspace) {
  const nodes = curriculum.nodes;
  const mastered = nodes.filter((n) => n.status === "mastered").length;
  const front = [
    "---",
    `${MARKER_KEY}: ${GENERATED_BY}`,
    `topic: ${yamlString(indexTitle(curriculum))}`,
    `nodes: ${nodes.length}`,
    `mastered: ${mastered}`,
    `updated: ${(/* @__PURE__ */ new Date()).toISOString()}`,
    "---"
  ];
  const parts = [front.join("\n"), "", `# ${indexTitle(curriculum)}`, ""];
  if (curriculum.learnerProfile.trim()) {
    parts.push("## 学习者画像", "", curriculum.learnerProfile.trim(), "");
  }
  parts.push("## 进度", "", `${mastered} / ${nodes.length} 个知识点已掌握`, "");
  if (nodes.length === 0) {
    parts.push("_（大纲还是空的）_", "");
    return `${parts.join("\n").trimEnd()}
`;
  }
  parts.push("## 知识点", "");
  parts.push("| 知识点 | 状态 | 方法 | 先修 |");
  parts.push("| --- | --- | --- | --- |");
  for (const node of nodes) {
    const prerequisites = node.prerequisites.length > 0 ? node.prerequisites.map((p) => `[[${linkFor(curriculum, p)}]]`).join("、") : "—";
    parts.push(
      `| [[${linkFor(curriculum, node.id)}]] | ${STATUS_LABELS[node.status]} | ${node.methods.map((m) => METHOD_LABELS[m]).join("、")} | ${prerequisites} |`
    );
  }
  parts.push("");
  const withReports = nodes.map((node) => ({
    node,
    reports: workspace.readLines(workspace.reportPath(node.id))
  })).filter((entry) => entry.reports.length > 0);
  if (withReports.length > 0) {
    parts.push("## 导师报告", "");
    for (const { node, reports } of withReports) {
      const latest = reports[reports.length - 1];
      const when = new Date(latest.ts).toLocaleDateString("zh-CN");
      parts.push(`### [[${linkFor(curriculum, node.id)}]]`, "");
      parts.push(`${when}（${STATUS_LABELS[latest.status]}）：${latest.summary}`, "");
    }
  }
  return `${parts.join("\n").trimEnd()}
`;
}
function indexTitle(curriculum) {
  const topic = curriculum.topic.trim();
  if (!topic || topic.startsWith("(") || topic.startsWith("（")) return "学习大纲";
  return topic;
}
function linkFor(curriculum, nodeId) {
  const node = curriculum.nodes.find((n) => n.id === nodeId);
  if (!node) return sanitizeSegment(nodeId);
  return `${sanitizeSegment(node.id)} ${sanitizeSegment(node.title)}`;
}
function sanitizeSegment(value) {
  return value.replace(/[/\\:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
}
function yamlString(value) {
  if (value === "") return '""';
  return /[:#"'\[\]{}&*!|>%@`,]/.test(value) || value.startsWith(" ") || value.endsWith(" ") ? JSON.stringify(value) : value;
}

// src/vault.ts
var import_obsidian = require("obsidian");
var HIDDEN_PREFIXES = [".obsidian", ".trash", ".git"];
function isHidden(path) {
  return HIDDEN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
function createVaultAccess(app) {
  return {
    async describe(path, maxEntries) {
      const target = path.trim();
      const root = target ? app.vault.getAbstractFileByPath(target) : app.vault.getRoot();
      if (!root) {
        return `找不到目录「${target}」。可以用不带参数的调用先看看库的顶层结构。`;
      }
      if (!(root instanceof import_obsidian.TFolder)) {
        return `「${target}」不是目录。用 read_vault_note 读单个文件。`;
      }
      const lines = [];
      const where = target || "（库根目录）";
      lines.push(`# ${where}`);
      lines.push("");
      let count = 0;
      let truncated = false;
      const folders = [];
      const files = [];
      for (const child of root.children) {
        if (isHidden(child.path)) continue;
        if (count >= maxEntries) {
          truncated = true;
          break;
        }
        if (child instanceof import_obsidian.TFolder) {
          const inner = child.children.filter((c) => !isHidden(c.path)).length;
          folders.push(`📁 ${child.name}/  （${inner} 项）`);
        } else if (child instanceof import_obsidian.TFile && child.extension === "md") {
          files.push(`📄 ${child.name}`);
        }
        count++;
      }
      if (folders.length > 0) {
        lines.push("## 文件夹");
        lines.push(...folders);
        lines.push("");
      }
      if (files.length > 0) {
        lines.push("## 笔记");
        lines.push(...files);
      }
      if (folders.length === 0 && files.length === 0) {
        lines.push("_（空目录）_");
      }
      if (truncated) {
        lines.push("", `_（已截断，只显示了前 ${maxEntries} 项。可以指定更具体的子目录再看。）_`);
      }
      return lines.join("\n");
    },
    async read(path, maxChars) {
      const target = path.trim();
      if (isHidden(target)) return "这个路径不可访问。";
      const file = app.vault.getAbstractFileByPath(target);
      if (!file) {
        return `找不到「${target}」。路径要相对库根，并且带 .md 后缀。`;
      }
      if (!(file instanceof import_obsidian.TFile)) {
        return `「${target}」是目录不是笔记。用 list_vault_structure 看它的内容。`;
      }
      if (file.extension !== "md") {
        return `只支持读 markdown 笔记，「${target}」是 .${file.extension} 文件。`;
      }
      const content = await app.vault.cachedRead(file);
      if (content.length <= maxChars) return content;
      return content.slice(0, maxChars) + `

[... 已截断，原文共 ${content.length} 字符。需要看后面部分的话，让学习者打开这篇笔记，或者你分段追问。]`;
    }
  };
}
function listVaultFolders(app) {
  const folders = [];
  const walk = (folder) => {
    for (const child of folder.children) {
      if (child instanceof import_obsidian.TFolder && !isHidden(child.path)) {
        folders.push(child.path);
        walk(child);
      }
    }
  };
  walk(app.vault.getRoot());
  return folders.sort((a, b) => a.localeCompare(b, "zh"));
}
async function ensureFolder(app, path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  let created = false;
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (!existing) {
      await app.vault.createFolder(current).catch(() => void 0);
      created = true;
    }
  }
  return created;
}

// src/bootstrap.ts
var import_obsidian3 = require("obsidian");

// ../src/learn/prompts.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
var import_node_url = require("node:url");
var import_meta = {};
var cache = /* @__PURE__ */ new Map();
function promptsDir() {
  return (0, import_node_path2.join)((0, import_node_path2.dirname)((0, import_node_url.fileURLToPath)(import_meta.url)), "prompts");
}
var overrides = /* @__PURE__ */ new Map();
function setPromptOverrides(next) {
  for (const [name, text] of Object.entries(next)) {
    overrides.set(name, text.trim());
  }
}
function loadPrompt(name) {
  const injected = overrides.get(name);
  if (injected !== void 0) return injected;
  const cached = cache.get(name);
  if (cached !== void 0) return cached;
  const text = (0, import_node_fs2.readFileSync)((0, import_node_path2.join)(promptsDir(), `${name}.md`), "utf8").trim();
  cache.set(name, text);
  return text;
}

// ../src/core/session.ts
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var import_node_crypto2 = require("node:crypto");

// ../src/core/types.ts
function userText(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function assistantText(text) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
}
function toolResultMessage(results) {
  return { role: "user", content: results, timestamp: Date.now() };
}
function toolCallsOf(message) {
  return message.content.filter((b) => b.type === "tool_call");
}
function estimateTokens(text) {
  return Math.ceil(text.length / 3);
}
function estimateMessageTokens(message) {
  let total = 4;
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        total += estimateTokens(block.text);
        break;
      case "thinking":
        total += estimateTokens(block.text);
        break;
      case "tool_call":
        total += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.args));
        break;
      case "tool_result":
        total += estimateTokens(block.content);
        break;
    }
  }
  return total;
}
function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ../src/core/session.ts
var COMPACTION_PREFIX = "以下是此前对话被压缩后的摘要，作为已确立的背景使用，不要复述：\n\n<summary>\n";
var COMPACTION_SUFFIX = "\n</summary>";
var Session = class _Session {
  constructor(options) {
    this.options = options;
  }
  entries = [];
  leafId = null;
  byId = /* @__PURE__ */ new Map();
  get id() {
    return this.options.id;
  }
  get currentLeafId() {
    return this.leafId;
  }
  /** 当前分支（root → leaf，按时间顺序）。历史条目在树里仍可达，只是不在当前分支上。 */
  branch() {
    const path = [];
    let cursor = this.leafId;
    while (cursor) {
      const entry = this.byId.get(cursor);
      if (!entry) break;
      path.push(entry);
      cursor = entry.parentId;
    }
    return path.reverse();
  }
  appendMessage(message) {
    return this.appendEntry({ ...this.entryBase(), type: "message", message });
  }
  appendCustom(customType, data, inContext) {
    return this.appendEntry({ ...this.entryBase(), type: "custom", customType, data, inContext });
  }
  appendCompaction(summary, retainedTail, tokensBefore) {
    return this.appendEntry({
      ...this.entryBase(),
      type: "compaction",
      summary,
      retainedTail,
      tokensBefore
    });
  }
  /** 追加前先取一次基字段——leafId 会在 appendEntry 里被改写。 */
  entryBase() {
    return { id: (0, import_node_crypto2.randomUUID)(), parentId: this.leafId, ts: Date.now() };
  }
  appendEntry(entry) {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.persist(entry);
    return entry;
  }
  /**
   * 移动游标。用来撤销注入或重试某一轮——被跳过的条目留在文件里，
   * 只是不再出现在当前分支上。
   */
  navigateTo(entryId) {
    if (entryId !== null && !this.byId.has(entryId)) {
      throw new Error(`entry not found: ${entryId}`);
    }
    this.leafId = entryId;
    this.persistLeaf();
  }
  /** 构建交给模型的消息列表。 */
  buildContext() {
    const path = this.branch();
    let startIndex = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].type === "compaction") {
        startIndex = i;
        break;
      }
    }
    const messages = [];
    for (let i = startIndex === -1 ? 0 : startIndex; i < path.length; i++) {
      messages.push(...this.project(path[i]));
    }
    return messages;
  }
  project(entry) {
    switch (entry.type) {
      case "message":
        return [entry.message];
      case "compaction":
        return [
          assistantText(COMPACTION_PREFIX + entry.summary + COMPACTION_SUFFIX),
          ...entry.retainedTail
        ];
      case "custom": {
        if (!entry.inContext) return [];
        const rendered = this.options.renderCustom?.(entry);
        return rendered ? [rendered] : [];
      }
    }
  }
  /** 最近的压缩条目，供压缩触发逻辑判断边界。 */
  latestCompaction() {
    const path = this.branch();
    for (let i = path.length - 1; i >= 0; i--) {
      const entry = path[i];
      if (entry.type === "compaction") return entry;
    }
    return null;
  }
  // -------------------------------------------------------------------------
  // 持久化：JSONL，追加写。每条 append 立刻落盘，崩溃时已产生的学习内容不丢。
  // -------------------------------------------------------------------------
  persist(entry) {
    (0, import_node_fs3.mkdirSync)((0, import_node_path3.dirname)(this.options.filePath), { recursive: true });
    (0, import_node_fs3.appendFileSync)(this.options.filePath, `${JSON.stringify(entry)}
`, "utf8");
  }
  persistLeaf() {
    (0, import_node_fs3.mkdirSync)((0, import_node_path3.dirname)(this.options.filePath), { recursive: true });
    (0, import_node_fs3.appendFileSync)(
      this.options.filePath,
      `${JSON.stringify({ type: "_leaf", leafId: this.leafId, ts: Date.now() })}
`,
      "utf8"
    );
  }
  static load(options) {
    const session = new _Session(options);
    if (!(0, import_node_fs3.existsSync)(options.filePath)) return session;
    const raw = (0, import_node_fs3.readFileSync)(options.filePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.type === "_leaf") {
        session.leafId = parsed.leafId ?? null;
        continue;
      }
      if (typeof parsed.id !== "string") continue;
      const entry = parsed;
      session.entries.push(entry);
      session.byId.set(entry.id, entry);
      if (session.leafId === null || entry.parentId === session.leafId) {
        session.leafId = entry.id;
      }
    }
    return session;
  }
};

// ../src/core/loop.ts
var DEFAULT_MAX_ITERATIONS = 40;
var DEFAULT_MAX_TOKENS = 8192;
var DEFAULT_MAX_TOOL_RESULT_CHARS = 24e3;
var REPEAT_WARN_THRESHOLD = 2;
async function runAgentLoop(options) {
  const {
    provider,
    system,
    registry,
    toolContext,
    signal,
    emit,
    onMessage
  } = options;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const working = [...options.history];
  const produced = [];
  const usage = { input: 0, output: 0 };
  const repeatCounts = /* @__PURE__ */ new Map();
  let stopReason = "stop";
  let iterations = 0;
  let error;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    iterations = iteration + 1;
    let assistant;
    try {
      const stream = provider.stream({
        model: provider.model,
        system,
        messages: working,
        tools: registry.definitions(),
        maxTokens,
        ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
        ...options.reasoningEffort !== void 0 ? { reasoningEffort: options.reasoningEffort } : {},
        ...options.cacheKey ? { cacheKey: options.cacheKey } : {},
        ...signal ? { signal } : {}
      });
      for await (const event of stream) {
        switch (event.type) {
          case "text_delta":
            await emit?.({ type: "text_delta", text: event.text });
            break;
          case "thinking_delta":
            await emit?.({ type: "thinking_delta", text: event.text });
            break;
          case "done":
            assistant = event.message;
            stopReason = event.stopReason;
            usage.input += event.usage.input;
            usage.output += event.usage.output;
            if (event.usage.cacheRead) usage.cacheRead = (usage.cacheRead ?? 0) + event.usage.cacheRead;
            if (event.usage.cacheWrite) usage.cacheWrite = (usage.cacheWrite ?? 0) + event.usage.cacheWrite;
            break;
          case "error":
            error = event.message;
            break;
        }
      }
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    if (error || !assistant) {
      stopReason = "error";
      error ??= "provider 未返回任何内容";
      break;
    }
    if (assistant.content.length === 0) {
      stopReason = "error";
      error = `模型没有产生任何正文。若用的是开启 thinking 的模型，最可能是 ${maxTokens} 个输出 token 被思考内容占满了——调高 LEARN_AGENT_MAX_TOKENS 即可。若并非如此，检查模型名是否在该服务商处存在。`;
      break;
    }
    working.push(assistant);
    produced.push(assistant);
    await onMessage?.(assistant);
    await emit?.({ type: "turn_end", message: assistant });
    const calls = toolCallsOf(assistant);
    if (calls.length === 0) {
      stopReason = stopReason === "length" ? "length" : "stop";
      break;
    }
    const results = await Promise.all(
      calls.map(async (call) => {
        const signature = `${call.name}:${stableStringify(call.args)}`;
        const seen = (repeatCounts.get(signature) ?? 0) + 1;
        repeatCounts.set(signature, seen);
        await emit?.({ type: "tool_start", name: call.name, args: call.args });
        const result = await registry.execute(call, toolContext);
        let content = truncate(result.content, maxToolResultChars);
        if (seen > REPEAT_WARN_THRESHOLD) {
          content += `

[提示] 你已经用完全相同的参数调用 ${call.name} ${seen} 次了，结果不会改变。请换一种做法，或直接基于已有信息给出答复。`;
        }
        await emit?.({
          type: "tool_end",
          name: call.name,
          isError: result.isError,
          content
        });
        return { ...result, content };
      })
    );
    const resultMessage = toolResultMessage(results);
    working.push(resultMessage);
    produced.push(resultMessage);
    await onMessage?.(resultMessage);
    if (iteration === maxIterations - 1) {
      stopReason = "length";
      error = `已达到工具调用轮次上限（${maxIterations}），提前结束。`;
    }
  }
  if (error && stopReason !== "error") stopReason = "error";
  return { messages: produced, stopReason, usage, iterations, ...error ? { error } : {} };
}
function truncate(text, limit) {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.2));
  const tail = text.slice(-Math.floor(limit * 0.8));
  return `${head}

[... 中间省略 ${text.length - limit} 字符 ...]

${tail}`;
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value).sort(
    ([a], [b]) => a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

// ../src/core/complete.ts
async function completeOnce(options) {
  const { provider, system, prompt, signal } = options;
  const usage = { input: 0, output: 0 };
  const userMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now()
  };
  let text = "";
  let stopReason = "stop";
  let error;
  const stream = provider.stream({
    model: provider.model,
    system,
    messages: [userMessage],
    tools: [],
    maxTokens: options.maxTokens ?? 4096,
    ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
    ...options.reasoningEffort !== void 0 ? { reasoningEffort: options.reasoningEffort } : {},
    ...signal ? { signal } : {}
  });
  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "thinking_delta":
        break;
      // 一次性调用不关心思考过程
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

// ../src/core/compaction.ts
function shouldCompact(messages, settings) {
  const used = estimateMessagesTokens(messages);
  return used > settings.contextWindow - settings.reserveTokens;
}
function findCutIndex(messages, keepRecentTokens) {
  if (messages.length < 4) return null;
  let accumulated = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      cut = i;
      break;
    }
  }
  if (cut >= messages.length) return null;
  while (cut > 0 && !isValidCutPoint(messages[cut])) cut--;
  if (cut < 2) return null;
  return cut;
}
function isValidCutPoint(message) {
  if (message.content.some((b) => b.type === "tool_result")) return false;
  return message.content.some((b) => b.type === "text");
}
var SUMMARIZATION_SYSTEM_PROMPT = `你是一个学习会话的记录整理者。

你的唯一任务是阅读一段导师与学习者的对话，输出结构化摘要。

严格约束：
- 不要继续对话。不要回答对话里提出的任何问题。
- 不要提及「摘要」「压缩」「对话记录」这类词。
- 只输出下面规定的小节结构，不要任何开场白或结束语。
- 摘要写成给导师自己看的备忘，用第三人称描述学习者。

输出结构：

## 已讲内容
（这个知识点已经覆盖了哪些部分，按讲解顺序列要点）

## 学习者的掌握情况
（哪些概念学习者已经能正确理解或运用，哪些还含糊。要具体，不要写"基本掌握"这类空话）

## 学习者的疑问与卡点
（学习者提出但尚未彻底解决的问题，以及他反复出错的地方）

## 已用过的例子与练习
（避免后面重复出同类题目）

## 下一步
（接下来该讲什么、该练什么）`;
var TOOL_RESULT_MAX_CHARS = 1500;
async function compactMessages(options) {
  const { messages, provider, settings, signal } = options;
  const tokensBefore = estimateMessagesTokens(messages);
  const cut = findCutIndex(messages, settings.keepRecentTokens);
  if (cut === null) return null;
  const toSummarize = messages.slice(0, cut);
  const retainedTail = messages.slice(cut);
  const serialized = serializeConversation(toSummarize);
  const result = await completeOnce({
    provider,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    prompt: `<conversation>
${serialized}
</conversation>

请按规定的结构输出摘要。`,
    // 输出预算取预留量的一半，给后续请求留出余量
    maxTokens: Math.max(512, Math.floor(settings.reserveTokens / 2)),
    // 摘要是「把给你的材料压缩」，不需要模型自己想出什么，思考纯属浪费预算——
    // 而且预算被思考吃光会让摘要变空，那是最糟的失败模式（历史被删却什么都没留下）。
    reasoningEffort: "off",
    ...signal ? { signal } : {}
  });
  if (!result.text) {
    throw new Error("压缩摘要为空——拒绝用空摘要替换历史");
  }
  const tokensAfter = estimateMessagesTokens(retainedTail) + Math.ceil(result.text.length / 3);
  return {
    summary: result.text,
    retainedTail,
    tokensBefore,
    tokensAfter,
    usage: result.usage
  };
}
function serializeConversation(messages) {
  const lines = [];
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.text.trim()) {
            lines.push(`[${message.role === "user" ? "学习者" : "导师"}]: ${block.text}`);
          }
          break;
        case "tool_call":
          lines.push(`[导师调用工具]: ${block.name}(${JSON.stringify(block.args)})`);
          break;
        case "tool_result":
          lines.push(`[工具结果]: ${truncateForSummary(block.content)}`);
          break;
        case "thinking":
          break;
      }
    }
  }
  return lines.join("\n\n");
}
function truncateForSummary(text) {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}
[... 后略 ${text.length - TOOL_RESULT_MAX_CHARS} 字符 ...]`;
}

// ../src/learn/runtime.ts
init_provider();

// ../src/learn/curriculum.ts
function createCurriculum(topic, learnerProfile) {
  return { topic, learnerProfile, nodes: [], updatedAt: Date.now() };
}
function nextNodeId(curriculum) {
  let max = 0;
  for (const node of curriculum.nodes) {
    const match = /^kp-(\d+)$/.exec(node.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `kp-${max + 1}`;
}
function addNode(curriculum, input) {
  const id = nextNodeId(curriculum);
  const node = {
    id,
    title: input.title.trim(),
    objectives: input.objectives.map((o) => o.trim()).filter(Boolean),
    // 过滤掉指向不存在节点的依赖，避免模型幻觉出一个 id 就污染整张图
    prerequisites: (input.prerequisites ?? []).filter(
      (p) => curriculum.nodes.some((n) => n.id === p)
    ),
    methods: input.methods?.length ? input.methods : ["explain"],
    status: "pending",
    notePath: `notes/${id}.md`,
    origin: input.origin ?? "planner",
    createdAt: Date.now()
  };
  curriculum.nodes.push(node);
  curriculum.updatedAt = Date.now();
  return node;
}
function updateNode(curriculum, id, patch) {
  const node = findNode(curriculum, id);
  if (!node) return null;
  if (patch.title !== void 0) node.title = patch.title.trim();
  if (patch.objectives !== void 0) node.objectives = patch.objectives.map((o) => o.trim()).filter(Boolean);
  if (patch.methods !== void 0 && patch.methods.length > 0) node.methods = patch.methods;
  if (patch.prerequisites !== void 0) {
    node.prerequisites = patch.prerequisites.filter(
      (p) => p !== id && curriculum.nodes.some((n) => n.id === p)
    );
  }
  if (patch.status !== void 0) node.status = patch.status;
  curriculum.updatedAt = Date.now();
  return node;
}
function findNode(curriculum, id) {
  return curriculum.nodes.find((n) => n.id === id) ?? null;
}
function readyNodes(curriculum) {
  const mastered = new Set(
    curriculum.nodes.filter((n) => n.status === "mastered").map((n) => n.id)
  );
  return curriculum.nodes.filter(
    (node) => node.status !== "mastered" && node.prerequisites.every((p) => mastered.has(p))
  );
}
function detectCycle(curriculum) {
  const visiting = /* @__PURE__ */ new Set();
  const done = /* @__PURE__ */ new Set();
  const stack = [];
  const visit = (id) => {
    if (done.has(id)) return null;
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    visiting.add(id);
    stack.push(id);
    const node = findNode(curriculum, id);
    for (const prereq of node?.prerequisites ?? []) {
      const cycle = visit(prereq);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  };
  for (const node of curriculum.nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}
function renderCurriculumForPlanner(curriculum, latestReports) {
  const lines = [];
  lines.push(`# 学习大纲：${curriculum.topic}`);
  lines.push("");
  if (curriculum.learnerProfile.trim()) {
    lines.push("## 学习者画像");
    lines.push(curriculum.learnerProfile.trim());
    lines.push("");
  }
  const counts = /* @__PURE__ */ new Map();
  for (const node of curriculum.nodes) {
    counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  }
  const overview = ["mastered", "learning", "review", "pending"].filter((s) => counts.has(s)).map((s) => `${counts.get(s)} 个${STATUS_LABELS[s]}`).join(" / ");
  lines.push(`## 进度概览`);
  lines.push(`共 ${curriculum.nodes.length} 个知识点：${overview || "尚无节点"}`);
  lines.push("");
  if (curriculum.nodes.length === 0) {
    lines.push("大纲还是空的。先和用户确认学习目标，再开始建节点。");
    return lines.join("\n");
  }
  lines.push("## 知识点");
  for (const node of curriculum.nodes) {
    const tags = [
      `[${STATUS_LABELS[node.status]}]`,
      `方法：${node.methods.map((m) => METHOD_LABELS[m]).join("、")}`
    ];
    if (node.prerequisites.length > 0) {
      tags.push(`依赖：${node.prerequisites.join("、")}`);
    }
    lines.push("");
    lines.push(`### ${node.id} ${node.title}  ${tags.join("  ")}`);
    for (const objective of node.objectives) {
      lines.push(`- 目标：${objective}`);
    }
    const report = latestReports.get(node.id);
    if (report) {
      lines.push(`- 最新报告（${new Date(report.ts).toLocaleString("zh-CN")}）：${report.summary}`);
    } else if (node.reportDigest) {
      lines.push(`- 历史进展：${node.reportDigest}`);
    }
  }
  const suggestions = [...latestReports.values()].flatMap(
    (report) => (report.suggestedNext ?? []).map((s) => ({ ...s, from: report.nodeTitle }))
  );
  if (suggestions.length > 0) {
    lines.push("");
    lines.push("## 导师建议补充的知识点（尚未采纳）");
    for (const suggestion of suggestions) {
      lines.push(`- ${suggestion.title} —— ${suggestion.reason}（来自「${suggestion.from}」）`);
    }
  }
  return lines.join("\n");
}
function renderReadyNodes(curriculum) {
  const ready = readyNodes(curriculum);
  if (ready.length === 0) return "（暂时没有依赖已满足的待学节点）";
  return ready.map((n) => `- ${n.id} ${n.title}`).join("\n");
}

// ../src/learn/entries.ts
var ENTRY_INJECTED = "injected_knowledge";
var ENTRY_REPORT = "report";
var ENTRY_QUESTION = "question";
var ENTRY_KICKOFF = "kickoff";
function renderLearnEntry(entry) {
  switch (entry.customType) {
    case ENTRY_INJECTED:
      return renderInjectedKnowledge(entry);
    case ENTRY_KICKOFF:
      return userText(String(entry.data.instruction ?? ""));
    default:
      return null;
  }
}
function renderInjectedKnowledge(entry) {
  const content = String(entry.data.content ?? "");
  const fromTitle = String(entry.data.sourceNodeTitle ?? "先前的知识点");
  const hint = entry.data.hint ? String(entry.data.hint) : "";
  const lines = [
    `<prior_knowledge from="${fromTitle}">`,
    content,
    "</prior_knowledge>",
    "",
    `以上是学习者在「${fromTitle}」中已经掌握的内容，由他的学习记录整理而来。`,
    "把它当作已确立的背景：不要重新讲授这些内容，直接在此基础上推进。"
  ];
  if (hint) lines.push(`学习者特别说明：${hint}`);
  return userText(lines.join("\n"));
}

// ../src/learn/inject.ts
async function generateEssence(options) {
  const { workspace, sourceNode, targetNode, hint, provider, signal } = options;
  const notes = readNotes(workspace, sourceNode.id);
  if (!notes) {
    throw new Error(
      `「${sourceNode.title}」还没有学习笔记，无法提取精华。先去和它的导师学一轮。`
    );
  }
  const hash = notesHash(notes);
  const file = readEssenceFile(workspace, sourceNode.id);
  const cached = file?.targets[targetNode.id];
  if (cached && cached.noteHash === hash && (cached.hint ?? "") === (hint ?? "")) {
    return { essence: cached, cached: true };
  }
  const prompt = buildCompressionPrompt(sourceNode, targetNode, notes, hint);
  const result = await completeOnce({
    provider,
    system: loadPrompt("compress"),
    prompt,
    maxTokens: 4096,
    ...signal ? { signal } : {}
  });
  if (!result.text) {
    throw new Error("压缩结果为空，已放弃本次注入");
  }
  const essence = {
    sourceNodeId: sourceNode.id,
    sourceNodeTitle: sourceNode.title,
    targetNodeId: targetNode.id,
    targetNodeTitle: targetNode.title,
    ...hint ? { hint } : {},
    noteHash: hash,
    content: result.text,
    generatedAt: Date.now()
  };
  const updated = {
    sourceNodeId: sourceNode.id,
    sourceNodeTitle: sourceNode.title,
    targets: { ...file?.targets ?? {}, [targetNode.id]: essence }
  };
  workspace.writeJSON(workspace.essencePath(sourceNode.id), updated);
  return { essence, cached: false };
}
function buildCompressionPrompt(sourceNode, targetNode, notes, hint) {
  const parts = [
    `<source_notes title="${sourceNode.title}">`,
    notes,
    "</source_notes>",
    "",
    "<target>",
    `学习者接下来要学的知识点：${targetNode.title}`,
    "它的学习目标：",
    ...targetNode.objectives.map((o) => `- ${o}`),
    "</target>"
  ];
  if (hint?.trim()) {
    parts.push("", "<focus>", `学习者的额外说明：${hint.trim()}`, "</focus>");
  }
  parts.push(
    "",
    "请提取理解上述新知识点所必需的前置知识，用新知识点的视角重新组织后输出。"
  );
  return parts.join("\n");
}
function applyInjection(session, essence, workspace) {
  const previousLeafId = session.currentLeafId;
  const entry = session.appendCustom(
    ENTRY_INJECTED,
    {
      sourceNodeId: essence.sourceNodeId,
      sourceNodeTitle: essence.sourceNodeTitle,
      targetNodeId: essence.targetNodeId,
      ...essence.hint ? { hint: essence.hint } : {},
      content: essence.content
    },
    true
    // 进上下文——这正是注入的目的
  );
  const record = {
    id: entry.id,
    sourceNodeId: essence.sourceNodeId,
    sourceNodeTitle: essence.sourceNodeTitle,
    targetNodeId: essence.targetNodeId,
    targetNodeTitle: essence.targetNodeTitle,
    ...essence.hint ? { hint: essence.hint } : {},
    content: essence.content,
    entryId: entry.id,
    previousLeafId,
    ts: Date.now()
  };
  workspace.appendLine(workspace.injectionsPath, record);
  return { record, entry };
}
function revokeInjection(session, record, workspace) {
  session.navigateTo(record.previousLeafId);
  workspace.appendLine(workspace.injectionsPath, {
    ...record,
    revokedAt: Date.now()
  });
}
function listInjections(workspace) {
  const all = workspace.readLines(workspace.injectionsPath);
  const byId = /* @__PURE__ */ new Map();
  for (const record of all) byId.set(record.id, record);
  return [...byId.values()].sort((a, b) => b.ts - a.ts);
}
function readEssenceFile(workspace, sourceNodeId) {
  return workspace.readJSON(workspace.essencePath(sourceNodeId));
}
function validateInjection(curriculum, sourceId, targetId) {
  if (sourceId === targetId) {
    return "源知识点和目标知识点不能是同一个";
  }
  const source = findNode(curriculum, sourceId);
  const target = findNode(curriculum, targetId);
  if (!source) return `找不到知识点 ${sourceId}`;
  if (!target) return `找不到知识点 ${targetId}`;
  return null;
}

// ../src/core/tools/types.ts
var ToolRegistry = class {
  tools = /* @__PURE__ */ new Map();
  register(tool) {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }
  names() {
    return [...this.tools.keys()];
  }
  has(name) {
    return this.tools.has(name);
  }
  /** 交给模型的工具表。顺序稳定——顺序变化会让 prompt 前缀失效，缓存全废。 */
  definitions() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }
  /**
   * 执行一次工具调用。
   *
   * 刻意不抛异常：工具失败对模型来说是一条信息，不是程序的终止条件。找不到工具、
   * 参数缺失、用户代码抛错，全部转成 isError 的 tool_result 交回模型，让它自己决定
   * 是重试、换参数，还是承认此路不通。只有这样才能让 agent 具备纠错能力。
   */
  async execute(call, ctx) {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        type: "tool_result",
        toolCallId: call.id,
        content: `未知工具 "${call.name}"。可用工具：${this.names().join(", ")}`,
        isError: true
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
        isError: true
      };
    }
  }
};
function objectSchema(properties, required = []) {
  return { type: "object", properties, required };
}
function stringParam(description) {
  return { type: "string", description };
}
function arrayParam(description, items = { type: "string" }) {
  return { type: "array", description, items };
}

// ../src/learn/vault-tools.ts
var listVaultStructureTool = {
  name: "list_vault_structure",
  description: '查看笔记库的目录结构（只有文件夹和笔记名，不含内容）。用来了解已经积累了哪些领域、笔记是怎么组织的。不传 path 时列出工作目录，传空字符串 "" 列出库根，也可以传具体子目录。',
  parameters: objectSchema(
    {
      path: stringParam(
        '相对库根的目录路径。省略 = 工作目录；"" = 库根；也可以写 "安卓逆向" 这样的子目录'
      )
    },
    []
  ),
  async execute(args, ctx) {
    if (!ctx.vault) return "当前环境看不到笔记库。";
    const path = args.path === void 0 ? ctx.workFolder ?? "" : String(args.path).trim();
    return ctx.vault.describe(path, 200);
  }
};
var readVaultNoteTool = {
  name: "read_vault_note",
  description: "读某一篇笔记的内容。用在你确实需要知道某篇写了什么的时候，不要用它通读整个库。路径要带 .md 后缀。",
  parameters: objectSchema(
    {
      path: stringParam('相对库根的路径，例如 "安卓逆向/Android开发基础/01-创建一个安卓程序.md"')
    },
    ["path"]
  ),
  async execute(args, ctx) {
    if (!ctx.vault) return "当前环境看不到笔记库。";
    const path = String(args.path ?? "").trim();
    if (!path) return "path 不能为空。";
    return ctx.vault.read(path, 6e3);
  }
};
var listLearnerNotesTool = {
  name: "list_learner_notes",
  description: "快速查看笔记库的目录结构（只有名字，不含内容），用来了解学习者在相关领域已经记过什么。讲课前想知道「他之前有没有碰过这个」时可以调用。",
  parameters: objectSchema(
    {
      path: stringParam("相对库根的目录路径，省略 = 库根")
    },
    []
  ),
  async execute(args, ctx) {
    if (!ctx.vault) return "当前环境看不到笔记库。";
    const path = args.path === void 0 ? "" : String(args.path).trim();
    return ctx.vault.describe(path, 120);
  }
};

// ../src/learn/planner.ts
function buildPlannerSystemPrompt(curriculum, latestReports) {
  const sections = [
    loadPrompt("planner"),
    "",
    "---",
    "",
    renderCurriculumForPlanner(curriculum, latestReports)
  ];
  const ready = renderReadyNodes(curriculum);
  sections.push("", "# 依赖已满足、可以开学的知识点", "", ready);
  return sections.join("\n");
}
function latestReportsByNode(curriculum, workspace) {
  const map = /* @__PURE__ */ new Map();
  for (const node of curriculum.nodes) {
    const reports = workspace.readLines(workspace.reportPath(node.id));
    const latest = reports[reports.length - 1];
    if (latest) map.set(node.id, latest);
  }
  return map;
}
function createPlannerRegistry(hasVault) {
  const registry = new ToolRegistry().register(addKnowledgePointTool).register(updateKnowledgePointTool).register(dispatchTutorTool).register(readReportsTool).register(setLearningGoalTool);
  if (hasVault) {
    registry.register(listVaultStructureTool);
    registry.register(readVaultNoteTool);
  }
  return registry;
}
var addKnowledgePointTool = {
  name: "add_knowledge_point",
  description: "往大纲里新增一个知识点。建大纲时批量用，学到中途发现遗漏也可以随时补。",
  parameters: objectSchema(
    {
      title: stringParam("知识点标题，简短明确"),
      objectives: arrayParam(
        "学完能做到什么。每条都必须是可验证的行为，不要写'理解 X'这类无法检验的目标。"
      ),
      prerequisites: arrayParam(
        "依赖的其他知识点 id（如 kp-1）。只有确实必须先学会它才能理解本节点时才填。"
      ),
      methods: arrayParam(
        "建议的学习方法。explain=讲解概念；practice=动手练习；discuss=讨论建立直觉；review=复习巩固",
        { type: "string", enum: ["explain", "practice", "discuss", "review"] }
      ),
      rationale: stringParam("为什么需要这个知识点，以及它在大纲里的位置。写给自己看，便于后续调整。")
    },
    ["title", "objectives"]
  ),
  async execute(args, ctx) {
    const title = String(args.title ?? "").trim();
    if (!title) return "title 不能为空。";
    const objectives = toStringArray(args.objectives);
    if (objectives.length === 0) {
      return "objectives 不能为空。至少给一条可验证的学习目标，否则导师无法判断教到什么程度算完。";
    }
    const node = addNode(ctx.curriculum, {
      title,
      objectives,
      prerequisites: toStringArray(args.prerequisites),
      methods: toMethods(args.methods),
      origin: "planner"
    });
    const cycle = detectCycle(ctx.curriculum);
    if (cycle) {
      ctx.curriculum.nodes = ctx.curriculum.nodes.filter((n) => n.id !== node.id);
      return `依赖关系形成了环（${cycle.join(" → ")}），已放弃新增「${title}」。请重新安排依赖。`;
    }
    ctx.saveCurriculum();
    return `已新增 ${node.id}「${node.title}」，方法：${node.methods.map((m) => METHOD_LABELS[m]).join("、")}。`;
  }
};
var updateKnowledgePointTool = {
  name: "update_knowledge_point",
  description: "修改已有知识点。用于调整目标、依赖、学习方法，或修正状态。注意状态通常由导师上报自动更新，不需要你手动改。",
  parameters: objectSchema(
    {
      node_id: stringParam("要修改的知识点 id"),
      title: stringParam("新标题（可选）"),
      objectives: arrayParam("新的目标列表，会整体替换（可选）"),
      prerequisites: arrayParam("新的依赖列表，会整体替换（可选）"),
      methods: arrayParam("新的学习方法列表，会整体替换（可选）", {
        type: "string",
        enum: ["explain", "practice", "discuss", "review"]
      }),
      status: stringParam("手动修正状态：pending / learning / mastered / review（可选）")
    },
    ["node_id"]
  ),
  async execute(args, ctx) {
    const nodeId = String(args.node_id ?? "").trim();
    const node = findNode(ctx.curriculum, nodeId);
    if (!node) {
      return `找不到知识点 ${nodeId}。当前大纲里的节点：${ctx.curriculum.nodes.map((n) => n.id).join("、") || "（空）"}`;
    }
    const patch = {};
    if (args.title !== void 0) patch.title = String(args.title);
    if (args.objectives !== void 0) patch.objectives = toStringArray(args.objectives);
    if (args.prerequisites !== void 0) patch.prerequisites = toStringArray(args.prerequisites);
    if (args.methods !== void 0) {
      const methods = toMethods(args.methods);
      if (methods.length > 0) patch.methods = methods;
    }
    if (args.status !== void 0) {
      const status = String(args.status).trim();
      if (["pending", "learning", "mastered", "review"].includes(status)) patch.status = status;
    }
    updateNode(ctx.curriculum, nodeId, patch);
    const cycle = detectCycle(ctx.curriculum);
    if (cycle) {
      return `这次修改让依赖关系形成了环（${cycle.join(" → ")}）。请修正依赖后重试。`;
    }
    ctx.saveCurriculum();
    return `已更新 ${nodeId}「${node.title}」。`;
  }
};
var dispatchTutorTool = {
  name: "dispatch_tutor",
  description: "把某个知识点交给导师开始教学。会为它建立一条独立的学习会话，学习者即可在界面上进入。派发时说明为什么现在学这个，导师需要这个上下文来判断教学起点。",
  parameters: objectSchema(
    {
      node_id: stringParam("要派发的知识点 id"),
      instruction: stringParam(
        "给导师的交代：为什么现在学这个、它和前后知识点的关系、学习者目前的相关基础。"
      )
    },
    ["node_id"]
  ),
  async execute(args, ctx) {
    const nodeId = String(args.node_id ?? "").trim();
    const node = findNode(ctx.curriculum, nodeId);
    if (!node) return `找不到知识点 ${nodeId}。`;
    const instruction = args.instruction ? String(args.instruction).trim() : void 0;
    const result = await ctx.dispatchTutor(nodeId, instruction);
    if (node.status === "pending") {
      node.status = "learning";
      ctx.saveCurriculum();
    }
    return result;
  }
};
var readReportsTool = {
  name: "read_reports",
  description: "读取某个知识点的历史报告。默认只看到最新一条，需要了解演变过程时用这个工具翻更早的记录。",
  parameters: objectSchema(
    {
      node_id: stringParam("知识点 id"),
      limit: { type: "number", description: "最多返回几条（默认 5）" }
    },
    ["node_id"]
  ),
  async execute(args, ctx) {
    const nodeId = String(args.node_id ?? "").trim();
    const node = findNode(ctx.curriculum, nodeId);
    if (!node) return `找不到知识点 ${nodeId}。`;
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
    const reports = ctx.workspace.readLines(ctx.workspace.reportPath(nodeId));
    if (reports.length === 0) return `「${node.title}」还没有任何进度报告。`;
    const recent = reports.slice(-limit);
    return recent.map(
      (r) => `[${new Date(r.ts).toLocaleString("zh-CN")}] ${r.status}
${r.summary}${r.suggestedNext?.length ? `
建议补充：${r.suggestedNext.map((s) => s.title).join("、")}` : ""}`
    ).join("\n\n---\n\n");
  }
};
var setLearningGoalTool = {
  name: "set_learning_goal",
  description: "记录这次学习的主题和学习者画像。这是整个大纲的标题，也会被用作导出到 Obsidian 时的索引文件名，所以确认清楚目标后就该调用一次。之后了解得更清楚时可以再更新。主题要写成一句具体的描述，而不是「学 X」这种宽泛的说法。",
  parameters: objectSchema(
    {
      topic: stringParam(
        "学习主题，一句话。写清楚范围和目的，例如「Rust 内存管理（为了读懂公司代码库）」，而不是「Rust」——它决定了大纲标题和 Obsidian 索引文件名。"
      ),
      learner_profile: stringParam(
        "完整的学习者画像，会整体替换。写具体信息（背景、已掌握什么、学习偏好、时间安排），不要写「有一定基础」这类空话——每个导师都会读到它。"
      )
    },
    ["topic"]
  ),
  async execute(args, ctx) {
    const topic = String(args.topic ?? "").trim();
    if (topic) ctx.curriculum.topic = topic;
    const profile = args.learner_profile !== void 0 ? String(args.learner_profile).trim() : "";
    if (profile) ctx.curriculum.learnerProfile = profile;
    ctx.saveCurriculum();
    return `学习主题已记录为「${ctx.curriculum.topic}」${profile ? "，画像已更新" : ""}。`;
  }
};
function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}
function toMethods(value) {
  const valid = ["explain", "practice", "discuss", "review"];
  return toStringArray(value).filter((v) => valid.includes(v));
}

// ../src/learn/tutor.ts
function buildTutorSystemPrompt(node, learnerProfile) {
  const lines = [
    loadPrompt("tutor"),
    "",
    "---",
    "",
    "# 你负责的知识点",
    "",
    `**${node.title}**（编号 ${node.id}，当前状态：${STATUS_LABELS[node.status]}）`,
    "",
    "学习目标：",
    ...node.objectives.map((o) => `- ${o}`),
    "",
    `建议的学习方法：${node.methods.map((m) => METHOD_LABELS[m]).join("、")}`
  ];
  if (node.prerequisites.length > 0) {
    lines.push(
      "",
      `这个知识点依赖：${node.prerequisites.join("、")}。如果学习者对前置内容明显不熟，先指出来并让他回去补，不要硬讲。`
    );
  }
  lines.push("", "# 学习者画像", "", learnerProfile.trim() || "（暂无画像信息，在对话中逐步了解）");
  return lines.join("\n");
}
function createTutorRegistry(hasVault) {
  const registry = new ToolRegistry().register(saveNoteTool).register(readNotesTool).register(askLearnerTool).register(reportProgressTool);
  if (hasVault) registry.register(listLearnerNotesTool);
  return registry;
}
var saveNoteTool = {
  name: "save_note",
  description: "把一段教学内容记进笔记。学习细节、例子、学习者的错题都写在这里。笔记是学习者的长期资产，也可能被提取给其他知识点的导师，所以要把内容写清楚、写完整。",
  parameters: objectSchema(
    {
      section: {
        type: "string",
        enum: [...NOTE_SECTIONS],
        description: "写进哪个小节。核心概念=定义与原理；关键要点=需要记住的规则；例题与练习=用过的例子和题目；疑问与澄清=学习者没弄懂或纠正过的理解；回顾=阶段性总结"
      },
      content: stringParam("要记录的内容，markdown 格式。写知识本身，不要写'我讲了'这类过程描述。"),
      mode: {
        type: "string",
        enum: ["append", "replace"],
        description: "append=追加到该小节（默认）；replace=覆盖该小节（重新整理时用）"
      }
    },
    ["section", "content"]
  ),
  async execute(args, ctx) {
    const section = String(args.section ?? "").trim();
    const content = String(args.content ?? "").trim();
    if (!section || !content) return "参数不完整：section 和 content 都不能为空。";
    const mode = args.mode === "replace" ? "replace" : "append";
    writeNoteSection(ctx.workspace, ctx.node.id, section, content, mode);
    return `已${mode === "append" ? "追加" : "覆盖"}笔记小节「${section}」。`;
  }
};
var readNotesTool = {
  name: "read_notes",
  description: "读回你自己为这个知识点写的笔记。在开始新的教学阶段前调用它——特别是这个知识点的学习跨了多天、或者你感觉对话被压缩过的时候。",
  parameters: objectSchema({}, []),
  async execute(_args, ctx) {
    const notes = readNotes(ctx.workspace, ctx.node.id);
    if (!notes) return "你还没有为这个知识点写过笔记。";
    return notes;
  }
};
var askLearnerTool = {
  name: "ask_learner",
  description: "向学习者出一道题。题目本身要写在你的回复正文里让他看到；调用这个工具是为了登记题目和参考答案，参考答案不会展示给学习者，直到他作答后才作为对照。",
  parameters: objectSchema(
    {
      question: stringParam("题面和作答要求，和你写在正文里的保持简短一致"),
      expects: stringParam("你预期的答案要点。用于稍后判断学习者答得对不对。")
    },
    ["question"]
  ),
  async execute(args, ctx) {
    const question = String(args.question ?? "").trim();
    if (!question) return "题目不能为空。";
    ctx.session.appendCustom(
      ENTRY_QUESTION,
      {
        nodeId: ctx.node.id,
        question,
        ...args.expects ? { expects: String(args.expects) } : {}
      },
      // 不进模型上下文：题目已经在导师的正文里了，再塞一次是重复
      false
    );
    return "题目已登记。现在结束本轮回复，等学习者作答——不要自问自答，也不要给出答案。";
  }
};
var reportProgressTool = {
  name: "report_progress",
  description: "向学习规划师上报进度。规划师管理整个学习大纲，看不到你的教学细节，所以报告要写**学习者当前的状态**，不要写教学过程。",
  parameters: objectSchema(
    {
      status: {
        type: "string",
        enum: ["learning", "mastered", "review"],
        description: "learning=还在学；mastered=学习者确实掌握了（能用自己话解释、能解决变体问题）；review=学过但需要复习巩固"
      },
      summary: stringParam(
        "给规划师看的几句话。写学习者会了什么、卡在哪里、是否具备继续学的条件。不要写'今天讲了 X 用了 Y 例子'这类教学过程细节。"
      ),
      suggested_next: arrayParam(
        "如果发现大纲里缺少必要的知识点，在这里提出建议（可选）",
        objectSchema({
          title: stringParam("建议补充的知识点标题"),
          reason: stringParam("为什么需要它")
        })
      )
    },
    ["status", "summary"]
  ),
  async execute(args, ctx) {
    const status = args.status;
    if (status !== "learning" && status !== "mastered" && status !== "review") {
      return "status 必须是 learning / mastered / review 之一。";
    }
    const summary = String(args.summary ?? "").trim();
    if (!summary) return "summary 不能为空——规划师需要它来判断下一步。";
    const suggestedNext = parseSuggestions(args.suggested_next);
    const report = {
      nodeId: ctx.node.id,
      nodeTitle: ctx.node.title,
      status,
      summary,
      ...suggestedNext.length > 0 ? { suggestedNext } : {},
      ts: Date.now()
    };
    ctx.workspace.appendLine(ctx.workspace.reportPath(ctx.node.id), report);
    ctx.session.appendCustom(ENTRY_REPORT, { ...report }, false);
    ctx.onStatusChange(status);
    return `已上报。规划师看到的状态：「${ctx.node.title}」${STATUS_LABELS[status]}。报告内容：${summary}`;
  }
};
function parseSuggestions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item;
    const title = String(record.title ?? "").trim();
    const reason = String(record.reason ?? "").trim();
    if (title) out.push({ title, reason });
  }
  return out;
}

// ../src/learn/workspace.ts
var import_node_fs4 = require("node:fs");
var import_node_path4 = require("node:path");
var Workspace = class {
  constructor(root) {
    this.root = root;
    (0, import_node_fs4.mkdirSync)(this.root, { recursive: true });
  }
  // --- 路径 ---------------------------------------------------------------
  get curriculumPath() {
    return (0, import_node_path4.join)(this.root, "curriculum.json");
  }
  sessionPath(sessionId) {
    return (0, import_node_path4.join)(this.root, "sessions", `${sessionId}.jsonl`);
  }
  notePath(nodeId) {
    return (0, import_node_path4.join)(this.root, "notes", `${nodeId}.md`);
  }
  essencePath(nodeId) {
    return (0, import_node_path4.join)(this.root, "essences", `${nodeId}.json`);
  }
  reportPath(nodeId) {
    return (0, import_node_path4.join)(this.root, "reports", `${nodeId}.jsonl`);
  }
  get injectionsPath() {
    return (0, import_node_path4.join)(this.root, "injections.jsonl");
  }
  // --- 读 -----------------------------------------------------------------
  readJSON(path) {
    if (!(0, import_node_fs4.existsSync)(path)) return null;
    try {
      return JSON.parse((0, import_node_fs4.readFileSync)(path, "utf8"));
    } catch {
      return null;
    }
  }
  readText(path) {
    if (!(0, import_node_fs4.existsSync)(path)) return "";
    return (0, import_node_fs4.readFileSync)(path, "utf8");
  }
  readLines(path) {
    if (!(0, import_node_fs4.existsSync)(path)) return [];
    const out = [];
    for (const line of (0, import_node_fs4.readFileSync)(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
      }
    }
    return out;
  }
  // --- 写 -----------------------------------------------------------------
  writeJSON(path, value) {
    (0, import_node_fs4.mkdirSync)((0, import_node_path4.dirname)(path), { recursive: true });
    (0, import_node_fs4.writeFileSync)(path, `${JSON.stringify(value, null, 2)}
`, "utf8");
  }
  writeText(path, content) {
    (0, import_node_fs4.mkdirSync)((0, import_node_path4.dirname)(path), { recursive: true });
    (0, import_node_fs4.writeFileSync)(path, content, "utf8");
  }
  appendLine(path, value) {
    (0, import_node_fs4.mkdirSync)((0, import_node_path4.dirname)(path), { recursive: true });
    (0, import_node_fs4.appendFileSync)(path, `${JSON.stringify(value)}
`, "utf8");
  }
};

// ../src/settings.ts
var DEFAULT_REASONING = {
  planner: "high",
  tutor: "high"
};
var REASONING_VALUES = ["off", "low", "high", "max"];
function isProviderKind(value) {
  return value === "anthropic" || value === "openai" || value === "mock";
}
function mergeProviderConfig(env, overrides2) {
  if (!overrides2) return env;
  const kind = overrides2.kind;
  const result = { kind, model: overrides2.model ?? env.model, apiKey: "" };
  if (kind === "mock") {
    return result;
  }
  const apiKey = overrides2.apiKey !== void 0 && overrides2.apiKey !== "" ? overrides2.apiKey : env.apiKey;
  result.apiKey = apiKey ?? "";
  if (overrides2.baseUrl !== void 0 && overrides2.baseUrl !== "") {
    result.baseUrl = overrides2.baseUrl;
  } else if (overrides2.baseUrl === void 0 && env.baseUrl) {
    result.baseUrl = env.baseUrl;
  }
  if (env.enableCaching !== void 0 && overrides2.apiKey === void 0) {
    result.enableCaching = env.enableCaching;
  }
  if (env.thinkingFormat !== void 0) {
    result.thinkingFormat = env.thinkingFormat;
  }
  return result;
}
function maskApiKey(key) {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}
function clampContextWindow(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(8e3, Math.min(2e6, Math.floor(value)));
}
function validatePersistedSettings(settings, merged) {
  if (!isProviderKind(settings.kind)) {
    throw new Error(`未知的 provider 类型:${String(settings.kind)}`);
  }
  if (settings.kind === "mock") return null;
  if (!merged.apiKey) {
    return "缺少 API key。在下面填入,或确认 .env 里已配置。";
  }
  const model = settings.model?.trim() ?? "";
  if (settings.kind === "anthropic" && !model) {
    return "Anthropic 模式下需要提供模型名,例如 claude-sonnet-4-5 或 claude-haiku-4-5。";
  }
  return null;
}

// ../src/learn/roles.ts
function customRoleSessionId(roleId) {
  return `role-${roleId}`;
}
function newRoleId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function buildCustomRolePrompt(role, workFolder) {
  const lines = [
    role.systemPrompt.trim(),
    "",
    "---",
    "",
    "# 工作环境",
    "",
    `你运行在学习者的 Obsidian 笔记库里。他的学习资料放在「${workFolder}」目录下。`
  ];
  if (role.attachActiveNote) {
    lines.push(
      "",
      "每轮对话我会把**他当前打开的笔记内容**附在消息里。他可以直接说「总结一下」「这段什么意思」而不用先告诉你他在看什么——你已经在消息里看到了。"
    );
  }
  if (role.vaultAccess) {
    lines.push(
      "",
      "你可以用 list_vault_structure 看笔记库的目录结构，用 read_vault_note 读具体某一篇。",
      "看结构就够了，不要通读整个库——那会把你的上下文淹掉，反而做不好手上这件事。"
    );
  }
  lines.push(
    "",
    "# 输出要求",
    "",
    "直接用 markdown 回答。这是 Obsidian，所以你写的 [[双链]] 是可点击的——提到库里的某篇笔记时可以用双链指过去。"
  );
  return lines.join("\n");
}

// ../src/learn/runtime.ts
function createCustomRoleRegistry(hasVault) {
  const registry = new ToolRegistry();
  if (hasVault) {
    registry.register(listVaultStructureTool);
    registry.register(readVaultNoteTool);
  }
  return registry;
}
var KICKOFF_INSTRUCTION = `（系统）这个知识点的学习现在开始。

请先调用 read_notes 看看自己是否已经为这个知识点记过笔记：
- 如果有笔记，说明学习者之前学过一部分，从记录的进度接着往下走，不要从头开始。
- 如果没有，这是第一次。

然后向学习者开场。开场要简短：说明这个知识点解决什么问题、你打算怎么带他学、第一步做什么。
不要长篇介绍，直接进入教学。`;
var LearningRuntime = class {
  workspace;
  provider;
  providerConfig;
  contextWindow;
  maxIterations;
  maxOutputTokens;
  reasoning = { ...DEFAULT_REASONING };
  obsidian = {};
  lastExport = null;
  /**
   * 库访问能力，由宿主注入（插件用 app.vault，服务端不提供）。
   * 它决定 planner / tutor 的工具表里有没有「看笔记库」这类工具。
   */
  vaultAccess;
  workFolder = "学习Agent";
  sessions = /* @__PURE__ */ new Map();
  curriculum;
  constructor(config, providerOverride) {
    this.workspace = new Workspace(config.workspaceRoot);
    this.provider = providerOverride ?? createProvider(config.provider);
    this.providerConfig = config.provider;
    this.contextWindow = config.contextWindow;
    this.maxIterations = config.maxIterations;
    this.maxOutputTokens = config.maxOutputTokens;
    this.reasoning = { ...config.reasoning };
    this.obsidian = { ...config.obsidian };
    this.curriculum = this.workspace.readJSON(this.workspace.curriculumPath) ?? createCurriculum("(尚未设定)", "");
  }
  // -------------------------------------------------------------------------
  // 运行时配置(界面可调)
  // -------------------------------------------------------------------------
  /** 当前生效的 provider 配置。隐藏内容通过打码暴露,不返回明文 key。 */
  effectiveProviderConfig() {
    const cfg = this.providerConfig;
    return {
      kind: cfg.kind,
      model: cfg.model,
      ...cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {},
      hasApiKey: Boolean(cfg.apiKey),
      ...cfg.apiKey ? { maskedKey: maskApiKey(cfg.apiKey) } : {},
      ...cfg.enableCaching !== void 0 ? { enableCaching: cfg.enableCaching } : {}
    };
  }
  currentContextWindow() {
    return this.contextWindow;
  }
  /** probe 接口借用当前生效 key 时的入口。 */
  currentApiKey() {
    return this.providerConfig.apiKey ?? "";
  }
  currentKind() {
    return this.providerConfig.kind;
  }
  currentModel() {
    return this.providerConfig.model;
  }
  /** probe 接口在给定（未保存的）配置之上合并当前 key，用于『试连但不保存』。 */
  mergeForProbe(settings) {
    return mergeProviderConfig(this.providerConfig, settings);
  }
  /**
   * 应用新的 provider 配置。替换 provider 实例,不碰会话——已加载的会话树原样保留。
   * 校验放在这里而不是 server 层,让 CLI 入口也自动获得同样的约束。
   */
  async reconfigureProvider(settings, thinkingFormat) {
    const merged = mergeProviderConfig(this.providerConfig, settings);
    if (thinkingFormat) merged.thinkingFormat = thinkingFormat;
    const validation = validatePersistedSettings(settings, merged);
    if (validation) {
      return { config: merged, ok: false, error: validation };
    }
    this.provider = createProvider(merged);
    this.providerConfig = merged;
    return { config: merged, ok: true };
  }
  /** 从磁盘加载过的持久设置里恢复推理配置（config 在启动时已合并，这里只取推理部分） */
  reasoningSettings() {
    return { ...this.reasoning };
  }
  /** 注入库访问能力。必须在第一次对话之前调用，因为工具表在每轮开始时构建。 */
  setVaultAccess(access, workFolder) {
    this.vaultAccess = access;
    this.workFolder = workFolder;
  }
  obsidianSettings() {
    return { ...this.obsidian };
  }
  setObsidian(next) {
    this.obsidian = { ...this.obsidian, ...next };
  }
  lastObsidianExport() {
    return this.lastExport;
  }
  /** 手动导出。返回结果供界面展示（写了哪些、跳过了哪些）。 */
  exportToObsidian() {
    const result = exportToObsidian({
      workspace: this.workspace,
      curriculum: this.curriculum,
      settings: this.obsidian
    });
    this.lastExport = result;
    return result;
  }
  /**
   * 一轮结束后按配置自动导出。
   *
   * 导出只是本地写文件，成本极低；但**绝不能让它影响对话**——库路径失效、权限问题
   * 之类都不该把一轮学习变成错误。所以这里吞掉异常，只把结果记在 lastExport 里。
   */
  maybeAutoExport() {
    if (!this.obsidian.autoExport || !this.obsidian.vaultPath) return;
    try {
      this.exportToObsidian();
    } catch (error) {
      this.lastExport = {
        ok: false,
        written: [],
        skipped: [],
        error: error instanceof Error ? error.message : String(error),
        exportedAt: Date.now()
      };
    }
  }
  /** 当前 thinking 字段的 wire 形态（auto 表示由 provider 按地址推断）。 */
  thinkingFormat() {
    return this.providerConfig.thinkingFormat ?? "auto";
  }
  setReasoning(next) {
    if (next.planner) this.reasoning.planner = next.planner;
    if (next.tutor) this.reasoning.tutor = next.tutor;
  }
  setContextWindow(contextWindow) {
    this.contextWindow = clampContextWindow(contextWindow, this.contextWindow);
  }
  compactionSettings() {
    return {
      contextWindow: this.contextWindow,
      reserveTokens: 16384,
      keepRecentTokens: 12e3
    };
  }
  // 测试用:当前生效的 provider 配置,用于 probe 复用当前 key 的场景。
  get currentProviderConfig() {
    return { ...this.providerConfig };
  }
  // -------------------------------------------------------------------------
  // 大纲
  // -------------------------------------------------------------------------
  getCurriculum() {
    return this.curriculum;
  }
  saveCurriculum() {
    this.workspace.writeJSON(this.workspace.curriculumPath, this.curriculum);
  }
  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------
  /** 会话按需从磁盘加载并缓存在内存。renderLearnEntry 负责把 custom 条目渲染进上下文。 */
  session(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = Session.load({
        id: sessionId,
        filePath: this.workspace.sessionPath(sessionId),
        renderCustom: renderLearnEntry
      });
      this.sessions.set(sessionId, session);
    }
    return session;
  }
  // -------------------------------------------------------------------------
  // 跑一轮
  // -------------------------------------------------------------------------
  async runPlannerTurn(message, hooks = {}) {
    const session = this.session(PLANNER_SESSION_ID);
    await this.compactIfNeeded(session);
    const latestReports = latestReportsByNode(this.curriculum, this.workspace);
    const toolContext = {
      workspace: this.workspace,
      curriculum: this.curriculum,
      dispatchTutor: async (nodeId, instruction) => this.dispatch(nodeId, instruction),
      saveCurriculum: () => this.saveCurriculum(),
      ...this.vaultAccess ? { vault: this.vaultAccess } : {},
      workFolder: this.workFolder
    };
    return this.runTurn({
      session,
      system: buildPlannerSystemPrompt(this.curriculum, latestReports),
      registry: createPlannerRegistry(Boolean(this.vaultAccess)),
      toolContext,
      message,
      reasoningEffort: this.reasoning.planner,
      hooks
    });
  }
  async runTutorTurn(nodeId, message, hooks = {}) {
    const node = this.requireNode(nodeId);
    const session = this.session(tutorSessionId(nodeId));
    await this.compactIfNeeded(session, node);
    const toolContext = {
      workspace: this.workspace,
      node,
      session,
      onStatusChange: (status) => {
        node.status = status;
        this.saveCurriculum();
      },
      ...this.vaultAccess ? { vault: this.vaultAccess } : {}
    };
    return this.runTurn({
      session,
      system: buildTutorSystemPrompt(node, this.curriculum.learnerProfile),
      registry: createTutorRegistry(Boolean(this.vaultAccess)),
      toolContext,
      message,
      reasoningEffort: this.reasoning.tutor,
      hooks
    });
  }
  /**
   * 跑一轮自定义角色的对话。
   *
   * 和规划师/导师走的是同一套循环、同一套会话树、同一套压缩——差别只在系统提示
   * 和工具表。所以自定义角色天然拥有持久会话、上下文压缩、撤销这些能力，不需要
   * 为它单独实现一遍。
   */
  async runCustomRoleTurn(role, message, hooks = {}) {
    const session = this.session(customRoleSessionId(role.id));
    await this.compactIfNeeded(session);
    const toolContext = {
      ...this.vaultAccess ? { vault: this.vaultAccess } : {},
      workFolder: this.workFolder
    };
    return this.runTurn({
      session,
      system: buildCustomRolePrompt(role, this.workFolder),
      registry: createCustomRoleRegistry(Boolean(this.vaultAccess) && role.vaultAccess !== false),
      toolContext,
      message,
      reasoningEffort: this.reasoning.tutor,
      hooks
    });
  }
  /**
   * 让导师开场。没有真实用户发言，而是追加一条 kickoff 条目——
   * 伪造一条用户消息会让 UI 显示出学习者没说过的话。
   */
  async kickoffTutor(nodeId, instruction, hooks = {}) {
    const node = this.requireNode(nodeId);
    const session = this.session(tutorSessionId(nodeId));
    await this.compactIfNeeded(session, node);
    const toolContext = {
      workspace: this.workspace,
      node,
      session,
      onStatusChange: (status) => {
        node.status = status;
        this.saveCurriculum();
      },
      ...this.vaultAccess ? { vault: this.vaultAccess } : {}
    };
    session.appendCustom(
      ENTRY_KICKOFF,
      { instruction: instruction ? `${KICKOFF_INSTRUCTION}

补充交代：${instruction}` : KICKOFF_INSTRUCTION },
      true
    );
    if (node.status === "pending") {
      node.status = "learning";
      this.saveCurriculum();
    }
    const result = await runAgentLoop({
      provider: this.provider,
      system: buildTutorSystemPrompt(node, this.curriculum.learnerProfile),
      history: session.buildContext(),
      registry: createTutorRegistry(Boolean(this.vaultAccess)),
      toolContext,
      maxIterations: this.maxIterations,
      maxTokens: this.maxOutputTokens,
      reasoningEffort: this.reasoning.tutor,
      cacheKey: session.id,
      ...hooks.emit ? { emit: hooks.emit } : {},
      ...hooks.signal ? { signal: hooks.signal } : {},
      onMessage: (m) => {
        session.appendMessage(m);
      }
    });
    this.maybeAutoExport();
    return result;
  }
  async runTurn(options) {
    const { session, system, message, hooks } = options;
    session.appendMessage(userText(message));
    const result = await runAgentLoop({
      provider: this.provider,
      system,
      history: session.buildContext(),
      registry: options.registry,
      toolContext: options.toolContext,
      maxIterations: this.maxIterations,
      maxTokens: this.maxOutputTokens,
      reasoningEffort: options.reasoningEffort,
      // 会话 id 同时作为缓存亲和键：让同一会话的请求粘在同一个后端
      cacheKey: session.id,
      ...hooks.emit ? { emit: hooks.emit } : {},
      ...hooks.signal ? { signal: hooks.signal } : {},
      onMessage: (m) => {
        session.appendMessage(m);
      }
    });
    this.maybeAutoExport();
    return result;
  }
  /**
   * 上下文接近窗口上限时压缩。
   *
   * 放在每轮请求之前检查，而不是之后：这样能保证即将发出的这次请求一定装得下。
   * 事后压缩则可能出现「已经超了但还没压」的窗口期。
   */
  async compactIfNeeded(session, node) {
    const settings = this.compactionSettings();
    const messages = session.buildContext();
    if (!shouldCompact(messages, settings)) return;
    const result = await compactMessages({
      messages,
      provider: this.provider,
      settings
    });
    if (!result) return;
    session.appendCompaction(result.summary, result.retainedTail, result.tokensBefore);
    if (node) appendCompactionToNotes(this.workspace, node.id, result.summary);
  }
  // -------------------------------------------------------------------------
  // 派发与注入
  // -------------------------------------------------------------------------
  /**
   * 把知识点交给导师。这里不做任何后台工作——导师是学习者直接对话的对象，
   * 它的第一轮由学习者或界面的「开场」动作触发，而不是悄悄跑掉。
   */
  async dispatch(nodeId, instruction) {
    const node = this.requireNode(nodeId);
    this.session(tutorSessionId(nodeId));
    const prerequisites = node.prerequisites.map((id) => this.curriculum.nodes.find((n) => n.id === id)).filter((n) => n !== void 0);
    const lines = [`已为「${node.title}」建立学习会话。`];
    if (instruction) lines.push(`已把你的交代转达给导师。`);
    if (prerequisites.length > 0) {
      const notMastered = prerequisites.filter((p) => p.status !== "mastered");
      if (notMastered.length > 0) {
        lines.push(
          `注意：前置知识点 ${notMastered.map((p) => `「${p.title}」(${p.id})`).join("、")} 尚未掌握，导师会在对话中指出。若学习者确实不熟，考虑先用它的笔记做一次注入。`
        );
      }
    }
    return lines.join("\n");
  }
  async inject(sourceId, targetId, hint, signal) {
    const invalid = validateInjection(this.curriculum, sourceId, targetId);
    if (invalid) throw new Error(invalid);
    const sourceNode = this.requireNode(sourceId);
    const targetNode = this.requireNode(targetId);
    const { essence, cached } = await generateEssence({
      workspace: this.workspace,
      curriculum: this.curriculum,
      sourceNode,
      targetNode,
      ...hint ? { hint } : {},
      provider: this.provider,
      ...signal ? { signal } : {}
    });
    const existing = listInjections(this.workspace).find(
      (record2) => !record2.revokedAt && record2.sourceNodeId === sourceId && record2.targetNodeId === targetId && record2.content === essence.content
    );
    if (existing) {
      return { record: existing, cached: true, alreadyApplied: true };
    }
    const session = this.session(tutorSessionId(targetId));
    const { record } = applyInjection(session, essence, this.workspace);
    return { record, cached, alreadyApplied: false };
  }
  revokeInjection(injectionId) {
    const record = listInjections(this.workspace).find((r) => r.id === injectionId);
    if (!record) throw new Error(`找不到注入记录 ${injectionId}`);
    if (record.revokedAt) return;
    const session = this.session(tutorSessionId(record.targetNodeId));
    revokeInjection(session, record, this.workspace);
  }
  // -------------------------------------------------------------------------
  // 给上层的视图
  // -------------------------------------------------------------------------
  snapshot() {
    const latestReports = latestReportsByNode(this.curriculum, this.workspace);
    return {
      topic: this.curriculum.topic,
      learnerProfile: this.curriculum.learnerProfile,
      nodes: this.curriculum.nodes.map((node) => ({
        ...node,
        hasNotes: hasNotes(this.workspace, node.id),
        ...latestReports.get(node.id) ? { latestReport: latestReports.get(node.id) } : {}
      })),
      injections: listInjections(this.workspace)
    };
  }
  /**
   * 导出某个会话的分支，供界面渲染。
   *
   * 直接返回条目而不是渲染后的消息：界面对报告、题目、注入的呈现方式和模型看到的
   * 完全不同（比如题目的参考答案要等学习者作答后才显示），这个区分必须在原始条目
   * 层面保留，渲染成消息就丢失了。
   */
  sessionEntries(sessionId) {
    return this.session(sessionId).branch();
  }
  notes(nodeId) {
    return readNotes(this.workspace, nodeId);
  }
  requireNode(nodeId) {
    const node = this.curriculum.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`找不到知识点 ${nodeId}`);
    return node;
  }
};

// ../src/learn/prompts/compress.md
var compress_default = '你是一个学习内容的转换器。\n\n学习者正在学一个新的知识点。他之前学过另一个知识点，并留下了学习笔记。\n你的任务是从那些笔记里，提取出**理解新知识点所必需**的前置知识。\n\n## 严格规则\n\n- 只提取对理解新知识点有用的部分。源笔记里与新知识点无关的内容一律舍弃。\n- 用新知识点会用到的视角重新组织，不要照搬源笔记的结构。\n- 保留具体可用的内容：定义、规则、具体例子、容易混淆的概念对比。\n- 删掉所有元话语——不要写"学习者应该记住""需要注意的是"这类引导语，直接写知识本身。\n- 如果源笔记里有学习者尚未解决的问题，也带过来并明确标注，提醒新导师留意。\n- 宁精勿全。这是一份参考资料，不是教材。目标是让新导师不用重复讲解已经会的东西。\n\n## 输出格式\n\n直接输出 markdown 正文，不要开场白、不要"以下是提取的内容"这类引导句。\n用二级标题组织，标题按新知识点的需要来定，不必沿用源笔记的小节名。\n';

// ../src/learn/prompts/planner.md
var planner_default = '你是一个学习规划师，负责管理一位学习者的整体学习路径。\n\n你的产出是**大纲**——一张知识点的依赖图，以及每个知识点该用什么方法学。具体每个\n知识点怎么讲，是导师的事，不是你的。\n\n## 你看得到什么，看不到什么\n\n你只能看到两样东西：\n\n1. **大纲本身** —— 有哪些知识点、它们的依赖关系、各自的状态和学习方法\n2. **导师的进度报告** —— 每个知识点最新的几句状态描述\n\n**你看不到任何教学细节。** 导师和学习者具体聊了什么、用了什么例子、学习者做错了\n哪道题，这些都不在你的视野里。这不是限制，是设计：你的职责是做全局调度，如果把\n几十个知识点的教学细节都堆进来，你的判断力会被淹没在噪声里。\n\n所以：\n- 不要试图追问教学细节，也不要要求导师给你更多过程信息\n- 报告里说了学习者掌握了什么，你就据此判断，不必怀疑\n- 你的信息不足时，应该问**学习者本人**，而不是去翻导师的记录\n\n## 建大纲的原则\n\n- **依赖要真实。** 只有确实需要先学会 A 才能理解 B 时才连边。不要为了"循序渐进"\n  而虚构依赖——那会让学习者被无关的顺序绑住。\n- **目标是可验证的行为。** 写"能解释栈和堆的内存分配差异"，不写"理解栈和堆"。\n  后者无法检验，导师也就无法判断教到什么程度算完。\n- **粒度适中。** 一个知识点应该是"一次能学完的量"——大约一次专注学习的时长。\n  太大了导师会教得发散，太小了会把大纲撑得琐碎。\n- **选对方法。** 概念性的内容用 explain，需要手感的用 practice，有争议或需要建立\n  直觉的用 discuss，容易遗忘或需要串联的用 review。可以多选。\n\n## 派发与调整\n\n- 派发时讲清楚**为什么现在学这个**、以及和前后知识点的关系，导师需要这个上下文。\n- 学习者学完一个知识点后，根据报告判断下一步：继续下一个、回头复习、或者补一个\n  遗漏的前置。\n- 导师上报的 suggested_next 是你了解知识缺口的重要信号——它来自一线的教学判断。\n  但采纳与否由你决定，因为只有你看得到全局。采纳时注意它在大纲里的位置是否合理。\n- 大纲不是一次成型的。学到中途发现遗漏很正常，随时补。\n\n## 和学习者对话\n\n## 了解学习者的笔记库\n\n如果运行环境提供了 `list_vault_structure`，说明你**能看到学习者的 Obsidian 笔记库**。\n这很重要：设计大纲前先看一眼他的库是怎么组织的——哪些领域已经有积累、笔记记到什么\n粒度、有没有相关的既有笔记可以接上。你的大纲和他已有的笔记脉络对得上，他才真的会去用。\n\n两个注意：\n- 先看结构（`list_vault_structure`），需要时再读单篇（`read_vault_note`）。**不要通读整个库**，\n  那会把你的上下文淹掉，反而做不好全局调度。\n- 他已有的笔记是你的**依据**，不是你的产出。你的产出仍然是大纲和派发给导师的任务。\n\n学习者会跟你说他的目标、进度、困难。你回应时的重点：\n- 他表达模糊的学习目标时，**追问具体场景**。想"学 Rust"和想"能读懂公司代码库里的\n  Rust 服务"需要的大纲完全不同。\n- 他反馈学不下去、太难、太慢时，调整大纲——拆细、换方法、去掉不必要的前置，\n  而不是让他硬扛。\n- 定期告诉他整体进度和下一步安排，让他知道自己在哪。\n\n## 工具使用\n\n- **add_knowledge_point**：新增知识点。建大纲时批量加，学到中途按需补。\n- **update_knowledge_point**：调整标题、目标、依赖、方法，或修正状态。\n- **dispatch_tutor**：把某个知识点交给导师开始教。学习者会在界面上进入对应的对话。\n- **set_learning_goal**：把学习主题和读者画像记录下来。确认清楚目标后**先调它一次**，\n  因为主题决定了大纲标题，也决定了导出到 Obsidian 时的索引文件名。主题要写成一句\n  具体的描述（"Rust 内存管理，为了读懂公司代码库里的服务"），不要只写"Rust"——\n  范围不同，大纲会完全不同。之后了解得更清楚了可以再更新。\n\n## 开头怎么做\n\n如果大纲还是空的，先问清楚：想学什么、为了什么、现在什么水平、大概能投入多少时间。\n问清楚了再开始建节点。不要一上来就列一堆知识点——那通常和真实需求对不上。\n';

// ../src/learn/prompts/tutor.md
var tutor_default = '你是一个知识点的专属导师，负责带一位学习者把这个知识点真正学会。\n\n你不是问答机器人。你的目标是让学习者**能够自己用出来**，而不是让他听过一遍就过去。\n所以你要主动推进：什么时候讲、什么时候出题检验、什么时候回头补漏，由你判断。\n\n## 教学原则\n\n- **先摸清起点。** 开口之前先确认学习者对这个知识点已经知道多少。他不知道的先讲，\n  他会了的别浪费时间。\n- **一次一个点。** 一个回合只推进一个概念，讲完就停下来确认。连续讲五个要点等于\n  一个都没讲。\n- **用具体的东西。** 抽象规则必须配例子。学习者卡住时，换一个更小的例子重新讲，\n  而不是把同样的话再说一遍。\n- **检验而不是询问。** 不要问"听明白了吗"——学习者几乎总是说听明白了。要出具体的\n  题让他做，从他的答案里判断。\n- **接受"不知道"。** 学习者说不会的时候，那是有效信息，不要让他觉得尴尬。直接讲，\n  或者换个角度再讲一次。\n- **别灌水。** 不要用大段铺垫、总结、鼓励。学习者要的是内容。\n\n## 你的三种产物，去向严格不同\n\n这是最重要的一条纪律。你的工作会产生三样东西，它们流向完全不同的地方：\n\n1. **笔记**（save_note）—— 你的详细教学记录。存在文件里，给学习者回顾用，也可能\n   被提取给其他知识点的导师。**这是你唯一可以写学习细节的地方。**\n\n2. **进度报告**（report_progress）—— 给学习规划师看的。规划师管理着整个学习大纲，\n   他会根据你的报告调整学习计划。**他看不到你的教学细节，只看到你报告的这几句话。**\n   所以报告要写"学习者现在处于什么状态"，而不是"我们今天讲了什么"。\n\n3. **对话** —— 你和学习者的实时交流，只有你们两个人看得到。\n\n**绝不要把教学细节塞进进度报告。** 规划师不需要知道你怎么解释某个概念的、学习者\n做错了哪道题。把细节写进笔记，把状态写进报告。\n\n## 工具使用\n\n- **list_learner_notes**：如果运行环境提供这个工具，说明你能看到学习者的 Obsidian\n  笔记库。讲一个概念前想知道「他之前有没有碰过这个、记过什么」时可以看一眼——\n  从他的既有笔记出发讲，比从头讲起有效得多。看完就把注意力收回到教学上。\n- **read_notes**：开始一个新的学习阶段前先调用它，看看你之前记了什么。特别是当一个\n  知识点的学习跨了很多天、或者对话已经被压缩过的时候——你的记忆可能不完整，笔记\n  才是可靠的。\n- **save_note**：讲完一个成体系的段落就记下来。宁可多记，笔记是学习者的资产。\n  用固定的小节名（核心概念 / 关键要点 / 例题与练习 / 疑问与澄清）。\n- **ask_learner**：出一道需要学习者动脑的题。题目要能区分"真懂了"和"觉得懂了"。\n  出完题就停下来等，不要自问自答。\n- **report_progress**：在这些时刻调用——学习者明确掌握了一个阶段、遇到明显卡点、\n  或者你判断这个知识点整体学完了。不要求每轮都报。\n\n## 判断"学完了"的标准\n\n不要因为讲完了就报 mastered。判断依据应该是学习者的表现：他能用自己的话解释、\n能解决没见过的变体问题、能指出常见错误。做不到就继续，或者明确报告卡在哪里。\n\n如果学习者提出的大纲里没有的知识点，用它作为 suggested_next 上报给规划师——\n那是规划师的职责范围，你不要自己去补。\n';

// src/bootstrap.ts
var DEFAULT_SETTINGS = {
  providerKind: "anthropic",
  model: "claude-sonnet-4-5",
  apiKey: "",
  baseUrl: "",
  contextWindow: 2e5,
  maxOutputTokens: 32768,
  reasoning: { ...DEFAULT_REASONING },
  thinkingFormat: "auto",
  notesFolder: "学习Agent",
  autoWriteNotes: true,
  customRoles: []
};
var promptsInjected = false;
function injectPrompts() {
  if (promptsInjected) return;
  setPromptOverrides({
    tutor: tutor_default,
    planner: planner_default,
    compress: compress_default
  });
  promptsInjected = true;
}
function vaultBasePath(app) {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof import_obsidian3.FileSystemAdapter)) {
    throw new Error("Learn Agent 只支持桌面端 Obsidian");
  }
  return adapter.getBasePath();
}
function stateDir(app, manifestDir) {
  return `${vaultBasePath(app)}/${manifestDir}/data`;
}
function buildRuntimeConfig(app, manifestDir, settings) {
  injectPrompts();
  const provider = {
    kind: settings.providerKind,
    model: settings.model,
    apiKey: settings.apiKey,
    ...settings.baseUrl.trim() ? { baseUrl: settings.baseUrl.trim() } : {},
    ...settings.thinkingFormat !== "auto" ? { thinkingFormat: settings.thinkingFormat } : {}
  };
  return {
    provider,
    // 状态放插件目录，不放笔记树
    workspaceRoot: stateDir(app, manifestDir),
    port: 0,
    // 插件里没有服务端
    maxIterations: 40,
    contextWindow: settings.contextWindow,
    maxOutputTokens: settings.maxOutputTokens,
    reasoning: settings.reasoning,
    thinkingFormat: settings.thinkingFormat,
    // 插件里不走向量导出那条路——笔记由 view 层在每轮结束后直接写进库，
    // 这样复用 app.vault，Obsidian 的文件索引能立刻感知到。
    obsidian: {}
  };
}
function createRuntime(app, manifestDir, settings) {
  return new LearningRuntime(buildRuntimeConfig(app, manifestDir, settings));
}

// src/settings-tab.ts
var import_obsidian5 = require("obsidian");

// src/settings-form.ts
var import_obsidian4 = require("obsidian");
var EFFORT_LABELS = {
  off: "关闭",
  low: "低",
  high: "高（默认）",
  max: "最高"
};
var KIND_LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI 兼容（含 DeepSeek）",
  mock: "演示模式"
};
var THINKING_FORMAT_LABELS = {
  auto: "自动（按地址推断）",
  deepseek: "DeepSeek（thinking.type 字段）",
  openai: "OpenAI（reasoning_effort）",
  none: "不发送（兼容服务不认时选它）"
};
var PRESETS = [
  {
    label: "DeepSeek（官方，推荐）",
    kind: "openai",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    contextWindow: 1e6
  },
  {
    label: "DeepSeek（Anthropic 兼容）",
    kind: "anthropic",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com/anthropic",
    contextWindow: 1e6
  },
  {
    label: "Anthropic 官方",
    kind: "anthropic",
    model: "claude-sonnet-4-5",
    baseUrl: "",
    contextWindow: 2e5
  }
];
function renderSettingsForm(container, host) {
  const settings = host.getSettings();
  container.empty();
  container.createEl("h4", { text: "工作目录" });
  container.createEl("p", {
    cls: "setting-item-description",
    text: "导师的笔记写进这里；规划师也从这个目录开始了解你的笔记怎么组织。"
  });
  const folders = listVaultFolders(host.app);
  const current = settings.notesFolder.trim() || DEFAULT_SETTINGS.notesFolder;
  const NEW_OPTION = "__new__";
  new import_obsidian4.Setting(container).setName("目录").setDesc(folders.includes(current) ? current : `${current}（尚不存在，会新建）`).addDropdown((dropdown) => {
    dropdown.addOption(NEW_OPTION, "＋ 新建目录…");
    for (const folder of folders) dropdown.addOption(folder, folder);
    dropdown.setValue(folders.includes(current) ? current : NEW_OPTION);
    dropdown.onChange(async (value) => {
      if (value === NEW_OPTION) {
        showNewFolderInput(container, host);
        return;
      }
      await ensureFolder(host.app, value);
      await host.commit({ notesFolder: value });
      new import_obsidian4.Notice(`工作目录已设为「${value}」`);
      host.rerender();
    });
  });
  if (!folders.includes(current)) showNewFolderInput(container, host);
  new import_obsidian4.Setting(container).setName("每轮自动写入").setDesc("关掉则笔记只留在 agent 内部，不写进库。").addToggle((toggle) => {
    toggle.setValue(settings.autoWriteNotes);
    toggle.onChange(async (value) => {
      await host.commit({ autoWriteNotes: value });
    });
  });
  container.createEl("h4", { text: "模型" });
  new import_obsidian4.Setting(container).setName("快速填充").setDesc("填入地址、模型名和上下文窗口；key 仍需你自己填。").addDropdown((dropdown) => {
    dropdown.addOption("", "选择预设…");
    for (const preset of PRESETS) dropdown.addOption(preset.label, preset.label);
    dropdown.setValue("");
    dropdown.onChange(async (value) => {
      const preset = PRESETS.find((p) => p.label === value);
      if (!preset) return;
      await host.commit({
        providerKind: preset.kind,
        model: preset.model,
        baseUrl: preset.baseUrl,
        contextWindow: preset.contextWindow
      });
      host.rerender();
    });
  });
  new import_obsidian4.Setting(container).setName("提供方").addDropdown((dropdown) => {
    for (const [value, label] of Object.entries(KIND_LABELS)) {
      dropdown.addOption(value, label);
    }
    dropdown.setValue(settings.providerKind);
    dropdown.onChange(async (value) => {
      await host.commit({ providerKind: value });
      host.rerender();
    });
  });
  if (settings.providerKind !== "mock") {
    new import_obsidian4.Setting(container).setName("API key").setDesc("只存在本机。").addText((text) => {
      text.inputEl.type = "password";
      text.setValue(settings.apiKey);
      text.onChange(async (value) => {
        await host.commit({ apiKey: value.trim() });
      });
    });
    new import_obsidian4.Setting(container).setName("模型名").addText((text) => {
      text.setValue(settings.model);
      text.onChange(async (value) => {
        await host.commit({ model: value.trim() });
      });
    });
    new import_obsidian4.Setting(container).setName("baseUrl").setDesc("留空用官方地址。").addText((text) => {
      text.setValue(settings.baseUrl);
      text.onChange(async (value) => {
        await host.commit({ baseUrl: value.trim() });
      });
    });
    new import_obsidian4.Setting(container).setName("上下文窗口").setDesc("决定压缩时机。DeepSeek V4 是 1,000,000——填错会让压缩过早或请求超限。").addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(settings.contextWindow));
      text.onChange(async (value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return;
        await host.commit({ contextWindow: Math.max(8e3, Math.floor(parsed)) });
      });
    });
    new import_obsidian4.Setting(container).setName("测试连接").setDesc("发一条最小请求，验证 key / 模型名 / 地址。").addButton((button) => {
      button.setButtonText("测试").onClick(async () => {
        button.setDisabled(true);
        button.setButtonText("…");
        try {
          const { probeProvider: probeProvider2 } = await Promise.resolve().then(() => (init_probe(), probe_exports));
          const s = host.getSettings();
          const result = await probeProvider2({
            kind: s.providerKind,
            model: s.model,
            apiKey: s.apiKey,
            ...s.baseUrl ? { baseUrl: s.baseUrl } : {}
          });
          new import_obsidian4.Notice(result.message, result.ok ? 6e3 : 12e3);
        } catch (error) {
          new import_obsidian4.Notice(`测试失败：${error instanceof Error ? error.message : String(error)}`, 12e3);
        } finally {
          button.setDisabled(false);
          button.setButtonText("测试");
        }
      });
    });
  }
  container.createEl("h4", { text: "推理强度" });
  container.createEl("p", {
    cls: "setting-item-description",
    text: "回答前花多少 token 思考。是拿延迟和费用换多步推理的准确率，不是「提升智力」。"
  });
  new import_obsidian4.Setting(container).setName("规划师").addDropdown((dropdown) => {
    for (const value of REASONING_VALUES) dropdown.addOption(value, EFFORT_LABELS[value]);
    dropdown.setValue(settings.reasoning.planner);
    dropdown.onChange(async (value) => {
      await host.commit({
        reasoning: { ...host.getSettings().reasoning, planner: value }
      });
    });
  });
  new import_obsidian4.Setting(container).setName("导师").addDropdown((dropdown) => {
    for (const value of REASONING_VALUES) dropdown.addOption(value, EFFORT_LABELS[value]);
    dropdown.setValue(settings.reasoning.tutor);
    dropdown.onChange(async (value) => {
      await host.commit({
        reasoning: { ...host.getSettings().reasoning, tutor: value }
      });
    });
  });
  container.createEl("h4", { text: "高级" });
  new import_obsidian4.Setting(container).setName("thinking 字段形态").setDesc("自动判断即可；某些兼容服务两个字段都不认时选「不发送」。").addDropdown((dropdown) => {
    for (const [value, label] of Object.entries(THINKING_FORMAT_LABELS)) {
      dropdown.addOption(value, label);
    }
    dropdown.setValue(settings.thinkingFormat);
    dropdown.onChange(async (value) => {
      await host.commit({ thinkingFormat: value });
    });
  });
  new import_obsidian4.Setting(container).setName("最大输出 tokens").setDesc("默认 32768。开启 thinking 的模型给小了会「不说话」。").addText((text) => {
    text.inputEl.type = "number";
    text.setValue(String(settings.maxOutputTokens));
    text.onChange(async (value) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return;
      await host.commit({ maxOutputTokens: Math.max(1024, Math.floor(parsed)) });
    });
  });
}
function showNewFolderInput(container, host) {
  let draft = "";
  new import_obsidian4.Setting(container).setName("新建目录").setDesc("可以写多级，如 学习/Rust。").addText((text) => {
    text.setPlaceholder("学习Agent");
    text.onChange((value) => {
      draft = value.trim();
    });
  }).addButton((button) => {
    button.setButtonText("创建").setCta().onClick(async () => {
      const name = draft.trim();
      if (!name) {
        new import_obsidian4.Notice("目录名不能为空");
        return;
      }
      await ensureFolder(host.app, name);
      await host.commit({ notesFolder: name });
      new import_obsidian4.Notice(`工作目录已设为「${name}」`);
      host.rerender();
    });
  });
}

// src/settings-tab.ts
var LearnAgentSettingTab = class extends import_obsidian5.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Learn Agent" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "这些设置在面板右上角的齿轮里也能改。"
    });
    renderSettingsForm(containerEl, {
      app: this.app,
      getSettings: () => this.plugin.settings,
      commit: (next) => this.plugin.updateSettings(next),
      rerender: () => this.display()
    });
  }
};

// src/view.ts
var import_obsidian7 = require("obsidian");

// src/role-list.ts
var import_obsidian6 = require("obsidian");
function roleRefId(ref) {
  switch (ref.kind) {
    case "planner":
      return "planner";
    case "tutor":
      return `tutor:${ref.nodeId}`;
    case "custom":
      return `custom:${ref.roleId}`;
  }
}
var RoleList = class {
  constructor(root, options) {
    this.root = root;
    this.options = options;
  }
  expanded = false;
  get isExpanded() {
    return this.expanded;
  }
  toggle() {
    this.expanded = !this.expanded;
    this.render();
  }
  render() {
    const { root } = this;
    root.empty();
    root.toggleClass("is-expanded", this.expanded);
    const header = root.createDiv({ cls: "learn-agent-roles-header" });
    const toggleBtn = header.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": this.expanded ? "收起角色栏" : "展开角色栏" }
    });
    (0, import_obsidian6.setIcon)(toggleBtn, this.expanded ? "chevron-left" : "chevron-right");
    toggleBtn.addEventListener("click", () => this.toggle());
    if (this.expanded) {
      header.createSpan({ cls: "learn-agent-roles-title", text: "角色" });
    }
    const list = root.createDiv({ cls: "learn-agent-roles-list" });
    for (const entry of this.entries()) {
      const isActive = roleRefId(entry.ref) === roleRefId(this.options.selected);
      const item = list.createDiv({
        cls: `learn-agent-role${isActive ? " is-active" : ""}`,
        attr: { "aria-label": entry.name }
      });
      const iconEl = item.createDiv({ cls: "learn-agent-role-icon" });
      (0, import_obsidian6.setIcon)(iconEl, entry.icon);
      if (this.expanded) {
        const text = item.createDiv({ cls: "learn-agent-role-text" });
        text.createDiv({ cls: "learn-agent-role-name", text: entry.name });
        if (entry.hint) {
          text.createDiv({ cls: "learn-agent-role-hint", text: entry.hint });
        }
        if (entry.editable) {
          const actions = item.createDiv({ cls: "learn-agent-role-actions" });
          const editBtn = actions.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "编辑" }
          });
          (0, import_obsidian6.setIcon)(editBtn, "pencil");
          editBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            this.openRoleEditor(entry.editable, false);
          });
          const delBtn = actions.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "删除" }
          });
          (0, import_obsidian6.setIcon)(delBtn, "trash-2");
          delBtn.addEventListener("click", async (event) => {
            event.stopPropagation();
            const roles = this.options.plugin.settings.customRoles.filter(
              (r) => r.id !== entry.editable.id
            );
            await this.options.plugin.updateSettings({ customRoles: roles });
            if (this.options.selected.kind === "custom" && this.options.selected.roleId === entry.editable.id) {
              this.options.onSelect({ kind: "planner" });
            }
            new import_obsidian6.Notice(`已删除角色「${entry.name}」（它的会话记录还在磁盘上）`);
            this.options.onChange();
          });
        }
      }
      item.addEventListener("click", () => {
        if (!this.expanded) {
          this.toggle();
          return;
        }
        this.options.onSelect(entry.ref);
      });
    }
    if (this.expanded) {
      const addBtn = list.createDiv({ cls: "learn-agent-role learn-agent-role-add" });
      const addIcon = addBtn.createDiv({ cls: "learn-agent-role-icon" });
      (0, import_obsidian6.setIcon)(addIcon, "plus");
      const addText = addBtn.createDiv({ cls: "learn-agent-role-text" });
      addText.createDiv({ cls: "learn-agent-role-name", text: "新增角色" });
      addText.createDiv({ cls: "learn-agent-role-hint", text: "自定义提示词与工具" });
      addBtn.addEventListener("click", () => this.openRoleEditor(null, true));
    }
  }
  /** 组装当前应该显示的角色条目。 */
  entries() {
    const out = [];
    const curriculum = this.options.plugin.runtime.getCurriculum();
    out.push({
      ref: { kind: "planner" },
      name: "规划师",
      icon: "compass",
      hint: "管理大纲与学习计划"
    });
    for (const node of curriculum.nodes) {
      out.push({
        ref: { kind: "tutor", nodeId: node.id },
        name: node.title,
        icon: node.status === "mastered" ? "check-circle" : "graduation-cap",
        hint: `${node.id} · 导师`
      });
    }
    for (const role of this.options.plugin.settings.customRoles) {
      out.push({
        ref: { kind: "custom", roleId: role.id },
        name: role.name,
        icon: role.icon?.trim() || "message-square",
        hint: role.attachActiveNote ? "自动附带当前笔记" : "自定义角色",
        editable: role
      });
    }
    return out;
  }
  /**
   * 角色编辑弹窗。
   *
   * 用 Obsidian 的 Modal 而不是塞进设置页——新增角色是「现在就想加一个」的动作，
   * 不该把人赶到设置里去。写提示词需要空间，弹窗比右栏里的输入框合适。
   */
  openRoleEditor(role, isNew) {
    const draft = role ? { ...role } : {
      id: newRoleId(),
      name: "",
      icon: "message-square",
      systemPrompt: "",
      attachActiveNote: true,
      vaultAccess: true
    };
    const modal = new import_obsidian6.Modal(this.options.app);
    modal.titleEl.setText(isNew ? "新增对话角色" : "编辑角色");
    const { contentEl } = modal;
    new import_obsidian6.Setting(contentEl).setName("名称").setDesc("会显示在左栏").addText((text) => {
      text.setValue(draft.name);
      text.setPlaceholder("例如：笔记总结");
      text.onChange((value) => {
        draft.name = value;
      });
    });
    new import_obsidian6.Setting(contentEl).setName("图标").setDesc("lucide 图标名，如 file-text / list / languages / lightbulb").addText((text) => {
      text.setValue(draft.icon ?? "");
      text.setPlaceholder("message-square");
      text.onChange((value) => {
        draft.icon = value.trim();
      });
    });
    new import_obsidian6.Setting(contentEl).setName("系统提示").setDesc("这个角色是干什么的、该怎么回应。写得越具体，它越像你要的那个人。").addTextArea((area) => {
      area.setValue(draft.systemPrompt);
      area.setPlaceholder(
        "例如：\n你是一个笔记整理助手。学习者会给你一篇笔记或一段内容，你要把它压缩成结构清晰的要点，保留具体的名称、数字和结论，删掉铺垫和重复。输出用 markdown，不要加评论。"
      );
      area.inputEl.rows = 8;
      area.inputEl.style.width = "100%";
      area.onChange((value) => {
        draft.systemPrompt = value;
      });
    });
    new import_obsidian6.Setting(contentEl).setName("自动附带当前笔记").setDesc("打开时，每轮都把你当前打开的笔记内容附在消息前面——不用先复制粘贴。").addToggle((toggle) => {
      toggle.setValue(Boolean(draft.attachActiveNote));
      toggle.onChange((value) => {
        draft.attachActiveNote = value;
      });
    });
    new import_obsidian6.Setting(contentEl).setName("允许查看笔记库").setDesc("给它看目录结构和按需读单篇的能力。只读，不能改你的笔记。").addToggle((toggle) => {
      toggle.setValue(draft.vaultAccess !== false);
      toggle.onChange((value) => {
        draft.vaultAccess = value;
      });
    });
    new import_obsidian6.Setting(contentEl).addButton((button) => {
      button.setButtonText(isNew ? "创建" : "保存").setCta().onClick(async () => {
        if (!draft.name.trim()) {
          new import_obsidian6.Notice("名称不能为空");
          return;
        }
        if (!draft.systemPrompt.trim()) {
          new import_obsidian6.Notice("系统提示不能为空——那才是这个角色的行为定义");
          return;
        }
        const roles = [...this.options.plugin.settings.customRoles];
        const index = roles.findIndex((r) => r.id === draft.id);
        if (index >= 0) roles[index] = draft;
        else roles.push(draft);
        await this.options.plugin.updateSettings({ customRoles: roles });
        modal.close();
        if (isNew) this.options.onSelect({ kind: "custom", roleId: draft.id });
        else this.options.onChange();
      });
    });
    modal.open();
  }
  /** 当前选中的角色条目（给视图查提示用）。 */
  find(ref) {
    return this.entries().find((e) => roleRefId(e.ref) === roleRefId(ref));
  }
};

// src/view.ts
var VIEW_TYPE_LEARN_AGENT = "learn-agent-view";
var ACTIVE_NOTE_MAX_CHARS = 8e3;
var LearnAgentView = class extends import_obsidian7.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.runtime = plugin.runtime;
  }
  runtime;
  role = { kind: "planner" };
  roleListEl;
  roleList;
  listEl;
  inputEl;
  sendBtn;
  statusEl;
  settingsEl;
  composerEl;
  gearBtn;
  showingSettings = false;
  streaming = false;
  streamEl = null;
  streamText = "";
  getViewType() {
    return VIEW_TYPE_LEARN_AGENT;
  }
  getDisplayText() {
    return "学习 Agent";
  }
  getIcon() {
    return "graduation-cap";
  }
  async onOpen() {
    this.buildLayout();
    await this.renderConversation();
    this.inputEl.focus();
  }
  onRuntimeChanged(runtime) {
    this.runtime = runtime;
    this.roleList?.render();
    void this.renderConversation();
  }
  // -------------------------------------------------------------------------
  // 布局
  // -------------------------------------------------------------------------
  buildLayout() {
    const root = this.contentEl;
    root.empty();
    root.addClass("learn-agent-root");
    this.roleListEl = root.createDiv({ cls: "learn-agent-roles" });
    this.roleList = new RoleList(this.roleListEl, {
      app: this.app,
      plugin: this.plugin,
      selected: this.role,
      onSelect: (ref) => {
        this.role = ref;
        this.roleList.options.selected = ref;
        this.roleList.render();
        void this.renderConversation();
        this.inputEl.focus();
      },
      onChange: () => this.roleList.render()
    });
    const main = root.createDiv({ cls: "learn-agent-main" });
    const header = main.createDiv({ cls: "learn-agent-header" });
    this.statusEl = header.createDiv({ cls: "learn-agent-status" });
    const actions = header.createDiv({ cls: "learn-agent-header-actions" });
    this.gearBtn = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "设置" }
    });
    (0, import_obsidian7.setIcon)(this.gearBtn, "settings");
    this.gearBtn.addEventListener("click", () => this.toggleSettings());
    const refreshBtn = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "刷新" }
    });
    (0, import_obsidian7.setIcon)(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => {
      this.roleList.render();
      void this.renderConversation();
    });
    this.settingsEl = main.createDiv({ cls: "learn-agent-settings" });
    this.settingsEl.style.display = "none";
    this.listEl = main.createDiv({ cls: "learn-agent-messages" });
    this.composerEl = main.createDiv({ cls: "learn-agent-composer" });
    this.inputEl = this.composerEl.createEl("textarea", {
      cls: "learn-agent-input",
      attr: { rows: "1", placeholder: "说点什么…（Enter 发送，Shift+Enter 换行）" }
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.send();
      }
    });
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 200)}px`;
    });
    this.sendBtn = this.composerEl.createEl("button", {
      cls: "mod-cta learn-agent-send",
      text: "发送"
    });
    this.sendBtn.addEventListener("click", () => void this.send());
    this.roleList.render();
  }
  toggleSettings() {
    this.showingSettings = !this.showingSettings;
    this.settingsEl.style.display = this.showingSettings ? "" : "none";
    this.listEl.style.display = this.showingSettings ? "none" : "";
    this.composerEl.style.display = this.showingSettings ? "none" : "";
    this.gearBtn.toggleClass("is-active", this.showingSettings);
    if (this.showingSettings) {
      this.statusEl.setText("设置");
      this.paintSettings();
    } else {
      this.updateStatus();
      this.inputEl.focus();
    }
  }
  paintSettings() {
    renderSettingsForm(this.settingsEl, {
      app: this.app,
      getSettings: () => this.plugin.settings,
      commit: (next) => this.plugin.updateSettings(next),
      rerender: () => this.paintSettings()
    });
  }
  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------
  // 都先取到局部变量再收窄：this.role 是可变的，TS 不会跨属性读取保持收窄
  sessionId() {
    const role = this.role;
    switch (role.kind) {
      case "planner":
        return PLANNER_SESSION_ID;
      case "tutor":
        return tutorSessionId(role.nodeId);
      case "custom":
        return customRoleSessionId(role.roleId);
    }
  }
  currentCustomRole() {
    const role = this.role;
    if (role.kind !== "custom") return null;
    return this.plugin.settings.customRoles.find((r) => r.id === role.roleId) ?? null;
  }
  roleName() {
    const role = this.role;
    switch (role.kind) {
      case "planner":
        return "规划师";
      case "tutor": {
        const node = this.runtime.getCurriculum().nodes.find((n) => n.id === role.nodeId);
        return node ? `导师 · ${node.title}` : "导师";
      }
      case "custom":
        return this.currentCustomRole()?.name ?? "（角色已删除）";
    }
  }
  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------
  async renderConversation() {
    this.listEl.empty();
    const current = this.role;
    if (current.kind === "custom" && !this.currentCustomRole()) {
      this.listEl.createDiv({ cls: "learn-agent-empty", text: "这个角色已被删除。" });
      this.updateStatus();
      return;
    }
    const entries = this.runtime.sessionEntries(this.sessionId());
    if (entries.length === 0) {
      this.listEl.createDiv({ cls: "learn-agent-empty", text: this.emptyHint() });
      this.updateStatus();
      return;
    }
    for (const entry of entries) {
      switch (entry.type) {
        case "message": {
          const text = entry.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (!text.trim()) break;
          await this.appendBubble(entry.message.role === "user" ? "user" : "agent", text);
          break;
        }
        case "compaction":
          this.listEl.createDiv({
            cls: "learn-agent-marker",
            text: `上下文已压缩（${entry.tokensBefore.toLocaleString()} tokens → 摘要）`
          });
          break;
        case "custom":
          this.renderCustomEntry(entry.customType, entry.data);
          break;
      }
    }
    this.scrollToBottom();
    this.updateStatus();
  }
  emptyHint() {
    const role = this.role;
    switch (role.kind) {
      case "planner":
        return "告诉规划师你想学什么。说清楚目的和现在的水平，他才能把大纲拆对。";
      case "tutor": {
        const node = this.runtime.getCurriculum().nodes.find((n) => n.id === role.nodeId);
        return node ? `开始学「${node.title}」。` : "这个知识点已经不在大纲里了。";
      }
      case "custom": {
        const role2 = this.currentCustomRole();
        if (role2?.attachActiveNote) {
          return "直接说你想做什么——「总结一下」「梳理成清单」「这段什么意思」。\n\n你当前打开的笔记会自动附在消息里，不用先复制粘贴。";
        }
        return `和「${role2?.name ?? "这个角色"}」开始对话。`;
      }
    }
  }
  renderCustomEntry(customType, data) {
    switch (customType) {
      case "injected_knowledge":
        this.listEl.createDiv({
          cls: "learn-agent-marker learn-agent-injection",
          text: `已注入前置知识 · 来自「${String(data.sourceNodeTitle ?? "")}」`
        });
        break;
      case "report":
        this.listEl.createDiv({
          cls: "learn-agent-marker",
          text: `已向规划师上报：${String(data.summary ?? "")}`
        });
        break;
      case "question":
        this.listEl.createDiv({
          cls: "learn-agent-marker learn-agent-question",
          text: `练习：${String(data.question ?? "")}`
        });
        break;
      case "kickoff":
        break;
    }
  }
  async appendBubble(role, markdown) {
    const wrap = this.listEl.createDiv({ cls: `learn-agent-msg learn-agent-${role}` });
    const body = wrap.createDiv({ cls: "learn-agent-bubble" });
    if (role === "user") {
      body.setText(markdown);
    } else {
      await import_obsidian7.MarkdownRenderer.render(this.app, markdown, body, "", this);
    }
    return body;
  }
  scrollToBottom() {
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }
  updateStatus() {
    this.statusEl.setText(this.roleName());
  }
  // -------------------------------------------------------------------------
  // 一轮对话
  // -------------------------------------------------------------------------
  /**
   * 把当前打开的笔记内容包成一段附在消息前面。
   *
   * 这是「总结当前内容」这类角色能好用的关键：不用先复制粘贴、再描述「我在看哪篇」。
   * 界面上仍然只显示用户原话（那才是他说的），实际发出去的是带上下文的那份。
   */
  async withActiveNote(message) {
    const file = this.app.workspace.getActiveFile();
    if (!file) return message;
    const content = await this.app.vault.cachedRead(file);
    const truncated = content.length > ACTIVE_NOTE_MAX_CHARS ? `${content.slice(0, ACTIVE_NOTE_MAX_CHARS)}

[... 笔记较长，已截断，原文共 ${content.length} 字符]` : content;
    const selection = this.app.workspace.activeEditor?.editor?.getSelection()?.trim();
    const parts = [`（当前笔记：[[${file.basename}]]）`, "", "<note>", truncated, "</note>"];
    if (selection) {
      parts.push("", "学习者当前选中的部分：", "", "<selection>", selection, "</selection>");
    }
    parts.push("", message);
    return parts.join("\n");
  }
  async send() {
    const message = this.inputEl.value.trim();
    if (!message || this.streaming) return;
    const settings = this.plugin.settings;
    if (settings.providerKind !== "mock" && !settings.apiKey.trim()) {
      new import_obsidian7.Notice("还没有配置模型。点右上角齿轮，填入 API key（或先用演示模式）。", 8e3);
      return;
    }
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    if (this.listEl.querySelector(".learn-agent-empty")) this.listEl.empty();
    const outgoing = this.currentCustomRole()?.attachActiveNote ? await this.withActiveNote(message) : message;
    await this.appendBubble("user", message);
    this.streaming = true;
    this.sendBtn.disabled = true;
    this.sendBtn.setText("…");
    const wrap = this.listEl.createDiv({ cls: "learn-agent-msg learn-agent-agent" });
    this.streamEl = wrap.createDiv({ cls: "learn-agent-bubble" });
    this.streamText = "";
    const toolsEl = wrap.createDiv({ cls: "learn-agent-tools" });
    this.scrollToBottom();
    const role = this.role;
    try {
      const onEvent = async (event) => {
        if (event.type === "text_delta") {
          this.streamText += event.text;
          this.streamEl.setText(this.streamText);
          this.scrollToBottom();
        } else if (event.type === "tool_start") {
          toolsEl.createSpan({ cls: "learn-agent-tool", text: this.toolLabel(event.name) });
          this.scrollToBottom();
        }
      };
      const run = (() => {
        switch (role.kind) {
          case "planner":
            return this.runtime.runPlannerTurn(outgoing, { emit: onEvent });
          case "tutor":
            return this.runtime.runTutorTurn(role.nodeId, outgoing, { emit: onEvent });
          case "custom": {
            const customRole = this.plugin.settings.customRoles.find((r) => r.id === role.roleId);
            if (!customRole) throw new Error("角色已被删除");
            return this.runtime.runCustomRoleTurn(customRole, outgoing, { emit: onEvent });
          }
        }
      })();
      const result = await run;
      if (result.error) new import_obsidian7.Notice(`学习 Agent：${result.error}`, 8e3);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      new import_obsidian7.Notice(`学习 Agent 出错：${detail}`, 1e4);
      this.streamEl.setText(`⚠️ ${detail}`);
    } finally {
      this.streaming = false;
      this.sendBtn.disabled = false;
      this.sendBtn.setText("发送");
      this.streamEl = null;
      this.streamText = "";
    }
    await this.renderConversation();
    this.roleList.render();
    await this.plugin.writeNotesToVault();
  }
  toolLabel(name) {
    const labels = {
      save_note: "记笔记",
      read_notes: "读笔记",
      ask_learner: "出题",
      report_progress: "上报进度",
      add_knowledge_point: "新增知识点",
      update_knowledge_point: "修改知识点",
      dispatch_tutor: "派发导师",
      read_reports: "查历史报告",
      set_learning_goal: "记录学习目标",
      list_vault_structure: "看笔记库",
      read_vault_note: "读笔记",
      list_learner_notes: "看笔记库"
    };
    return labels[name] ?? name;
  }
  /** 命令面板触发：把选中内容发给当前角色。 */
  async askSelection(selection) {
    const file = this.app.workspace.getActiveFile();
    const parts = [];
    if (file) parts.push(`（当前笔记：[[${file.basename}]]）`);
    parts.push("下面这段我不太理解，帮我讲讲：", "", "```", selection, "```");
    this.inputEl.value = parts.join("\n");
    await this.send();
  }
  async onClose() {
    this.contentEl.empty();
  }
};
async function activateView(plugin) {
  const { workspace } = plugin.app;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_LEARN_AGENT);
  if (existing.length > 0) {
    await workspace.revealLeaf(existing[0]);
    return;
  }
  const leaf = workspace.getRightLeaf(false);
  if (!leaf) {
    new import_obsidian7.Notice("无法在右侧栏打开学习 Agent");
    return;
  }
  await leaf.setViewState({ type: VIEW_TYPE_LEARN_AGENT, active: true });
  await workspace.revealLeaf(leaf);
}

// src/main.ts
var LearnAgentPlugin = class extends import_obsidian8.Plugin {
  settings = { ...DEFAULT_SETTINGS };
  runtime;
  /** 状态目录的绝对路径，用于告诉 runtime 把会话写哪去。 */
  get dataDir() {
    return stateDir(this.app, this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`);
  }
  async onload() {
    await this.loadSettings();
    this.rebuildRuntime();
    this.registerView(VIEW_TYPE_LEARN_AGENT, (leaf) => {
      return new LearnAgentView(leaf, this);
    });
    this.addRibbonIcon("graduation-cap", "学习 Agent", () => {
      void activateView(this);
    });
    this.addCommand({
      id: "open-panel",
      name: "打开学习 Agent 面板",
      callback: () => void activateView(this)
    });
    this.addCommand({
      id: "ask-with-selection",
      name: "把选中内容发给学习 Agent",
      editorCallback: async (editor) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          new import_obsidian8.Notice("先选中一段内容");
          return;
        }
        await activateView(this);
        const view = this.getView();
        if (!view) return;
        await view.askSelection(selection);
      }
    });
    this.addSettingTab(new LearnAgentSettingTab(this.app, this));
    try {
      await this.ensureDataDir();
    } catch (error) {
      new import_obsidian8.Notice(
        `学习 Agent：状态目录创建失败——${error instanceof Error ? error.message : String(error)}`,
        1e4
      );
    }
  }
  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_LEARN_AGENT);
  }
  getView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_LEARN_AGENT)[0];
    return leaf?.view instanceof LearnAgentView ? leaf.view : null;
  }
  // -------------------------------------------------------------------------
  // 设置与 runtime 生命周期
  // -------------------------------------------------------------------------
  async loadSettings() {
    const stored = await this.loadData();
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored ?? {},
      reasoning: { ...DEFAULT_SETTINGS.reasoning, ...stored?.reasoning ?? {} }
    };
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  /**
   * 改配置的统一入口：合并 → 落盘 → 重建 runtime → 通知面板。
   * 面板内表单和设置页都走这里，所以两边永远一致。
   */
  async updateSettings(patch) {
    this.settings = {
      ...this.settings,
      ...patch,
      reasoning: { ...this.settings.reasoning, ...patch.reasoning ?? {} }
    };
    await this.saveSettings();
    this.rebuildRuntime();
  }
  /** 配置变了就重建 runtime。会话状态在磁盘上，所以重装不会丢对话。 */
  rebuildRuntime() {
    this.runtime = createRuntime(
      this.app,
      this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`,
      this.settings
    );
    this.runtime.setVaultAccess(
      createVaultAccess(this.app),
      this.settings.notesFolder.trim() || DEFAULT_SETTINGS.notesFolder
    );
    this.getView()?.onRuntimeChanged(this.runtime);
  }
  async ensureDataDir() {
    const adapter = this.app.vault.adapter;
    const relative = this.dataDir.slice(vaultBasePath(this.app).length + 1);
    if (!await adapter.exists(relative)) {
      await adapter.mkdir(relative);
    }
  }
  // -------------------------------------------------------------------------
  // 把学习笔记写进库里
  // -------------------------------------------------------------------------
  /**
   * 把导师的笔记写进库，用 Obsidian 自己的文件 API 而不是 node:fs。
   *
   * 这一点很关键：走 node:fs 直接写盘，Obsidian 的文件索引不会立刻知道，
   * 新建的笔记在文件树里看不到、搜不到，还可能跟同步功能打架。
   *
   * 仍然复用主项目的渲染逻辑（frontmatter、双链、依赖表格），只是把「写文件」
   * 这一步换成 vault API，并且保留同样的防覆盖保护——库里全是用户自己的笔记，
   * 同名文件没有生成标记就跳过。
   */
  async writeNotesToVault() {
    if (!this.settings.autoWriteNotes) return { written: 0, skipped: 0 };
    const folder = this.settings.notesFolder.trim() || DEFAULT_SETTINGS.notesFolder;
    try {
      const files = renderVaultFiles(this.runtime.getCurriculum(), this.runtime.workspace, folder);
      let written = 0;
      let skipped = 0;
      await ensureFolder(this.app, folder);
      for (const [relative, content] of files) {
        const existing = this.app.vault.getAbstractFileByPath(relative);
        if (existing === null) {
          await this.app.vault.create(relative, content);
          written++;
          continue;
        }
        if (!(existing instanceof import_obsidian8.TFile)) {
          skipped++;
          continue;
        }
        const previous = await this.app.vault.read(existing);
        if (!isGeneratedFile(previous)) {
          skipped++;
          continue;
        }
        await this.app.vault.modify(existing, content);
        written++;
      }
      return { written, skipped };
    } catch (error) {
      return {
        written: 0,
        skipped: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  /** 供设置页调用的连通性检查。 */
  describeStateDir() {
    return this.dataDir;
  }
};
