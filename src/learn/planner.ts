/**
 * 规划师 agent：管理整张学习大纲，派发知识点给导师。
 *
 * 它是这个框架里「上下文必须干净」要求最强的角色。它要看的是全局结构——依赖关系、
 * 进度分布、哪里卡住了——而不是任何一门课是怎么讲的。几十个知识点的教学细节堆进来
 * 会直接淹没它的判断力。
 *
 * 这个约束不是靠提示词里的「请不要追问细节」实现的，而是靠
 * buildPlannerSystemPrompt 的函数签名：它的入参只有 Curriculum 和 Report，
 * 而这两个类型里没有任何字段能装下笔记内容（只能拿到 notePath 这样的引用）。
 * 规划师想看到教学细节都没有路径可走。
 */

import type { Session } from "../core/session.js";
import {
  arrayParam,
  objectSchema,
  stringParam,
  ToolRegistry,
  type Tool,
  type ToolRegistry as Registry,
} from "../core/tools/types.js";
import {
  addNode,
  detectCycle,
  findNode,
  renderCurriculumForPlanner,
  renderReadyNodes,
  updateNode,
} from "./curriculum.js";
import { METHOD_LABELS, type Curriculum, type Method, type NodeStatus, type Report } from "./types.js";
import type { Workspace } from "./workspace.js";
import { loadPrompt } from "./prompts.js";

export interface PlannerToolContext {
  workspace: Workspace;
  curriculum: Curriculum;
  /**
   * 派发动作由 runtime 注入。规划师只负责表达「该派发了」，
   * 具体建会话、开首轮不归它管——避免规划师直接操作会话层。
   */
  dispatchTutor: (nodeId: string, instruction?: string) => Promise<string>;
  /** 大纲被改动后落盘 */
  saveCurriculum: () => void;
}

/**
 * 规划师的系统提示。
 *
 * **这是隔离机制的关键落点**：函数只接受 Curriculum 和 Report。
 * 想让规划师看到笔记内容，得先改这个签名——这让「不小心把细节漏上去」
 * 变成一件需要主动修改类型才能做到的事，而不是一次疏忽。
 */
export function buildPlannerSystemPrompt(
  curriculum: Curriculum,
  latestReports: Map<string, Report>,
): string {
  const sections = [
    loadPrompt("planner"),
    "",
    "---",
    "",
    renderCurriculumForPlanner(curriculum, latestReports),
  ];

  const ready = renderReadyNodes(curriculum);
  sections.push("", "# 依赖已满足、可以开学的知识点", "", ready);

  return sections.join("\n");
}

/**
 * 每个知识点只把最新一条报告喂给规划师。
 *
 * 报告是 append-only 累积的，如果全量注入，一个学了几周的大纲会变成上千条记录，
 * 规划师的上下文会被历史报告挤满。所以这里取最新一条；更早的由 runtime 在报告
 * 累积过多时折叠进节点的 reportDigest。
 */
export function latestReportsByNode(curriculum: Curriculum, workspace: Workspace): Map<string, Report> {
  const map = new Map<string, Report>();
  for (const node of curriculum.nodes) {
    const reports = workspace.readLines<Report>(workspace.reportPath(node.id));
    const latest = reports[reports.length - 1];
    if (latest) map.set(node.id, latest);
  }
  return map;
}

export function createPlannerRegistry(): Registry<PlannerToolContext> {
  return new ToolRegistry<PlannerToolContext>()
    .register(addKnowledgePointTool)
    .register(updateKnowledgePointTool)
    .register(dispatchTutorTool)
    .register(readReportsTool)
    .register(setLearningGoalTool);
}

const addKnowledgePointTool: Tool<PlannerToolContext> = {
  name: "add_knowledge_point",
  description:
    "往大纲里新增一个知识点。建大纲时批量用，学到中途发现遗漏也可以随时补。",
  parameters: objectSchema(
    {
      title: stringParam("知识点标题，简短明确"),
      objectives: arrayParam(
        "学完能做到什么。每条都必须是可验证的行为，不要写'理解 X'这类无法检验的目标。",
      ),
      prerequisites: arrayParam(
        "依赖的其他知识点 id（如 kp-1）。只有确实必须先学会它才能理解本节点时才填。",
      ),
      methods: arrayParam(
        "建议的学习方法。explain=讲解概念；practice=动手练习；discuss=讨论建立直觉；review=复习巩固",
        { type: "string", enum: ["explain", "practice", "discuss", "review"] },
      ),
      rationale: stringParam("为什么需要这个知识点，以及它在大纲里的位置。写给自己看，便于后续调整。"),
    },
    ["title", "objectives"],
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
      origin: "planner",
    });

    const cycle = detectCycle(ctx.curriculum);
    if (cycle) {
      // 建出环会让整张图死锁，回滚这个节点并让规划师重新考虑依赖
      ctx.curriculum.nodes = ctx.curriculum.nodes.filter((n) => n.id !== node.id);
      return `依赖关系形成了环（${cycle.join(" → ")}），已放弃新增「${title}」。请重新安排依赖。`;
    }

    ctx.saveCurriculum();
    return `已新增 ${node.id}「${node.title}」，方法：${node.methods.map((m) => METHOD_LABELS[m]).join("、")}。`;
  },
};

