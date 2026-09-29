/**
 * 长对话的上下文压缩。
 *
 * 两种压缩在这里是刻意分开的：
 *   - 本文件：**模型调用**，把旧消息摘要成一段文本。昂贵、偶发。
 *   - provider 层不做任何压缩，工具结果的尺寸上限在 loop 里（单次结果过大就截断）。
 *
 * 最容易写错的地方是**切割点**。工具调用和它的结果必须落在边界的同一侧：
 * 如果工具调用被摘掉而结果被保留，provider 会拒绝这个请求（结果找不到对应的调用）。
 * 所以 findCutIndex 里有一条硬规则——带 tool_result 的消息永远不能作为切割点。
 */

import { completeOnce } from "./complete.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  type Message,
  type Usage,
} from "./types.js";
import type { Provider } from "./provider/types.js";

export interface CompactionSettings {
  /** 模型的上下文窗口 */
  contextWindow: number;
  /** 预留给模型输出的 token。上下文用到「窗口 - 预留」就该压缩了。 */
  reserveTokens: number;
  /** 压缩后至少保留多少近期 token 的原文 */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: Omit<CompactionSettings, "contextWindow"> = {
  reserveTokens: 16_384,
  keepRecentTokens: 12_000,
};

export interface CompactionResult {
  summary: string;
  /** 边界之后保留的原文，内联进压缩条目 */
  retainedTail: Message[];
  tokensBefore: number;
  tokensAfter: number;
  usage: Usage;
}

/** 上下文用量是否已达到需要压缩的程度。 */
export function shouldCompact(messages: Message[], settings: CompactionSettings): boolean {
  const used = estimateMessagesTokens(messages);
  return used > settings.contextWindow - settings.reserveTokens;
}

/**
 * 找到一个合法的切割点：返回的索引及其之后的原文保留，之前的会被摘要掉。
 *
 * 返回 null 表示「压不动」——要么总量还不够大，要么尾部结构不允许切。
 * 这时宁可放弃压缩，也不能产出会破坏请求的历史。
 */
export function findCutIndex(messages: Message[], keepRecentTokens: number): number | null {
  if (messages.length < 4) return null;

  // 从最新往回数，累积到 keepRecentTokens 就停
  let accumulated = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(messages[i]!);
    if (accumulated >= keepRecentTokens) {
      cut = i;
      break;
    }
  }
  if (cut >= messages.length) return null;

  // 把切割点往前挪到最近的合法位置。往前挪意味着保留更多原文——
  // 这是安全的偏向：往后挪可能把某次工具调用摘掉却留下它的结果。
  while (cut > 0 && !isValidCutPoint(messages[cut]!)) cut--;

  // 至少要有两条消息可摘要，否则这次压缩没有意义
  if (cut < 2) return null;
  return cut;
}

function isValidCutPoint(message: Message): boolean {
  // 带工具结果的消息必须紧跟它的工具调用，不能作为边界
  if (message.content.some((b) => b.type === "tool_result")) return false;
  // 只有文本的消息才能作为干净的开头
  return message.content.some((b) => b.type === "text");
}

/**
 * 学习场景专用的摘要提示词。
 *
 * 与通用 coding agent 的摘要模板（保留文件路径、报错信息）不同，这里要保住的是
 * 学习过程本身的脉络：学习者已经会了什么、卡在哪、哪些是还没解决的疑问。
 * 这些信息丢了的话，压缩后的导师会失去教学连续性——它不知道自己讲到哪了。
 */
const SUMMARIZATION_SYSTEM_PROMPT = `你是一个学习会话的记录整理者。

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

const TOOL_RESULT_MAX_CHARS = 1_500;

export interface CompactOptions {
  messages: Message[];
  provider: Provider;
  settings: CompactionSettings;
  signal?: AbortSignal;
}

/**
 * 执行一次压缩。返回 null 表示当前不需要或无法压缩（不是错误）。
 */
export async function compactMessages(
  options: CompactOptions,
): Promise<CompactionResult | null> {
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
    prompt: `<conversation>\n${serialized}\n</conversation>\n\n请按规定的结构输出摘要。`,
    // 输出预算取预留量的一半，给后续请求留出余量
    maxTokens: Math.max(512, Math.floor(settings.reserveTokens / 2)),
    // 摘要是「把给你的材料压缩」，不需要模型自己想出什么，思考纯属浪费预算——
    // 而且预算被思考吃光会让摘要变空，那是最糟的失败模式（历史被删却什么都没留下）。
    reasoningEffort: "off",
    ...(signal ? { signal } : {}),
  });

  if (!result.text) {
    throw new Error("压缩摘要为空——拒绝用空摘要替换历史");
  }

  const tokensAfter =
    estimateMessagesTokens(retainedTail) + Math.ceil(result.text.length / 3);

  return {
    summary: result.text,
    retainedTail,
    tokensBefore,
    tokensAfter,
    usage: result.usage,
  };
}

/**
 * 把对话序列化成扁平文本再交给模型。
 *
 * 这一步不能省。如果把消息按原结构发过去，摘要模型很容易把它当成「一段正在进行的
 * 对话」接着往下聊，而不是当成待处理材料。拍平之后就没有了对话的形状。
 *
 * 另一个作用是控制请求体积：工具结果往往是大头（一次搜索结果几千字），
 * 这里截断它们，而用户和助手的文本保持完整——教学过程的脉络比工具输出重要。
 */
function serializeConversation(messages: Message[]): string {
  const lines: string[] = [];

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
          break; // 思考过程不进摘要，它的价值在生成当时
      }
    }
  }

  return lines.join("\n\n");
}

function truncateForSummary(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[... 后略 ${text.length - TOOL_RESULT_MAX_CHARS} 字符 ...]`;
}
