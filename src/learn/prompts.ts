/**
 * 提示词加载。
 *
 * 提示词放在独立的 .md 文件而不是代码里的模板字符串，因为提示词的迭代频率远高于
 * 代码：改措辞、调语气、加约束，这些操作不应该有碰坏代码的风险，diff 也应该干净。
 *
 * 注意：这依赖运行时能从源码目录读到文件，所以服务必须用 tsx 从 src/ 启动。
 * 若将来要编译成 dist，需要把 prompts/ 一起拷贝过去。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "prompts");
const cache = new Map<string, string>();

export function loadPrompt(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const text = readFileSync(join(promptsDir, `${name}.md`), "utf8").trim();
  cache.set(name, text);
  return text;
}