const updateKnowledgePointTool: Tool<PlannerToolContext> = {
  name: "update_knowledge_point",
  description:
    "修改已有知识点。用于调整目标、依赖、学习方法，或修正状态。注意状态通常由导师上报自动更新，不需要你手动改。",
  parameters: objectSchema(
    {
      node_id: stringParam("要修改的知识点 id"),
      title: stringParam("新标题（可选）"),
      objectives: arrayParam("新的目标列表，会整体替换（可选）"),
      prerequisites: arrayParam("新的依赖列表，会整体替换（可选）"),
      methods: arrayParam("新的学习方法列表，会整体替换（可选）", {
        type: "string",
        enum: ["explain", "practice", "discuss", "review"],
      }),
      status: stringParam("手动修正状态：pending / learning / mastered / review（可选）"),
    },
    ["node_id"],
  ),
  async execute(args, ctx) {
    const nodeId = String(args.node_id ?? "").trim();
    const node = findNode(ctx.curriculum, nodeId);
    if (!node) {
      return `找不到知识点 ${nodeId}。当前大纲里的节点：${
        ctx.curriculum.nodes.map((n) => n.id).join("、") || "（空）"
      }`;
    }

    const patch: Parameters<typeof updateNode>[2] = {};
    if (args.title !== undefined) patch.title = String(args.title);
    if (args.objectives !== undefined) patch.objectives = toStringArray(args.objectives);
    if (args.prerequisites !== undefined) patch.prerequisites = toStringArray(args.prerequisites);
    if (args.methods !== undefined) {
      const methods = toMethods(args.methods);
      if (methods.length > 0) patch.methods = methods;
    }
    if (args.status !== undefined) {
      const status = String(args.status).trim() as NodeStatus;
      if (["pending", "learning", "mastered", "review"].includes(status)) patch.status = status;
    }

    updateNode(ctx.curriculum, nodeId, patch);

    const cycle = detectCycle(ctx.curriculum);
    if (cycle) {
      return `这次修改让依赖关系形成了环（${cycle.join(" → ")}）。请修正依赖后重试。`;
    }

    ctx.saveCurriculum();
    return `已更新 ${nodeId}「${node.title}」。`;
  },
};

const dispatchTutorTool: Tool<PlannerToolContext> = {
  name: "dispatch_tutor",
  description:
    "把某个知识点交给导师开始教学。会为它建立一条独立的学习会话，学习者即可在界面上进入。" +
    "派发时说明为什么现在学这个，导师需要这个上下文来判断教学起点。",
  parameters: objectSchema(
    {
      node_id: stringParam("要派发的知识点 id"),
      instruction: stringParam(
        "给导师的交代：为什么现在学这个、它和前后知识点的关系、学习者目前的相关基础。",
      ),
    },
    ["node_id"],
  ),
  async execute(args, ctx) {
    const nodeId = String(args.node_id ?? "").trim();
    const node = findNode(ctx.curriculum, nodeId);
    if (!node) return `找不到知识点 ${nodeId}。`;

    const instruction = args.instruction ? String(args.instruction).trim() : undefined;
    const result = await ctx.dispatchTutor(nodeId, instruction);

    // 派发即进入学习状态；导师上报 mastered 时会覆盖它
    if (node.status === "pending") {
      node.status = "learning";
      ctx.saveCurriculum();
    }

    return result;
  },
};

const readReportsTool: Tool<PlannerToolContext> = {
  name: "read_reports",
  description:
    "读取某个知识点的历史报告。默认只看到最新一条，需要了解演变过程时用这个工具翻更早的记录。",
  parameters: objectSchema(
    {
      node_id: stringParam("知识点 id"),
      limit: { type: "number", description: "最多返回几条（默认 5）" },
    },
    ["node_id"],
  ),
  async execute(args, ctx) {
    const nodeId = String(args.node_id ?? "").trim();
    const node = findNode(ctx.curriculum, nodeId);
    if (!node) return `找不到知识点 ${nodeId}。`;

    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
    const reports = ctx.workspace.readLines<Report>(ctx.workspace.reportPath(nodeId));
    if (reports.length === 0) return `「${node.title}」还没有任何进度报告。`;

    const recent = reports.slice(-limit);
    return recent
      .map(
        (r) =>
          `[${new Date(r.ts).toLocaleString("zh-CN")}] ${r.status}\n${r.summary}${
            r.suggestedNext?.length
              ? `\n建议补充：${r.suggestedNext.map((s) => s.title).join("、")}`
              : ""
          }`,
      )
      .join("\n\n---\n\n");
  },
};

const setLearningGoalTool: Tool<PlannerToolContext> = {
  name: "set_learning_goal",
  description:
    "记录这次学习的主题和学习者画像。这是整个大纲的标题，也会被用作导出到 Obsidian 时的" +
    "索引文件名，所以确认清楚目标后就该调用一次。之后了解得更清楚时可以再更新。" +
    "主题要写成一句具体的描述，而不是「学 X」这种宽泛的说法。",
  parameters: objectSchema(
    {
      topic: stringParam(
        "学习主题，一句话。写清楚范围和目的，例如「Rust 内存管理（为了读懂公司代码库）」，" +
          "而不是「Rust」——它决定了大纲标题和 Obsidian 索引文件名。",
      ),
      learner_profile: stringParam(
        "完整的学习者画像，会整体替换。写具体信息（背景、已掌握什么、学习偏好、时间安排），" +
          "不要写「有一定基础」这类空话——每个导师都会读到它。",
      ),
    },
    ["topic"],
  ),
  async execute(args, ctx) {
    const topic = String(args.topic ?? "").trim();
    if (topic) ctx.curriculum.topic = topic;

    const profile = args.learner_profile !== undefined ? String(args.learner_profile).trim() : "";
    if (profile) ctx.curriculum.learnerProfile = profile;

    ctx.saveCurriculum();
    return `学习主题已记录为「${ctx.curriculum.topic}」${profile ? "，画像已更新" : ""}。`;
  },
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function toMethods(value: unknown): Method[] {
  const valid: Method[] = ["explain", "practice", "discuss", "review"];
  return toStringArray(value).filter((v): v is Method => valid.includes(v as Method));
}
