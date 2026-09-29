/**
 * 导师 agent：一个知识点的专属教师，与学习者长周期对话。
 *
 * 它和 Nanobot 那种「后台子 agent」的关键区别：导师不是跑完就消失的 worker，
 * 而是一条长期存在的、学习者直接对话的会话。所以它需要持久 session、需要压缩、
 * 需要能记住自己教到哪了——而不是执行完一个任务就回传摘要。
 *
 * 它的工具只有 4 个，刻意保持窄。**没有文件系统、没有 shell、没有网络**：
 * 一个教学 agent 不需要这些，而每多一个工具就多一条让模型跑偏的路径。
 * 需要外部资料时由规划师在派发时提供，或由注入机制送来。
 */

import type { Session } from "../core/session.js";
import { objectSchema, arrayParam, stringParam, type Tool, type ToolRegistry } from "../core/tools/types.js";
import { ToolRegistry as Registry } from "../core/tools/types.js";
import { METHOD_LABELS, STATUS_LABELS, type KnowledgePoint, type NodeStatus, type Report } from "./types.js";
import { ENTRY_QUESTION, ENTRY_REPORT } from "./entries.js";
import { NOTE_SECTIONS, readNotes, writeNoteSection } from "./notes.js";
import type { Workspace } from "./workspace.js";
import { loadPrompt } from "./prompts.js";

export interface TutorToolContext {
  workspace: Workspace;
  node: KnowledgePoint;
  session: Session;
  /** report_progress 会同步更新大纲里的状态，回调由 runtime 提供 */
  onStatusChange: (status: NodeStatus) => void;
}

/**
 * 导师的系统提示。
 *
 * 这里**不包含笔记内容**。原因是缓存：系统提示是 prompt 缓存的第一个断点，
 * 而笔记每 save_note 一次就变一次——如果笔记常驻系统提示，导师每写一次笔记就会
 * 让整个会话的缓存失效，长对话的账单会成倍上涨。所以笔记走 read_notes 按需读取。
 *
 * 代价是每次开新阶段可能多一次工具调用，这个代价远小于缓存全失。
 */
export function buildTutorSystemPrompt(node: KnowledgePoint, learnerProfile: string): string {
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
    `建议的学习方法：${node.methods.map((m) => METHOD_LABELS[m]).join("、")}`,
  ];

  if (node.prerequisites.length > 0) {
    lines.push(
      "",
      `这个知识点依赖：${node.prerequisites.join("、")}。` +
        "如果学习者对前置内容明显不熟，先指出来并让他回去补，不要硬讲。",
    );
  }

  lines.push("", "# 学习者画像", "", learnerProfile.trim() || "（暂无画像信息，在对话中逐步了解）");

  return lines.join("\n");
}

/** 新建一份只在导师会话里使用的工具注册表。规划师的工具不会出现在这里。 */
export function createTutorRegistry(): ToolRegistry<TutorToolContext> {
  return new Registry<TutorToolContext>()
    .register(saveNoteTool)
    .register(readNotesTool)
    .register(askLearnerTool)
    .register(reportProgressTool);
}

const saveNoteTool: Tool<TutorToolContext> = {
  name: "save_note",
  description:
    "把一段教学内容记进笔记。学习细节、例子、学习者的错题都写在这里。" +
    "笔记是学习者的长期资产，也可能被提取给其他知识点的导师，所以要把内容写清楚、写完整。",
  parameters: objectSchema(
    {
      section: {
        type: "string",
        enum: [...NOTE_SECTIONS],
        description: "写进哪个小节。核心概念=定义与原理；关键要点=需要记住的规则；" +
          "例题与练习=用过的例子和题目；疑问与澄清=学习者没弄懂或纠正过的理解；回顾=阶段性总结",
      },
      content: stringParam("要记录的内容，markdown 格式。写知识本身，不要写'我讲了'这类过程描述。"),
      mode: {
        type: "string",
        enum: ["append", "replace"],
        description: "append=追加到该小节（默认）；replace=覆盖该小节（重新整理时用）",
      },
    },
    ["section", "content"],
  ),
  async execute(args, ctx) {
    const section = String(args.section ?? "").trim();
    const content = String(args.content ?? "").trim();
    if (!section || !content) return "参数不完整：section 和 content 都不能为空。";

    const mode = args.mode === "replace" ? "replace" : "append";
    writeNoteSection(ctx.workspace, ctx.node.id, section, content, mode);
    return `已${mode === "append" ? "追加" : "覆盖"}笔记小节「${section}」。`;
  },
};

