/**
 * 学习层自定义会话条目的种类与渲染。
 *
 * core 的 Session 只管存取 custom 条目，是否进模型上下文由 inContext 决定，
 * 怎么渲染由这里提供。分开的好处是：报告、题目这类「只给人看、不给模型看」的
 * 条目不会意外进入上下文——它们的 inContext 是 false，渲染函数根本不会被调用。
 */

import type { CustomEntry } from "../core/session.js";
import { userText, type Message } from "../core/types.js";

/** 别处压缩来的前置知识。进上下文。 */
export const ENTRY_INJECTED = "injected_knowledge";
/** 上报给规划师的进度报告。不进导师自己的上下文。 */
export const ENTRY_REPORT = "report";
/** 登记给学习者的题目与参考答案。不进上下文——题目已经在导师正文里了。 */
export const ENTRY_QUESTION = "question";
/** 系统发起的开场指令。进上下文。 */
export const ENTRY_KICKOFF = "kickoff";

export function renderLearnEntry(entry: CustomEntry): Message | null {
  switch (entry.customType) {
    case ENTRY_INJECTED:
      return renderInjectedKnowledge(entry);
    case ENTRY_KICKOFF:
      return userText(String(entry.data.instruction ?? ""));
    default:
      return null;
  }
}

/**
 * 把注入条目渲染成模型可读的消息。
 *
 * 用 XML 标签包裹并附上使用说明，是为了防止导师把这份参考资料当成学习者的实时
 * 发言去回应它。「背景资料」和「对话」的混淆是上下文注入最常见的失败模式——
 * 模型看到一段第三人称描述自己的知识点，很容易接一句"看起来很全面，我们继续"，
 * 而它本该直接在这基础上讲课。
 */
function renderInjectedKnowledge(entry: CustomEntry): Message {
  const content = String(entry.data.content ?? "");
  const fromTitle = String(entry.data.sourceNodeTitle ?? "先前的知识点");
  const hint = entry.data.hint ? String(entry.data.hint) : "";

  const lines = [
    `<prior_knowledge from="${fromTitle}">`,
    content,
    "</prior_knowledge>",
    "",
    `以上是学习者在「${fromTitle}」中已经掌握的内容，由他的学习记录整理而来。`,
    "把它当作已确立的背景：不要重新讲授这些内容，直接在此基础上推进。",
  ];
  if (hint) lines.push(`学习者特别说明：${hint}`);

  return userText(lines.join("\n"));
}
