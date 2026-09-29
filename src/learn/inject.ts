/**
 * 知识点之间的注入：把一个节点的学习笔记压缩后，投给另一个节点的导师。
 *
 * 这是本项目和普通「子 agent 汇报」最大的不同——内容可以在**平级的兄弟 agent
 * 之间横向流动**，而不只是向上汇报。学「所有权」的导师能把「栈与堆」里已经讲透的
 * 东西直接交给「借用检查」的导师，后者不必从头再问一遍学习者。
 *
 * 三个设计上的关键点：
 *
 * 1. **压缩是面向目标的，不是通用摘要。** 「总结栈与堆」和「提取学习借用检查所需的
 *    栈与堆知识」是两种不同的抽取，后者必须知道接收方是谁。所以精华按
 *    (源节点, 目标节点, 提示语, 笔记哈希) 四元组缓存，而不是每个源节点一份。
 *
 * 2. **精华由系统生成，不由导师写。** 导师写不好面向未知接收方的压缩——它不知道
 *    谁要学什么。让它在写完笔记后再揣测下游需求，只会产出又多又偏的中间产物。
 *
 * 3. **注入是可撤销的。** 会话是 append-only 树，撤销就是把 leaf 游标移回注入前的
 *    位置。注错了前置知识会持续误导导师，必须能干净地撤掉。
 */

import { completeOnce } from "../core/complete.js";
import type { CustomEntry, Session } from "../core/session.js";
import type { Provider } from "../core/provider/types.js";
import { findNode } from "./curriculum.js";
import { ENTRY_INJECTED } from "./entries.js";
import { notesHash, readNotes } from "./notes.js";
import { loadPrompt } from "./prompts.js";
import type { Curriculum, Essence, InjectionRecord, KnowledgePoint } from "./types.js";
import type { Workspace } from "./workspace.js";

/** 缓存单位：一个源节点针对各个目标节点分别缓存一份精华。 */
interface EssenceFile {
  sourceNodeId: string;
  sourceNodeTitle: string;
  targets: Record<string, Essence>;
}

export interface GenerateEssenceOptions {
  workspace: Workspace;
  curriculum: Curriculum;
  sourceNode: KnowledgePoint;
  targetNode: KnowledgePoint;
  hint?: string;
  provider: Provider;
  signal?: AbortSignal;
}

export interface GenerateEssenceResult {
  essence: Essence;
  /** 命中缓存时为 true，没有产生模型调用 */
  cached: boolean;
}

export async function generateEssence(
  options: GenerateEssenceOptions,
): Promise<GenerateEssenceResult> {
  const { workspace, sourceNode, targetNode, hint, provider, signal } = options;

  const notes = readNotes(workspace, sourceNode.id);
  if (!notes) {
    throw new Error(
      `「${sourceNode.title}」还没有学习笔记，无法提取精华。先去和它的导师学一轮。`,
    );
  }

  const hash = notesHash(notes);
  const file = readEssenceFile(workspace, sourceNode.id);
  const cached = file?.targets[targetNode.id];

  // 笔记没变、提示语也没变，直接复用
  if (cached && cached.noteHash === hash && (cached.hint ?? "") === (hint ?? "")) {
    return { essence: cached, cached: true };
  }

  const prompt = buildCompressionPrompt(sourceNode, targetNode, notes, hint);
  const result = await completeOnce({
    provider,
    system: loadPrompt("compress"),
    prompt,
    maxTokens: 4096,
    ...(signal ? { signal } : {}),
  });

  if (!result.text) {
    throw new Error("压缩结果为空，已放弃本次注入");
  }

  const essence: Essence = {
    sourceNodeId: sourceNode.id,
    sourceNodeTitle: sourceNode.title,
    targetNodeId: targetNode.id,
    targetNodeTitle: targetNode.title,
    ...(hint ? { hint } : {}),
    noteHash: hash,
    content: result.text,
    generatedAt: Date.now(),
  };

  const updated: EssenceFile = {
    sourceNodeId: sourceNode.id,
    sourceNodeTitle: sourceNode.title,
    targets: { ...(file?.targets ?? {}), [targetNode.id]: essence },
  };
  workspace.writeJSON(workspace.essencePath(sourceNode.id), updated);

  return { essence, cached: false };
}

