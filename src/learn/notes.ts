/**
 * 学习笔记：导师的产物，也是注入压缩的原料。
 *
 * 笔记是 markdown，按 `## 小节` 组织。导师通过 save_note 工具写它，UI 直接展示它，
 * 注入时读它做压缩。这三条路径操作的是同一份文件，所以格式必须稳定——
 * 用固定的小节名，而不是让模型自由发挥标题。
 *
 * 为什么笔记不常驻导师的上下文：它每写一次就会改变系统提示的内容，而系统提示是
 * prompt 缓存的第一个断点——笔记一变，整个会话的缓存全部失效，长对话的账单会
 * 成倍上涨。所以导师通过 read_notes 工具按需读取（见 tutor.ts 的说明）。
 */

import { createHash } from "node:crypto";
import type { Workspace } from "./workspace.js";

/** 笔记的固定小节。顺序固定，便于 UI 稳定渲染和压缩时按重要度取舍。 */
export const NOTE_SECTIONS = [
  "核心概念",
  "关键要点",
  "例题与练习",
  "疑问与澄清",
  "回顾",
] as const;

export type NoteSection = (typeof NOTE_SECTIONS)[number];

export function readNotes(workspace: Workspace, nodeId: string): string {
  return workspace.readText(workspace.notePath(nodeId)).trim();
}

export function hasNotes(workspace: Workspace, nodeId: string): boolean {
  return readNotes(workspace, nodeId).length > 0;
}

/**
 * 写入一个小节。
 *
 * mode 的语义：
 *   - append：追加到该小节末尾。用于「又讲了一个要点」这类增量记录。
 *   - replace：覆盖该小节。用于「这一节我重新整理了」。
 */
export function writeNoteSection(
  workspace: Workspace,
  nodeId: string,
  section: string,
  content: string,
  mode: "append" | "replace" = "append",
): void {
  const body = content.trim();
  if (!body) return;

  const existing = readNotes(workspace, nodeId);
  const sections = parseSections(existing);

  const index = sections.findIndex((s) => s.title === section);
  if (index === -1) {
    sections.push({ title: section, body });
  } else {
    const current = sections[index]!;
    sections[index] = {
      title: current.title,
      body: mode === "append" && current.body ? `${current.body}\n\n${body}` : body,
    };
  }

  workspace.writeText(workspace.notePath(nodeId), renderSections(sections));
}

/**
 * 把压缩摘要追加进「回顾」小节。
 *
 * 压缩和记笔记本来要做两次模型调用，这里复用同一次调用的产物：会话被压缩时那段
 * 摘要本身就是「刚才讲了什么」的良好概括，直接沉淀成笔记，不需要再问一遍模型。
 */
export function appendCompactionToNotes(
  workspace: Workspace,
  nodeId: string,
  summary: string,
): void {
  const stamp = new Date().toLocaleString("zh-CN");
  writeNoteSection(workspace, nodeId, "回顾", `_（${stamp} 自动归档）_\n\n${summary}`, "append");
}

export function notesHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

interface Section {
  title: string;
  body: string;
}

/** 解析 `## 标题` 分节的 markdown。没有标题的内容归入前言，重排时丢弃。 */
function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1]!, body: "" };
      sections.push(current);
      continue;
    }
    if (current) {
      current.body = current.body ? `${current.body}\n${line}` : line;
    }
  }

  for (const section of sections) section.body = section.body.trim();
  return sections;
}

function renderSections(sections: Section[]): string {
  return `${sections
    .filter((s) => s.body)
    .map((s) => `## ${s.title}\n\n${s.body}`)
    .join("\n\n")}\n`;
}
