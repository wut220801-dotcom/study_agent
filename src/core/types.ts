/**
 * Agent runtime 的基础类型。
 *
 * 消息用「内容块」模型（Anthropic 的形状），而不是 OpenAI 那种把 tool 结果塞进
 * 独立 role 的做法。原因：工具结果在语义上属于「用户侧给模型的输入」，和模型自己
 * 的文本输出不同源；两者混在一个 role 里会让上下文压缩时难以判断该保留哪些内容。
 * 具体协议差异在 provider 层转换。
 */

/** 只有两个 role。工具结果放在 user 消息的 tool_result 块里。 */
export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

/** 扩展思考。OpenAI 系 provider 若不支持则该块不会产生。 */
export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  /** provider 给的调用 id，tool_result 靠它配对 */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
  timestamp: number;
}

export interface Usage {
  input: number;
  output: number;
  /** 命中缓存的输入 token（provider 支持时才有） */
  cacheRead?: number;
  /** 写入缓存的输入 token */
  cacheWrite?: number;
}

export type StopReason = "stop" | "tool_use" | "length" | "error" | "aborted";

/**
 * 工具参数的 JSON Schema。刻意不引入 zod 之类的校验库——工具参数由模型生成，
 * 校验失败的正确处理是把错误文本喂回模型让它重试，而不是抛异常中断整个循环。
 * 所以这里只需要「能生成 schema 给模型看」这一件事。
 */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

// ---------------------------------------------------------------------------
// 消息构造与读取的辅助函数
// ---------------------------------------------------------------------------

export function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

export function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
}

export function toolResultMessage(results: ToolResultBlock[]): Message {
  return { role: "user", content: results, timestamp: Date.now() };
}

/** 拼接一条消息里所有文本块。用于把 assistant 回复展示给用户或写进日志。 */
export function messageText(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** 一条消息里的全部工具调用。循环用它判断「还要不要继续跑」。 */
export function toolCallsOf(message: Message): ToolCallBlock[] {
  return message.content.filter((b): b is ToolCallBlock => b.type === "tool_call");
}

export function hasToolCalls(message: Message): boolean {
  return message.content.some((b) => b.type === "tool_call");
}

/**
 * 粗略估算 token 数。用于压缩触发判断——不需要精确，只要单调即可。
 * 中文按 1 字符 ≈ 1 token、英文按 4 字符 ≈ 1 token 折中取 3。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function estimateMessageTokens(message: Message): number {
  let total = 4; // 每条消息的角色标记等固定开销
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

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
