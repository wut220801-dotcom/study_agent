/**
 * 大纲：一张带学习方法标注的依赖图。
 *
 * 它不只是任务清单，还是「学习方法的调度」——每个节点带 methods 字段，规划师
 * 在派发时决定这个知识点该用讲解、练习、讨论还是复盘来学，导师据此调整策略。
 *
 * 依赖关系刻意只做**推荐顺序**，不做强制阻塞。真实学习里经常需要跳着学：
 * 你可能想先看看后面长什么样再回头补基础，也可能已经有相关经验不需要前置。
 * 强行阻塞只会让人绕过这个工具。缺前置时由导师在对话里指出来，这比系统拒绝
 * 提供服务要好。
 */

import type { KnowledgePoint, Curriculum, Method, NodeStatus, Report } from "./types.js";
import { METHOD_LABELS, STATUS_LABELS } from "./types.js";

export function createCurriculum(topic: string, learnerProfile: string): Curriculum {
  return { topic, learnerProfile, nodes: [], updatedAt: Date.now() };
}

/** 节点 id 用 kp-N 递增。从现有 id 里算最大值而不是用长度，删除节点后不会撞号。 */
export function nextNodeId(curriculum: Curriculum): string {
  let max = 0;
  for (const node of curriculum.nodes) {
    const match = /^kp-(\d+)$/.exec(node.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `kp-${max + 1}`;
}

export interface AddNodeInput {
  title: string;
  objectives: string[];
  prerequisites?: string[];
  methods?: Method[];
  origin?: KnowledgePoint["origin"];
}

export function addNode(curriculum: Curriculum, input: AddNodeInput): KnowledgePoint {
  const id = nextNodeId(curriculum);
  const node: KnowledgePoint = {
    id,
    title: input.title.trim(),
    objectives: input.objectives.map((o) => o.trim()).filter(Boolean),
    // 过滤掉指向不存在节点的依赖，避免模型幻觉出一个 id 就污染整张图
    prerequisites: (input.prerequisites ?? []).filter((p) =>
      curriculum.nodes.some((n) => n.id === p),
    ),
    methods: input.methods?.length ? input.methods : ["explain"],
    status: "pending",
    notePath: `notes/${id}.md`,
    origin: input.origin ?? "planner",
    createdAt: Date.now(),
  };
  curriculum.nodes.push(node);
  curriculum.updatedAt = Date.now();
  return node;
}

export function updateNode(
  curriculum: Curriculum,
  id: string,
  patch: Partial<Pick<KnowledgePoint, "title" | "objectives" | "prerequisites" | "methods" | "status">>,
): KnowledgePoint | null {
  const node = findNode(curriculum, id);
  if (!node) return null;

  if (patch.title !== undefined) node.title = patch.title.trim();
  if (patch.objectives !== undefined) node.objectives = patch.objectives.map((o) => o.trim()).filter(Boolean);
  if (patch.methods !== undefined && patch.methods.length > 0) node.methods = patch.methods;
  if (patch.prerequisites !== undefined) {
    node.prerequisites = patch.prerequisites.filter(
      (p) => p !== id && curriculum.nodes.some((n) => n.id === p),
    );
  }
  if (patch.status !== undefined) node.status = patch.status;

  curriculum.updatedAt = Date.now();
  return node;
}

export function findNode(curriculum: Curriculum, id: string): KnowledgePoint | null {
  return curriculum.nodes.find((n) => n.id === id) ?? null;
}

/**
 * 找出「依赖都已掌握」的待学节点——规划师建议下一步学什么时的首选。
 * 没有依赖的节点天然满足条件。
 */
export function readyNodes(curriculum: Curriculum): KnowledgePoint[] {
  const mastered = new Set(
    curriculum.nodes.filter((n) => n.status === "mastered").map((n) => n.id),
  );
  return curriculum.nodes.filter(
    (node) =>
      node.status !== "mastered" && node.prerequisites.every((p) => mastered.has(p)),
  );
}

/** 依赖图里是否存在环。新增节点或改依赖后调用，防止规划师建出一张死锁的图。 */
export function detectCycle(curriculum: Curriculum): string[] | null {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
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

/**
 * 渲染给规划师看的大纲视图。
 *
 * 这个函数是整个隔离机制的关键落点：它的入参只有 Curriculum 和 Report，
 * **拿不到 notes**。规划师想看到教学细节都没有路径，不是"被要求别看"。
 *
 * 每个节点只展示最新一条报告。历史报告在超过阈值时会由 planner 折叠进
 * reportDigest（见 foldReports），所以这里不处理无限增长。
 */
export function renderCurriculumForPlanner(
  curriculum: Curriculum,
  latestReports: Map<string, Report>,
): string {
  const lines: string[] = [];

  lines.push(`# 学习大纲：${curriculum.topic}`);
  lines.push("");

  if (curriculum.learnerProfile.trim()) {
    lines.push("## 学习者画像");
    lines.push(curriculum.learnerProfile.trim());
    lines.push("");
  }

  const counts = new Map<NodeStatus, number>();
  for (const node of curriculum.nodes) {
    counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  }
  const overview = (["mastered", "learning", "review", "pending"] as NodeStatus[])
    .filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} 个${STATUS_LABELS[s]}`)
    .join(" / ");
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
      `方法：${node.methods.map((m) => METHOD_LABELS[m]).join("、")}`,
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

  // 导师上报的学习缺口，等规划师决定要不要采纳
  const suggestions = [...latestReports.values()].flatMap((report) =>
    (report.suggestedNext ?? []).map((s) => ({ ...s, from: report.nodeTitle })),
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

/** 依赖都已掌握、且还没开始学的节点——给规划师排下一个任务用。 */
export function renderReadyNodes(curriculum: Curriculum): string {
  const ready = readyNodes(curriculum);
  if (ready.length === 0) return "（暂时没有依赖已满足的待学节点）";
  return ready.map((n) => `- ${n.id} ${n.title}`).join("\n");
}
