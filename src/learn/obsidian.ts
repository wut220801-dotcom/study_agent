/**
 * 导出到 Obsidian。
 *
 * Obsidian 的库就是本地一个 markdown 文件夹，所以「联动」不需要装插件、不需要 API、
 * 不需要跑着 Obsidian——写文件就够了。这一点决定了整个设计的形状：
 * 与其做同步协议，不如把内容渲染成**原生 Obsidian 用法**的 markdown。
 *
 * 两个刻意为之的地方：
 *
 * 1. **依赖关系渲染成双链 `[[...]]`。** 大纲本来就是一张有向图，Obsidian 的图谱
 *    视图正好是看这张图的地方。导出后你会发现学习路径自动成了可视化的网络。
 *
 * 2. **frontmatter 承载元数据**，状态、方法、编号都进去。这样 Obsidian 的属性面板
 *    和 Dataview 都能直接查，不需要在正文里写给人看的表格。
 *
 * **安全上最重要的一条**：这是往用户的库里写文件，而库里全是用户自己的笔记。
 * 所以每个生成的文件都在 frontmatter 里带 `generated_by` 标记；覆盖之前先读一遍，
 * 没有标记的同名文件一律跳过并报告冲突，绝不静默覆盖。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Curriculum, KnowledgePoint, Report } from "./types.js";
import { METHOD_LABELS, STATUS_LABELS } from "./types.js";
import { readNotes } from "./notes.js";
import type { Workspace } from "./workspace.js";

/** 生成标记。没有这个标记的文件被视为用户自己的，不碰。 */
const GENERATED_BY = "learn-agent";
const MARKER_KEY = "generated_by";

/**
 * 这个文件是不是本工具生成的。
 *
 * 写入前必须问这一句：库里全是用户自己的笔记，同名文件静默覆盖是不可接受的损失。
 * 插件侧（走 Obsidian vault API）和服务端侧（走 node:fs）共用同一个判断。
 */
export function isGeneratedFile(content: string): boolean {
  return content.includes(`${MARKER_KEY}: ${GENERATED_BY}`);
}

export interface ObsidianSettings {
  /** Obsidian 库的绝对路径 */
  vaultPath?: string;
  /** 库内的子文件夹，默认「学习Agent」。所有生成文件都收在这里，避免污染库根目录。 */
  folder?: string;
  /** 每轮学习结束后自动重新导出 */
  autoExport?: boolean;
}

export const DEFAULT_OBSIDIAN_FOLDER = "学习Agent";

export interface ExportSkip {
  path: string;
  reason: string;
}

export interface ExportResult {
  ok: boolean;
  /** 实际写入的文件（相对库路径） */
  written: string[];
  /** 跳过的文件及原因 */
  skipped: ExportSkip[];
  error?: string;
  exportedAt: number;
}

/** 判断给定路径是不是一个 Obsidian 库——有 .obsidian 目录才算。 */
export function inspectVault(vaultPath: string): { ok: boolean; error?: string } {
  if (!vaultPath.trim()) return { ok: false, error: "没有填写库路径" };
  if (!existsSync(vaultPath)) return { ok: false, error: `路径不存在：${vaultPath}` };
  if (!existsSync(join(vaultPath, ".obsidian"))) {
    return {
      ok: false,
      error:
        `这个目录里没有 .obsidian 文件夹，看起来不是 Obsidian 库。` +
        "请填库的根目录（就是能看到 .obsidian 的那一层）。",
    };
  }
  return { ok: true };
}

export interface ExportOptions {
  workspace: Workspace;
  curriculum: Curriculum;
  settings: ObsidianSettings;
}

export function exportToObsidian(options: ExportOptions): ExportResult {
  const { workspace, curriculum, settings } = options;

  const vaultPath = settings.vaultPath?.trim();
  if (!vaultPath) {
    return { ok: false, written: [], skipped: [], error: "没有配置 Obsidian 库路径", exportedAt: Date.now() };
  }

  const probe = inspectVault(vaultPath);
  if (!probe.ok) {
    return { ok: false, written: [], skipped: [], error: probe.error, exportedAt: Date.now() };
  }

  const folder = settings.folder?.trim() || DEFAULT_OBSIDIAN_FOLDER;
  const files = renderVaultFiles(curriculum, workspace, folder);

  const written: string[] = [];
  const skipped: ExportSkip[] = [];

  try {
    mkdirSync(targetDirFor(vaultPath, files), { recursive: true });
    for (const [relative, content] of files) {
      if (writeGuarded(join(vaultPath, relative), content, relative, skipped)) {
        written.push(relative);
      }
    }
    return { ok: true, written, skipped, exportedAt: Date.now() };
  } catch (error) {
    return {
      ok: false,
      written,
      skipped,
      error: error instanceof Error ? error.message : String(error),
      exportedAt: Date.now(),
    };
  }
}