function buildCompressionPrompt(
  sourceNode: KnowledgePoint,
  targetNode: KnowledgePoint,
  notes: string,
  hint?: string,
): string {
  const parts = [
    `<source_notes title="${sourceNode.title}">`,
    notes,
    "</source_notes>",
    "",
    "<target>",
    `学习者接下来要学的知识点：${targetNode.title}`,
    "它的学习目标：",
    ...targetNode.objectives.map((o) => `- ${o}`),
    "</target>",
  ];

  if (hint?.trim()) {
    parts.push("", "<focus>", `学习者的额外说明：${hint.trim()}`, "</focus>");
  }

  parts.push(
    "",
    "请提取理解上述新知识点所必需的前置知识，用新知识点的视角重新组织后输出。",
  );

  return parts.join("\n");
}

export interface InjectionOutcome {
  record: InjectionRecord;
  entry: CustomEntry;
}

/**
 * 把精华注入目标导师的会话。
 *
 * previousLeafId 必须在追加之前捕获——它是撤销的锚点。
 */
export function applyInjection(
  session: Session,
  essence: Essence,
  workspace: Workspace,
): InjectionOutcome {
  const previousLeafId = session.currentLeafId;

  const entry = session.appendCustom(
    ENTRY_INJECTED,
    {
      sourceNodeId: essence.sourceNodeId,
      sourceNodeTitle: essence.sourceNodeTitle,
      targetNodeId: essence.targetNodeId,
      ...(essence.hint ? { hint: essence.hint } : {}),
      content: essence.content,
    },
    true, // 进上下文——这正是注入的目的
  );

  const record: InjectionRecord = {
    id: entry.id,
    sourceNodeId: essence.sourceNodeId,
    sourceNodeTitle: essence.sourceNodeTitle,
    targetNodeId: essence.targetNodeId,
    targetNodeTitle: essence.targetNodeTitle,
    ...(essence.hint ? { hint: essence.hint } : {}),
    content: essence.content,
    entryId: entry.id,
    previousLeafId,
    ts: Date.now(),
  };
  workspace.appendLine(workspace.injectionsPath, record);

  return { record, entry };
}

/**
 * 撤销一次注入：把目标会话的 leaf 移回注入前的位置。
 * 注入条目及其之后的对话都还在文件里，只是不在当前分支上了。
 */
export function revokeInjection(
  session: Session,
  record: InjectionRecord,
  workspace: Workspace,
): void {
  session.navigateTo(record.previousLeafId);
  workspace.appendLine(workspace.injectionsPath, {
    ...record,
    revokedAt: Date.now(),
  });
}

/** 注入记录（含撤销记录，后写的覆盖先写的）。 */
export function listInjections(workspace: Workspace): InjectionRecord[] {
  const all = workspace.readLines<InjectionRecord>(workspace.injectionsPath);
  const byId = new Map<string, InjectionRecord>();
  for (const record of all) byId.set(record.id, record);
  return [...byId.values()].sort((a, b) => b.ts - a.ts);
}

function readEssenceFile(workspace: Workspace, sourceNodeId: string): EssenceFile | null {
  return workspace.readJSON<EssenceFile>(workspace.essencePath(sourceNodeId));
}

/**
 * 校验一次注入是否合理。返回错误信息表示不该注入。
 * 这类检查放在这里而不是 UI 里，是为了让 CLI 入口也自动获得同样的约束。
 */
export function validateInjection(
  curriculum: Curriculum,
  sourceId: string,
  targetId: string,
): string | null {
  if (sourceId === targetId) {
    return "源知识点和目标知识点不能是同一个";
  }
  const source = findNode(curriculum, sourceId);
  const target = findNode(curriculum, targetId);
  if (!source) return `找不到知识点 ${sourceId}`;
  if (!target) return `找不到知识点 ${targetId}`;
  return null;
}
