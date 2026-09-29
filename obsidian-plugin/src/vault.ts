/**
 * 库访问的实现（插件侧）。
 *
 * 学习层只认识 VaultAccess 接口，这里用 Obsidian 的 API 把它实现出来。
 * 全部走 `app.vault` 而不是 node:fs——这样拿到的是 Obsidian 已经索引好的文件树，
 * 不会漏掉未落盘的编辑，也不会跟同步功能打架。
 */

import { TFile, TFolder, type App, type TAbstractFile } from "obsidian";

import type { VaultAccess } from "../../src/learn/vault-access.js";

/** 这些目录不给 agent 看：要么是配置，要么是别的插件的运行数据。 */
const HIDDEN_PREFIXES = [".obsidian", ".trash", ".git"];

function isHidden(path: string): boolean {
  return HIDDEN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function createVaultAccess(app: App): VaultAccess {
  return {
    async describe(path: string, maxEntries: number): Promise<string> {
      const target = path.trim();
      const root = target ? app.vault.getAbstractFileByPath(target) : app.vault.getRoot();

      if (!root) {
        return `找不到目录「${target}」。可以用不带参数的调用先看看库的顶层结构。`;
      }
      if (!(root instanceof TFolder)) {
        return `「${target}」不是目录。用 read_vault_note 读单个文件。`;
      }

      const lines: string[] = [];
      const where = target || "（库根目录）";
      lines.push(`# ${where}`);
      lines.push("");

      let count = 0;
      let truncated = false;

      // 广度优先，先把当前层的文件夹列完再列文件——结构比文件名重要
      const folders: string[] = [];
      const files: string[] = [];

      for (const child of root.children) {
        if (isHidden(child.path)) continue;
        if (count >= maxEntries) {
          truncated = true;
          break;
        }
        if (child instanceof TFolder) {
          // 数一下子项，让 agent 知道哪个目录值得深入
          const inner = child.children.filter((c) => !isHidden(c.path)).length;
          folders.push(`📁 ${child.name}/  （${inner} 项）`);
        } else if (child instanceof TFile && child.extension === "md") {
          files.push(`📄 ${child.name}`);
        }
        count++;
      }

      if (folders.length > 0) {
        lines.push("## 文件夹");
        lines.push(...folders);
        lines.push("");
      }
      if (files.length > 0) {
        lines.push("## 笔记");
        lines.push(...files);
      }
      if (folders.length === 0 && files.length === 0) {
        lines.push("_（空目录）_");
      }

      if (truncated) {
        lines.push("", `_（已截断，只显示了前 ${maxEntries} 项。可以指定更具体的子目录再看。）_`);
      }

      return lines.join("\n");
    },

    async read(path: string, maxChars: number): Promise<string> {
      const target = path.trim();
      if (isHidden(target)) return "这个路径不可访问。";

      const file = app.vault.getAbstractFileByPath(target);
      if (!file) {
        return `找不到「${target}」。路径要相对库根，并且带 .md 后缀。`;
      }
      if (!(file instanceof TFile)) {
        return `「${target}」是目录不是笔记。用 list_vault_structure 看它的内容。`;
      }
      if (file.extension !== "md") {
        return `只支持读 markdown 笔记，「${target}」是 .${file.extension} 文件。`;
      }

      const content = await app.vault.cachedRead(file);
      if (content.length <= maxChars) return content;

      return (
        content.slice(0, maxChars) +
        `\n\n[... 已截断，原文共 ${content.length} 字符。需要看后面部分的话，让学习者打开这篇笔记，或者你分段追问。]`
      );
    },
  };
}

/** 库里所有文件夹的路径，供设置页做选择器。 */
export function listVaultFolders(app: App): string[] {
  const folders: string[] = [];
  const walk = (folder: TFolder): void => {
    for (const child of folder.children) {
      if (child instanceof TFolder && !isHidden(child.path)) {
        folders.push(child.path);
        walk(child);
      }
    }
  };
  walk(app.vault.getRoot());
  return folders.sort((a, b) => a.localeCompare(b, "zh"));
}

/** 确保目录存在（含多级），返回是否新建了。 */
export async function ensureFolder(app: App, path: string): Promise<boolean> {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  let created = false;

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing: TAbstractFile | null = app.vault.getAbstractFileByPath(current);
    if (!existing) {
      await app.vault.createFolder(current).catch(() => undefined);
      created = true;
    }
  }
  return created;
}