/**
 * 渲染出所有要写进库的文件，**不碰磁盘**。
 *
 * 把渲染和写入分开，是因为写入方式取决于宿主：服务端用 node:fs，Obsidian 插件
 * 必须用 `app.vault`——直接写盘的话 Obsidian 的文件索引不会更新，新建的笔记在
 * 文件树里看不到，还可能跟同步打架。渲染逻辑只有一份，两边共用。
 *
 * @returns 相对库根的路径 → 文件内容
 */
export function renderVaultFiles(
  curriculum: Curriculum,
  workspace: Workspace,
  folder: string,
): Map<string, string> {
  const safeFolder = sanitizeSegment(folder.trim() || DEFAULT_OBSIDIAN_FOLDER);
  const files = new Map<string, string>();

  for (const node of curriculum.nodes) {
    const filename = `${sanitizeSegment(node.id)} ${sanitizeSegment(node.title)}.md`;
    files.set(`${safeFolder}/${filename}`, renderNodeFile(node, curriculum, workspace));
  }

  // 索引文件。主题还没设定时用固定名，不要把「(尚未设定)」这种占位文案写进文件名。
  const indexName = `${sanitizeSegment(indexTitle(curriculum))}.md`;
  files.set(`${safeFolder}/${indexName}`, renderIndexFile(curriculum, workspace));

  return files;
}

/**
 * 带保护的写入。
 *
 * 目标文件已存在且没有生成标记 → 跳过并记录冲突。这是这个模块里唯一真正重要的
 * 逻辑：用户库里可能有他自己的笔记恰好重名，静默覆盖是不可接受的损失。
 */
/** 所有渲染结果所在的目录（取第一个文件的父目录）。 */
function targetDirFor(vaultPath: string, files: Map<string, string>): string {
  const first = files.keys().next().value as string | undefined;
  if (!first) return vaultPath;
  const parts = first.split("/");
  parts.pop();
  return join(vaultPath, ...parts);
}

