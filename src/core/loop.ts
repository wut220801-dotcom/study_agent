/**
 * agent 循环。
 *
 * 结构上是很朴素的一件事：调模型 → 有工具调用就执行 → 结果塞回历史 → 再来一遍 →
 * 没有工具调用就退出。真正需要想清楚的是**退出条件**和**出错时的行为**，这两处
 * 决定了一个 agent 是会自己纠错还是会失控。
 */

import {
  toolCallsOf,
  toolResultMessage,
  type Message,
  type StopReason,
  type Usage,
} from "./types.js";
import type { ToolRegistry } from "./tools/types.js";
import type { Provider, ReasoningEffort } from "./provider/types.js";

export type LoopEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; name: string; isError: boolean; content: string }
  /** 一轮 assistant 回复完成（可能还带工具调用） */
  | { type: "turn_end"; message: Message }
  | { type: "error"; message: string };

export interface AgentLoopOptions<TContext> {
  provider: Provider;
  system: string;
  /** 既有历史。循环不会修改这个数组。 */
  history: Message[];
  registry: ToolRegistry<TContext>;
  toolContext: TContext;
  maxIterations?: number;
  maxTokens?: number;
  temperature?: number;
  /** 本次运行的推理强度，由上层按角色决定 */
  reasoningEffort?: ReasoningEffort;
  cacheKey?: string;
  signal?: AbortSignal;
  /** 单个工具结果超过此长度就截断。防止一次 grep 把整个上下文吃掉。 */
  maxToolResultChars?: number;
  /**
   * 事件回调。允许返回 Promise 并被 await——流式推送到客户端时，异步写入必须
   * 按顺序完成，否则文本增量会乱序到达。
   */
  emit?: (event: LoopEvent) => void | Promise<void>;
  /** 每条新消息产出后立即回调。调用方用它做持久化，也保证崩溃时已有内容不丢。 */
  onMessage?: (message: Message) => void | Promise<void>;
}

export interface LoopResult {
  /** 本轮新增的消息（不含传入的 history） */
  messages: Message[];
  stopReason: StopReason;
  usage: Usage;
  iterations: number;
  error?: string;
}

const DEFAULT_MAX_ITERATIONS = 40;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 24_000;
/** 相同工具 + 相同参数连续出现这么多次，就认为模型卡住了 */
const REPEAT_WARN_THRESHOLD = 2;

export async function runAgentLoop<TContext>(
  options: AgentLoopOptions<TContext>,
): Promise<LoopResult> {
  const {
    provider,
    system,
    registry,
    toolContext,
    signal,
    emit,
    onMessage,
  } = options;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxToolResultChars =
    options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;

  const working: Message[] = [...options.history];
  const produced: Message[] = [];
  const usage: Usage = { input: 0, output: 0 };
  const repeatCounts = new Map<string, number>();

  let stopReason: StopReason = "stop";
  let iterations = 0;
  let error: string | undefined;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    iterations = iteration + 1;

    let assistant: Message | undefined;

    try {
      const stream = provider.stream({
        model: provider.model,
        system,
        messages: working,
        tools: registry.definitions(),
        maxTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.reasoningEffort !== undefined
          ? { reasoningEffort: options.reasoningEffort }
          : {}),
        ...(options.cacheKey ? { cacheKey: options.cacheKey } : {}),
        ...(signal ? { signal } : {}),
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

    /**
     * 流正常结束但一个内容块都没有——这是「静默失败」里最难查的一种：
     * 请求是 200，没有报错，只是模型什么都没说。
     *
     * 最常见的成因是开启 thinking 的模型把输出预算全花在思考上（DeepSeek V4 系列、
     * Claude 的扩展思考都会这样）。deepseek-harness 对同一种情况报 EMPTY_RESPONSE
     * 错误并重试；这里至少要让用户看见，而不是把空回复当成正常结束。
     */
    if (assistant.content.length === 0) {
      stopReason = "error";
      error =
        `模型没有产生任何正文。若用的是开启 thinking 的模型，最可能是 ${maxTokens} 个输出 ` +
        "token 被思考内容占满了——调高 LEARN_AGENT_MAX_TOKENS 即可。" +
        "若并非如此，检查模型名是否在该服务商处存在。";
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

    // 并行执行本轮的全部工具调用，但结果顺序必须与调用顺序一致——
    // tool_result 靠顺序和 id 双重配对，乱序会让 provider 拒绝请求。
    const results = await Promise.all(
      calls.map(async (call) => {
        const signature = `${call.name}:${stableStringify(call.args)}`;
        const seen = (repeatCounts.get(signature) ?? 0) + 1;
        repeatCounts.set(signature, seen);

        await emit?.({ type: "tool_start", name: call.name, args: call.args });
        const result = await registry.execute(call, toolContext);

        let content = truncate(result.content, maxToolResultChars);
        if (seen > REPEAT_WARN_THRESHOLD) {
          content +=
            `\n\n[提示] 你已经用完全相同的参数调用 ${call.name} ${seen} 次了，` +
            `结果不会改变。请换一种做法，或直接基于已有信息给出答复。`;
        }

        await emit?.({
          type: "tool_end",
          name: call.name,
          isError: result.isError,
          content,
        });
        return { ...result, content };
      }),
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

  return { messages: produced, stopReason, usage, iterations, ...(error ? { error } : {}) };
}

/** 截断时保留尾部——工具结果的结论通常在末尾，头部多为冗余输出。 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.2));
  const tail = text.slice(-Math.floor(limit * 0.8));
  return `${head}\n\n[... 中间省略 ${text.length - limit} 字符 ...]\n\n${tail}`;
}

/** 键顺序无关的字符串化，用于判定「相同参数的重复调用」。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
