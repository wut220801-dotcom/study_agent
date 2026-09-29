/**
 * 学习层的数据模型。
 *
 * **这个文件里没有任何字段能承载笔记内容**——这是刻意的。规划师的上下文只能由
 * Curriculum 和 Report 构建（见 planner.ts 的 buildPlannerContext），而这两个类型
 * 指向知识的唯一方式是 notePath 这样的**引用**。于是「学习细节不上传主 agent」
 * 不需要靠提示词约束，它在类型上就做不到。
 */

/** 学习方法。规划师给每个知识点标注该用什么方式学。 */
export type Method = "explain" | "practice" | "discuss" | "review";

export const METHOD_LABELS: Record<Method, string> = {
  explain: "讲解",
  practice: "练习",
  discuss: "讨论",
  review: "复盘",
};

export type NodeStatus = "pending" | "learning" | "mastered" | "review";

export const STATUS_LABELS: Record<NodeStatus, string> = {
  pending: "未开始",
  learning: "学习中",
  mastered: "已掌握",
  review: "待复习",
};

export interface KnowledgePoint {
  id: string;
  title: string;
  /** 学完能做到什么。要可验证，不要写"理解 X"这类无法检验的目标。 */
  objectives: string[];
  /** 依赖的其他知识点 id。只用于推荐顺序和 UI 提示，不强制阻塞。 */
  prerequisites: string[];
  methods: Method[];
  status: NodeStatus;
  /** 笔记文件路径。只是引用，内容不在这个结构里。 */
  notePath: string;
  origin: "user" | "planner" | "tutor-suggestion";
  createdAt: number;
  /** 旧报告折叠后的摘要，防止报告无限增长挤占规划师上下文。 */
  reportDigest?: string;
}

export interface Curriculum {
  topic: string;
  /** 学习者画像：背景、偏好、已掌握的技能。每次新建导师都会注入。 */
  learnerProfile: string;
  nodes: KnowledgePoint[];
  updatedAt: number;
}

/** 导师上报给规划师的进度报告。**唯一**的向上通道。 */
export interface Report {
  nodeId: string;
  nodeTitle: string;
  status: NodeStatus;
  summary: string;
  /** 导师发现的知识缺口，由规划师决定是否采纳为新节点。 */
  suggestedNext?: { title: string; reason: string }[];
  ts: number;
}

/**
 * 压缩后的知识精华。
 *
 * 注意它不是导师写的，而是注入时由系统按**目标知识点**临时生成的——
 * 「总结这个知识点」和「提取目标知识点所需的前置知识」是两种不同的抽取，
 * 后者必须知道接收方是谁才做得对。
 */
export interface Essence {
  sourceNodeId: string;
  sourceNodeTitle: string;
  targetNodeId: string;
  targetNodeTitle: string;
  hint?: string;
  /** 生成时源笔记的哈希。笔记改了缓存就失效。 */
  noteHash: string;
  content: string;
  generatedAt: number;
}

/** 一次注入的记录，展示在 UI 上并支持撤销。 */
export interface InjectionRecord {
  id: string;
  sourceNodeId: string;
  sourceNodeTitle: string;
  targetNodeId: string;
  targetNodeTitle: string;
  hint?: string;
  content: string;
  /** 注入在目标导师会话里产生的条目 id，撤销时把 leaf 移回它的 parent */
  entryId: string;
  /** 目标会话在注入前的位置，撤销时移回这里 */
  previousLeafId: string | null;
  ts: number;
  revokedAt?: number;
}

/** 导师会话 id 由节点 id 派生，不单独存字段——少一个会不同步的状态。 */
export function tutorSessionId(nodeId: string): string {
  return `tutor-${nodeId}`;
}

export const PLANNER_SESSION_ID = "planner";