function writeGuarded(
  absolutePath: string,
  content: string,
  relativeForReport: string,
  skipped: ExportSkip[],
): boolean {
  if (existsSync(absolutePath)) {
    let existing = "";
    try {
      existing = readFileSync(absolutePath, "utf8");
    } catch {
      /* 读不了就当冲突处理，保守优先 */
    }
    if (!isGeneratedFile(existing)) {
      skipped.push({
        path: relativeForReport,
        reason: "同名文件已存在且不是本工具生成的，已跳过以免覆盖你自己的笔记",
      });
      return false;
    }
  }

  writeFileSync(absolutePath, content, "utf8");
  return true;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderNodeFile(
  node: KnowledgePoint,
  curriculum: Curriculum,
  workspace: Workspace,
): string {
  const notes = readNotes(workspace, node.id);
  const reports = workspace.readLines<Report>(workspace.reportPath(node.id));

  const front: string[] = [
    "---",
    `${MARKER_KEY}: ${GENERATED_BY}`,
    `id: ${node.id}`,
    `title: ${yamlString(node.title)}`,
    `status: ${node.status}`,
    `methods: [${node.methods.map((m) => METHOD_LABELS[m]).join(", ")}]`,
    `objectives: ${node.objectives.length}`,
    `curriculum: ${yamlString(indexTitle(curriculum))}`,
    `updated: ${new Date().toISOString()}`,
  ];
  if (node.prerequisites.length > 0) {
    // 逐项引号化：标题里若含逗号，不加引号会被 YAML 当成两个列表项
    front.push(
      `prerequisites: [${node.prerequisites
        .map((p) => yamlString(linkFor(curriculum, p)))
        .join(", ")}]`,
    );
  }
  front.push("---");

  const parts: string[] = [front.join("\n"), "", `# ${node.title}`, ""];

  parts.push(`> 所属大纲：[[${sanitizeSegment(indexTitle(curriculum))}]]`);
  parts.push("");

  if (node.objectives.length > 0) {
    parts.push("## 学习目标", "");
    for (const objective of node.objectives) parts.push(`- ${objective}`);
    parts.push("");
  }

  if (node.prerequisites.length > 0) {
    parts.push("## 先修知识", "");
    for (const prerequisite of node.prerequisites) {
      parts.push(`- [[${linkFor(curriculum, prerequisite)}]]`);
    }
    parts.push("");
  }

  parts.push(`## 学习方法`, "", node.methods.map((m) => METHOD_LABELS[m]).join("、"), "");

  parts.push("## 学习笔记", "");
  parts.push(notes || "_（导师还没有写笔记）_");
  parts.push("");

  if (reports.length > 0) {
    parts.push("## 学习进展", "");
    // 倒序：最近的进展放最上面，方便回顾时一眼看到学到哪了
    for (const report of [...reports].reverse()) {
      const when = new Date(report.ts).toLocaleDateString("zh-CN");
      parts.push(`- **${when}**（${STATUS_LABELS[report.status]}）${report.summary}`);
    }
    parts.push("");
  }

  return `${parts.join("\n").trimEnd()}\n`;
}

function renderIndexFile(curriculum: Curriculum, workspace: Workspace): string {
  const nodes = curriculum.nodes;
  const mastered = nodes.filter((n) => n.status === "mastered").length;

  const front = [
    "---",
    `${MARKER_KEY}: ${GENERATED_BY}`,
    `topic: ${yamlString(indexTitle(curriculum))}`,
    `nodes: ${nodes.length}`,
    `mastered: ${mastered}`,
    `updated: ${new Date().toISOString()}`,
    "---",
  ];

  const parts: string[] = [front.join("\n"), "", `# ${indexTitle(curriculum)}`, ""];

  if (curriculum.learnerProfile.trim()) {
    parts.push("## 学习者画像", "", curriculum.learnerProfile.trim(), "");
  }

  parts.push("## 进度", "", `${mastered} / ${nodes.length} 个知识点已掌握`, "");

  if (nodes.length === 0) {
    parts.push("_（大纲还是空的）_", "");
    return `${parts.join("\n").trimEnd()}\n`;
  }

  // 用表格呈现，依赖列放双链——图谱视图里就能看到这张图的形状
  parts.push("## 知识点", "");
  parts.push("| 知识点 | 状态 | 方法 | 先修 |");
  parts.push("| --- | --- | --- | --- |");
  for (const node of nodes) {
    const prerequisites =
      node.prerequisites.length > 0
        ? node.prerequisites.map((p) => `[[${linkFor(curriculum, p)}]]`).join("、")
        : "—";
    parts.push(
      `| [[${linkFor(curriculum, node.id)}]] | ${STATUS_LABELS[node.status]} | ` +
        `${node.methods.map((m) => METHOD_LABELS[m]).join("、")} | ${prerequisites} |`,
    );
  }
  parts.push("");

  // 导师上报的进度摘要，给规划师看的东西顺便也给人看一份
  const withReports = nodes
    .map((node) => ({
      node,
      reports: workspace.readLines<Report>(workspace.reportPath(node.id)),
    }))
    .filter((entry) => entry.reports.length > 0);

  if (withReports.length > 0) {
    parts.push("## 导师报告", "");
    for (const { node, reports } of withReports) {
      const latest = reports[reports.length - 1]!;
      const when = new Date(latest.ts).toLocaleDateString("zh-CN");
      parts.push(`### [[${linkFor(curriculum, node.id)}]]`, "");
      parts.push(`${when}（${STATUS_LABELS[latest.status]}）：${latest.summary}`, "");
    }
  }

  return `${parts.join("\n").trimEnd()}\n`;
}

/** 索引文件的名字。主题未设定时退回到一个稳定的名字。 */
function indexTitle(curriculum: Curriculum): string {
  const topic = curriculum.topic.trim();
  if (!topic || topic.startsWith("(") || topic.startsWith("（")) return "学习大纲";
  return topic;
}

/** 笔记文件在库里的链接名（不含 .md 后缀）。 */
function linkFor(curriculum: Curriculum, nodeId: string): string {
  const node = curriculum.nodes.find((n) => n.id === nodeId);
  if (!node) return sanitizeSegment(nodeId);
  return `${sanitizeSegment(node.id)} ${sanitizeSegment(node.title)}`;
}

/** 去掉文件名里非法或会造成歧义的字符。 */
function sanitizeSegment(value: string): string {
  return value
    .replace(/[/\\:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** YAML 值里含冒号、引号等字符时要加引号，否则 frontmatter 会解析失败。 */
function yamlString(value: string): string {
  if (value === "") return '""';
  return /[:#"'\[\]{}&*!|>%@`,]/.test(value) || value.startsWith(" ") || value.endsWith(" ")
    ? JSON.stringify(value)
    : value;
}
