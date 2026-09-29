/**
 * 学习数据的落盘位置与读写。
 *
 * 目录布局（workspace/ 是运行时产物，不进版本库）：
 *
 *   curriculum.json          大纲 DAG + 学习者画像
 *   sessions/*.jsonl         每个 agent 一条会话（planner / tutor-kp-1 / ...）
 *   notes/{nodeId}.md        导师的学习笔记 —— 学习细节停在这里
 *   reports/{nodeId}.jsonl   上报给规划师的进度报告（append-only）
 *   essences/{nodeId}.json   该节点笔记压缩出的、面向各个目标的精华（带缓存）
 *   injections.jsonl         注入记录，用于 UI 展示和撤销
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export class Workspace {
  constructor(readonly root: string) {
    mkdirSync(this.root, { recursive: true });
  }

  // --- 路径 ---------------------------------------------------------------

  get curriculumPath(): string {
    return join(this.root, "curriculum.json");
  }

  sessionPath(sessionId: string): string {
    return join(this.root, "sessions", `${sessionId}.jsonl`);
  }

  notePath(nodeId: string): string {
    return join(this.root, "notes", `${nodeId}.md`);
  }

  essencePath(nodeId: string): string {
    return join(this.root, "essences", `${nodeId}.json`);
  }

  reportPath(nodeId: string): string {
    return join(this.root, "reports", `${nodeId}.jsonl`);
  }

  get injectionsPath(): string {
    return join(this.root, "injections.jsonl");
  }

  // --- 读 -----------------------------------------------------------------

  readJSON<T>(path: string): T | null {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null; // 损坏的文件当不存在处理，由调用方决定重建
    }
  }

  readText(path: string): string {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  }

  readLines<T>(path: string): T[] {
    if (!existsSync(path)) return [];
    const out: T[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* 半截行跳过 */
      }
    }
    return out;
  }

  // --- 写 -----------------------------------------------------------------

  writeJSON(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  writeText(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  appendLine(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
  }
}