const readNotesTool: Tool<TutorToolContext> = {
  name: "read_notes",
  description:
    "读回你自己为这个知识点写的笔记。在开始新的教学阶段前调用它——" +
    "特别是这个知识点的学习跨了多天、或者你感觉对话被压缩过的时候。",
  parameters: objectSchema({}, []),
  async execute(_args, ctx) {
    const notes = readNotes(ctx.workspace, ctx.node.id);
    if (!notes) return "你还没有为这个知识点写过笔记。";
    return notes;
  },
};

const askLearnerTool: Tool<TutorToolContext> = {
  name: "ask_learner",
  description:
    "向学习者出一道题。题目本身要写在你的回复正文里让他看到；" +
    "调用这个工具是为了登记题目和参考答案，参考答案不会展示给学习者，直到他作答后才作为对照。",
  parameters: objectSchema(
    {
      question: stringParam("题面和作答要求，和你写在正文里的保持简短一致"),
      expects: stringParam("你预期的答案要点。用于稍后判断学习者答得对不对。"),
    },
    ["question"],
  ),
  async execute(args, ctx) {
    const question = String(args.question ?? "").trim();
    if (!question) return "题目不能为空。";

    ctx.session.appendCustom(
      ENTRY_QUESTION,
      {
        nodeId: ctx.node.id,
        question,
        ...(args.expects ? { expects: String(args.expects) } : {}),
      },
      // 不进模型上下文：题目已经在导师的正文里了，再塞一次是重复
      false,
    );

    return "题目已登记。现在结束本轮回复，等学习者作答——不要自问自答，也不要给出答案。";
  },
};

const reportProgressTool: Tool<TutorToolContext> = {
  name: "report_progress",
  description:
    "向学习规划师上报进度。规划师管理整个学习大纲，看不到你的教学细节，" +
    "所以报告要写**学习者当前的状态**，不要写教学过程。",
  parameters: objectSchema(
    {
      status: {
        type: "string",
        enum: ["learning", "mastered", "review"],
        description:
          "learning=还在学；mastered=学习者确实掌握了（能用自己话解释、能解决变体问题）；" +
          "review=学过但需要复习巩固",
      },
      summary: stringParam(
        "给规划师看的几句话。写学习者会了什么、卡在哪里、是否具备继续学的条件。" +
          "不要写'今天讲了 X 用了 Y 例子'这类教学过程细节。",
      ),
      suggested_next: arrayParam(
        "如果发现大纲里缺少必要的知识点，在这里提出建议（可选）",
        objectSchema({
          title: stringParam("建议补充的知识点标题"),
          reason: stringParam("为什么需要它"),
        }),
      ),
    },
    ["status", "summary"],
  ),
  async execute(args, ctx) {
    const status = args.status;
    if (status !== "learning" && status !== "mastered" && status !== "review") {
      return "status 必须是 learning / mastered / review 之一。";
    }
    const summary = String(args.summary ?? "").trim();
    if (!summary) return "summary 不能为空——规划师需要它来判断下一步。";

    const suggestedNext = parseSuggestions(args.suggested_next);
    const report: Report = {
      nodeId: ctx.node.id,
      nodeTitle: ctx.node.title,
      status,
      summary,
      ...(suggestedNext.length > 0 ? { suggestedNext } : {}),
      ts: Date.now(),
    };

    ctx.workspace.appendLine(ctx.workspace.reportPath(ctx.node.id), report);
    // 报告对导师自己不进上下文——它知道自己报过什么，再读一遍是浪费
    ctx.session.appendCustom(ENTRY_REPORT, { ...report }, false);
    ctx.onStatusChange(status);

    return `已上报。规划师看到的状态：「${ctx.node.title}」${STATUS_LABELS[status]}。报告内容：${summary}`;
  },
};

function parseSuggestions(value: unknown): { title: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { title: string; reason: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const title = String(record.title ?? "").trim();
    const reason = String(record.reason ?? "").trim();
    if (title) out.push({ title, reason });
  }
  return out;
}
